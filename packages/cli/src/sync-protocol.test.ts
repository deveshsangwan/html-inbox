import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import platformTest, { type TestContext } from "node:test";
import { SyncClient } from "./sync-client";
import { createSyncHttpsCredentials, startSyncHttpsProxy, type SyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import { canonicalKey, parseObject, sha256, signOriginState, stateFingerprint, type SyncRoute, type OriginGrant, type OriginState } from "./sync-model";
import { startSyncApplication } from "./sync-protocol-fixture";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { ManagedSyncStore, toOriginState } from "./sync-store";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { startOwnedSyncWorker } from "./sync-worker";
import { createEvidence, opaqueToken, parseIdentityResponse, parseManifestPage, parseOfferResponse, parseReadiness, SyncProtocolError, WIRE_LIMITS } from "./sync-wire";

// Managed durability requires POSIX directory fsync; Windows opt-in rejection has its own active regression.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const bytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>synthetic π</body></html>\r\n");
const input = { originalBytes: bytes, title: "Synthetic protocol", type: "report", sourceFileName: "synthetic.html" };

interface Inbox { home: string; store: ManagedSyncStore; peerId: string; stopApplications: (() => Promise<void>)[] }

async function inbox(t: TestContext): Promise<Inbox> {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-wire-"));
  const stopApplications: (() => Promise<void>)[] = [];
  t.after(async () => {
    // Inbox cleanup is registered before the application's own after hook.
    // Reap its writers before removing the storage they can still access.
    for (const stop of stopApplications) await stop();
    await rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, "inbox");
  const store = new ManagedSyncStore(home);
  await store.enroll();
  return { home, store, peerId: randomUUID(), stopApplications };
}


async function connect(a: Inbox, b: Inbox, aUrl: string, bUrl: string, grant?: OriginGrant, id: string = randomUUID(), revision = 1) {
  const source = await a.store.snapshot();
  const destination = await b.store.snapshot();
  const origin = grant ?? source.originKeys[0];
  const route: SyncRoute = { id, revision, direction: "outbound", peerId: b.peerId, peerUrl: bUrl, sourceInboxId: source.inboxId,
    destinationInboxId: destination.inboxId, localInboxName: "synthetic", readerAudience: "disposable synthetic fixture", allowedOrigins: [{ ...origin }],
    credentialRef: "synthetic_token", tlsTrustRef: "synthetic_ca", state: "active", lastError: null };
  const outbound = await a.store.configureRoute(route);
  const inbound = await b.store.configureRoute({ ...route, direction: "inbound", peerId: a.peerId, peerUrl: aUrl });
  return { outbound, inbound };
}

async function server(t: TestContext, fixture: Inbox, tls: SyncHttpsCredentials, token: string, options: { requestMs?: number; leaseMs?: number; cert?: "trusted" | "rogue" | "wrongHost" | "expired"; port?: number } = {}) {
  const credentials = tls[options.cert ?? "trusted"];
  const application = await startSyncApplication(t, { home: fixture.home, peerId: fixture.peerId, token, ...credentials, requestMs: options.requestMs, leaseMs: options.leaseMs, port: options.port });
  fixture.stopApplications.push(() => application.stop());
  return application;
}

async function pair(t: TestContext, options: { sourceListener?: boolean; leaseMs?: number } = {}) {
  const tls = await createSyncHttpsCredentials(t);
  const ca = await readFile(tls.caPath);
  const token = opaqueToken();
  const a = await inbox(t);
  const b = await inbox(t);
  const bs = await server(t, b, tls, token, { leaseMs: options.leaseMs });
  const as = options.sourceListener ? await server(t, a, tls, token, { leaseMs: options.leaseMs }) : undefined;
  const routes = await connect(a, b, as?.url ?? "https://127.0.0.1:1", bs.url);
  const credentials = () => ({ token, ca });
  const run = (fixture: Inbox, route: SyncRoute, extra: Partial<Parameters<typeof reconcileSyncRoutes>[0]> = {}) =>
    reconcileSyncRoutes({ store: fixture.store, peerId: fixture.peerId, credentials, routeIds: [route.id], ...extra });
  return { a, b, as, bs, tls, token, ca, credentials, ...routes, run };
}

async function descriptor(a: Inbox, id: string): Promise<OriginState> {
  const ledger = await a.store.snapshot();
  const record = ledger.records[canonicalKey(ledger.inboxId, id)];
  assert.ok(record);
  return toOriginState(record);
}

test("real HTTPS payload push works with source listener unavailable; exact bytes, durable receipts and no-op scans", { timeout: 30_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "Case-ID");
  await f.b.store.publish(input, "Case-ID");
  assert.equal((await f.a.store.snapshot()).routes[f.outbound.id].state, "reconnecting");
  const result = await f.run(f.a, f.outbound);
  assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
  assert.equal(result.routes[0].transferred, 1);
  const delivery = await f.a.store.deliveryStatus(f.outbound.id, f.outbound.sourceInboxId, "Case-ID");
  assert.equal(delivery.isCommitted, true);
  assert.equal(delivery.status, "committed");
  const documents = await f.b.store.listDocuments();
  assert.equal(documents.length, 2);
  const imported = documents.find((item) => item.origin);
  assert.ok(imported);
  assert.deepEqual((await f.b.store.getDocument(imported.id))?.originalBytes, bytes);
  const receiver = await f.b.store.snapshot();
  assert.equal(Object.keys(receiver.receipts).length, 1);
  assert.equal(Object.keys(receiver.checkpoints).length, 0);
  assert.equal(Object.keys(receiver.historyCheckpoints).length, 1);
  const before = f.a.store.counters.htmlOpens;
  for (let count = 0; count < 3; count += 1) {
    assert.equal((await f.run(f.a, f.outbound)).routes[0].status, "confirmed");
  }

  assert.equal(f.a.store.counters.htmlOpens, before);
  assert.equal(Object.keys((await f.b.store.snapshot()).records).length, 2);
});

test("receiver independently pulls after dropped push and full checkpoint waits for every body", { timeout: 30_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  await f.a.store.publish(input, "pull-99");
  await f.a.store.publish(input, "pull-100");
  const state99 = await descriptor(f.a, "pull-99");
  const client = new SyncClient(f.b.store, f.b.peerId, f.credentials);
  const nonce = opaqueToken();
  const session = await client.json(routeAuthorization(f.inbound), "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const page = await client.json(routeAuthorization(f.inbound), "manifest", { op: "pull", sessionId: session.sessionId, cursor: null }, parseManifestPage, WIRE_LIMITS.page);
  await f.b.store.completeInventory(routeAuthorization(f.inbound), page.evidence, page.descriptors, nonce);
  assert.equal(Object.keys((await f.b.store.snapshot()).checkpoints).length, 0);
  const state100 = await descriptor(f.a, "pull-100");
  await f.b.store.apply(routeAuthorization(f.inbound), state100, bytes);
  assert.equal(await f.b.store.completeReconciliation(routeAuthorization(f.inbound), page.evidence, page.descriptors), false);
  assert.equal(Object.keys((await f.b.store.snapshot()).checkpoints).length, 0);
  assert.equal((await f.b.store.apply(routeAuthorization(f.inbound), state99)).status, "needs-body");
  const result = await f.run(f.b, f.inbound);
  assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
  assert.equal(result.routes[0].fullyReconciled, true);
  assert.equal(result.routes[0].transferred, 1);
  assert.equal((await f.b.store.listDocuments()).length, 2);
  assert.equal(Object.keys((await f.b.store.snapshot()).checkpoints).length, 1);
  assert.equal(Object.keys((await f.a.store.snapshot()).historyCheckpoints).length, 0);
  assert.equal(Object.keys((await f.a.store.snapshot()).receipts).length, 0);
});

test("simultaneous push and independent pull install one row; lost final ACK resolves from current holdings", { timeout: 30_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  const proxy = await startSyncHttpsProxy(t, { upstreamUrl: f.bs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
    routes: [{ label: "body", pathname: "/sync/v1/body", method: "PUT" }], faults: [{ id: "lost-ack", route: "body", kind: "drop-response" }] });
  const routes = await connect(f.a, f.b, f.as?.url ?? "https://127.0.0.1:1", proxy.url, undefined, randomUUID());
  await f.a.store.publish(input, "raced");
  const first = await f.run(f.a, routes.outbound, { requestMs: 1000 });
  assert.equal(first.routes[0].status, "pending");
  assert.equal((await proxy.stats()).faultHits["lost-ack"], 1);
  assert.equal((await f.b.store.listDocuments()).length, 1);
  await Promise.all([f.run(f.a, routes.outbound), f.run(f.b, f.inbound)]);
  assert.equal((await f.run(f.a, routes.outbound)).routes[0].status, "confirmed");
  assert.equal((await f.b.store.listDocuments()).length, 1);
  assert.equal(Object.keys((await f.b.store.snapshot()).records).length, 1);
});

test("new route IDs and explicit reconnection reconcile retained copies and offline tombstones before live bytes", { timeout: 30_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "offline-delete");
  await f.a.store.publish(input, "retain");
  await f.run(f.a, f.outbound);
  await f.a.store.revokeRoute(f.outbound.id, 1);
  await f.b.store.revokeRoute(f.inbound.id, 1);
  await f.a.store.deleteDocument("offline-delete");
  const stale = (await f.b.store.listDocuments()).find((item) => item.origin?.documentId === "offline-delete");
  assert.equal(stale?.origin?.detached, true);
  const before = f.a.store.counters.htmlOpens;
  assert.equal((await f.run(f.a, f.outbound)).counters.requests, 0);
  const fresh = await connect(f.a, f.b, "https://127.0.0.1:1", f.bs.url);
  assert.equal(fresh.outbound.state, "reconnecting");
  const retained = await descriptor(f.a, "retain");
  await assert.rejects(f.a.store.pinOutgoing(routeAuthorization(fresh.outbound), retained.originInboxId, retained.originDocumentId), /scope/);
  await assert.rejects(f.b.store.apply(routeAuthorization(fresh.inbound), retained), /terminal inventory/);
  assert.equal((await f.run(f.a, fresh.outbound)).routes[0].status, "confirmed");
  assert.equal((await f.b.store.listDocuments()).length, 1);
  assert.equal(f.a.store.counters.htmlOpens, before);
  await f.a.store.revokeRoute(fresh.outbound.id, 1);
  await f.b.store.revokeRoute(fresh.inbound.id, 1);
  const revised = await connect(f.a, f.b, "https://127.0.0.1:1", f.bs.url, undefined, fresh.outbound.id, 3);
  assert.equal((await f.run(f.a, revised.outbound)).routes[0].status, "confirmed");
});

const invalidCertificates: ("rogue" | "wrongHost" | "expired")[] = ["rogue", "wrongHost", "expired"];
for (const cert of invalidCertificates) {
  test(`application client rejects ${cert} TLS before protected HTTP disclosure`, { timeout: 20_000 }, async (t) => {
    const tls = await createSyncHttpsCredentials(t);
    const token = opaqueToken();
    const readCa = await readFile(tls.caPath);
    const a = await inbox(t);
    const b = await inbox(t);
    const bs = await server(t, b, tls, token, { cert });
    const routes = await connect(a, b, "https://127.0.0.1:1", bs.url);
    await a.store.publish(input, "private");
    const result = await reconcileSyncRoutes({ store: a.store, peerId: a.peerId, credentials: () => ({ token, ca: readCa }), routeIds: [routes.outbound.id], requestMs: 500 });
    assert.equal(result.routes[0].status, "blocked");
    const repeated = await reconcileSyncRoutes({ store: a.store, peerId: a.peerId, credentials: () => ({ token, ca: readCa }), routeIds: [routes.outbound.id] });
    assert.equal(repeated.counters.requests, 0);
    const status = await bs.command({ type: "status" });
    assert.equal(parseObject(parseObject(status.status, "server status").counters, "counters").requests, 0);
    assert.equal((await b.store.listDocuments()).length, 0);
  });
}

test("ingestion refuses wildcard binding and plaintext route configuration", async (t) => {
  const a = await inbox(t);
  assert.throws(() => createSyncIngestionServer({ store: a.store, peerId: a.peerId, key: "synthetic", cert: "synthetic", host: "0.0.0.0", credentials: () => ({ token: opaqueToken() }) }), /literal unicast/);
  const ledger = await a.store.snapshot();
  await assert.rejects(a.store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId: randomUUID(), peerUrl: "http://127.0.0.1:1234", sourceInboxId: ledger.inboxId,
    destinationInboxId: randomUUID(), localInboxName: "synthetic", readerAudience: "synthetic", allowedOrigins: ledger.originKeys, credentialRef: "synthetic", tlsTrustRef: "synthetic", state: "active", lastError: null }), /HTTPS/);
});

async function rawRequest(url: string, ca: Buffer, token: string, binding: unknown, endpoint: string, body: Buffer, headers: Record<string, string> = {}, method = "POST") {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = https.request(new URL(endpoint, url), { method, ca, agent: false, headers: { authorization: `Bearer ${token}`,
      "x-html-inbox-sync": Buffer.from(JSON.stringify(binding)).toString("base64url"), "content-type": "application/json", "content-length": String(body.length), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("Synthetic raw request deadline")));
    request.end(body);
  });
}

async function bindingFor(f: Awaited<ReturnType<typeof pair>>) {
  const ledger = await f.a.store.snapshot();
  return { protocolVersion: 1, routeId: f.outbound.id, revision: f.outbound.revision, callerPeerId: f.a.peerId, targetPeerId: f.b.peerId,
    sourceInboxId: f.outbound.sourceInboxId, destinationInboxId: f.outbound.destinationInboxId, callerStorageIncarnation: ledger.storageIncarnation };
}

test("authorization rejects wrong credential, peer, target, revision, direction and origin before payload consumption", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "protected");
  const binding = await bindingFor(f);
  const payload = Buffer.from(JSON.stringify({ nonce: opaqueToken() }));
  const variants = [{ token: opaqueToken(), binding }, ...["callerPeerId", "targetPeerId", "sourceInboxId", "destinationInboxId", "routeId"].map((key) => ({ token: f.token, binding: { ...binding, [key]: randomUUID() } })),
    { token: f.token, binding: { ...binding, revision: 999 } }];
  for (const variant of variants) {
    const response = await rawRequest(f.bs.url, f.ca, variant.token, variant.binding, "/sync/v1/identity", payload);
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body.toString()), { error: "unauthorized" });
  }

  const wrongDirection = await rawRequest(f.bs.url, f.ca, f.token, binding, `/sync/v1/body?sessionId=${opaqueToken()}`, Buffer.alloc(0), {}, "GET");
  assert.equal(wrongDirection.status, 403);
  const state = await descriptor(f.a, "protected");
  const scope = await rawRequest(f.bs.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: { ...state, originInboxId: randomUUID() } })));
  assert.equal(scope.status, 403);
  const status = await f.bs.command({ type: "status" });
  const counters = parseObject(status.counters, "storage counters");
  assert.equal(counters.bodyTransfers, 0);
  assert.equal((await f.b.store.listDocuments()).length, 0);
});

test("129 descriptors paginate one immutable cut; missing pages, changed scope, nonce replay and expiry fail", { timeout: 30_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  for (let index = 0; index < 129; index += 1) {
    await f.a.store.publish(input, `page-${String(index).padStart(3, "0")}`);
  }

  const sourceClient = new SyncClient(f.a.store, f.a.peerId, f.credentials);
  const receiverClient = new SyncClient(f.b.store, f.b.peerId, f.credentials);
  const auth = routeAuthorization(f.outbound);
  const receiveAuth = routeAuthorization(f.inbound);
  const nonce = opaqueToken();
  const receiveSession = await sourceClient.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const cut = await f.a.store.inventory(auth);
  const evidence = createEvidence(f.outbound, f.a.peerId, receiveSession.challengeNonce, cut);
  const finalPage = { evidence, pageNumber: 1, descriptors: cut.states.slice(128), nextCursor: null };
  await assert.rejects(sourceClient.json(auth, "manifest", { op: "push", sessionId: receiveSession.sessionId, page: finalPage }, parseReadiness, WIRE_LIMITS.readiness), (error: unknown) => error instanceof SyncProtocolError && error.status === 409);
  const firstPage = { evidence, pageNumber: 0, descriptors: cut.states.slice(0, 128), nextCursor: opaqueToken() };
  await sourceClient.json(auth, "manifest", { op: "push", sessionId: receiveSession.sessionId, page: firstPage }, (value) => value, WIRE_LIMITS.readiness);
  await assert.rejects(sourceClient.json(auth, "manifest", { op: "push", sessionId: receiveSession.sessionId, page: { ...finalPage, evidence: { ...evidence, nonce: opaqueToken() } } }, parseReadiness, WIRE_LIMITS.readiness));
  await assert.rejects(sourceClient.json(auth, "manifest", { op: "push", sessionId: receiveSession.sessionId, page: { ...finalPage, evidence: { ...evidence, scope: [] } } }, parseReadiness, WIRE_LIMITS.readiness));
  assert.equal(Object.keys((await f.b.store.snapshot()).historyCheckpoints).length, 0);
  const ready = await sourceClient.json(auth, "manifest", { op: "push", sessionId: receiveSession.sessionId, page: finalPage }, parseReadiness, WIRE_LIMITS.readiness);
  await assert.rejects(f.a.store.activateOutbound(auth, ready, evidence, opaqueToken(), f.b.peerId), /locally issued/);
  await f.a.store.activateOutbound(auth, ready, evidence, nonce, f.b.peerId);
  await assert.rejects(sourceClient.json(auth, "manifest", { op: "push", sessionId: receiveSession.sessionId, page: finalPage }, parseReadiness, WIRE_LIMITS.readiness));
  const pullNonce = opaqueToken();
  const sourceSession = await receiverClient.json(receiveAuth, "identity", { nonce: pullNonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const page1 = await receiverClient.json(receiveAuth, "manifest", { op: "pull", sessionId: sourceSession.sessionId, cursor: null }, parseManifestPage, WIRE_LIMITS.page);
  assert.equal(page1.descriptors.length, 128);
  assert.ok(page1.nextCursor);
  await f.a.store.publish(input, "after-cut");
  const page2 = await receiverClient.json(receiveAuth, "manifest", { op: "pull", sessionId: sourceSession.sessionId, cursor: page1.nextCursor }, parseManifestPage, WIRE_LIMITS.page);
  assert.equal(page2.descriptors.length, 1);
  assert.equal(page2.evidence.count, 129);
  assert.deepEqual(page1.evidence, page2.evidence);
  await assert.rejects(receiverClient.json(receiveAuth, "manifest", { op: "pull", sessionId: sourceSession.sessionId, cursor: page1.nextCursor }, parseManifestPage, WIRE_LIMITS.page));
});

test("expired and exhausted sessions are bounded without activation", { timeout: 20_000 }, async (t) => {
  const f = await pair(t, { leaseMs: 100 });
  const client = new SyncClient(f.a.store, f.a.peerId, f.credentials);
  const auth = routeAuthorization(f.outbound);
  const session = await client.json(auth, "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity);
  await new Promise((resolve) => setTimeout(resolve, 130));
  const cut = await f.a.store.inventory(auth);
  const evidence = createEvidence(f.outbound, f.a.peerId, session.challengeNonce, cut);
  await assert.rejects(client.json(auth, "manifest", { op: "push", sessionId: session.sessionId, page: { evidence, pageNumber: 0, descriptors: [], nextCursor: null } }, parseReadiness, WIRE_LIMITS.readiness), (error: unknown) => error instanceof SyncProtocolError && error.status === 410);
  const long = await server(t, f.b, f.tls, f.token);
  const routes = await connect(f.a, f.b, "https://127.0.0.1:1", long.url);
  for (let index = 0; index < 8; index += 1) {
    await client.json(routeAuthorization(routes.outbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity);
  }

  await assert.rejects(client.json(routeAuthorization(routes.outbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity),
    (error: unknown) => error instanceof SyncProtocolError && error.status === 503 && error.code === "session-capacity");
  const capacity = parseObject((await long.command({ type: "status" })).status, "bounded server status");
  assert.equal(capacity.sessions, 8);
  assert.equal((await f.a.store.snapshot()).routes[routes.outbound.id].state, "reconnecting");
});

test("empty outbox body loss creates persistent repair; holdings polls preserve blocked attempts and suppression", { timeout: 30_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "repair");
  assert.equal((await f.run(f.a, f.outbound)).routes[0].status, "confirmed");
  const source = await f.a.store.snapshot();
  source.outbox = {};
  await writeFile(path.join(f.a.home, "sync", "ledger.json"), JSON.stringify(source));
  const receiver = await f.b.store.snapshot();
  const record = Object.values(receiver.records)[0];
  assert.ok(record.bodyFile);
  await rm(path.join(f.b.home, "sync", "bodies", record.bodyFile));
  const proxy = await startSyncHttpsProxy(t, { upstreamUrl: f.bs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
    routes: [{ label: "offer", pathname: "/sync/v1/offer" }], faults: [{ id: "block-offer", route: "offer", kind: "stall-response", times: 4 }], requestTimeoutMs: 5000 });
  // A transient outage at a receiver can block after a caller-selected finite attempt ceiling.
  const route = source.routes[f.outbound.id];
  route.peerUrl = proxy.url;
  source.routes[route.id] = route;
  await writeFile(path.join(f.a.home, "sync", "ledger.json"), JSON.stringify(source));
  const first = await f.run(f.a, route, { requestMs: 1500, maxAttempts: 1 });
  assert.equal(first.routes[0].blocked, 1, JSON.stringify(first));
  assert.equal((await proxy.stats()).faultHits["block-offer"], 1);
  const blocked = Object.values((await f.a.store.snapshot()).outbox)[0];
  assert.equal(blocked.attempts, 1);
  assert.equal(blocked.receiverStorageIncarnation, receiver.storageIncarnation);
  await f.run(f.a, route, { requestMs: 1500 });
  const unchanged = Object.values((await f.a.store.snapshot()).outbox)[0];
  assert.deepEqual(unchanged, blocked);
  assert.equal((await proxy.stats()).routes.offer.starts, 1);
  await f.a.store.retry(routeAuthorization(route));
  route.peerUrl = f.bs.url;
  const current = await f.a.store.snapshot();
  current.routes[route.id] = route;
  await writeFile(path.join(f.a.home, "sync", "ledger.json"), JSON.stringify(current));
  assert.equal((await f.run(f.a, route)).routes[0].status, "confirmed");
  const local = (await f.b.store.listDocuments())[0];
  await f.b.store.deleteDocument(local.id);
  assert.equal((await f.run(f.a, route)).routes[0].status, "confirmed");
  assert.ok(Object.values((await f.a.store.snapshot()).receipts).some((receipt) => receipt.disposition === "suppressed"));
  const delivery = await f.a.store.deliveryStatus(route.id, route.sourceInboxId, "repair");
  assert.equal(delivery.isCommitted, false);
  assert.equal(delivery.status, "suppressed");
});

test("actual streamed body handlers reject corruption, invalid UTF-8/HTML, compression and length violations; stages are cleaned", { timeout: 30_000 }, async (t) => {
  const f = await pair(t);
  await f.run(f.a, f.outbound);
  const client = new SyncClient(f.a.store, f.a.peerId, f.credentials);
  const auth = routeAuthorization(f.outbound);
  const binding = await bindingFor(f);
  const cases = [
    { id: "corrupt", expected: bytes, actual: Buffer.alloc(bytes.length, 120) },
    { id: "utf8", expected: Buffer.from([0xff, 0xfe, 0xfc]), actual: Buffer.from([0xff, 0xfe, 0xfc]) },
    { id: "html", expected: Buffer.from("plain text without HTML"), actual: Buffer.from("plain text without HTML") },
    { id: "short-length", expected: bytes, actual: bytes.subarray(0, -1) },
  ];
  for (const item of cases) {
    await f.a.store.publish(input, item.id);
    const state = await descriptor(f.a, item.id);
    const privateKey = await readFile(path.join(f.a.home, "sync", `owner-${state.originInboxId}.pem`), "utf8");
    const descriptorWithBytes = signOriginState({ ...state, sha256: sha256(item.expected), byteLength: item.expected.length }, privateKey);
    const offered = await client.json(auth, "offer", { descriptor: descriptorWithBytes }, parseOfferResponse, WIRE_LIMITS.offer);
    assert.equal(offered.status, "needs-body");
    if (offered.status !== "needs-body") throw new Error("Expected body request");
    const result = await rawRequest(f.bs.url, f.ca, f.token, binding, `/sync/v1/body?transferId=${offered.transferId}`, item.actual, { "content-type": "application/octet-stream" }, "PUT");
    assert.equal(result.status, 409, `${item.id}: ${result.body.toString()}`);
    assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, 0);
  }

  const response = await rawRequest(f.bs.url, f.ca, f.token, binding, "/sync/v1/identity", Buffer.from(JSON.stringify({ nonce: opaqueToken() })), { "content-encoding": "gzip" });
  assert.equal(response.status, 409);
  const oversized = await rawRequest(f.bs.url, f.ca, f.token, binding, "/sync/v1/identity", Buffer.alloc(4097, 32));
  assert.equal(oversized.status, 413);
  assert.equal(Object.keys((await f.b.store.snapshot()).records).length, 0);
  const status = await f.bs.command({ type: "status" });
  assert.ok(Number(parseObject(status.counters, "counters").bodyTransfers) >= 3);
});

test("whole HTTPS deadlines and abort leave durable obligations and finite retry state", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "deadline");
  const proxy = await startSyncHttpsProxy(t, { upstreamUrl: f.bs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
    routes: [{ label: "identity", pathname: "/sync/v1/identity" }], faults: [{ id: "stall", route: "identity", kind: "stall-response", times: 4 }], requestTimeoutMs: 1000 });
  const routes = await connect(f.a, f.b, "https://127.0.0.1:1", proxy.url);
  const before = Date.now();
  const result = await f.run(f.a, routes.outbound, { requestMs: 100, deadlineMs: 300 });
  assert.ok(Date.now() - before < 1500);
  assert.equal(result.routes[0].historyReady, false);
  assert.ok(Object.values((await f.a.store.snapshot()).outbox).some((entry) => entry.routeId === routes.outbound.id && entry.disposition !== "retired"));
  const controller = new AbortController();
  controller.abort();
  const cancelled = await f.run(f.a, routes.outbound, { signal: controller.signal });
  assert.equal(cancelled.counters.requests, 0);
  assert.equal(cancelled.routes[0].status, "aborted");
  assert.deepEqual((await f.a.store.getDocument("deadline"))?.originalBytes, bytes);
});

for (const fence of ["revoke", "target-replacement"]) {
  test(`receiver ${fence} during upload fences final commit and removes private stage`, { timeout: 20_000 }, async (t) => {
    const f = await pair(t);
    await f.a.store.publish(input, "fenced");
    await f.bs.command({ type: "arm", event: "body-flushed" });
    const sending = f.run(f.a, f.outbound, { requestMs: 2000 });
    const fault = await f.bs.waitFor("fault");
    assert.equal(fault.event, "body-flushed");
    assert.equal(fault.hits, 1);
    if (fence === "revoke") {
      await f.bs.command({ type: "revoke", routeId: f.inbound.id, revision: 1 });
    } else {
      await writeFile(path.join(f.b.home, "instance-id"), randomUUID());
    }

    await f.bs.command({ type: "release" });
    const result = await sending;
    assert.notEqual(result.routes[0].status, "confirmed");
    const raw = parseObject(JSON.parse(await readFile(path.join(f.b.home, "sync", "ledger.json"), "utf8")), "ledger");
    assert.equal(Object.keys(parseObject(raw.records, "records")).length, 0);
    assert.equal((await readdir(path.join(f.b.home, "sync", "bodies"))).length, 0);
    assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, 0);
  });
}

test("local revoke aborts registered requests and fences every subsequent request start including probes/retries", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "local-fence");
  const proxy = await startSyncHttpsProxy(t, { upstreamUrl: f.bs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
    routes: [{ label: "identity", pathname: "/sync/v1/identity" }], faults: [{ id: "paused", route: "identity", kind: "pause-response" }] });
  const routes = await connect(f.a, f.b, "https://127.0.0.1:1", proxy.url);
  const running = f.run(f.a, routes.outbound, { requestMs: 2000 });
  await proxy.waitForEvent((event) => event.type === "fault-hit");
  await f.a.store.revokeRoute(routes.outbound.id, 1);
  const result = await running;
  assert.equal(result.routes[0].status, "aborted");
  const starts = (await proxy.stats()).routes.identity.starts;
  assert.equal((await f.run(f.a, routes.outbound)).counters.requests, 0);
  const client = new SyncClient(f.a.store, f.a.peerId, f.credentials);
  await assert.rejects(client.json(routeAuthorization(routes.outbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity), /route authorization/);
  await assert.rejects(f.a.store.retry(routeAuthorization(routes.outbound)), /route authorization/);
  assert.equal((await proxy.stats()).routes.identity.starts, starts);
});

for (const event of ["body-flushed", "committed-before-receipt"]) {
  test(`actual server crash at ${event} resolves by repeatable durable receiver receipt`, { timeout: 25_000 }, async (t) => {
    const f = await pair(t);
    await f.a.store.publish(input, "crash");
    await f.bs.command({ type: "arm", event });
    const sending = f.run(f.a, f.outbound, { requestMs: 1000 });
    const fault = await f.bs.waitFor("fault");
    assert.equal(fault.hits, 1);
    await f.bs.stop(true);
    const first = await sending;
    assert.notEqual(first.routes[0].status, "confirmed");
    const recovered = new ManagedSyncStore(f.b.home);
    await recovered.recover();
    const before = await recovered.snapshot();
    assert.equal(Object.keys(before.receipts).length, event === "committed-before-receipt" ? 1 : 0);
    assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, 0);
    const restarted = await server(t, f.b, f.tls, f.token, { port: Number(new URL(f.bs.url).port) });
    assert.equal(restarted.url, f.bs.url);
    await f.a.store.retry(routeAuthorization(f.outbound));
    assert.equal((await f.run(f.a, f.outbound)).routes[0].status, "confirmed");
    const after = await recovered.snapshot();
    assert.equal(Object.keys(after.records).length, 1);
    assert.equal(Object.keys(after.receipts).length, 1);
    if (event === "committed-before-receipt") assert.deepEqual(after.receipts, before.receipts);
  });
}

test("signed A→B→C deletion relays with A offline and no attached live contribution; cycles and duplicate routes terminate", { timeout: 30_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  const c = await inbox(t);
  const cs = await server(t, c, f.tls, f.token);
  const owner = (await f.a.store.snapshot()).originKeys[0];
  const bc = await connect(f.b, c, f.bs.url, cs.url, owner);
  const ca = await connect(c, f.a, cs.url, f.as?.url ?? "https://127.0.0.1:1", owner);
  const duplicate = await connect(f.a, f.b, f.as?.url ?? "https://127.0.0.1:1", f.bs.url);
  await f.a.store.publish(input, "cycle");
  for (const [inbox, route] of [[f.a, f.outbound], [f.b, bc.outbound], [c, ca.outbound], [f.a, duplicate.outbound]] satisfies [Inbox, SyncRoute][]) {
    assert.equal((await f.run(inbox, route)).routes[0].status, "confirmed");
  }

  const before = await Promise.all([f.a.store.snapshot(), f.b.store.snapshot(), c.store.snapshot()]);
  for (const [inbox, route] of [[f.a, f.outbound], [f.b, bc.outbound], [c, ca.outbound]] satisfies [Inbox, SyncRoute][]) {
    assert.equal((await f.run(inbox, route)).routes[0].status, "confirmed");
  }

  const after = await Promise.all([f.a.store.snapshot(), f.b.store.snapshot(), c.store.snapshot()]);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(Object.keys(after[index].records).length, 1);
    assert.equal(Object.keys(after[index].outbox).length, Object.keys(before[index].outbox).length);
    assert.equal(after[index].nextOriginVersion, before[index].nextOriginVersion);
  }

  await f.a.store.deleteDocument("cycle");
  const revised = await connect(f.a, f.b, f.as?.url ?? "https://127.0.0.1:1", f.bs.url, undefined, f.outbound.id, 2);
  const client = new SyncClient(f.a.store, f.a.peerId, f.credentials);
  const auth = routeAuthorization(revised.outbound);
  const nonce = opaqueToken();
  const session = await client.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const cut = await f.a.store.inventory(auth);
  const evidence = createEvidence(revised.outbound, f.a.peerId, session.challengeNonce, cut);
  await client.json(auth, "manifest", { op: "push", sessionId: session.sessionId, page: { evidence, pageNumber: 0, descriptors: cut.states, nextCursor: null } }, parseReadiness, WIRE_LIMITS.readiness);
  const terminalAtB = Object.values((await f.b.store.snapshot()).records)[0];
  assert.equal(terminalAtB.state, "deleted");
  assert.equal(terminalAtB.contributions.some((item) => item.state === "attached" && item.routeId === revised.inbound.id), false);
  await f.as?.stop();
  assert.equal((await f.run(f.b, bc.outbound)).routes[0].status, "confirmed");
  assert.equal((await c.store.listDocuments()).length, 0);
  assert.equal(Object.values((await c.store.snapshot()).records)[0].signature, terminalAtB.signature);
});

test("newer signed receiver terminal state converges through state-only outbound observation without false ACK or owner events", { timeout: 25_000 }, async (t) => {
  const f = await pair(t);
  const c = await inbox(t);
  const cs = await server(t, c, f.tls, f.token);
  const owner = (await f.a.store.snapshot()).originKeys[0];
  const bc = await connect(f.b, c, f.bs.url, cs.url, owner);
  await f.a.store.publish(input, "superseded");
  await f.run(f.a, f.outbound);
  await f.run(f.b, bc.outbound);
  const before = await f.b.store.snapshot();
  await f.a.store.deleteDocument("superseded");
  const terminal = await descriptor(f.a, "superseded");
  await c.store.apply(routeAuthorization(bc.inbound), terminal);
  const result = await f.run(f.b, bc.outbound);
  assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
  const after = await f.b.store.snapshot();
  const record = Object.values(after.records)[0];
  assert.equal(record.state, "deleted");
  assert.equal(record.signature, terminal.signature);
  assert.deepEqual(record.contributions, Object.values(before.records)[0].contributions);
  assert.deepEqual(record.provenance, Object.values(before.records)[0].provenance);
  assert.equal(after.nextOriginVersion, before.nextOriginVersion);
  assert.ok(Object.values(after.receipts).some((receipt) => receipt.routeId === bc.outbound.id && receipt.fingerprint === stateFingerprint(terminal)));
});

test("unexpected signed remote advance beyond local owner history fences owner recovery", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "owner-fence");
  await f.run(f.a, f.outbound);
  const state = await descriptor(f.a, "owner-fence");
  const privateKey = await readFile(path.join(f.a.home, "sync", `owner-${state.originInboxId}.pem`), "utf8");
  const unexpected = signOriginState({ ...state, version: state.version + 10, state: "deleted" }, privateKey);
  await assert.rejects(f.a.store.observeOutboundState(routeAuthorization(f.outbound), unexpected), /owner quarantined/);
  const ledger = await f.a.store.snapshot();
  assert.equal(ledger.worker.ownerQuarantined, true);
  assert.equal(Object.values(ledger.records)[0].state, "deleted");
  assert.equal(Object.values(ledger.records)[0].signature, unexpected.signature);
  await assert.rejects(f.a.store.publish(input, "forbidden"), /quarantine/);
  assert.equal((await f.run(f.a, f.outbound)).counters.requests, 0);
});

test("changed receiver incarnation invalidates custody even when the body still exists", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.a.store.publish(input, "incarnation");
  await f.run(f.a, f.outbound);
  const before = await f.b.store.snapshot();
  const oldReceipt = Object.values(before.receipts)[0];
  before.storageIncarnation = randomUUID();
  before.receipts = {};
  await writeFile(path.join(f.b.home, "sync", "ledger.json"), JSON.stringify(before));
  const state = await descriptor(f.a, "incarnation");
  await f.a.store.reconcileHoldings(routeAuthorization(f.outbound), [{ originInboxId: state.originInboxId, originDocumentId: state.originDocumentId,
    fingerprint: stateFingerprint(state), available: true, storageIncarnation: before.storageIncarnation }]);
  assert.equal(Object.values((await f.a.store.snapshot()).outbox)[0].disposition, "pending");
  await assert.rejects(f.a.store.acknowledge(routeAuthorization(f.outbound), oldReceipt), /replaced receiver/);
  const result = await f.run(f.a, f.outbound);
  assert.equal(result.routes[0].status, "confirmed");
  assert.equal(result.routes[0].transferred, 0);
  assert.equal(Object.values((await f.a.store.snapshot()).outbox)[0].receiverStorageIncarnation, before.storageIncarnation);
});

test("an already recovered process establishes durable custody after another process fails ledger-directory fsync", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.run(f.a, f.outbound);
  const reader = new ManagedSyncStore(f.b.home);
  await reader.recover();
  await f.a.store.publish(input, "failed-flush");
  const state = await descriptor(f.a, "failed-flush");
  const client = new SyncClient(f.a.store, f.a.peerId, f.credentials);
  const auth = routeAuthorization(f.outbound);
  const offer = await client.json(auth, "offer", { descriptor: state }, parseOfferResponse, WIRE_LIMITS.offer);
  assert.equal(offer.status, "needs-body");
  if (offer.status !== "needs-body") throw new Error("Expected staging");
  await f.bs.command({ type: "fail-directory-sync" });
  await assert.rejects(client.putBody(auth, offer.transferId, state, bytes));
  const failed = await f.bs.waitFor("fsync-failed");
  assert.equal(failed.hits, 1);
  const before = reader.counters.events["directory-flushed"] ?? 0;
  const cut = await reader.holdingsCut(routeAuthorization(f.inbound), [state]);
  assert.ok((reader.counters.events["directory-flushed"] ?? 0) > before);
  assert.equal(cut.holdings[0].available, true);
  assert.equal(cut.holdings[0].receipts.length, 1);
  assert.equal(cut.holdings[0].receipts[0].storageIncarnation, cut.storageIncarnation);
  assert.equal(reader.counters.htmlOpens, 0);
  assert.equal(reader.counters.hashPasses, 0);
});

for (const quota of ["bytes", "files"]) {
  test(`shared staging ${quota} quota preserves active leases and cleans failed owned streams`, { timeout: 25_000 }, async (t) => {
    const f = await pair(t);
    await f.run(f.a, f.outbound);
    await f.a.store.publish(input, "staged");
    const base = await descriptor(f.a, "staged");
    const privateKey = await readFile(path.join(f.a.home, "sync", `owner-${base.originInboxId}.pem`), "utf8");
    const state = signOriginState({ ...base, byteLength: quota === "bytes" ? 10 * 1024 * 1024 : base.byteLength }, privateKey);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* blocked() {
      await gate;
      throw new Error("Synthetic stream cancellation");
      yield Buffer.alloc(0);
    }

    const count = quota === "bytes" ? 6 : 16;
    const pending = Array.from({ length: count }, () => f.b.store.applyStream(routeAuthorization(f.inbound), state, blocked()));
    const observed = Promise.allSettled(pending);
    try {
      const deadline = Date.now() + 5000;
      while ((await readdir(path.join(f.b.home, "sync", "staging"))).length !== count * 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, count * 2);
      await new ManagedSyncStore(f.b.home).recover();
      assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, count * 2, "live ownership must survive recovery");
      await assert.rejects(f.b.store.applyStream(routeAuthorization(f.inbound), state, blocked()), /staging quota/);
    } finally {
      release();
      const results = await observed;
      assert.ok(results.every((result) => result.status === "rejected"));
    }

    assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, 0);
    assert.equal(Object.keys((await f.b.store.snapshot()).records).length, 0);
  });
}

for (const profile of ["lan", "tailscale"]) {
  test(`same application push/pull through synthetic ${profile} endpoint profile`, { timeout: 25_000 }, async (t) => {
    const f = await pair(t, { sourceListener: true });
    const outgoing = await startSyncHttpsProxy(t, { upstreamUrl: f.bs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
      profile: profile === "lan" ? "lan" : "tailscale", routes: [{ label: "wire", pathname: "/sync/v1/identity" }] });
    assert.ok(f.as);
    const incoming = await startSyncHttpsProxy(t, { upstreamUrl: f.as.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
      profile: profile === "lan" ? "lan" : "tailscale", routes: [{ label: "wire", pathname: "/sync/v1/identity" }] });
    const routes = await connect(f.a, f.b, incoming.url, outgoing.url);
    await f.a.store.publish(input, "profile-push");
    assert.equal((await f.run(f.a, routes.outbound)).routes[0].status, "confirmed");
    await f.a.store.publish(input, "profile-pull");
    assert.equal((await f.run(f.b, routes.inbound)).routes[0].fullyReconciled, true);
    assert.equal((await f.b.store.listDocuments()).length, 2);
    assert.equal((await outgoing.stats()).routes.wire.starts, 1);
    assert.equal((await incoming.stats()).routes.wire.starts, 1);
  });
}

for (const direction of ["push", "pull"]) {
  test(`real truncated ${direction} stream retains pending work and removes unused stages`, { timeout: 25_000 }, async (t) => {
    const f = await pair(t, { sourceListener: true });
    assert.ok(f.as);
    const proxy = await startSyncHttpsProxy(t, { upstreamUrl: direction === "push" ? f.bs.url : f.as.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
      routes: [{ label: "body", pathname: "/sync/v1/body", method: direction === "push" ? "PUT" : "GET" }],
      faults: [{ id: "truncated", route: "body", kind: direction === "push" ? "truncate-request" : "truncate-response", afterBytes: 11 }] });
    const routes = await connect(f.a, f.b, direction === "pull" ? proxy.url : f.as.url, direction === "push" ? proxy.url : f.bs.url);
    await f.a.store.publish(input, "truncated");
    const first = await f.run(direction === "push" ? f.a : f.b, direction === "push" ? routes.outbound : routes.inbound, { requestMs: 500 });
    assert.notEqual(first.routes[0].status, "confirmed");
    assert.equal((await proxy.stats()).faultHits.truncated, 1);
    assert.equal(Object.keys((await f.b.store.snapshot()).receipts).length, 0);
    assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, 0);
    await f.a.store.retry(routeAuthorization(routes.outbound));
    const recovered = await f.run(direction === "push" ? f.a : f.b, direction === "push" ? routes.outbound : routes.inbound);
    assert.equal(recovered.routes[0].status, "confirmed", JSON.stringify(recovered));
    assert.equal((await f.b.store.listDocuments()).length, 1);
  });
}


test("explicit LAN and Tailscale literal unicast bindings validate without starting any listener", async (t) => {
  const fixture = await inbox(t);
  const tls = await createSyncHttpsCredentials(t);
  const key = await readFile(tls.trusted.keyPath);
  const cert = await readFile(tls.trusted.certPath);
  for (const host of ["192.0.2.51", "100.64.12.34", "2001:db8::51", "fd7a:115c:a1e0::51"]) {
    const configured = createSyncIngestionServer({ store: fixture.store, peerId: fixture.peerId, key, cert, host, credentials: () => ({ token: opaqueToken() }) });
    assert.equal(configured.status().listening, false);
    assert.equal(configured.status().url, null);
    await configured.close();
  }

  for (const host of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "224.0.0.1", "ff02::1", "255.255.255.255", "localhost", "192.0.2.51:3217", "::ffff:0.0.0.0"]) {
    assert.throws(() => createSyncIngestionServer({ store: fixture.store, peerId: fixture.peerId, key, cert, host, credentials: () => ({ token: opaqueToken() }) }), /literal unicast/);
  }
});

test("body GET pins the requested fingerprint under lock and never substitutes a newer state", { timeout: 20_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  await f.a.store.publish(input, "pinned");
  const client = new SyncClient(f.b.store, f.b.peerId, f.credentials);
  const auth = routeAuthorization(f.inbound);
  const nonce = opaqueToken();
  const session = await client.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const page = await client.json(auth, "manifest", { op: "pull", sessionId: session.sessionId, cursor: null }, parseManifestPage, WIRE_LIMITS.page);
  await f.b.store.completeInventory(auth, page.evidence, page.descriptors, nonce);
  await client.json(auth, "manifest", { op: "ready", sessionId: session.sessionId, ready: { kind: "terminal-inventory-ready", evidence: page.evidence,
    ackNonce: session.challengeNonce, receiverPeerId: f.b.peerId, destinationInboxId: f.inbound.destinationInboxId,
    storageIncarnation: (await f.b.store.snapshot()).storageIncarnation } }, (value) => value, WIRE_LIMITS.identity);
  await f.a.store.deleteDocument("pinned");
  await assert.rejects(client.pullBody(auth, session.sessionId, page.descriptors[0]), (error: unknown) => error instanceof SyncProtocolError && error.status === 409);
  assert.equal(Object.keys((await f.b.store.snapshot()).records).length, 0);
  assert.equal((await f.run(f.b, f.inbound)).routes[0].status, "confirmed");
  assert.equal(Object.values((await f.b.store.snapshot()).records)[0].state, "deleted");
});

test("lost readiness ACK requires a fresh challenge and never counts metadata readiness as custody", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  const proxy = await startSyncHttpsProxy(t, { upstreamUrl: f.bs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
    routes: [{ label: "manifest", pathname: "/sync/v1/manifest" }], faults: [{ id: "lost-ready", route: "manifest", kind: "drop-response" }] });
  const routes = await connect(f.a, f.b, "https://127.0.0.1:1", proxy.url);
  await f.a.store.publish(input, "ready-only");
  const first = await f.run(f.a, routes.outbound, { requestMs: 500 });
  assert.notEqual(first.routes[0].status, "confirmed");
  assert.equal(first.routes[0].historyReady, false);
  assert.equal(Object.keys((await f.b.store.snapshot()).historyCheckpoints).length, 1);
  assert.equal(Object.keys((await f.b.store.snapshot()).receipts).length, 0);
  assert.equal((await f.a.store.deliveryStatus(routes.outbound.id, routes.outbound.sourceInboxId, "ready-only")).isCommitted, false);
  assert.equal((await proxy.stats()).faultHits["lost-ready"], 1);
  assert.equal((await f.run(f.a, routes.outbound)).routes[0].status, "confirmed");
});

test("a tombstone returned specifically by a superseded offer is observed without acknowledging stale live state", { timeout: 25_000 }, async (t) => {
  const f = await pair(t);
  const c = await inbox(t);
  const cs = await server(t, c, f.tls, f.token);
  const owner = (await f.a.store.snapshot()).originKeys[0];
  const proxy = await startSyncHttpsProxy(t, { upstreamUrl: cs.url, upstreamCaPath: f.tls.caPath, server: f.tls.trusted, directory: f.tls.directory,
    routes: [{ label: "holdings", pathname: "/sync/v1/holdings" }, { label: "offer", pathname: "/sync/v1/offer" }],
    faults: [{ id: "pause-holdings", route: "holdings", kind: "pause-response", times: 2 }] });
  const bc = await connect(f.b, c, f.bs.url, proxy.url, owner);
  await f.a.store.publish(input, "late-terminal");
  await f.run(f.a, f.outbound);
  const initial = f.run(f.b, bc.outbound);
  const firstPause = await proxy.waitForEvent((event) => event.type === "fault-hit");
  assert.equal(firstPause.type, "fault-hit");
  if (firstPause.type !== "fault-hit") throw new Error("Expected pause");
  proxy.release(firstPause.requestId);
  assert.equal((await initial).routes[0].status, "confirmed");
  const receiver = await c.store.snapshot();
  const record = Object.values(receiver.records)[0];
  assert.ok(record.bodyFile);
  await rm(path.join(c.home, "sync", "bodies", record.bodyFile));
  await f.a.store.deleteDocument("late-terminal");
  const terminal = await descriptor(f.a, "late-terminal");
  const sending = f.run(f.b, bc.outbound);
  const pause = await proxy.waitForEvent((event) => event.type === "fault-hit", { after: firstPause.sequence });
  if (pause.type !== "fault-hit") throw new Error("Expected second pause");
  await c.store.apply(routeAuthorization(bc.inbound), terminal);
  proxy.release(pause.requestId);
  const result = await sending;
  assert.equal(result.routes[0].status, "pending", JSON.stringify(result));
  const relay = await f.b.store.snapshot();
  assert.equal(Object.values(relay.records)[0].state, "deleted");
  const obligation = Object.values(relay.outbox).find((entry) => entry.routeId === bc.outbound.id);
  assert.equal(obligation?.disposition, "pending");
  assert.equal(obligation?.fingerprint, stateFingerprint(terminal));
  assert.equal((await f.run(f.b, bc.outbound)).routes[0].status, "confirmed");
});

test("a valid incoming cycle cannot advance restored owner history while leaving owner writes enabled", { timeout: 20_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  await f.a.store.publish(input, "incoming-owner-fence");
  await f.run(f.a, f.outbound);
  const owner = (await f.a.store.snapshot()).originKeys[0];
  const reverse = await connect(f.b, f.a, f.bs.url, f.as?.url ?? "https://127.0.0.1:1", owner);
  const state = await descriptor(f.a, "incoming-owner-fence");
  const privateKey = await readFile(path.join(f.a.home, "sync", `owner-${state.originInboxId}.pem`), "utf8");
  const terminal = signOriginState({ ...state, state: "deleted", version: state.version + 10 }, privateKey);
  await assert.rejects(f.a.store.apply(routeAuthorization(reverse.inbound), terminal), /owner quarantined/);
  const ledger = await f.a.store.snapshot();
  assert.equal(ledger.worker.ownerQuarantined, true);
  assert.equal(Object.values(ledger.records)[0].state, "deleted");
  assert.equal(Object.values(ledger.records)[0].signature, terminal.signature);
  assert.equal(await f.a.store.deleteDocument("incoming-owner-fence"), null);
  await assert.rejects(f.a.store.publish(input, "forbidden"), /quarantine/);
});

test("unknown stage ownership blocks admission and is never reclaimed merely because a file is old", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.run(f.a, f.outbound);
  await f.a.store.publish(input, "unknown-stage");
  const state = await descriptor(f.a, "unknown-stage");
  const staged = path.join(f.b.home, "sync", "staging", `${randomUUID()}.stage`);
  await writeFile(staged, Buffer.alloc(0), { mode: 0o600 });
  await writeFile(`${staged}.lease`, "{unfinished ownership", { mode: 0o600 });
  const before = await readFile(`${staged}.lease`);
  await assert.rejects(new ManagedSyncStore(f.b.home).recover());
  async function* chunks() { yield bytes; }
  await assert.rejects(f.b.store.applyStream(routeAuthorization(f.inbound), state, chunks()));
  assert.deepEqual(await readFile(`${staged}.lease`), before);
  assert.equal((await readdir(path.join(f.b.home, "sync", "staging"))).length, 2);
  assert.equal(Object.keys((await f.b.store.snapshot()).records).length, 0);
});


test("inherited NODE_TLS_REJECT_UNAUTHORIZED=0 cannot bypass the real sync client's verification", { timeout: 20_000 }, async (t) => {
  const tls = await createSyncHttpsCredentials(t);
  const token = opaqueToken();
  const a = await inbox(t);
  const b = await inbox(t);
  const receiver = await server(t, b, tls, token, { cert: "rogue" });
  const routes = await connect(a, b, "https://127.0.0.1:1", receiver.url);
  await a.store.publish(input, "environment-bypass");
  const configuration = { directory: __dirname, home: a.home, peerId: a.peerId, routeId: routes.outbound.id, token, caPath: tls.caPath };
  const script = `
    const path = require("node:path");
    const { readFileSync } = require("node:fs");
    const config = JSON.parse(process.argv[1]);
    const { ManagedSyncStore } = require(path.join(config.directory, "sync-store.js"));
    const { reconcileSyncRoutes } = require(path.join(config.directory, "sync-reconciliation.js"));
    reconcileSyncRoutes({ store: new ManagedSyncStore(config.home), peerId: config.peerId, routeIds: [config.routeId],
      credentials: () => ({ token: config.token, ca: readFileSync(config.caPath) }), requestMs: 1000, deadlineMs: 3000,
    }).then(result => process.stdout.write(JSON.stringify(result)), () => { process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["-e", script, JSON.stringify(configuration)], { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: a.home, XDG_CONFIG_HOME: a.home, ZDOTDIR: a.home, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
  let output = "";
  let diagnostics = "";
  let hasClosed = false;
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { hasClosed = true; resolve({ code, signal }); });
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  t.after(async () => {
    if (!hasClosed) child.kill("SIGKILL");
    await closed;
    clearTimeout(timer);
    if (child.pid) assert.throws(() => process.kill(child.pid ?? 0, 0), { code: "ESRCH" });
    t.diagnostic(`client child ${child.pid}: reaped`);
  });
  const exit = await closed;
  clearTimeout(timer);
  assert.equal(exit.code, 0, diagnostics);
  assert.equal(exit.signal, null);
  const result = parseObject(JSON.parse(output), "subprocess result");
  assert.ok(Array.isArray(result.routes));
  const route = parseObject(result.routes[0], "subprocess route result");
  assert.equal(route.status, "blocked");
  assert.equal(route.lastError, "tls-verification-failed");
  const status = await receiver.command({ type: "status" });
  assert.equal(parseObject(parseObject(status.status, "server status").counters, "counters").requests, 0);
  assert.equal(Object.keys((await b.store.snapshot()).records).length, 0);
});

test("a history-only blocked relay forwards current and later signed tombstones without live activation or HTML I/O", { timeout: 20_000 }, async (t) => {
  const tls = await createSyncHttpsCredentials(t);
  const token = opaqueToken();
  const ca = await readFile(tls.caPath);
  const a = await inbox(t);
  const b = await inbox(t);
  const c = await inbox(t);
  a.peerId = (await a.store.snapshot()).inboxId;
  b.peerId = (await b.store.snapshot()).inboxId;
  c.peerId = (await c.store.snapshot()).inboxId;
  const grant = (await a.store.snapshot()).originKeys[0];
  assert(grant);
  const ab = await connect(a, b, "https://127.0.0.1:1", "https://127.0.0.1:2");
  const cs = await server(t, c, tls, token);
  const bc = await connect(b, c, "https://127.0.0.1:2", cs.url, { ...grant, redistribute: true });
  const run = () => reconcileSyncRoutes({ store: b.store, peerId: b.peerId, credentials: () => ({ token, ca }), routeIds: [bc.outbound.id], deadlineMs: 3000 });
  const blocked = await run();
  assert.equal(blocked.routes[0].historyReady, false);
  assert.equal(blocked.routes[0].status, "blocked");
  assert.equal(blocked.routes[0].lastError, "trusted-history-unavailable");
  await b.store.recordRouteRun(routeAuthorization(bc.outbound), blocked.routes[0].lastError, true);
  const tokenPath = path.join(b.home, "synthetic-token");
  await writeFile(tokenPath, token, { mode: 0o600 });
  await b.store.configureRuntime({ ...defaultRuntimeConfig(), credentials: { synthetic_token: tokenPath }, trust: { synthetic_ca: tls.caPath } });
  await b.store.setWorkerEnabled(true);
  const worker = await startOwnedSyncWorker(b.home);
  try {
    for (const id of ["first-terminal", "later-terminal"]) {
      await a.store.publish(input, id);
      await a.store.deleteDocument(id);
      const terminal = await descriptor(a, id);
      assert.equal((await b.store.apply(routeAuthorization(ab.inbound), terminal)).status, "deleted");
      const before = { ...b.store.counters };
      const deadline = Date.now() + 5000;
      while (!(await c.store.snapshot()).records[canonicalKey(grant.inboxId, id)]) {
        assert(Date.now() < deadline, "The owned worker must drain a later terminal during its persisted history-only delay");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const destination = await c.store.snapshot();
      const installed = destination.records[canonicalKey(grant.inboxId, id)];
      assert(installed, "The authorized terminal must reach C while complete origin history remains unavailable");
      assert.deepEqual(toOriginState(installed), terminal);
      let delivery = await b.store.deliveryStatus(bc.outbound.id, grant.inboxId, id);
      while (delivery.status !== "deleted") {
        assert(Date.now() < deadline, "The sender must persist the exact terminal receipt");
        await new Promise((resolve) => setTimeout(resolve, 10));
        delivery = await b.store.deliveryStatus(bc.outbound.id, grant.inboxId, id);
      }

      assert.equal(delivery.status, "deleted");
      assert.equal(delivery.isCommitted, false);
      assert.equal(b.store.counters.htmlOpens, before.htmlOpens);
      assert.equal(b.store.counters.htmlBytes, before.htmlBytes);
      assert.equal(b.store.counters.hashPasses, before.hashPasses);
      assert.equal(b.store.counters.bodyTransfers, before.bodyTransfers);
    }
  } finally {
    await worker.close();
  }

  const relay = await b.store.snapshot();
  const destination = await c.store.snapshot();
  assert.equal(relay.routes[bc.outbound.id].state, "reconnecting");
  assert.equal(destination.routes[bc.inbound.id].state, "reconnecting");
  assert.equal(Object.keys(relay.historyCheckpoints).length, 0);
  assert.equal(Object.keys(relay.checkpoints).length, 0);
  assert.equal(Object.keys(destination.historyCheckpoints).length, 0);
  assert.equal(Object.keys(destination.checkpoints).length, 0);
  assert.equal((await c.store.listDocuments()).length, 0);
  const receiver = await cs.command({ type: "status" });
  const counters = parseObject(receiver.counters, "receiver counters");
  for (const name of ["htmlOpens", "htmlBytes", "hashPasses", "bodyTransfers"]) {
    assert.equal(counters[name], 0);
  }
});

test("route failure bookkeeping stops after the current durable update when its pass is cancelled", { timeout: 15_000 }, async (t) => {
  const f = await pair(t);
  for (const id of ["cancel-one", "cancel-two", "cancel-three"]) {
    await f.a.store.publish(input, id);
    await f.a.store.deleteDocument(id);
  }

  const controller = new AbortController();
  let bookkeepingWrites = 0;
  const perform = f.a.store.updateAttempt.bind(f.a.store);
  f.a.store.updateAttempt = async (...args) => {
    await perform(...args);
    bookkeepingWrites += 1;
    controller.abort();
  };
  await f.run(f.a, f.outbound, { credentials: () => ({ token: opaqueToken(), ca: f.ca }), signal: controller.signal });
  assert.equal(bookkeepingWrites, 1);
  const entries = Object.values((await f.a.store.snapshot()).outbox).filter((entry) => entry.routeId === f.outbound.id);
  assert.equal(entries.length, 3);
  assert.equal(entries.reduce((sum, entry) => sum + entry.attempts, 0), 1);
  assert.equal(entries.filter((entry) => entry.attempts === 0 && entry.disposition === "pending").length, 2);
});
