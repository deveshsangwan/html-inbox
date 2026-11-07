import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import platformTest, { type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import * as lifecycle from "./sync-lifecycle";
import { SYNC_HISTORY_UNAVAILABLE, type SyncRoute } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { routeAuthorization } from "./sync-reconciliation";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { readWorkerRecordOffline, workerPaths } from "./sync-worker-records";
import { nextWorkerRetryAt } from "./sync-worker-schedule";
import { temporaryHome } from "./test-fixtures";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function fixture(t: TestContext, temporary = false) {
  const home = await realpath(await temporaryHome(t));
  const store = new ManagedSyncStore(home);
  await store.enroll();
  await store.setWorkerEnabled(true);
  const clock = { wall: Date.now(), monotonic: 0 };
  t.mock.method(Date, "now", () => clock.wall);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events: string[] = [];
  const releases: (() => void)[] = [];
  const worker = await startOwnedSyncWorker(home, { temporary, testHooks: {
    wallNow: () => clock.wall, monotonicNow: () => clock.monotonic, onEvent: (event) => { events.push(event.type); },
  } });
  t.after(async () => {
    for (const release of releases) release();
    await worker.close();
    await assertLoopbackClosed(worker.record.controlOrigin);
    assert.equal(await readWorkerRecordOffline(home), null);
  });
  await worker.tick();

  async function advance(milliseconds: number) {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) {
      clock.wall += 250;
      clock.monotonic += 250;
      await worker.tick();
    }
  }

  async function route() {
    const ledger = await store.snapshot();
    const destination = randomUUID();
    const value: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: destination,
      peerUrl: "https://127.0.0.1:1", sourceInboxId: ledger.inboxId, destinationInboxId: destination,
      localInboxName: "scheduler", readerAudience: "synthetic", allowedOrigins: [ledger.originKeys[0]],
      credentialRef: "missing", tlsTrustRef: "missing", state: "reconnecting", lastError: null };
    return store.configureRoute(value);
  }

  function hold() {
    const held = gate();
    releases.push(held.release);
    return held;
  }

  return { home, store, worker, clock, events, advance, route, hold, passes: () => events.filter((event) => event === "pass").length };
}

test("idle clock observations avoid snapshots and empty outboxes retain periodic passes", async (t) => {
  const f = await fixture(t);
  const snapshot = ManagedSyncStore.prototype.snapshot;
  let reads = 0;
  t.mock.method(ManagedSyncStore.prototype, "snapshot", function(this: ManagedSyncStore) {
    reads += 1;
    return snapshot.call(this);
  });
  const initialPasses = f.passes();
  await f.advance(4750);
  assert.equal(reads, 0);
  await f.advance(250);
  assert.equal(reads, 1, "external-change fallback reads validated state at five seconds");
  assert.equal(f.passes(), initialPasses);
  await f.advance(25_000);
  assert.equal(f.passes(), initialPasses + 1, "periodic reconciliation is independent of outbox contents");
});

test("slow ticks share one read and coalesce pending wakes into one pass", async (t) => {
  const f = await fixture(t);
  await f.advance(4750);
  const entered = gate();
  const held = f.hold();
  const snapshot = ManagedSyncStore.prototype.snapshot;
  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  t.mock.method(ManagedSyncStore.prototype, "snapshot", async function(this: ManagedSyncStore) {
    reads += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (reads === 1) {
        entered.release();
        await held.promise;
      }

      return await snapshot.call(this);
    } finally {
      active -= 1;
    }
  });
  f.clock.wall += 250;
  f.clock.monotonic += 250;
  const first = f.worker.tick();
  await entered.promise;
  const before = f.passes();
  const ticks = Array.from({ length: 30 }, () => f.worker.tick());
  assert.ok(ticks.every((tick) => tick === first));
  for (let wake = 0; wake < 30; wake += 1) f.worker.requestWake();
  await turn();
  assert.equal(reads, 1);
  assert.equal(f.passes(), before);
  held.release();
  await Promise.all([first, ...ticks]);
  assert.equal(maximumActive, 1);
  assert.equal(f.passes(), before + 1);
});

test("wakes during pass admission retain exactly one follow-up pass", async (t) => {
  const f = await fixture(t);
  const held = f.hold();
  const entered = gate();
  const check = lifecycle.assertManagedLifecycle;
  let admissions = 0;
  t.mock.method(lifecycle, "assertManagedLifecycle", async (home: string) => {
    admissions += 1;
    if (admissions === 1) {
      entered.release();
      await held.promise;
    }

    return check(home);
  });
  const before = f.passes();
  f.worker.requestWake();
  await entered.promise;
  for (let wake = 0; wake < 30; wake += 1) f.worker.requestWake();
  const pending = f.worker.tick();
  held.release();
  await pending;
  assert.equal(f.passes(), before + 2);
  assert.equal(admissions, 2);
});

test("shutdown joins a pending observation and refuses all later admission", async (t) => {
  const f = await fixture(t);
  await f.advance(4750);
  const entered = gate();
  const held = f.hold();
  const snapshot = ManagedSyncStore.prototype.snapshot;
  let reads = 0;
  t.mock.method(ManagedSyncStore.prototype, "snapshot", async function(this: ManagedSyncStore) {
    const cut = await snapshot.call(this);
    reads += 1;
    if (reads === 1) {
      entered.release();
      await held.promise;
    }

    return cut;
  });
  f.clock.wall += 250;
  f.clock.monotonic += 250;
  const observation = f.worker.tick();
  await entered.promise;
  const passes = f.passes();
  const closing = f.worker.close();
  assert.equal(f.worker.close(), closing);
  f.worker.requestWake();
  assert.throws(() => f.worker.requestRun({ ticketId: randomUUID(), deadlineAt: Date.now() + 1000, requestMs: 100 }), /stopping/);
  await f.worker.tick();
  assert.ok(await lstat(workerPaths(f.home).lifetime));
  assert.ok(await readWorkerRecordOffline(f.home));
  assert.equal(f.events.includes("closed"), false);
  held.release();
  await Promise.all([observation, closing]);
  assert.equal(f.passes(), passes);
  assert.equal(reads, 1);
  assert.equal(f.events.filter((event) => event === "closed").length, 1);
});

test("cancellation and ticket expiry during pending admission cannot start a pass", async (t) => {
  const f = await fixture(t, true);
  const held = f.hold();
  const entered = gate();
  const check = lifecycle.assertManagedLifecycle;
  t.mock.method(lifecycle, "assertManagedLifecycle", async (home: string) => {
    entered.release();
    await held.promise;
    return check(home);
  });
  const cancelled = randomUUID();
  const expired = randomUUID();
  f.worker.requestRun({ ticketId: cancelled, deadlineAt: Date.now() + 1000, requestMs: 100 });
  await entered.promise;
  f.worker.requestRun({ ticketId: expired, deadlineAt: Date.now() + 1000, requestMs: 100 });
  f.worker.cancel(cancelled);
  f.clock.wall += 2000;
  const pending = f.worker.tick();
  held.release();
  await pending;
  assert.equal(f.passes(), 0);
  assert.equal(f.worker.status().tickets.find((ticket) => ticket.ticketId === cancelled)?.state, "cancelled");
  assert.equal(f.worker.status().tickets.find((ticket) => ticket.ticketId === expired)?.state, "complete");
});

test("external retry state is discovered at fallback and known retry deadlines wake sooner", async (t) => {
  const f = await fixture(t);
  const route = await f.route();
  // Another store instance commits without using the worker wake/control path.
  const writer = new ManagedSyncStore(f.home);
  await writer.recordRouteRun(routeAuthorization(route), "temporary failure", false, 0);
  const before = f.passes();
  await f.advance(4750);
  assert.equal(f.passes(), before);
  await f.advance(250);
  assert.equal(f.passes(), before + 1);
  assert.equal((await writer.snapshot()).routeRetries[route.id].lastError, "runtime-credential-unavailable");

  await writer.retry(routeAuthorization(route));
  await writer.recordRouteRun(routeAuthorization(route), "temporary failure", false, 0);
  f.worker.requestWake();
  await f.worker.tick();
  const waiting = f.passes();
  await f.advance(250);
  assert.equal(f.passes(), waiting);
  await f.advance(250);
  assert.equal(f.passes(), waiting + 1, "the known 500ms retry does not wait for fallback refresh");
});

test("route removal during queued admission prevents stale route work", async (t) => {
  const f = await fixture(t, true);
  const route = await f.route();
  const held = f.hold();
  const entered = gate();
  const check = lifecycle.assertManagedLifecycle;
  t.mock.method(lifecycle, "assertManagedLifecycle", async (home: string) => {
    const stale = await check(home);
    entered.release();
    await held.promise;
    return stale;
  });
  f.worker.requestRun({ ticketId: randomUUID(), routeIds: [route.id], deadlineAt: Date.now() + 1000, requestMs: 100 });
  await entered.promise;
  await new ManagedSyncStore(f.home).revokeRoute(route.id, route.revision);
  const pending = f.worker.tick();
  held.release();
  await pending;
  const ledger = await f.store.snapshot();
  assert.equal(ledger.routes[route.id].state, "detached");
  assert.equal(ledger.routeRetries[route.id], undefined, "even unavailable-credential bookkeeping must not admit a stale route");
  assert.deepEqual(f.worker.status().tickets[0].routes, []);
});

for (const event of ["wall-forward", "wall-backward", "monotonic-gap", "suspend-both"] as const) {
  test(`${event} coalesces catch-up on the first observation`, async (t) => {
    const f = await fixture(t);
    const before = f.passes();
    f.clock.wall += event === "wall-backward" ? -5000 : event === "monotonic-gap" ? 0 : 5000;
    f.clock.monotonic += event === "wall-forward" || event === "wall-backward" ? 0 : 5000;
    await f.worker.tick();
    assert.equal(f.passes(), before + 1);
    assert.equal(f.events.filter((entry) => entry === "gap").length, 1);
    await f.worker.tick();
    assert.equal(f.passes(), before + 1);
  });
}

test("retry hints preserve route backoff, blocked revisions and terminal history bypass", async (t) => {
  const f = await fixture(t, true);
  const route = await f.route();
  await f.store.publish({ originalBytes: Buffer.from("<!doctype html><title>Schedule</title>"), title: "Schedule", type: "report", sourceFileName: "schedule.html" }, "schedule");
  const ledger = await f.store.snapshot();
  const entry = Object.values(ledger.outbox)[0];
  assert.ok(entry);
  ledger.routeRetries[route.id] = { revision: route.revision, attempts: 1, nextAttemptAt: 4000, lastError: "temporary", blocked: false };
  entry.nextAttemptAt = 1000;
  assert.equal(nextWorkerRetryAt(ledger), 4000);
  ledger.routeRetries[route.id].lastError = SYNC_HISTORY_UNAVAILABLE;
  assert.equal(nextWorkerRetryAt(ledger), 4000, "live work cannot bypass a history wait");
  ledger.records[entry.canonicalKey].state = "deleted";
  assert.equal(nextWorkerRetryAt(ledger), 1000);
  ledger.routeRetries[route.id].blocked = true;
  assert.equal(nextWorkerRetryAt(ledger), Infinity);
  ledger.routeRetries[route.id].blocked = false;
  ledger.routeRetries[route.id].nextAttemptAt = 0;
  entry.revision += 1;
  assert.equal(nextWorkerRetryAt(ledger), Infinity);
  entry.revision = route.revision;
  entry.disposition = "confirmed";
  assert.equal(nextWorkerRetryAt(ledger), Infinity, "healthy caught-up routes wait for periodic repair");
  delete ledger.routeRetries[route.id];
  assert.equal(nextWorkerRetryAt(ledger), 0, "new external routes need an initial pass without an outbox");
  ledger.routes[route.id].state = "detached";
  assert.equal(nextWorkerRetryAt(ledger), Infinity);
});
