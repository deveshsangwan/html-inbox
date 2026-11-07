const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const [distValue, rootValue, countValue, direction, durationValue] = process.argv.slice(2);
const dist = path.resolve(distValue);
const root = path.resolve(rootValue);
const count = Number(countValue);
const duration = Number(durationValue);
const load = name => require(path.join(dist, name));
const emit = value => console.log(JSON.stringify({ wall: Date.now(), monotonic: performance.now(), ...value }));
const bytes = Buffer.from('<!doctype html><html><title>Scheduler fixture</title><body>' + 'x'.repeat(10_240) + '</body></html>');
const input = { originalBytes: bytes, title: 'Scheduler reaction', type: 'report', sourceFileName: 'fixture.html' };
const children = [];
const ports = [];

async function rebind(origin) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

async function launch(settings) {
  const settingsFile = path.join(root, `${settings.role}.json`);
  await fs.writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const child = fork(path.join(__dirname, 'scheduler-process.cjs'), [dist, settingsFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const events = [];
  const pending = new Map();
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const entry of pending.values()) entry.reject(new Error(`Fixture child exited ${code}/${signal}`));
    resolve({ code, signal });
  }));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${settings.role} exceeded unchanged 10000ms startup bound`)), 10_000);
    child.on('message', message => {
      events.push(message);
      emit({ role: settings.role, ...message });
      if (message.type === 'ready') { clearTimeout(timeout); resolve(message); }
      if (message.type === 'startup-failed') { clearTimeout(timeout); reject(new Error(message.error)); }
      if (message.type === 'reply') {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
        }
      }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Fixture exited before readiness')); });
  });

  function rpc(operation, argument = null) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture command ${operation} exceeded 70000ms outer observation bound`)); }, 70_000);
      pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.send({ id, operation, argument }, error => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }

  const handle = { child, rpc, exit, ready, events, stopped: false };
  children.push(handle);
  emit({ type: 'child-started', role: settings.role, pid: child.pid });
  return handle;
}

// Fixture preparation only, before any worker exists. No receipt or checkpoint is fabricated.
async function seed(home, records) {
  const { ManagedSyncStore } = load('sync-store.js');
  const { signOriginState, canonicalKey, sha256, metadataEncoding } = load('sync-model.js');
  const { parseLedger } = load('sync-ledger.js');
  const { DurableFiles, createStorageCounters } = load('sync-files.js');
  const store = new ManagedSyncStore(home);
  await store.enroll();
  const ledger = await store.snapshot();
  const key = await fs.readFile(path.join(home, 'sync', `owner-${ledger.inboxId}.pem`), 'utf8');
  const files = new DurableFiles(createStorageCounters(), {}, home);
  assert.deepEqual(load('html-validation.js').validateHtml(bytes.toString('utf8')), { ok: true, errors: [], warnings: [] });
  for (let index = 0; index < records; index += 1) {
    const id = `bench-${String(index).padStart(5, '0')}`;
    const metadata = { schemaVersion: 1, id, title: `Scheduler ${index}`, type: 'report', createdAt: '2026-11-07T00:00:00.000Z', sourceFileName: 'fixture.html' };
    const state = signOriginState({ originInboxId: ledger.inboxId, originDocumentId: id, historyEpoch: ledger.historyEpoch, version: index + 1,
      state: 'live', metadata, sha256: sha256(bytes), byteLength: bytes.length, metadataSha256: sha256(metadataEncoding(metadata)) }, key);
    const bodyFile = `${randomUUID()}.html`;
    await files.exclusiveFile(path.join(home, 'sync', 'bodies', bodyFile), bytes);
    ledger.records[canonicalKey(ledger.inboxId, id)] = { ...state, localId: id, bodyFile, contributions: [], suppressed: false, provenance: [] };
    ledger.publicationIntents[canonicalKey(ledger.inboxId, id)] = null;
  }

  ledger.nextOriginVersion = records + 1;
  ledger.generation += 1;
  parseLedger(ledger);
  await files.flushDirectory(path.join(home, 'sync', 'bodies'));
  await files.replaceLedger(path.join(home, 'sync', 'ledger.json'), ledger);
  assert.equal(Object.keys((await store.snapshot()).records).length, records);
  return store;
}

async function until(label, operation, predicate, milliseconds = 30_000) {
  const deadline = performance.now() + milliseconds;
  do {
    const result = await operation();
    if (predicate(result)) return result;
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error(`${label} exceeded preselected ${milliseconds}ms observation bound`);
}

async function main() {
  assert.equal(await fs.readFile(path.join(root, '.issue95-fixture'), 'utf8'), 'disposable scheduler fixture\n');
  assert.ok([0, 1000, 10000].includes(count));
  assert.ok(['none', 'outbound', 'inbound'].includes(direction));
  assert.ok(Number.isSafeInteger(duration) && duration >= 65_000);
  const { canonicalKey, stateFingerprint } = load('sync-model.js');
  const { routeAuthorization } = load('sync-reconciliation.js');
  const { defaultRuntimeConfig } = load('sync-runtime-config.js');
  const source = await seed(path.join(root, 'source'), count);
  const receiver = await seed(path.join(root, 'receiver'), 0);
  const local = direction === 'inbound' ? receiver : source;
  const localHome = path.join(root, direction === 'inbound' ? 'receiver' : 'source');
  const sourceLedger = await source.snapshot();
  const receiverLedger = await receiver.snapshot();
  let peer;
  let route;
  const tlsCleanups = [];

  try {
    if (direction !== 'none') {
      const tls = await load('sync-https-fixtures.js').createSyncHttpsCredentials({ after: close => tlsCleanups.push(close) });
      const token = path.join(root, 'token');
      await fs.writeFile(token, load('sync-wire.js').opaqueToken(), { mode: 0o600 });
      const peerHome = path.join(root, direction === 'inbound' ? 'source' : 'receiver');
      peer = await launch({ role: 'peer', home: peerHome, token, ca: tls.caPath, key: tls.trusted.keyPath, cert: tls.trusted.certPath });
      const ready = await peer.ready;
      ports.push(ready.url);
      route = { id: randomUUID(), revision: 1, direction: 'outbound', peerId: receiverLedger.inboxId, peerUrl: direction === 'outbound' ? ready.url : 'https://127.0.0.1:1',
        sourceInboxId: sourceLedger.inboxId, destinationInboxId: receiverLedger.inboxId, localInboxName: 'fixture', readerAudience: 'disposable scheduler fixture',
        allowedOrigins: [sourceLedger.originKeys[0]], credentialRef: 'token', tlsTrustRef: 'ca', state: 'reconnecting', lastError: null };
      await source.configureRoute(route);
      await receiver.configureRoute({ ...route, direction: 'inbound', peerId: sourceLedger.inboxId, peerUrl: direction === 'inbound' ? ready.url : 'https://127.0.0.1:1' });
      await local.configureRuntime({ ...defaultRuntimeConfig(), credentials: { token }, trust: { ca: tls.caPath } });
    }

    await local.setWorkerEnabled(true);
    const worker = await launch({ role: 'worker', home: localHome });
    const ready = await worker.ready;
    ports.push(ready.record.controlOrigin);
    // The parent tick observes state but does not join its startup pass.
    await until('initial-pass-bookkeeping', () => worker.rpc('status'), value => value.completedPasses >= 1, 70_000);
    emit({ type: 'initial-catch-up-settled', ...(await worker.rpc('settle')) });

    async function assertCaughtUp() {
      const a = await source.snapshot();
      const b = await receiver.snapshot();
      assert.equal(Object.keys(a.records).length, count);
      if (!route) return;

      assert.equal(Object.keys(b.records).length, count);
      assert.equal(a.routes[route.id].state, 'active');
      assert.equal(b.routes[route.id].state, 'active');
      const measured = direction === 'inbound' ? b : a;
      assert.equal(measured.routeRetries[route.id]?.lastError ?? null, null);
      assert.ok(Object.values(measured.outbox).every(entry => entry.disposition === 'confirmed' || entry.disposition === 'retired'));
      const receipts = new Set(Object.values(b.receipts).filter(receipt => receipt.routeId === route.id && receipt.disposition === 'committed').map(receipt => receipt.fingerprint));
      for (const [key, record] of Object.entries(a.records)) {
        const copy = b.records[key];
        assert.ok(copy);
        assert.equal(stateFingerprint(copy), stateFingerprint(record));
        assert.deepEqual(await fs.readFile(path.join(root, 'receiver', 'sync', 'bodies', copy.bodyFile)), bytes);
        assert.ok(receipts.has(stateFingerprint(copy)));
      }
    }

    // A large fixture that cannot really catch up within existing pass/lease limits fails here.
    await assertCaughtUp();
    emit({ type: 'caught-up', count, direction });
    await fs.writeFile(path.join(root, 'setup-complete.json'), JSON.stringify({ count, direction }));

    const roles = [worker, ...(peer ? [peer] : [])];
    for (const child of roles) await child.rpc('sample-start');
    emit({ type: 'idle-start', count, direction, duration });
    await delay(duration);
    const observations = [];
    for (const child of roles) observations.push(await child.rpc('sample-stop'));
    emit({ type: 'idle-stop', count, direction, observations });
    assert.ok(observations[0].elapsedMs >= duration);
    assert.ok(observations[0].completedPasses >= 2, '65sec qualification requires two actual periodic pass completions');
    await worker.rpc('settle');
    await assertCaughtUp();

    async function reaction(label, trigger, predicate) {
      const before = worker.events.length;
      const started = performance.now();
      const at = Date.now();
      for (const child of roles) await child.rpc('sample-start');
      emit({ type: 'reaction-start', label });
      await trigger();
      await until(label, async () => worker.events.slice(before), predicate);
      assert.ok(performance.now() - started <= 30_000, `${label} exceeded the preselected overall reaction observation bound`);
      const resources = [];
      for (const child of roles) resources.push(await child.rpc('sample-stop'));
      emit({ type: 'reaction-stop', label, elapsedMs: performance.now() - started, triggerWall: at, resources });
    }

    await reaction('explicit-wake', () => worker.rpc('wake'), events => events.some(event => event.type === 'pass-finished'));
    for (const [label, wall, monotonic] of [['wall-forward', 5000, 0], ['wall-backward', -10000, 0], ['monotonic-gap', 0, 5000], ['suspend-both', 5000, 5000]]) {
      await reaction(label, () => worker.rpc('clock', { wall, monotonic }), events => events.some(event => event.type === 'worker-event' && event.event === 'gap') && events.some(event => event.type === 'pass-finished'));
    }

    if (route) {
      await worker.rpc('settle');
      const ledger = await local.snapshot();
      const authorization = routeAuthorization(ledger.routes[route.id]);
      let retryDeadline;
      const writer = new (load('sync-store.js').ManagedSyncStore)(localHome, { testHooks: { async onEvent(event) {
        if (event === 'ledger-renamed') {
          // Observation of our own disposable commit, not route authorization.
          const committed = JSON.parse(await fs.readFile(path.join(localHome, 'sync', 'ledger.json'), 'utf8'));
          retryDeadline = committed.routeRetries[route.id].nextAttemptAt;
          emit({ type: 'retry-committed', deadlineAt: retryDeadline });
        }
      } } });
      const requestIndex = worker.events.length;
      await reaction('retry-deadline', () => writer.recordRouteRun(authorization, 'synthetic-transient', false, 0), events => events.some(event => event.type === 'request'));
      const firstRequest = worker.events.slice(requestIndex).find(event => event.type === 'request');
      assert.ok(firstRequest.wall >= retryDeadline, 'no request may bypass durable backoff');
      emit({ type: 'retry-reaction', deadlineAt: retryDeadline, requestAt: firstRequest.wall, latenessMs: firstRequest.wall - retryDeadline });

      async function repair(documentId) {
        await worker.rpc('settle');
        const localBefore = await local.snapshot();
        assert.ok(Object.values(localBefore.outbox).every(entry => entry.disposition !== 'pending'));
        const copy = (await receiver.snapshot()).records[canonicalKey(sourceLedger.inboxId, documentId)];
        const body = path.join(root, 'receiver', 'sync', 'bodies', copy.bodyFile);
        const bodies = path.dirname(body);
        const beforeFiles = new Set(await fs.readdir(bodies));
        for (const child of roles) await child.rpc('sample-start');
        const repairAt = performance.now();
        await fs.rm(body);
        // No wake: only the independent periodic custody pass can discover this loss.
        const repairedFile = await until('empty-outbox-repair', async () => (await fs.readdir(bodies)).find(file => !beforeFiles.has(file)), Boolean, 65_000);
        const repairedLedger = await until('repair-ledger-commit', () => receiver.snapshot(), value =>
          value.records[canonicalKey(sourceLedger.inboxId, documentId)]?.bodyFile === repairedFile,
        Math.max(1, 65_000 - (performance.now() - repairAt)));
        const repaired = repairedLedger.records[canonicalKey(sourceLedger.inboxId, documentId)];
        assert.equal(repaired.bodyFile, repairedFile);
        assert.deepEqual(await fs.readFile(path.join(bodies, repairedFile)), bytes);
        const resources = [];
        for (const child of roles) resources.push(await child.rpc('sample-stop'));
        emit({ type: 'repair-complete', elapsedMs: performance.now() - repairAt, resources });
      }

      if (count) await repair('bench-00000');

      // At capacity, delete an existing original rather than silently lowering the count.
      const documentId = count ? `bench-${String(count - 1).padStart(5, '0')}` : 'external-commit';
      const externalAt = performance.now();
      for (const child of roles) await child.rpc('sample-start');
      if (count) await source.deleteDocument(documentId); else await source.publish(input, documentId);
      const expectedState = count ? 'deleted' : 'live';
      await until('external-commit-custody', async () => {
        const b = await receiver.snapshot();
        const key = canonicalKey(sourceLedger.inboxId, documentId);
        const record = b.records[key];
        if (record?.state !== expectedState) return false;

        const fingerprint = stateFingerprint(record);
        const receipt = Object.values(b.receipts).find(value => value.routeId === route.id && value.revision === route.revision &&
          value.storageIncarnation === b.storageIncarnation && value.fingerprint === fingerprint &&
          value.disposition === (expectedState === 'live' ? 'committed' : 'deleted'));
        if (!receipt) return false;

        if (expectedState === 'live') assert.deepEqual(await fs.readFile(path.join(root, 'receiver', 'sync', 'bodies', record.bodyFile)), bytes);
        if (direction === 'outbound') {
          const a = await source.snapshot();
          return Object.values(a.outbox).some(entry => entry.routeId === route.id && entry.canonicalKey === key &&
            entry.fingerprint === fingerprint && entry.disposition === 'confirmed' && entry.receiverStorageIncarnation === b.storageIncarnation);
        }

        return true;
      }, Boolean, 65_000);
      // Receiver state can precede sender ACK/bookkeeping. Repair must start only
      // after the latest admitted pass finishes, so it tests independent repair.
      await until('external-pass-finished', async () => {
        let admitted = -1;
        let finished = -1;
        for (const [index, event] of worker.events.entries()) {
          if (event.type === 'worker-event' && event.event === 'pass') admitted = index;
          if (event.type === 'pass-finished') finished = index;
        }

        return finished > admitted;
      }, Boolean, Math.max(1, 65_000 - (performance.now() - externalAt)));
      const resources = [];
      for (const child of roles) resources.push(await child.rpc('sample-stop'));
      emit({ type: 'external-commit-custody', elapsedMs: performance.now() - externalAt, state: expectedState, resources });
      if (!count) await repair(documentId);

      await local.revokeRoute(route.id, route.revision);
      const requestsBeforeFence = (await worker.rpc('status')).requests;
      await worker.rpc('run', { ticketId: randomUUID(), routeIds: [route.id], deadlineAt: Date.now() + 30_000, requestMs: 5000 });
      await worker.rpc('settle');
      assert.equal((await worker.rpc('status')).requests, requestsBeforeFence);
      emit({ type: 'stale-route-rejected' });
    }

    await worker.rpc('hold-next-read');
    const holdIndex = worker.events.length;
    await worker.rpc('wake');
    await until('pending-read-entry', async () => worker.events.slice(holdIndex), events => events.some(event => event.type === 'read-held'));
    const stopping = worker.rpc('stop');
    await until('shutdown-start', async () => worker.events.slice(holdIndex), events => events.some(event => event.type === 'stopping'));
    assert.ok(await fs.lstat(path.join(localHome, 'sync', 'worker', 'lifetime.lock')));
    assert.ok(await fs.lstat(path.join(localHome, 'sync', 'worker', 'runtime.json')));
    await worker.rpc('release-read');
    emit({ type: 'shutdown-resources', ...(await stopping) });
    worker.stopped = true;
    assert.deepEqual(await worker.exit, { code: 0, signal: null });
    emit({ type: 'pending-read-shutdown-joined' });
  } finally {
    const failures = [];
    for (const child of children.reverse()) {
      try {
        if (!child.stopped && child.child.exitCode === null && child.child.signalCode === null) await child.rpc('stop');
        assert.deepEqual(await child.exit, { code: 0, signal: null });
      } catch (error) {
        failures.push(String(error));
        child.child.kill('SIGKILL');
        await child.exit;
      }
    }

    for (const port of ports) {
      try { await rebind(port); } catch (error) { failures.push(String(error)); }
    }
    for (const close of tlsCleanups.reverse()) {
      try { await close(); } catch (error) { failures.push(String(error)); }
    }
    emit({ type: 'cleanup', exactPorts: ports, childrenReaped: children.length, failures });
    if (failures.length) throw new AggregateError(failures, 'Scheduler fixture cleanup failed');
  }
}

main().catch(error => { emit({ type: 'workload-failed', error: String(error.stack ?? error) }); process.exitCode = 1; });
