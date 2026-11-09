// Child of scheduler-workload.cjs only. Both revisions use this identical observer.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const [dist, settingsPath] = process.argv.slice(2);
const load = name => require(path.join(dist, name));
const send = value => {
  if (process.connected) process.send?.({ pid: process.pid, wall: Date.now(), monotonic: performance.now(), ...value });
};
function totalResources() {
  const cpu = process.cpuUsage();
  return { cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now(), rss: process.memoryUsage().rss, lifetimePeakRssKiB: process.resourceUsage().maxRSS };
}

async function main() {
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  const { ManagedSyncStore } = load('sync-store.js');
  const { SyncClient } = load('sync-client.js');
  const store = new ManagedSyncStore(settings.home);
  let worker;
  let server;
  let wallOffset = 0;
  let monotonicOffset = 0;
  let sample;
  let completedPasses = 0;
  let requests = 0;
  let releaseRead;
  let shouldHoldRead = false;
  let isStopped = false;
  let readTracingInstalled = false;
  let nextReadId = 0;
  let nextStoreId = 0;
  const storeIds = new WeakMap();
  const activeReads = new Map();
  const traceReadsFromStartup = process.env.ISSUE95_ROUTED_READ_DIAGNOSTIC === '1';

  const recordRun = ManagedSyncStore.prototype.recordWorkerRun;
  ManagedSyncStore.prototype.recordWorkerRun = async function(...args) {
    const result = await recordRun.apply(this, args);
    completedPasses += 1;
    send({ type: 'pass-finished', completedPasses });
    return result;
  };
  const json = SyncClient.prototype.json;
  SyncClient.prototype.json = function(...args) {
    requests += 1;
    send({ type: 'request', ordinal: requests, endpoint: args[1] });
    return json.apply(this, args);
  };

  // Only the controlled routed diagnostic tracks reads from startup. Ordinary
  // measurements install this wrapper after resource observation has ended.
  function installReadHold() {
    if (readTracingInstalled) return;

    readTracingInstalled = true;
    const snapshot = ManagedSyncStore.prototype.snapshot;
    ManagedSyncStore.prototype.snapshot = async function(...args) {
      const storeId = storeIds.get(this) ?? ++nextStoreId;
      storeIds.set(this, storeId);
      const read = { readId: ++nextReadId, storeId, scriptStore: this === store };
      activeReads.set(read.readId, read);
      const selected = shouldHoldRead;
      if (selected) shouldHoldRead = false;
      let outcome = 'rejected';
      try {
        if (selected) {
          let released = false;
          const held = new Promise(resolve => {
            releaseRead = reason => {
              if (released) return;

              released = true;
              resolve();
              send({ type: 'read-released', ...read, reason });
            };
          });
          send({ type: 'read-held', ...read, caller: new Error('issue95-routed-held-read').stack,
            activeReads: [...activeReads.values()] });
          await held;
        }

        const ledger = await snapshot.apply(this, args);
        outcome = 'fulfilled';
        return ledger;
      } finally {
        activeReads.delete(read.readId);
        if (selected) send({ type: 'read-finished', ...read, outcome, activeReads: [...activeReads.values()] });
      }
    };
  }

  if (settings.role === 'peer') {
    const ledger = await store.snapshot();
    const credentials = { token: (await fs.readFile(settings.token, 'utf8')).trim(), ca: await fs.readFile(settings.ca) };
    server = load('sync-http-server.js').createSyncIngestionServer({ store, peerId: ledger.inboxId, credentials: () => credentials,
      host: '127.0.0.1', key: await fs.readFile(settings.key), cert: await fs.readFile(settings.cert) });
    const { url } = await server.start();
    send({ type: 'ready', url, resources: totalResources() });
  } else {
    if (settings.role === 'worker') {
      try {
        const failure = load('sync-failure.js');
        const classify = failure.classifySyncFailure;
        let observedClassification = false;

        const admissionCalls = [];
        const admissionStores = new WeakMap();
        const rejectedCalls = new WeakMap();
        const promiseThen = Promise.prototype.then;
        let nextAdmissionStore = 0;
        let omittedAdmissions = 0;
        let admissionFaults = 0;
        let firstIdentitySeen = false;
        let firstIdentityCaller = 'unobserved';
        let firstRequestCallId = null;
        let activeAdmission = null;

        function finiteNumber(value) {
          return Number.isFinite(value) ? value : null;
        }

        function ownNumber(value, name) {
          return value !== null && typeof value === 'object'
            ? finiteNumber(Object.getOwnPropertyDescriptor(value, name)?.value) : null;
        }

        function admissionCaller(exclude) {
          const holder = {};
          Error.captureStackTrace(holder, exclude);
          const frame = typeof holder.stack === 'string' ? holder.stack.slice(0, 8192).split('\n', 2)[1] : undefined;
          const sites = [
            ['identity-json', 'SyncClient.json', 'sync-client.js', 25],
            ['client-attempt', 'SyncClient.request', 'sync-client.js', 80],
            ['request-authorization', 'SyncClient.request', 'sync-client.js', 96],
            ['attempt-registration', 'ManagedSyncStore.openRouteAttempt', 'sync-store.js', 483],
            ['outer-attempt', 'reconcileSyncRoutes', 'sync-reconciliation.js', 60]
          ];
          for (const [kind, name, module, line] of sites) {
            const prefix = `    at ${name} (${path.join(dist, module)}:${line}:`;
            if (typeof frame === 'string' && frame.startsWith(prefix) && /^[1-9][0-9]{0,3}\)$/.test(frame.slice(prefix.length))) return kind;
          }

          return 'unknown';
        }

        function beginAdmission(kind, receiver, deadlineAt, requestMs, exclude) {
          if (observedClassification) return;

          if (admissionCalls.length === 8) {
            omittedAdmissions = Math.min(65535, omittedAdmissions + 1);
            return;
          }

          const frameCaller = admissionCaller(exclude);
          const caller = kind === 'request' && frameCaller !== 'identity-json' ? 'unknown' : frameCaller;
          let storeId = null;
          if (receiver !== null && typeof receiver === 'object') {
            storeId = admissionStores.get(receiver);
            if (storeId === undefined) {
              storeId = ++nextAdmissionStore;
              admissionStores.set(receiver, storeId);
            }
          }

          const parent = activeAdmission;
          const isChild = parent && storeId !== null && parent.storeId === storeId &&
            (kind === 'attempt' && caller === 'client-attempt' && parent.kind === 'request' ||
             kind === 'communication' && caller === 'attempt-registration' && parent.kind === 'attempt');
          const entryWall = Date.now();
          const call = { callId: admissionCalls.length + 1, storeId, kind, caller,
            requestId: kind === 'request' ? 1 : isChild ? parent.requestId : null,
            parentId: isChild ? parent.callId : null, deadlineAt: finiteNumber(deadlineAt), requestMs,
            entryWall, entryMono: performance.now(), returnWall: null, returnMono: null,
            settledWall: null, settledMono: null,
            entryRemaining: deadlineAt === null ? null : finiteNumber(deadlineAt - entryWall),
            returnRemaining: null, settledRemaining: null, outcome: 'entered',
            otherUnsettled: storeId === null ? null : admissionCalls.filter(value => value.storeId === storeId && value.settledMono === null).length };
          admissionCalls.push(call);
          return call;
        }

        function settleAdmission(call, outcome, error) {
          try {
            if (!call || observedClassification) return;

            call.settledWall = Date.now();
            call.settledMono = performance.now();
            call.settledRemaining = call.deadlineAt === null ? null : finiteNumber(call.deadlineAt - call.settledWall);
            call.outcome = outcome;
            if ((outcome === 'rejected' || outcome === 'threw') && error !== null &&
                (typeof error === 'object' || typeof error === 'function')) {
              const matches = rejectedCalls.get(error) ?? [];
              if (matches.length < 8 && !matches.includes(call.callId)) matches.push(call.callId);
              rejectedCalls.set(error, matches);
            }
          } catch {
            admissionFaults = Math.min(65535, admissionFaults + 1);
          }
        }

        function invokeAdmission(original, receiver, args, call) {
          const previous = activeAdmission;
          activeAdmission = call ?? null;
          let result;
          try {
            result = Reflect.apply(original, receiver, args);
          } catch (error) {
            settleAdmission(call, 'threw', error);
            throw error;
          } finally {
            activeAdmission = previous;
          }

          try {
            if (call && !observedClassification) {
              call.returnWall = Date.now();
              call.returnMono = performance.now();
              call.returnRemaining = call.deadlineAt === null ? null : finiteNumber(call.deadlineAt - call.returnWall);
              call.outcome = 'pending';
              // Side observers return normally; callers retain the original promise.
              Reflect.apply(promiseThen, result, [() => { settleAdmission(call, 'fulfilled'); },
                error => { settleAdmission(call, 'rejected', error); }]);
            }
          } catch {
            admissionFaults = Math.min(65535, admissionFaults + 1);
          }

          return result;
        }

        const originalRequest = SyncClient.prototype.request;
        SyncClient.prototype.request = function request(authorization, method, requestPath, bytes, contentType, consume, options, expectedState) {
          'use strict';
          let call;
          try {
            if (!observedClassification && !firstIdentitySeen && method === 'POST' && requestPath === '/sync/v1/identity') {
              firstIdentitySeen = true;
              firstIdentityCaller = 'unknown';
              const receiver = Object.getOwnPropertyDescriptor(this, 'store')?.value;
              call = beginAdmission('request', receiver, ownNumber(options, 'deadlineAt'), ownNumber(options, 'requestMs'), request);
              firstIdentityCaller = call?.caller ?? 'unknown';
              firstRequestCallId = call?.callId ?? null;
            }
          } catch {
            admissionFaults = Math.min(65535, admissionFaults + 1);
          }

          return invokeAdmission(originalRequest, this, arguments, call);
        };

        const originalAttempt = ManagedSyncStore.prototype.openRouteAttempt;
        ManagedSyncStore.prototype.openRouteAttempt = function openRouteAttempt(authorization, parentSignal, deadlineAt) {
          'use strict';
          let call;
          try {
            if (!observedClassification) call = beginAdmission('attempt', this, finiteNumber(deadlineAt), null, openRouteAttempt);
          } catch {
            admissionFaults = Math.min(65535, admissionFaults + 1);
          }

          return invokeAdmission(originalAttempt, this, arguments, call);
        };

        const originalCommunication = ManagedSyncStore.prototype.startCommunication;
        ManagedSyncStore.prototype.startCommunication = function startCommunication(authorization, start, expectedState, deadlineAt) {
          'use strict';
          let call;
          try {
            if (!observedClassification) call = beginAdmission('communication', this, finiteNumber(deadlineAt), null, startCommunication);
          } catch {
            admissionFaults = Math.min(65535, admissionFaults + 1);
          }

          return invokeAdmission(originalCommunication, this, arguments, call);
        };

        let selectedMutationPhase = null;
        let mutationPhaseFaults = 0;
        let mutationPhaseMisses = 0;

        function phaseRow() {
          return [null, null, null, null, null, null, 'unobserved'];
        }

        function stampMutationPhase(row, offset, outcome) {
          try {
            if (!row || observedClassification) return;

            row[offset] = Date.now();
            row[offset + 1] = performance.now();
            row[6] = outcome;
          } catch {
            mutationPhaseFaults = Math.min(65535, mutationPhaseFaults + 1);
          }
        }

        function observeMutationReturn(row, result) {
          if (!row || observedClassification) return;

          stampMutationPhase(row, 2, 'pending');
          try {
            Reflect.apply(promiseThen, result, [() => { stampMutationPhase(row, 4, 'fulfilled'); },
              () => { stampMutationPhase(row, 4, 'rejected'); }]);
          } catch {
            mutationPhaseFaults = Math.min(65535, mutationPhaseFaults + 1);
          }
        }

        const originalMutate = ManagedSyncStore.prototype.mutate;
        ManagedSyncStore.prototype.mutate = function mutate(operation) {
          'use strict';
          let forwardedArgs = arguments;
          let phase;
          try {
            const communication = activeAdmission;
            if (!observedClassification && !selectedMutationPhase && communication?.kind === 'communication' &&
                communication.caller === 'attempt-registration' && communication.requestId === 1 &&
                communication.storeId !== null && admissionStores.get(this) === communication.storeId) {
              const attempt = admissionCalls.find(call => call.callId === communication.parentId);
              const request = admissionCalls.find(call => call.callId === attempt?.parentId);
              if (attempt?.kind === 'attempt' && attempt.caller === 'client-attempt' && attempt.requestId === 1 &&
                  attempt.storeId === communication.storeId && request?.kind === 'request' &&
                  request.caller === 'identity-json' && request.requestId === 1 &&
                  request.storeId === communication.storeId && request.callId === firstRequestCallId) {
                const holder = {};
                Error.captureStackTrace(holder, mutate);
                const frame = typeof holder.stack === 'string' ? holder.stack.slice(0, 8192).split('\n', 2)[1] : undefined;
                const prefix = `    at ManagedSyncStore.startCommunication (${path.join(dist, 'sync-store.js')}:453:`;
                if (typeof operation === 'function' && typeof frame === 'string' && frame.startsWith(prefix) &&
                    /^[1-9][0-9]{0,3}\)$/.test(frame.slice(prefix.length))) {
                  const selected = { callId: communication.callId, callbackEntriesObserved: 0,
                    mutation: phaseRow(), callback: phaseRow() };
                  const args = [...arguments];
                  args[0] = function observeProtectedOperation(ledger) {
                    'use strict';
                    let row;
                    try {
                      if (!observedClassification) {
                        selected.callbackEntriesObserved = Math.min(2, selected.callbackEntriesObserved + 1);
                        if (selected.callbackEntriesObserved === 1) row = selected.callback;
                      }
                    } catch {
                      mutationPhaseFaults = Math.min(65535, mutationPhaseFaults + 1);
                    }

                    stampMutationPhase(row, 0, 'entered');
                    let result;
                    try {
                      result = Reflect.apply(operation, this, arguments);
                    } catch (error) {
                      stampMutationPhase(row, 4, 'threw');
                      throw error;
                    }

                    observeMutationReturn(row, result);
                    return result;
                  };
                  phase = selected;
                  selectedMutationPhase = selected;
                  forwardedArgs = args;
                  stampMutationPhase(selected.mutation, 0, 'entered');
                } else {
                  mutationPhaseMisses = Math.min(65535, mutationPhaseMisses + 1);
                }
              }
            }
          } catch {
            mutationPhaseFaults = Math.min(65535, mutationPhaseFaults + 1);
          }

          let result;
          try {
            result = Reflect.apply(originalMutate, this, forwardedArgs);
          } catch (error) {
            stampMutationPhase(phase?.mutation, 4, 'threw');
            throw error;
          }

          observeMutationReturn(phase?.mutation, result);
          return result;
        };

        function mutationPhaseObservation() {
          return { schema: 1, selection: selectedMutationPhase ? 'selected' : 'unobserved',
            callId: selectedMutationPhase?.callId ?? null,
            callbackEntriesObserved: selectedMutationPhase?.callbackEntriesObserved ?? null,
            selectionMisses: mutationPhaseMisses, observationFaults: mutationPhaseFaults,
            mutation: selectedMutationPhase ? [...selectedMutationPhase.mutation] : phaseRow(),
            callback: selectedMutationPhase ? [...selectedMutationPhase.callback] : phaseRow() };
        }

        function admissionCorrelation(error) {
          const matches = error !== null && (typeof error === 'object' || typeof error === 'function')
            ? rejectedCalls.get(error) ?? [] : [];
          return { schema: 1, firstIdentity: firstIdentitySeen ? firstIdentityCaller : 'unobserved',
            firstRequestCallId, errorCallIds: [...matches], historyOmitted: omittedAdmissions,
            outputOmitted: 0, observationFaults: admissionFaults,
            phases: mutationPhaseObservation(),
            calls: admissionCalls.map(call => [call.callId, call.storeId, call.kind, call.caller,
              call.requestId, call.parentId, call.deadlineAt, call.requestMs,
              call.entryWall, call.entryMono, call.returnWall, call.returnMono,
              call.settledWall, call.settledMono, call.entryRemaining, call.returnRemaining,
              call.settledRemaining, call.outcome, call.otherUnsettled]) };
        }
        failure.classifySyncFailure = function classifySyncFailure(error) {
          'use strict';
          const result = Reflect.apply(classify, this, arguments);

          try {
            if (!observedClassification && result.kind === 'blocked' && result.code === 'local-validation-or-storage-failed') {
              observedClassification = true;

              const messageKinds = new Map([
                ["Communication authorization deadline exceeded", "communication-authorization-deadline"],
                ["Managed store lock deadline exceeded", "local-queue-deadline"],
                ["Managed store lock deadline exceeded; unknown or live owners are never stolen", "filesystem-ownership-deadline"],
                ["Revoked, stale, or incorrectly bound route authorization", "route-authorization"],
                ["Communication blocked during migration or restore quarantine", "migration-or-quarantine"],
                ["Locally initiated sync is persistently paused", "persistent-local-pause"],
                ["Route credential or TLS trust reference is not configured", "credential-reference"],
                ["Sync credential is not a canonical high-entropy token", "credential-token"],
                ["Storage outcome is uncertain; explicit recovery is required before further mutation", "storage-outcome-uncertain"],
                ["Managed file changed during open", "managed-file-changed"],
                ["Unsupported or missing schema fields", "schema-fields"],
                ["Invalid identity response", "identity-response-shape"]
              ]);
              const errorKinds = new Map([[Error.prototype, 'error'], [TypeError.prototype, 'type-error'],
                [SyntaxError.prototype, 'syntax-error'], [RangeError.prototype, 'range-error'], [AggregateError.prototype, 'aggregate-error']]);
              const codeKinds = new Map([['ENOENT', 'enoent'], ['EPERM', 'eperm'], ['ABORT_ERR', 'abort']]);
              const isObject = error !== null && typeof error === 'object';
              const message = isObject ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
              const code = isObject ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
              const stack = isObject ? Object.getOwnPropertyDescriptor(error, 'stack')?.value : undefined;
              const frames = typeof stack === 'string' ? stack.slice(0, 8192).split('\n').slice(1, 13) : [];
              const frameSites = [
                ["communication-deadline", "sync-store.js", 451],
                ["ledger-json-read", "sync-store.js", 1294],
                ["wire-json-decode", "sync-wire.js", 73],
                ["identity-response-shape", "sync-wire.js", 81]
              ];
              let frameKind = 'unknown';
              for (const frame of frames) {
                for (const [kind, module, line] of frameSites) {
                  const location = `(${path.join(dist, module)}:${line}:`;
                  const at = frame.lastIndexOf(location);
                  if (frame.startsWith('    at ') && at >= 0 && /^[1-9][0-9]{0,3}\)$/.test(frame.slice(at + location.length))) {
                    frameKind = kind;
                    break;
                  }
                }
                if (frameKind !== 'unknown') break;
              }

              const observation = { pid: process.pid, wall: Date.now(), monotonic: performance.now(),
                type: 'issue95-first-generic-blocked', ordinal: 1, timingEligibility: 'ineligible',
                errorKind: isObject ? errorKinds.get(Object.getPrototypeOf(error)) ?? 'unknown' : 'non-object',
                messageKind: messageKinds.get(message) ?? 'unknown', codeKind: codeKinds.get(code) ?? 'unknown', frameKind };
              observation.admission = admissionCorrelation(error);
              let framed = JSON.stringify({ wall: observation.wall, monotonic: observation.monotonic, role: 'worker', ...observation });
              while (Buffer.byteLength(framed, 'utf8') + 1 > 4096 && observation.admission.calls.length) {
                observation.admission.calls.pop();
                observation.admission.outputOmitted += 1;
                framed = JSON.stringify({ wall: observation.wall, monotonic: observation.monotonic, role: 'worker', ...observation });
              }
              if (process.connected && Buffer.byteLength(framed, 'utf8') + 1 <= 4096) process.send?.(observation, () => {});
            }
          } catch {
            // Observation and IPC failures cannot replace the original classification.
          }

          return result;
        };
      } catch {
        // A missing diagnostic is not evidence that no generic failure occurred.
      }
    }

    if (traceReadsFromStartup) installReadHold();

    worker = await load('sync-worker.js').startOwnedSyncWorker(settings.home, { testHooks: {
      wallNow: () => Date.now() + wallOffset, monotonicNow: () => performance.now() + monotonicOffset,
      onEvent: event => send({ type: 'worker-event', event: event.type,
        ...(event.type === 'closed' ? { activeReads: [...activeReads.values()] } : {}) }),
    } });
    send({ type: 'ready', resources: totalResources(), record: { processId: worker.record.processId, controlOrigin: worker.record.controlOrigin } });
  }

  process.on('message', message => {
    void (async () => {
      let result;
      switch (message.operation) {
        case 'settle':
          await worker.tick();
          result = { completedPasses, requests, status: worker.status(), totalResources: totalResources() };
          break;
        case 'wake': result = worker.requestWake(); break;
        case 'run': result = worker.requestRun(message.argument); break;
        case 'cancel': result = worker.cancel(message.argument); break;
        case 'status': result = worker ? { completedPasses, requests, status: worker.status() } : server.status(); break;
        case 'read-state':
          result = { traceReadsFromStartup, readTracingInstalled, activeReads: [...activeReads.values()],
            requests, status: worker.status() };
          break;
        case 'clock':
          wallOffset += message.argument.wall;
          monotonicOffset += message.argument.monotonic;
          await worker.tick();
          result = { wallOffset, monotonicOffset };
          break;
        case 'sample-start':
          assert.equal(sample, undefined);
          sample = { cpu: process.cpuUsage(), at: performance.now(), rss: process.memoryUsage().rss, completedPasses, requests };
          result = { started: true, completedPasses, requests };
          break;
        case 'sample-stop': {
          assert.ok(sample);
          const cpu = process.cpuUsage(sample.cpu);
          const elapsedMs = performance.now() - sample.at;
          result = { elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, cpuFraction: (cpu.user + cpu.system) / (elapsedMs * 1000),
            rssStart: sample.rss, rssEnd: process.memoryUsage().rss, lifetimePeakRssKiB: process.resourceUsage().maxRSS,
            completedPasses: completedPasses - sample.completedPasses, requests: requests - sample.requests };
          sample = undefined;
          break;
        }
        case 'hold-next-read':
          installReadHold();
          if (message.argument?.ticketId) {
            assert.ok(traceReadsFromStartup, 'the controlled barrier requires tracking from startup');
            const ticket = worker.status().tickets.find(ticket => ticket.ticketId === message.argument.ticketId);
            assert.equal(ticket?.state, 'complete');
            assert.equal(ticket.error, null, 'the controlled barrier ticket must complete without an error');
            assert.equal(activeReads.size, 0, 'controlled barrier must still have no active read when arming');
          }
          shouldHoldRead = true;
          result = { armed: true, ticketId: message.argument?.ticketId, traceReadsFromStartup, readTracingInstalled,
            activeReads: [...activeReads.values()], requests, status: worker.status() };
          break;
        case 'release-read': releaseRead?.('rpc'); result = { released: true }; break;
        case 'stop':
          send({ type: 'stopping', activeReads: [...activeReads.values()] });
          const started = performance.now();
          const used = process.cpuUsage();
          if (worker) await worker.close();
          if (server) await server.close();
          isStopped = true;
          const cpu = process.cpuUsage(used);
          result = { stopped: true, elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000, resources: totalResources() };
          break;
        default: throw new Error('Unknown scheduler fixture command');
      }

      send({ type: 'reply', id: message.id, result });
      if (message.operation === 'stop') process.disconnect();
    })().catch(error => send({ type: 'reply', id: message.id, error: String(error.stack ?? error) }));
  });
  process.once('disconnect', () => {
    if (isStopped) return;

    // Unexpected supervisor loss must not leave fixture listeners or ownership.
    releaseRead?.('disconnect');
    void Promise.allSettled([worker?.close(), server?.close()]).then(() => { process.exitCode = 1; });
  });
}

main().catch(error => {
  send({ type: 'startup-failed', error: String(error.stack ?? error) });
  process.exitCode = 1;
  process.disconnect?.();
});
