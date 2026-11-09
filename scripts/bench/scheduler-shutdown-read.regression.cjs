// Source-only diagnostic proposal. Execution needs a separate root slot grant.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const { setImmediate: turn } = require('node:timers/promises');

const dist = process.env.ISSUE95_DIAG_DIST;
const revision = process.env.ISSUE95_DIAG_REVISION;
assert.ok(dist && path.isAbsolute(dist), 'Pass the separately archived build directory');
assert.ok(['610c931b7b22920cce59cf03e49c0de15ebaf2a2', '9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f'].includes(revision));
assert.ok(['v20.20.2', 'v24.19.0'].includes(process.version));
const { ManagedSyncStore } = require(path.join(dist, 'sync-store.js'));
const { startOwnedSyncWorker } = require(path.join(dist, 'sync-worker.js'));
const { readWorkerRecordOffline, workerPaths } = require(path.join(dist, 'sync-worker-records.js'));

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function until(label, predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `${label} did not reach its diagnostic barrier`);
    await turn();
  }
}

async function present(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function rebind(origin) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

for (const mode of ['timer-observation', 'foreground-lifecycle', 'external-observer']) {
  test(`${mode} retains the identity of the held read and shutdown outcome`, { timeout: 30_000 }, async t => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'html-inbox-shutdown-read-')));
    const entered = gate();
    const held = gate();
    const events = [];
    const reads = [];
    const active = new Set();
    const operations = [];
    const clock = { wall: Date.now(), monotonic: 0 };
    let worker;
    let armed = false;
    let selected;
    let closed = false;
    let closeError;
    let closing;
    let nextRead = 0;
    const started = performance.now();
    const stamp = () => ({ elapsedMs: performance.now() - started, wall: clock.wall, monotonic: clock.monotonic });
    t.after(async () => {
      held.release();
      const failures = [];
      const settle = await Promise.allSettled([...operations, ...(worker ? [worker.close()] : [])]);
      for (const result of settle) if (result.status === 'rejected') failures.push(String(result.reason));
      if (worker) {
        try { await rebind(worker.record.controlOrigin); } catch (error) { failures.push(String(error)); }
        try { assert.equal(await readWorkerRecordOffline(home), null); } catch (error) { failures.push(String(error)); }
      }
      t.diagnostic(JSON.stringify({ revision, runtime: process.version, mode, cleanupFailures: failures,
        activeReads: [...active], controlOrigin: worker?.record.controlOrigin, home }));
      if (failures.length || active.size) throw new AggregateError(failures, 'Diagnostic fixture retained after incomplete joining');
      await fs.rm(home, { recursive: true, force: true });
    });

    const observer = new ManagedSyncStore(home);
    await observer.enroll();
    await observer.setWorkerEnabled(true);
    t.mock.timers.enable({ apis: ['setInterval'] });

    const snapshot = ManagedSyncStore.prototype.snapshot;
    t.mock.method(ManagedSyncStore.prototype, 'snapshot', function(...args) {
      const id = ++nextRead;
      const read = { id, ...stamp(), externalObserver: this === observer,
        caller: armed ? new Error('issue95-held-read-caller').stack : null };
      reads.push(read);
      active.add(id);
      const isSelected = armed;
      if (isSelected) { armed = false; selected = read; }

      const operation = (async () => {
        try {
          if (isSelected) { entered.release(); await held.promise; }
          return await snapshot.apply(this, args);
        } finally {
          read.finished = stamp();
          active.delete(id);
        }
      })();
      operations.push(operation);
      return operation;
    });

    worker = await startOwnedSyncWorker(home, { testHooks: {
      wallNow: () => clock.wall, monotonicNow: () => clock.monotonic,
      onEvent: event => { events.push({ event: event.type, ...stamp() }); },
    } });
    const barrier = randomUUID();
    worker.requestRun({ ticketId: barrier, deadlineAt: Date.now() + 10_000, requestMs: 5000 });
    await until('initial foreground ticket completion', () => worker.status().tickets.some(ticket => ticket.ticketId === barrier && ticket.state === 'complete'));
    await turn();
    await until('no outstanding snapshot', () => active.size === 0);
    await turn();

    if (mode === 'timer-observation') {
      for (let elapsed = 0; elapsed < 4750; elapsed += 250) {
        clock.wall += 250;
        clock.monotonic += 250;
        t.mock.timers.tick(250);
        await worker.tick();
        await until('ordinary tick snapshots finish', () => active.size === 0);
      }
    }
    const before = { reads: reads.length, events: events.length, status: worker.status(), ...stamp() };
    assert.equal(active.size, 0);
    armed = true;
    if (mode === 'timer-observation') {
      clock.wall += 250;
      clock.monotonic += 250;
      // Invoke the real interval callback once, through the existing timer seam.
      t.mock.timers.tick(250);
    } else if (mode === 'foreground-lifecycle') {
      worker.requestRun({ ticketId: randomUUID(), deadlineAt: Date.now() + 10_000, requestMs: 5000 });
    } else {
      const reading = observer.snapshot();
      operations.push(reading);
    }
    await entered.promise;
    assert.ok(selected.caller, 'A caller stack is mandatory; event names alone cannot classify this read');
    assert.equal(selected.externalObserver, mode === 'external-observer');
    if (mode === 'timer-observation') {
      assert.match(selected.caller, /tick|observeSchedule|refreshSchedule/, 'The actual observation caller must be identified');
      assert.doesNotMatch(selected.caller, /assertManagedLifecycle/, 'A lifecycle read is a different diagnostic case');
    } else if (mode === 'foreground-lifecycle') {
      assert.match(selected.caller, /assertManagedLifecycle/, 'The actual admission caller must be identified');
    }

    closing = worker.close();
    const closeOutcome = closing.then(() => { closed = true; }, error => { closeError = error; });
    operations.push(closeOutcome);
    let windowTimer;
    const window = await Promise.race([closeOutcome.then(() => 'settled'),
      new Promise(resolve => { windowTimer = setTimeout(() => resolve('pending'), 1000); })]);
    clearTimeout(windowTimer);
    const ownership = { lifetime: await present(workerPaths(home).lifetime), record: await readWorkerRecordOffline(home) };
    const duringHold = { window, closed, closeError: closeError && String(closeError), ownership,
      selectedReadStillActive: active.has(selected.id), ...stamp() };
    t.diagnostic(JSON.stringify({ revision, runtime: process.version, mode, phase: 'held', before, selected, duringHold, events }));
    selected.released = stamp();
    held.release();
    await Promise.allSettled([...operations]);
    await closing;
    await turn();
    t.diagnostic(JSON.stringify({ revision, runtime: process.version, mode, phase: 'joined', selected, events,
      subsequentReads: reads.filter(read => read.id > selected.id), finalActiveReads: [...active] }));

    assert.equal(events.filter(event => event.event === 'gap').length, 0);
    assert.equal(active.size, 0);
    assert.equal(duringHold.selectedReadStillActive, true);
    if (mode === 'external-observer') {
      assert.equal(duringHold.closed, true, 'An independent observer does not own worker lifetime');
      assert.equal(duringHold.ownership.lifetime, false);
      assert.equal(duringHold.ownership.record, null);
    } else {
      assert.equal(duringHold.closed, false, 'Worker-owned pending read must retain lifetime until release');
      assert.equal(duringHold.ownership.lifetime, true);
      assert.ok(duringHold.ownership.record);
    }
    assert.equal(await readWorkerRecordOffline(home), null);
  });
}
