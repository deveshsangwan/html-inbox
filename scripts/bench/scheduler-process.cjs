// Child of scheduler-workload.cjs only. Both revisions use this identical observer.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const [dist, settingsPath] = process.argv.slice(2);
const load = name => require(path.join(dist, name));
const send = value => process.send?.({ pid: process.pid, wall: Date.now(), monotonic: performance.now(), ...value });
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

  // Read holding is enabled only after the resource observation has ended.
  function installReadHold() {
    const snapshot = ManagedSyncStore.prototype.snapshot;
    ManagedSyncStore.prototype.snapshot = async function(...args) {
      if (shouldHoldRead) {
        shouldHoldRead = false;
        const held = new Promise(resolve => { releaseRead = resolve; });
        send({ type: 'read-held' });
        await held;
      }

      return snapshot.apply(this, args);
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
    worker = await load('sync-worker.js').startOwnedSyncWorker(settings.home, { testHooks: {
      wallNow: () => Date.now() + wallOffset, monotonicNow: () => performance.now() + monotonicOffset,
      onEvent: event => send({ type: 'worker-event', event: event.type }),
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
          shouldHoldRead = true;
          result = { armed: true };
          break;
        case 'release-read': releaseRead?.(); result = { released: true }; break;
        case 'stop':
          send({ type: 'stopping' });
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
    releaseRead?.();
    void Promise.allSettled([worker?.close(), server?.close()]).then(() => { process.exitCode = 1; });
  });
}

main().catch(error => {
  send({ type: 'startup-failed', error: String(error.stack ?? error) });
  process.exitCode = 1;
  process.disconnect?.();
});
