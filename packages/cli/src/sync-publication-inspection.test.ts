import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createInbox } from "./inbox-catalog";
import { acquireSyncOwnership } from "./sync-files";
import { canonicalKey, parseArray, parseObject } from "./sync-model";
import { outboxKey } from "./sync-ledger";
import { routeAuthorization } from "./sync-reconciliation";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import * as runtimeConfig from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { publishManagedDocument } from "./sync-publication";
import * as workerClient from "./sync-worker-client";
import * as viewerServer from "./viewer-server";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { assertLoopbackClosed, startSyncApplication } from "./sync-protocol-fixture";
import { startProtocolFaultChild } from "./sync-protocol-fault-child";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const bytes = Buffer.from("<!doctype html><html><body>durable inspection report</body></html>");
type InspectionState = "paused" | "disabled" | "permanent-route" | "permanent-retry" | "permanent-item" | "enabled";

async function inspectionFixture(t: TestContext, state: InspectionState) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "html-inbox-publication-inspection-"));
  await fs.chmod(root, 0o700);
  const cleanup: (() => Promise<unknown>)[] = [];
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const ports: string[] = [];
  const sentinel = path.join(root, "sentinel");
  await fs.writeFile(sentinel, "untouched synthetic sentinel", { mode: 0o600 });
  t.after(async () => {
    t.mock.restoreAll();
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    const leaked = handles.filter((file) => file.fd !== -1);
    // Failed assertions still dispose only this fixture's captured descriptors.
    for (const file of leaked) await file.close();
    for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
    for (const port of ports) await assertLoopbackClosed(port);
    assert.equal(await fs.readFile(sentinel, "utf8"), "untouched synthetic sentinel");
    await fs.rm(root, { recursive: true });
    await assert.rejects(fs.lstat(root), { code: "ENOENT" });
    t.diagnostic(JSON.stringify({ pid: process.pid, ports, capturedHandles: handles.length, leakedBeforeTeardown: leaked.length, removedRoot: root }));
    assert.equal(leaked.length, 0, "native FD closure must precede fixture teardown");
    if (failures.length) throw new AggregateError(failures, "Inspection fixture cleanup failed");
  });
  const context: Pick<TestContext, "after" | "diagnostic"> = { after(close) {
    if (close) cleanup.push(async () => { await close(t, () => {}); });
  }, diagnostic(message) { t.diagnostic(message); } };
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (String(args[0]).startsWith(root + path.sep)) handles.push(file);
    return file;
  });
  const entry = await createInbox("source", path.join(root, "source"), path.join(root, "catalog"));
  const store = new ManagedSyncStore(entry.home);
  await store.enroll();
  const peerId = randomUUID();
  await store.configureRuntime({ ...defaultRuntimeConfig(), intendedTarget: { peerId, destinationInboxId: peerId } });
  const ledger = await store.snapshot();
  const route = await store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId, peerUrl: "https://127.0.0.1:1",
    sourceInboxId: entry.instanceId, destinationInboxId: peerId, localInboxName: entry.name, readerAudience: "synthetic", allowedOrigins: ledger.originKeys,
    credentialRef: "missing", tlsTrustRef: "missing", state: "reconnecting", lastError: null });
  const auth = routeAuthorization(route);
  await store.setRouteError(auth, state === "permanent-route" ? "unauthorized" : "verified-transport-failed");
  if (state !== "permanent-route") await store.recordRouteRun(auth, "verified-transport-failed", state === "permanent-retry");
  await store.setWorkerEnabled(state === "paused" || state === "permanent-route" || state === "permanent-retry" || state === "enabled");
  await store.setRetryPaused(state === "paused");
  const filePath = path.join(root, "report.html");
  await fs.writeFile(filePath, bytes, { mode: 0o600 });
  const calls = { publications: 0, lookups: 0, holds: 0, deadlines: 0, starts: 0, contacts: 0, network: 0, credentials: 0, spawns: 0 };
  let publication: Awaited<ReturnType<ManagedSyncStore["publishWithIntent"]>> | undefined;
  let saved: Awaited<ReturnType<ManagedSyncStore["snapshot"]>> | undefined;
  let overallDeadline = 0;
  const statuses: Awaited<ReturnType<ManagedSyncStore["deliveryStatus"]>>[] = [];

  function observe(waitMs?: number) {
    const publish = ManagedSyncStore.prototype.publishWithIntent;
    t.mock.method(ManagedSyncStore.prototype, "publishWithIntent", async function(this: ManagedSyncStore, ...args: Parameters<typeof publish>) {
      const result = await publish.apply(this, args);
      publication = result;
      calls.publications += 1;
      overallDeadline = result.committedAt + (waitMs ?? result.timings.foregroundMs);
      if (state === "permanent-item") {
        await store.updateAttempt(auth, canonicalKey(result.origin.originInboxId, result.origin.originDocumentId), { nextAttemptAt: 0, lastError: "invalid-bytes", blocked: true });
      }
      saved = await store.snapshot();
      return result;
    });
    t.mock.method(viewerServer, "ensureViewer", async (...[_home, _port, _name, options]: Parameters<typeof viewerServer.ensureViewer>) => {
      assert.equal(options?.deadlineAt, overallDeadline);
      throw new Error("Synthetic viewer unavailable");
    });
    t.mock.method(workerClient, "ensureOwnedSyncWorker", async () => { calls.starts += 1; throw new Error("Unexpected worker startup"); });
    t.mock.method(workerClient, "contactWorker", async () => { calls.contacts += 1; throw new Error("Unexpected worker control"); });
    t.mock.method(runtimeConfig, "resolveRuntimeCredentials", async () => { calls.credentials += 1; throw new Error("Unexpected credential resolution"); });
    t.mock.method(https, "request", () => { calls.network += 1; throw new Error("Unexpected HTTPS request"); });
    t.mock.method(http, "request", () => { calls.network += 1; throw new Error("Unexpected HTTP request"); });
    t.mock.method(https, "createServer", () => { calls.network += 1; throw new Error("Unexpected HTTPS listener"); });
    t.mock.method(http, "createServer", () => { calls.network += 1; throw new Error("Unexpected HTTP listener"); });
    t.mock.method(childProcess, "spawn", () => { calls.spawns += 1; throw new Error("Unexpected child startup"); });
  }

  async function holdLookup<T>(operation: () => Promise<T>, expires = false): Promise<T> {
    calls.holds += 1;
    const lock = await acquireSyncOwnership(path.join(entry.home, "sync", "mutation.lock"), Date.now() + 1000);
    try {
      return await operation();
    } catch (error) {
      calls.deadlines += 1;
      assert.ok(error instanceof Error);
      assert.match(error.message, /lock deadline/);
      if (!expires) assert.ok(overallDeadline - Date.now() > 25_000, "short lookup expiry cannot stand in for overall expiry");
      throw error;
    } finally {
      if (expires) await delay(Math.max(1, overallDeadline - Date.now() + 1));
      await lock.release();
    }
  }

  function inspectAt(sequence: number, expires = false) {
    const lookup = ManagedSyncStore.prototype.deliveryStatus;
    t.mock.method(ManagedSyncStore.prototype, "deliveryStatus", async function(this: ManagedSyncStore, ...args: Parameters<typeof lookup>) {
      calls.lookups += 1;
      const bound = args[3];
      assert.ok(bound);
      assert.ok(bound - Date.now() <= 200);
      const read = async () => {
        const result = await lookup.apply(this, args);
        statuses.push(result);
        return result;
      };
      return calls.lookups === sequence ? holdLookup(read, expires) : read();
    });
  }

  async function publish(waitMs?: number) {
    return publishManagedDocument({ filePath, title: "Inspection", type: "report", ...(waitMs === undefined ? {} : { waitMs }) },
      { home: entry.home, name: entry.name, instanceId: entry.instanceId, source: "explicit" });
  }

  async function assertSaved() {
    assert.ok(publication);
    assert.ok(saved);
    assert.equal(publication.timings.foregroundMs, 30_000);
    assert.equal(calls.publications, 1);
    const current = await store.snapshot();
    assert.deepEqual(current.worker, saved.worker);
    assert.deepEqual(current.runtime, saved.runtime);
    assert.deepEqual(current.routes, saved.routes);
    assert.deepEqual(current.routeRetries, saved.routeRetries);
    assert.deepEqual(current.outbox, saved.outbox);
    assert.equal(Object.keys(current.records).length, 1);
    assert.equal(Object.keys(current.receipts).length, 0);
    assert.equal(Object.keys(current.historyCheckpoints).length, 0);
    assert.deepEqual((await store.getDocument(publication.metadata.id))?.originalBytes, bytes);
    assert.ok(Object.values(current.outbox).every((item) => item.disposition !== "retired"));
    assert.equal(calls.starts + calls.contacts + calls.network + calls.credentials + calls.spawns, 0);
  }

  return { root, entry, store, route, auth, context, cleanup, ports, observe, calls, statuses, holdLookup, inspectAt, publish, assertSaved,
    get publication() { return publication; }, get saved() { return saved; }, get overallDeadline() { return overallDeadline; } };
}

for (const state of ["paused", "disabled", "permanent-route", "permanent-retry", "permanent-item"] as const) {
  for (const sequence of [1, 2]) {
    test(`real ${sequence === 1 ? "first" : "final"} custody lookup deadline retains ${state} diagnosis`, { timeout: 5000 }, async (t) => {
      const f = await inspectionFixture(t, state);
      f.observe();
      f.inspectAt(sequence);
      const result = await f.publish();
      await f.assertSaved();
      assert.equal(f.calls.holds, 1);
      assert.equal(f.calls.deadlines, 1);
      assert.equal(f.calls.lookups, 2, "unconfirmed final inspection still executes");
      assert.ok(f.overallDeadline - Date.now() > 25_000);
      assert.equal(result.result.delivery.receipt, null);
      assert.deepEqual(result.result.local, { durable: true, queued: true });
      const blocked = state.startsWith("permanent");
      assert.equal(result.exitCode, blocked ? 3 : 2);
      assert.equal(result.result.delivery.state, blocked ? "blocked" : "pending");
      assert.equal(result.result.delivery.reason, state === "paused" ? "retries-paused" : state === "disabled" ? "worker-disabled" :
        state === "permanent-item" ? "invalid-bytes" : "Trusted terminal history is required");
      t.diagnostic(JSON.stringify({ state, sequence, calls: f.calls, remaining: f.overallDeadline - Date.now() }));
    });
  }
}

test("enabled worker startup rejection and final custody timeout retain inspection unavailability", { timeout: 5000 }, async (t) => {
  const f = await inspectionFixture(t, "enabled");
  f.observe();
  t.mock.method(workerClient, "ensureOwnedSyncWorker", async () => {
    f.calls.starts += 1;
    throw new Error("Controlled worker startup rejection before ticket dispatch");
  });
  f.inspectAt(2);

  const result = await f.publish();
  assert.ok(f.publication);
  assert.ok(f.saved);
  assert.equal(f.publication.timings.foregroundMs, 30_000);
  assert.equal(f.calls.publications, 1);
  assert.equal(f.calls.starts, 1);
  assert.equal(f.calls.lookups, 2);
  assert.equal(f.calls.holds, 1);
  assert.equal(f.calls.deadlines, 1);
  assert.equal(f.statuses.length, 1);
  assert.equal(f.statuses[0].isCommitted, false);
  assert.ok(f.overallDeadline - Date.now() > 25_000);
  assert.equal(f.calls.contacts + f.calls.network + f.calls.credentials + f.calls.spawns, 0);

  const current = await f.store.snapshot();
  assert.equal(current.worker.enabled, true);
  assert.equal(current.worker.retryPaused, false);
  assert.deepEqual(current.worker, f.saved.worker);
  assert.deepEqual(current.runtime, f.saved.runtime);
  assert.deepEqual(current.routes, f.saved.routes);
  assert.deepEqual(current.routeRetries, f.saved.routeRetries);
  assert.deepEqual(current.outbox, f.saved.outbox);
  assert.equal(Object.keys(current.records).length, 1);
  assert.equal(Object.keys(current.receipts).length, 0);
  assert.equal(Object.keys(current.historyCheckpoints).length, 0);
  assert.deepEqual((await f.store.getDocument(f.publication.metadata.id))?.originalBytes, bytes);
  assert.ok(Object.values(current.outbox).every((item) => item.disposition !== "retired" && item.attempts === 0));
  assert.deepEqual(result.result.local, { durable: true, queued: true });
  assert.equal(result.result.delivery.receipt, null);
  assert.equal(result.result.delivery.retriesEnabled, true);
  assert.equal(result.result.delivery.cancelled, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.delivery.state, "pending");
  t.diagnostic(JSON.stringify({ calls: f.calls, remaining: f.overallDeadline - Date.now(), delivery: result.result.delivery, durableStateUnchanged: true }));
  assert.equal(result.result.delivery.reason, "delivery-inspection-unavailable");
});

for (const authorized of [false, true]) {
  test(`a ${authorized ? "current eligible" : "scope-excluded"} second route preserves intended-target precedence after an unavailable lookup`, { timeout: 5000 }, async (t) => {
    const f = await inspectionFixture(t, "disabled");
    await f.store.setRouteError(f.auth, "unauthorized");
    await f.store.configureRoute({ ...f.route, id: randomUUID(), allowedOrigins: authorized ? f.route.allowedOrigins : [] });
    f.observe();
    const perRoute = new Map<string, number>();
    const lookup = ManagedSyncStore.prototype.deliveryStatus;
    t.mock.method(ManagedSyncStore.prototype, "deliveryStatus", async function(this: ManagedSyncStore, ...args: Parameters<typeof lookup>) {
      f.calls.lookups += 1;
      const count = (perRoute.get(args[0]) ?? 0) + 1;
      perRoute.set(args[0], count);
      return args[0] === f.route.id && count === 2 ? f.holdLookup(() => lookup.apply(this, args)) : lookup.apply(this, args);
    });
    const result = await f.publish();
    await f.assertSaved();
    assert.equal(f.calls.holds, 1);
    assert.equal(f.calls.deadlines, 1);
    assert.equal(result.exitCode, authorized ? 2 : 3);
    assert.equal(result.result.delivery.state, authorized ? "pending" : "blocked");
    assert.equal(result.result.delivery.reason, authorized ? "worker-disabled" : "Trusted terminal history is required");
    assert.equal(result.result.delivery.receipt, null);
    assert.equal(perRoute.size, authorized ? 2 : 1);
  });
}

for (const sequence of [1, 2]) {
  test(`nondeadline custody inspection error at lookup ${sequence} preserves original failure identity`, { timeout: 5000 }, async (t) => {
    const f = await inspectionFixture(t, "paused");
    f.observe();
    const failure = Object.assign(new Error("Controlled custody inspection EIO"), { code: "EIO" });
    const lookup = ManagedSyncStore.prototype.deliveryStatus;
    t.mock.method(ManagedSyncStore.prototype, "deliveryStatus", async function(this: ManagedSyncStore, ...args: Parameters<typeof lookup>) {
      f.calls.lookups += 1;
      if (f.calls.lookups === sequence) throw failure;
      return lookup.apply(this, args);
    });
    await assert.rejects(f.publish(), (error: unknown) => error === failure);
    await f.assertSaved();
  });
}

test("actual overall expiry remains finite pending with no custody or worker startup", { timeout: 5000 }, async (t) => {
  const f = await inspectionFixture(t, "enabled");
  f.observe(100);
  f.inspectAt(1, true);
  const result = await f.publish(100);
  await f.assertSaved();
  assert.equal(f.calls.holds, 1);
  assert.equal(f.calls.deadlines, 1);
  assert.ok(Date.now() >= f.overallDeadline);
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.delivery.state, "pending");
  assert.equal(result.result.delivery.reason, "foreground-deadline");
  assert.equal(result.result.delivery.receipt, null);
});

for (const outcome of ["unavailable", "confirmed", "suppressed"] as const) {
  const finalAvailable = outcome === "confirmed";
  test(`real intended custody on a second authorized route ${finalAvailable ? "confirms at final validation" : outcome === "suppressed" ? "retains an acknowledged suppression after lookup timeout" : "cannot be inferred from metadata after a final timeout"}`, { timeout: 5000 }, async (t) => {
    const f = await inspectionFixture(t, "disabled");
    await f.store.setRouteError(f.auth, "unauthorized");
    const tls = await createSyncHttpsCredentials(f.context);
    const receiver = new ManagedSyncStore(path.join(f.root, "receiver"));
    await receiver.enroll();
    const a = await f.store.snapshot();
    const b = await receiver.snapshot();
    const token = Buffer.alloc(48, 61).toString("base64url");
    const application = await startSyncApplication(f.context, { home: path.join(f.root, "receiver"), peerId: b.inboxId, keyPath: tls.trusted.keyPath, certPath: tls.trusted.certPath, token, requestMs: 1000 });
    f.ports.push(application.url);
    await f.store.configureRuntime({ ...defaultRuntimeConfig(), intendedTarget: { peerId: b.inboxId, destinationInboxId: b.inboxId } });
    // Both routes belong to this exact intended receiver; the first remains a real permanent block.
    await f.store.revokeRoute(f.route.id, f.route.revision);
    const blocked = await f.store.configureRoute({ ...f.route, id: randomUUID(), peerId: b.inboxId, destinationInboxId: b.inboxId });
    await f.store.setRouteError(routeAuthorization(blocked), "unauthorized");
    const eligible = await f.store.configureRoute({ ...f.route, id: randomUUID(), peerId: b.inboxId, destinationInboxId: b.inboxId, peerUrl: application.url });
    await receiver.configureRoute({ ...eligible, direction: "inbound", peerId: a.inboxId, peerUrl: "https://127.0.0.1:1", localInboxName: "receiver" });
    const runner = await startProtocolFaultChild(f.context, { mode: "runner", home: f.entry.home, peerId: a.inboxId, token, caPath: tls.caPath });
    const suppressionRunner = outcome === "suppressed" ? await startProtocolFaultChild(f.context, { mode: "runner", home: f.entry.home, peerId: a.inboxId, token, caPath: tls.caPath }) : undefined;
    f.observe();
    const lookup = ManagedSyncStore.prototype.deliveryStatus;
    let eligibleLookups = 0;
    let reconciliations = 0;
    t.mock.method(ManagedSyncStore.prototype, "deliveryStatus", async function(this: ManagedSyncStore, ...args: Parameters<typeof lookup>) {
      f.calls.lookups += 1;
      if (args[0] !== eligible.id) return lookup.apply(this, args);
      eligibleLookups += 1;
      if (eligibleLookups === 2 && !finalAvailable) return f.holdLookup(() => lookup.apply(this, args));
      const result = await lookup.apply(this, args);
      if (eligibleLookups === 1) {
        assert.equal(result.isCommitted, false);
        const reply = await runner.command({ type: "run", routeIds: [eligible.id], requestMs: 1000, deadlineMs: 4000 });
        assert.equal(reply.error, undefined);
        const routes = parseArray(parseObject(reply.result, "reconciliation").routes, (value) => parseObject(value, "route result"), 1);
        assert.equal(routes[0].status, "confirmed");
        reconciliations += 1;
        await runner.stop();
        await f.store.recover();
        if (suppressionRunner) {
          const publication = f.publication;
          assert.ok(publication);
          const received = await receiver.snapshot();
          const record = received.records[canonicalKey(a.inboxId, publication.origin.originDocumentId)];
          await receiver.setSuppressed(record.localId, true);
          const suppressedReply = await suppressionRunner.command({ type: "run", routeIds: [eligible.id], requestMs: 1000, deadlineMs: 4000 });
          assert.equal(suppressedReply.error, undefined);
          const suppressedRoutes = parseArray(parseObject(suppressedReply.result, "suppression reconciliation").routes, (value) => parseObject(value, "suppression route"), 1);
          assert.equal(suppressedRoutes[0].status, "confirmed");
          reconciliations += 1;
          await suppressionRunner.stop();
          await f.store.recover();
        }
      }
      return result;
    });
    const result = await f.publish();
    assert.ok(f.publication);
    assert.equal(eligibleLookups, 2);
    assert.equal(reconciliations, outcome === "suppressed" ? 2 : 1);
    assert.equal(f.calls.holds, finalAvailable ? 0 : 1);
    const current = await f.store.snapshot();
    assert.equal(current.worker.enabled, false);
    assert.equal(current.worker.retryPaused, false);
    assert.equal(current.routes[blocked.id].lastError, "unauthorized");
    const key = canonicalKey(a.inboxId, f.publication.origin.originDocumentId);
    assert.equal(current.outbox[outboxKey(eligible.id, eligible.revision, key)].disposition, "confirmed");
    assert.equal(current.outbox[outboxKey(eligible.id, eligible.revision, key)].receiptDisposition, outcome === "suppressed" ? "suppressed" : "committed");
    const received = await receiver.snapshot();
    assert.equal(Object.keys(received.records).length, 1);
    assert.equal(Object.keys(received.receipts).length, outcome === "suppressed" ? 2 : 1);
    if (outcome === "suppressed") {
      assert.equal(await receiver.getDocument(received.records[key].localId), null);
      const bodyFile = received.records[key].bodyFile;
      assert.ok(bodyFile);
      assert.deepEqual(await fs.readFile(path.join(f.root, "receiver", "sync", "bodies", bodyFile)), bytes);
    } else assert.deepEqual((await receiver.getDocument(received.records[key].localId))?.originalBytes, bytes);
    t.diagnostic(JSON.stringify({ outcome, acknowledgedDisposition: current.outbox[outboxKey(eligible.id, eligible.revision, key)].receiptDisposition,
      receiverRecords: Object.keys(received.records).length, receiverReceipts: Object.keys(received.receipts).length, returnedState: result.result.delivery.state }));
    assert.equal(result.exitCode, finalAvailable ? 0 : outcome === "suppressed" ? 3 : 2);
    assert.equal(result.result.delivery.state, finalAvailable ? "confirmed" : outcome === "suppressed" ? "blocked" : "pending");
    if (finalAvailable) assert.equal(result.result.delivery.receipt?.routeId, eligible.id);
    else {
      assert.equal(result.result.delivery.reason, outcome === "suppressed" ? "intended-target-suppressed" : "worker-disabled");
      assert.equal(result.result.delivery.receipt, null);
    }
    assert.equal(f.calls.starts + f.calls.contacts + f.calls.credentials, 0);
    t.diagnostic(JSON.stringify({ outcome, finalAvailable, eligibleLookups, reconciliations, ports: f.ports, remaining: f.overallDeadline - Date.now() }));
  });
}
