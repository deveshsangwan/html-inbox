import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { reconcileSyncRoutes, routeAuthorization, type ReconcileOptions } from "./sync-reconciliation";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { createEvidence, opaqueToken } from "./sync-wire";

// Managed enrollment requires POSIX directory durability; Windows rejection is tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const originalBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>pre-aborted reconciliation π</body></html>\r\n");
const input = { originalBytes, title: "Cancellation fixture", type: "report", sourceFileName: "synthetic.html" };
const permanentError = "local-validation-or-storage-failed";

async function fixture(t: TestContext, state: "active" | "reconnecting" = "reconnecting") {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-preaborted-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: "ENOENT" });
  });

  const source = new ManagedSyncStore(path.join(root, "source"));
  const receiver = new ManagedSyncStore(path.join(root, "receiver"));
  await source.enroll();
  await receiver.enroll();
  const owner = await source.snapshot();
  const destination = await receiver.snapshot();
  let route = await source.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId: destination.inboxId,
    peerUrl: "https://127.0.0.1:1", sourceInboxId: owner.inboxId, destinationInboxId: destination.inboxId,
    localInboxName: "synthetic", readerAudience: "synthetic", allowedOrigins: owner.originKeys,
    credentialRef: "synthetic", tlsTrustRef: "synthetic", state: "reconnecting", lastError: null });
  const incoming = await receiver.configureRoute({ ...route, direction: "inbound", peerId: owner.inboxId });
  await source.publish(input, "delivered");
  const issuedNonce = opaqueToken();
  const ackNonce = opaqueToken();
  const cut = await source.inventory(routeAuthorization(route));
  const evidence = createEvidence(route, owner.inboxId, issuedNonce, cut);
  await receiver.completeInventory(routeAuthorization(incoming), evidence, cut.states, issuedNonce);
  await source.activateOutbound(routeAuthorization(route), { kind: "terminal-inventory-ready", evidence, ackNonce,
    receiverPeerId: destination.inboxId, destinationInboxId: destination.inboxId, storageIncarnation: destination.storageIncarnation },
  evidence, ackNonce, destination.inboxId);
  const applied = await receiver.apply(routeAuthorization(incoming), cut.states[0], originalBytes);
  assert.equal(applied.status, "committed");
  await source.acknowledge(routeAuthorization(route), applied.receipt);

  if (state === "reconnecting") {
    route = await source.configureRoute({ ...route, revision: route.revision + 1 });
  }

  await source.configureRuntime({ ...defaultRuntimeConfig(), intendedTarget: { peerId: destination.inboxId, destinationInboxId: destination.inboxId } });
  await source.setWorkerEnabled(true);
  await source.publish(input, "pending");
  await source.setRouteError(routeAuthorization(route), permanentError);
  await source.recordRouteRun(routeAuthorization(route), permanentError, true, 0);
  const populated = await source.snapshot();
  assert.equal(populated.routes[route.id].state, state);
  assert.ok(Object.keys(populated.receipts).length > 0);
  assert.ok(Object.keys(populated.outbox).length > 0);
  assert.ok(populated.runtime);
  assert.equal(populated.routeRetries[route.id].blocked, true);
  const received = (await receiver.listDocuments())[0];
  assert.ok(received);

  const openAttempt = t.mock.method(source, "openRouteAttempt");
  let credentialResolutions = 0;
  const options = { store: source, peerId: owner.inboxId, routeIds: [route.id], credentials: () => {
    credentialResolutions += 1;
    throw new Error("Early reconciliation must not resolve credentials");
  } };
  const run = (settings: Partial<ReconcileOptions> = {}) => reconcileSyncRoutes({ ...options, ...settings });
  const snapshot = async () => ({ source: await source.snapshot(), receiver: await receiver.snapshot() });

  async function assertPreserved(before: Awaited<ReturnType<typeof snapshot>>) {
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await source.getDocument("delivered"))?.originalBytes, originalBytes);
    assert.deepEqual((await source.getDocument("pending"))?.originalBytes, originalBytes);
    assert.deepEqual((await receiver.getDocument(received.id))?.originalBytes, originalBytes);
    assert.equal(credentialResolutions, 0);
    assert.equal(openAttempt.mock.callCount(), 0);
  }

  return { source, route, run, snapshot, assertPreserved };
}

function cancelledSignal() {
  const controller = new AbortController();
  controller.abort();

  return controller.signal;
}

for (const state of ["reconnecting", "active"] as const) {
  test(`pre-aborted ${state} reconciliation preserves cached permanent failure without starting work`, async (t) => {
    const f = await fixture(t, state);
    const before = await f.snapshot();
    const result = await f.run({ signal: cancelledSignal() });

    await f.assertPreserved(before);
    assert.deepEqual(result.counters, { requests: 0, requestBytes: 0, responseBytes: 0 });
    assert.equal(result.routes[0].status, "aborted");
    assert.equal(result.routes[0].lastError, null);
  });
}

test("an expired pass reports aborted before its cached permanent failure", async (t) => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const result = await f.run({ deadlineAt: Date.now() - 1 });

  await f.assertPreserved(before);
  assert.deepEqual(result.counters, { requests: 0, requestBytes: 0, responseBytes: 0 });
  assert.equal(result.routes[0].status, "aborted");
  assert.equal(result.routes[0].lastError, null);
});

test("pre-aborted reconciliation with a clear route error preserves the same durable state", async (t) => {
  const f = await fixture(t);
  await f.source.setRouteError(routeAuthorization(f.route), null);
  const before = await f.snapshot();
  const result = await f.run({ signal: cancelledSignal() });

  await f.assertPreserved(before);
  assert.deepEqual(result.counters, { requests: 0, requestBytes: 0, responseBytes: 0 });
  assert.equal(result.routes[0].status, "aborted");
  assert.equal(result.routes[0].lastError, null);
});

test("ordinary cached permanent failure remains blocked until explicit retry", async (t) => {
  const f = await fixture(t, "active");
  const before = await f.snapshot();
  for (let pass = 0; pass < 2; pass += 1) {
    const result = await f.run();

    await f.assertPreserved(before);
    assert.deepEqual(result.counters, { requests: 0, requestBytes: 0, responseBytes: 0 });
    assert.equal(result.routes[0].status, "blocked");
    assert.equal(result.routes[0].lastError, permanentError);
  }

  await f.source.retry(routeAuthorization(f.route));
  const retried = await f.snapshot();
  assert.equal(retried.source.routes[f.route.id].lastError, null);
  assert.equal(retried.source.routeRetries[f.route.id], undefined);
  assert.ok(Object.values(retried.source.outbox).some((entry) => entry.routeId === f.route.id && entry.disposition === "pending"));
  const cancelled = await f.run({ signal: cancelledSignal() });

  await f.assertPreserved(retried);
  assert.equal(cancelled.routes[0].status, "aborted");
  assert.equal(cancelled.routes[0].lastError, null);
  assert.equal(cancelled.counters.requests, 0);
});

for (const fence of ["revoked", "quarantined"] as const) {
  test(`an already ${fence} route keeps its lifecycle fence before cancellation`, async (t) => {
    const f = await fixture(t);

    if (fence === "revoked") {
      await f.source.revokeRoute(f.route.id, f.route.revision);
    } else {
      await f.source.quarantineRestore();
    }

    const before = await f.snapshot();
    const result = await f.run({ signal: cancelledSignal(), deadlineAt: Date.now() - 1 });

    await f.assertPreserved(before);
    assert.deepEqual(result.counters, { requests: 0, requestBytes: 0, responseBytes: 0 });
    assert.equal(result.routes[0].status, fence === "revoked" ? "detached" : "blocked");
    assert.equal(result.routes[0].lastError, before.source.routes[f.route.id].lastError);
  });
}

test("pre-aborted calls still validate explicit input and reject unknown routes", async (t) => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const signal = cancelledSignal();
  await assert.rejects(f.run({ signal, routeIds: [randomUUID()] }), /Unknown explicit sync route/);
  await assert.rejects(f.run({ signal, routeIds: [] }), /distinct explicit route IDs/);
  await assert.rejects(f.run({ signal, routeIds: [f.route.id, f.route.id] }), /distinct explicit route IDs/);
  await assert.rejects(f.run({ signal, peerId: "invalid-peer" }));
  await assert.rejects(f.run({ signal, routeIds: ["invalid-route"] }));
  await assert.rejects(f.run({ signal, requestMs: 0 }));

  await f.assertPreserved(before);
});
