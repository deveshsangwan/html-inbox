import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { mock, type TestContext } from "node:test";
import { SyncClient } from "./sync-client";
import { createSyncHttpsCredentials, type SyncHttpsCredentials } from "./sync-https-fixtures";
import { outboxKey, parseLedger } from "./sync-ledger";
import { canonicalKey, parseObject, signOriginState, stateFingerprint, type OriginGrant, type SyncRoute } from "./sync-model";
import { startProtocolFaultChild } from "./sync-protocol-fault-child";
import { assertLoopbackClosed, startSyncApplication } from "./sync-protocol-fixture";
import { reconcileSyncRoutes, routeAuthorization, type ReconcileOptions } from "./sync-reconciliation";
import { ManagedSyncStore, toOriginState } from "./sync-store";
import { BINDING_HEADER, createEvidence, decodeJson, opaqueToken, parseHoldingsResponse, parseIdentityResponse, parseManifestPage, parseOfferResponse,
  parseReadiness, SyncProtocolError, WIRE_LIMITS, type RequestBinding } from "./sync-wire";
import { startViewerHttpServer } from "./viewer-http-server";

// Managed enrollment requires POSIX file/directory fsync; portable rejection is tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const bytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>Fault fixture π</body></html>\r\n");
const input = { originalBytes: bytes, title: "Synthetic wire fault", type: "report", sourceFileName: "fault.html" };

async function inbox(root: string, name: string) {
  const home = path.join(root, name);
  const store = new ManagedSyncStore(home);
  await store.enroll();

  return { home, store, peerId: randomUUID() };
}

type Inbox = Awaited<ReturnType<typeof inbox>>;

async function connect(source: Inbox, receiver: Inbox, sourceUrl: string, receiverUrl: string, grant?: OriginGrant) {
  const owner = await source.store.snapshot();
  const target = await receiver.store.snapshot();
  const origin = grant ?? owner.originKeys[0];
  assert.ok(origin);
  const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: receiver.peerId, peerUrl: receiverUrl,
    sourceInboxId: owner.inboxId, destinationInboxId: target.inboxId, localInboxName: "synthetic", readerAudience: "disposable test only",
    allowedOrigins: [{ ...origin }], credentialRef: "synthetic_token", tlsTrustRef: "synthetic_ca", state: "active", lastError: null };
  const outbound = await source.store.configureRoute(route);
  const inbound = await receiver.store.configureRoute({ ...route, direction: "inbound", peerId: source.peerId, peerUrl: sourceUrl });

  return { outbound, inbound };
}

type FixtureContext = Pick<TestContext, "after" | "diagnostic">;

async function application(t: FixtureContext, fixture: Inbox, tls: SyncHttpsCredentials, token: string, requestMs = 3000) {
  return startSyncApplication(t, { home: fixture.home, peerId: fixture.peerId, token, ...tls.trusted, requestMs });
}

async function pair(t: TestContext, options: { proxy?: boolean; sourceListener?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-protocol-faults-"));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, "Protocol fixture cleanup failed; shared store retained");
    }

    // Node runs after hooks in registration order; shared stores must outlive every writer.
    await rm(root, { recursive: true, force: true });
  });
  const context: FixtureContext = {
    after(close) {
      if (close) {
        cleanup.push(async () => { await close(t, () => {}); });
      }
    },
    diagnostic: (message) => t.diagnostic(message),
  };
  const tls = await createSyncHttpsCredentials(context);
  const token = opaqueToken();
  const ca = await readFile(tls.caPath);
  const source = await inbox(root, "source");
  const receiver = await inbox(root, "receiver");
  const receiverServer = await application(context, receiver, tls, token);
  const sourceServer = options.sourceListener ? await application(context, source, tls, token) : undefined;
  const proxy = options.proxy ? await startProtocolFaultChild(context, { mode: "proxy", home: tls.directory, upstreamUrl: receiverServer.url,
    caPath: tls.caPath, ...tls.trusted }) : undefined;
  const routes = await connect(source, receiver, sourceServer?.url ?? "https://127.0.0.1:1", proxy?.url ?? receiverServer.url);
  const credentials = () => ({ token, ca });
  const run = (fixture = source, route = routes.outbound, settings: Partial<ReconcileOptions> = {}) =>
    reconcileSyncRoutes({ store: fixture.store, peerId: fixture.peerId, credentials, routeIds: [route.id], requestMs: 1500, deadlineMs: 8000, ...settings });

  return { root, context, tls, token, ca, source, receiver, sourceServer, receiverServer, proxy, credentials, run, ...routes };
}

type Pair = Awaited<ReturnType<typeof pair>>;

async function stateFor(fixture: Inbox, id: string) {
  const ledger = await fixture.store.snapshot();
  const record = ledger.records[canonicalKey(ledger.inboxId, id)];
  assert.ok(record);

  return toOriginState(record);
}

async function bindingFor(caller: Inbox, route: SyncRoute): Promise<RequestBinding> {
  const local = await caller.store.snapshot();
  return { protocolVersion: 1, routeId: route.id, revision: route.revision, callerPeerId: caller.peerId, targetPeerId: route.peerId,
    sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId, callerStorageIncarnation: local.storageIncarnation };
}

async function request(url: string, ca: Buffer, token: string, binding: unknown, pathname: string, body = Buffer.from("{}"), method = "POST",
  extraHeaders: Record<string, string | undefined> = {}) {
  const target = new URL(pathname, url);
  assert.ok(["127.0.0.1", "[::1]"].includes(target.hostname));

  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const pending = https.request(target, { ca, agent: false, method, headers: { authorization: `Bearer ${token}`,
      [BINDING_HEADER]: Buffer.from(JSON.stringify(binding)).toString("base64url"), "content-type": method === "PUT" ? "application/octet-stream" : "application/json",
      "content-length": String(body.length), ...extraHeaders } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    const timer = setTimeout(() => pending.destroy(new Error("Bounded synthetic request deadline")), 3000);
    pending.once("close", () => clearTimeout(timer));
    pending.on("error", reject);
    pending.end(body);
  });
}

async function diskLedger(fixture: Inbox) {
  return parseLedger(decodeJson(await readFile(path.join(fixture.home, "sync", "ledger.json"))));
}

async function serverStatus(server: Awaited<ReturnType<typeof application>>) {
  const reply = await server.command({ type: "status" });
  return { storage: parseObject(reply.counters, "storage counters"), network: parseObject(parseObject(reply.status, "server status").counters, "network counters") };
}

function expectProtocolStatus(status: number) {
  return (error: unknown) => error instanceof SyncProtocolError && error.status === status;
}

async function faultProof(proxy: NonNullable<Pair["proxy"]>) {
  const proof = await proxy.command({ type: "status" });
  assert.equal(proof.hits, 1);
  assert.equal(proof.armed, false);
  assert.equal(proxy.messages.filter((message) => message.type === "fault").length, 1);
}

test("every protected endpoint rejects all identity bindings before reading or disclosing live and terminal records", { timeout: 30_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  assert.ok(f.sourceServer);
  await f.source.store.publish(input, "private-live");
  await f.source.store.publish(input, "private-terminal");
  assert.equal((await f.run()).routes[0].status, "confirmed");
  await f.source.store.deleteDocument("private-terminal");
  assert.equal((await f.run()).routes[0].status, "confirmed");
  const beforeReceiver = await serverStatus(f.receiverServer);
  const beforeSource = await serverStatus(f.sourceServer);
  const destinations = [
    { url: f.receiverServer.url, caller: f.source, route: f.outbound, pathname: "/sync/v1/identity", method: "POST" },
    { url: f.receiverServer.url, caller: f.source, route: f.outbound, pathname: "/sync/v1/manifest", method: "POST" },
    { url: f.receiverServer.url, caller: f.source, route: f.outbound, pathname: "/sync/v1/holdings", method: "POST" },
    { url: f.receiverServer.url, caller: f.source, route: f.outbound, pathname: "/sync/v1/offer", method: "POST" },
    { url: f.receiverServer.url, caller: f.source, route: f.outbound, pathname: `/sync/v1/body?transferId=${opaqueToken()}`, method: "PUT" },
    { url: f.sourceServer.url, caller: f.receiver, route: f.inbound, pathname: `/sync/v1/body?sessionId=${opaqueToken()}`, method: "GET" },
  ];
  let rejected = 0;
  for (const endpoint of destinations) {
    const binding = await bindingFor(endpoint.caller, endpoint.route);
    const variants = [{ token: opaqueToken(), binding }, { token: f.token, binding: { ...binding, protocolVersion: 2 } },
      { token: f.token, binding: { ...binding, revision: 9 } },
      ...["callerPeerId", "targetPeerId", "sourceInboxId", "destinationInboxId", "routeId"].map((key) => ({ token: f.token, binding: { ...binding, [key]: randomUUID() } }))];
    for (const variant of variants) {
      const result = await request(endpoint.url, f.ca, variant.token, variant.binding, endpoint.pathname, Buffer.from("private-body-must-not-be-consumed"), endpoint.method);
      assert.equal(result.status, 403, endpoint.pathname);
      assert.deepEqual(decodeJson(result.body), { error: "unauthorized" });
      rejected += 1;
    }
  }

  assert.equal(rejected, 48);
  const afterReceiver = await serverStatus(f.receiverServer);
  const afterSource = await serverStatus(f.sourceServer);
  assert.equal(afterReceiver.network.requestBytes, beforeReceiver.network.requestBytes);
  assert.equal(afterSource.network.requestBytes, beforeSource.network.requestBytes);
  assert.equal(afterReceiver.storage.htmlOpens, beforeReceiver.storage.htmlOpens);
  assert.equal(afterSource.storage.htmlOpens, beforeSource.storage.htmlOpens);
  const binding = await bindingFor(f.source, f.outbound);
  const live = await stateFor(f.source, "private-live");
  const terminal = await stateFor(f.source, "private-terminal");
  for (const state of [live, terminal]) {
    for (const changed of [{ ...state, originInboxId: randomUUID() }, { ...state, historyEpoch: randomUUID() }]) {
      const result = await request(f.receiverServer.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: changed })));
      assert.equal(result.status, 403);
      assert.deepEqual(decodeJson(result.body), { error: "unauthorized" });
    }
  }

  const client = new SyncClient(f.source.store, f.source.peerId, f.credentials);
  const holdings = await client.json(routeAuthorization(f.outbound), "holdings", { identities: [live, terminal].map(({ originInboxId, originDocumentId }) =>
    ({ originInboxId, originDocumentId })) }, parseHoldingsResponse, WIRE_LIMITS.holdings);
  assert.equal(holdings.holdings[0].available, true);
  assert.equal(holdings.holdings[1].state?.state, "deleted");
  assert.equal(holdings.holdings[1].available, false);
  t.diagnostic("48 binding rejections and 4 origin/epoch rejections; no protected payload bytes consumed");
});

test("ingestion has no process administration; actual reader and private control listeners cannot ingest", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  const binding = await bindingFor(f.source, f.outbound);
  for (const pathname of ["/control", "/api/publish", "/api/delete", "/shutdown", "/sync/v1/admin"]) {
    const response = await request(f.receiverServer.url, f.ca, f.token, binding, pathname);
    assert.equal(response.status, 403);
    assert.deepEqual(decodeJson(response.body), { error: "unauthorized" });
  }

  const identity = await f.receiver.store.snapshot();
  const viewer = await startViewerHttpServer(f.receiver.store, { port: 0, host: "127.0.0.1", exposure: "loopback" },
    { instanceId: identity.inboxId, processId: randomUUID(), protocolVersion: 1, pid: process.pid }, f.receiver.home);
  f.context.after(async () => {
    await viewer.close();
    await assertLoopbackClosed(viewer.urls[0]);
    await assertLoopbackClosed(viewer.controlUrl);
    t.diagnostic("reader and private control ports rebound");
  });
  for (const origin of [viewer.urls[0], new URL(viewer.controlUrl).origin]) {
    for (const endpoint of ["identity", "manifest", "holdings", "offer", "body"]) {
      const result = await new Promise<number>((resolve, reject) => {
        const pending = http.request(new URL(`/sync/v1/${endpoint}`, origin), { method: endpoint === "body" ? "PUT" : "POST", agent: false,
          headers: { "content-type": "application/json", "content-length": "2" } }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        pending.setTimeout(2000, () => pending.destroy(new Error("Reader isolation deadline")));
        pending.on("error", reject);
        pending.end("{}");
      });
      assert.ok(result >= 400 && result < 500, `${origin}: ${endpoint} returned ${result}`);
    }
  }

  assert.equal(Object.keys((await f.receiver.store.snapshot()).records).length, 0);
});

test("malformed JSON, UTF-8, headers, URL and declared lengths cannot install or create history", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  const binding = await bindingFor(f.source, f.outbound);
  const cases = [
    { body: Buffer.from("{bad"), headers: {}, expected: 409 },
    { body: Buffer.from([0xff, 0xfe]), headers: {}, expected: 409 },
    { body: Buffer.from(JSON.stringify({ nonce: opaqueToken(), unexpected: true })), headers: {}, expected: 409 },
    { body: Buffer.from(JSON.stringify({ nonce: opaqueToken() })), headers: { "content-type": "text/plain" }, expected: 409 },
    { body: Buffer.from(JSON.stringify({ nonce: opaqueToken() })), headers: { "content-encoding": "br" }, expected: 409 },
    { body: Buffer.alloc(4097, 32), headers: {}, expected: 413 },
  ];
  for (const item of cases) {
    const response = await request(f.receiverServer.url, f.ca, f.token, binding, "/sync/v1/identity", item.body, "POST", item.headers);
    assert.equal(response.status, item.expected);
  }

  await assert.rejects(request(f.receiverServer.url, f.ca, f.token, binding, "/sync/v1/identity", Buffer.from("{}"), "POST", { "x-large": "x".repeat(17 * 1024) }));
  const oversizedUrl = await request(f.receiverServer.url, f.ca, f.token, binding, `/sync/v1/identity?${"x".repeat(2050)}`);
  assert.equal(oversizedUrl.status, 403);
  await assert.rejects(request(f.receiverServer.url, f.ca, f.token, binding, "/sync/v1/identity", Buffer.from("{}"), "POST", { "content-length": "1" }), { code: "ECONNRESET" });
  const status = await f.receiverServer.command({ type: "status" });
  assert.equal(parseObject(status.status, "server status").sessions, 0);
  assert.equal(Object.keys((await f.receiver.store.snapshot()).historyCheckpoints).length, 0);
  assert.equal(Object.keys((await f.receiver.store.snapshot()).receipts).length, 0);
});

for (const kind of ["accepted", "redirect", "compressed", "json", "utf8", "extra", "oversized", "headers", "length"]) {
  test(`actual client rejects ${kind} identity response and leaves recoverable work`, { timeout: 20_000 }, async (t) => {
    const f = await pair(t, { proxy: true });
    assert.ok(f.proxy);
    await f.source.store.publish(input, "malformed-response");
    await f.proxy.command({ type: "arm", pathname: "/sync/v1/identity", method: "POST", kind });
    const result = await f.run(f.source, f.outbound, { requestMs: 500 });
    assert.notEqual(result.routes[0].status, "confirmed", JSON.stringify(result));
    assert.equal(result.routes[0].historyReady, false);
    assert.equal((await f.source.store.deliveryStatus(f.outbound.id, f.outbound.sourceInboxId, "malformed-response")).isCommitted, false);
    const ledger = await f.source.store.snapshot();
    assert.equal(Object.values(ledger.outbox).filter((entry) => entry.disposition !== "retired").length, 1);
    assert.equal(Object.keys(ledger.receipts).length, 0);
    assert.equal(Object.keys((await f.receiver.store.snapshot()).records).length, 0);
    assert.equal((await serverStatus(f.receiverServer)).network.requests, 1, "redirects must not be followed");
    await faultProof(f.proxy);
    await f.source.store.retry(routeAuthorization(f.outbound));
    assert.equal((await f.run()).routes[0].status, "confirmed");
    assert.equal((await f.receiver.store.listDocuments()).length, 1);
  });
}

for (const fault of [
  { kind: "exists", endpoint: "offer", method: "POST", hasRemoteCommit: false },
  { kind: "ack", endpoint: "manifest", method: "POST", hasRemoteCommit: false },
  { kind: "accepted", endpoint: "body", method: "PUT", hasRemoteCommit: true },
  { kind: "receipt", endpoint: "body", method: "PUT", hasRemoteCommit: true },
]) {
  test(`${fault.kind} at ${fault.endpoint} cannot replace a valid durable receipt`, { timeout: 20_000 }, async (t) => {
    const f = await pair(t, { proxy: true });
    assert.ok(f.proxy);
    await f.source.store.publish(input, "custody-proof");
    await f.proxy.command({ type: "arm", pathname: `/sync/v1/${fault.endpoint}`, method: fault.method, kind: fault.kind });
    const result = await f.run();
    assert.notEqual(result.routes[0].status, "confirmed", JSON.stringify(result));
    assert.equal((await f.source.store.deliveryStatus(f.outbound.id, f.outbound.sourceInboxId, "custody-proof")).isCommitted, false);
    assert.equal(Object.keys((await f.source.store.snapshot()).receipts).length, 0);
    const receiver = await f.receiver.store.snapshot();
    assert.equal(Object.keys(receiver.receipts).length, fault.hasRemoteCommit ? 1 : 0);
    assert.equal(Object.keys(receiver.records).length, fault.hasRemoteCommit ? 1 : 0);
    await faultProof(f.proxy);
    await f.source.store.retry(routeAuthorization(f.outbound));
    const recovered = await f.run();
    assert.equal(recovered.routes[0].status, "confirmed", JSON.stringify(recovered));
    assert.equal(recovered.routes[0].transferred, fault.hasRemoteCommit ? 0 : 1);
    const after = await f.receiver.store.snapshot();
    assert.equal(Object.keys(after.records).length, 1);
    if (fault.hasRemoteCommit) {
      assert.deepEqual(after.receipts, receiver.receipts);
    }
  });
}

test("opaque manifest cursors reject cross-session and cross-route reuse and retain a cut across owner deletion", { timeout: 30_000 }, async (t) => {
  const f = await pair(t, { sourceListener: true });
  assert.ok(f.sourceServer);
  for (let index = 0; index < 129; index += 1) {
    await f.source.store.publish(input, `cut-${String(index).padStart(3, "0")}`);
  }

  const duplicate = await connect(f.source, f.receiver, f.sourceServer.url, f.receiverServer.url);
  const client = new SyncClient(f.receiver.store, f.receiver.peerId, f.credentials);
  const auth = routeAuthorization(f.inbound);
  const otherAuth = routeAuthorization(duplicate.inbound);
  const nonce = opaqueToken();
  const session = await client.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const second = await client.json(auth, "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity);
  const other = await client.json(otherAuth, "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity);
  const first = await client.json(auth, "manifest", { op: "pull", sessionId: session.sessionId, cursor: null }, parseManifestPage, WIRE_LIMITS.page);
  assert.equal(first.descriptors.length, 128);
  assert.ok(first.nextCursor);
  await assert.rejects(client.json(auth, "manifest", { op: "pull", sessionId: second.sessionId, cursor: first.nextCursor }, parseManifestPage, WIRE_LIMITS.page), expectProtocolStatus(409));
  await assert.rejects(client.json(otherAuth, "manifest", { op: "pull", sessionId: session.sessionId, cursor: first.nextCursor }, parseManifestPage, WIRE_LIMITS.page), expectProtocolStatus(403));
  await assert.rejects(client.json(otherAuth, "manifest", { op: "pull", sessionId: other.sessionId, cursor: first.nextCursor }, parseManifestPage, WIRE_LIMITS.page), expectProtocolStatus(409));
  await f.source.store.deleteDocument("cut-128");
  const last = await client.json(auth, "manifest", { op: "pull", sessionId: session.sessionId, cursor: first.nextCursor }, parseManifestPage, WIRE_LIMITS.page);
  assert.deepEqual(last.evidence, first.evidence);
  assert.equal(last.descriptors.length, 1);
  assert.equal(last.descriptors[0].state, "live");
  assert.equal(last.nextCursor, null);
  const states = [...first.descriptors, ...last.descriptors];
  await f.receiver.store.completeInventory(auth, last.evidence, states, nonce);
  await client.json(auth, "manifest", { op: "ready", sessionId: session.sessionId, ready: { kind: "terminal-inventory-ready", evidence: last.evidence,
    ackNonce: session.challengeNonce, receiverPeerId: f.receiver.peerId, destinationInboxId: f.inbound.destinationInboxId,
    storageIncarnation: (await f.receiver.store.snapshot()).storageIncarnation } }, (value) => value, WIRE_LIMITS.identity);
  await assert.rejects(client.pullBody(auth, session.sessionId, last.descriptors[0]), expectProtocolStatus(409));
  assert.equal(Object.keys((await f.receiver.store.snapshot()).checkpoints).length, 0);

  const sourceClient = new SyncClient(f.source.store, f.source.peerId, f.credentials);
  const sourceAuth = routeAuthorization(f.outbound);
  const freshNonce = opaqueToken();
  const freshSession = await sourceClient.json(sourceAuth, "identity", { nonce: freshNonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const cut = await f.source.store.inventory(sourceAuth);
  const evidence = createEvidence(f.outbound, f.source.peerId, freshSession.challengeNonce, cut);
  await sourceClient.json(sourceAuth, "manifest", { op: "push", sessionId: freshSession.sessionId,
    page: { evidence, pageNumber: 0, descriptors: cut.states.slice(0, 128), nextCursor: opaqueToken() } }, (value) => value, WIRE_LIMITS.readiness);
  const ready = await sourceClient.json(sourceAuth, "manifest", { op: "push", sessionId: freshSession.sessionId,
    page: { evidence, pageNumber: 1, descriptors: cut.states.slice(128), nextCursor: null } }, parseReadiness, WIRE_LIMITS.readiness);
  await f.source.store.activateOutbound(sourceAuth, ready, evidence, freshNonce, f.receiver.peerId);
  const receiver = await f.receiver.store.snapshot();
  assert.equal(receiver.records[canonicalKey(f.outbound.sourceInboxId, "cut-128")].state, "deleted");
  assert.equal(receiver.records[canonicalKey(f.outbound.sourceInboxId, "cut-128")].signature, cut.states[128].signature);
  assert.equal(Object.keys(receiver.checkpoints).length, 0);
  assert.equal(Object.keys(receiver.receipts).length, 1);
  assert.equal((await f.receiver.store.listDocuments()).length, 0);
});

test("an older HTTPS server establishes durability before exposing another process's uncertain custody", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  assert.equal((await f.run()).routes[0].status, "confirmed");
  const oldReader = await application(f.context, f.receiver, f.tls, f.token);
  const binding = await bindingFor(f.source, f.outbound);
  const identities = [{ originInboxId: f.outbound.sourceInboxId, originDocumentId: "uncertain-wire" }];
  const empty = await request(oldReader.url, f.ca, f.token, binding, "/sync/v1/holdings", Buffer.from(JSON.stringify({ identities })));
  assert.equal(parseHoldingsResponse(decodeJson(empty.body)).holdings[0].state, null);
  const before = await serverStatus(oldReader);
  await f.source.store.publish(input, "uncertain-wire");
  const state = await stateFor(f.source, "uncertain-wire");
  const client = new SyncClient(f.source.store, f.source.peerId, f.credentials);
  const auth = routeAuthorization(f.outbound);
  const offer = await client.json(auth, "offer", { descriptor: state }, parseOfferResponse, WIRE_LIMITS.offer);
  assert.equal(offer.status, "needs-body");
  if (offer.status !== "needs-body") {
    throw new Error("Expected an application body transfer");
  }

  await f.receiverServer.command({ type: "fail-directory-sync" });
  await assert.rejects(client.putBody(auth, offer.transferId, state, bytes), expectProtocolStatus(503));
  assert.equal((await f.receiverServer.waitFor("fsync-failed")).hits, 1);
  assert.equal(f.receiverServer.messages.filter((message) => message.type === "fsync-failed").length, 1);
  const response = await request(oldReader.url, f.ca, f.token, binding, "/sync/v1/holdings", Buffer.from(JSON.stringify({ identities })));
  assert.equal(response.status, 200);
  const cut = parseHoldingsResponse(decodeJson(response.body));
  assert.equal(cut.holdings[0].available, true);
  assert.equal(cut.holdings[0].receipts.length, 1);
  assert.equal(cut.holdings[0].receipts[0].storageIncarnation, cut.storageIncarnation);
  assert.equal(cut.holdings[0].receipts[0].fingerprint, stateFingerprint(state));
  assert.deepEqual(cut.holdings[0].state, state);
  const after = await serverStatus(oldReader);
  assert.ok(Number(parseObject(after.storage.events, "storage events")["directory-flushed"]) > Number(parseObject(before.storage.events, "storage events")["directory-flushed"]));
  assert.equal(after.storage.htmlOpens, 0);
  assert.equal(after.storage.hashPasses, 0);
  assert.equal(after.storage.bodyTransfers, 0);
});

for (const damage of ["missing", "truncated", "nonregular"]) {
  test(`empty physical outbox durably requeues ${damage} receiver body before any repair bytes`, { timeout: 20_000 }, async (t) => {
    const f = await pair(t, { proxy: true });
    assert.ok(f.proxy);
    await f.source.store.publish(input, "durable-repair");
    assert.equal((await f.run()).routes[0].status, "confirmed");
    const original = await stateFor(f.source, "durable-repair");
    const sender = await diskLedger(f.source);
    sender.outbox = {};
    // This simulates completed-outbox cleanup on an idle synthetic ledger, not a production cleanup command.
    await writeFile(path.join(f.source.home, "sync", "ledger.json"), JSON.stringify(sender));
    const receiver = await f.receiver.store.snapshot();
    const record = receiver.records[canonicalKey(original.originInboxId, original.originDocumentId)];
    assert.ok(record.bodyFile);
    const bodyPath = path.join(f.receiver.home, "sync", "bodies", record.bodyFile);
    if (damage === "truncated") {
      await writeFile(bodyPath, bytes.subarray(0, -1));
    } else {
      await rm(bodyPath);
      if (damage === "nonregular") {
        await mkdir(bodyPath);
      }
    }

    const before = await serverStatus(f.receiverServer);
    await f.proxy.command({ type: "arm", pathname: "/sync/v1/offer", method: "POST", kind: "pause" });
    const sending = f.run(f.source, f.outbound, { requestMs: 2500 });
    const observed = Promise.allSettled([sending]);
    try {
      await f.proxy.waitFor("paused");
      const durable = await diskLedger(f.source);
      const obligation = durable.outbox[outboxKey(f.outbound.id, f.outbound.revision, canonicalKey(original.originInboxId, original.originDocumentId))];
      assert.ok(obligation);
      assert.equal(obligation.disposition, "pending");
      assert.equal(obligation.fingerprint, stateFingerprint(original));
      assert.equal(obligation.attempts, 0);
      const during = await serverStatus(f.receiverServer);
      assert.equal(during.storage.bodyTransfers, before.storage.bodyTransfers);
      assert.deepEqual((await f.receiver.store.snapshot()).receipts, receiver.receipts, "historical receipt remains separate from present availability");
      assert.equal((await f.source.store.deliveryStatus(f.outbound.id, original.originInboxId, original.originDocumentId)).isCommitted, false);
    } finally {
      await f.proxy.command({ type: "release" });
    }

    const result = await sending;
    await observed;
    assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
    assert.equal(result.routes[0].transferred, 1);
    await faultProof(f.proxy);
    const documents = await f.receiver.store.listDocuments();
    assert.equal(documents.length, 1);
    assert.deepEqual((await f.receiver.store.getDocument(documents[0].id))?.originalBytes, bytes);
    assert.equal((await readdir(path.join(f.receiver.home, "sync", "staging"))).length, 0);
    t.diagnostic("Quiescent synthetic ledger cleanup was simulated; repair obligation was read from disk while the offer response was paused");
  });
}

test("repeated actual holdings polls preserve blocked repair attempts and errors after a historical receipt", { timeout: 20_000 }, async (t) => {
  const f = await pair(t, { proxy: true });
  assert.ok(f.proxy);
  await f.source.store.publish(input, "blocked-repair");
  assert.equal((await f.run()).routes[0].status, "confirmed");
  const source = await diskLedger(f.source);
  source.outbox = {};
  await writeFile(path.join(f.source.home, "sync", "ledger.json"), JSON.stringify(source));
  const receiver = await f.receiver.store.snapshot();
  const record = Object.values(receiver.records)[0];
  assert.ok(record.bodyFile);
  await rm(path.join(f.receiver.home, "sync", "bodies", record.bodyFile));
  await f.proxy.command({ type: "arm", pathname: "/sync/v1/offer", method: "POST", kind: "accepted" });
  const first = await f.run(f.source, f.outbound, { maxAttempts: 1 });
  assert.equal(first.routes[0].blocked, 1, JSON.stringify(first));
  const blocked = Object.values((await diskLedger(f.source)).outbox)[0];
  assert.equal(blocked.disposition, "blocked");
  assert.equal(blocked.attempts, 1);
  assert.ok(blocked.lastError);
  const before = parseObject((await f.proxy.command({ type: "status" })).starts, "proxy starts");
  for (let pass = 0; pass < 3; pass += 1) {
    const result = await f.run();
    assert.equal(result.routes[0].status, "blocked");
    assert.deepEqual(Object.values((await diskLedger(f.source)).outbox)[0], blocked);
  }

  const after = parseObject((await f.proxy.command({ type: "status" })).starts, "proxy starts");
  assert.equal(Number(after["POST /sync/v1/holdings"]), Number(before["POST /sync/v1/holdings"]) + 3);
  assert.equal(after["POST /sync/v1/offer"], before["POST /sync/v1/offer"]);
  assert.equal(after["PUT /sync/v1/body"], before["PUT /sync/v1/body"]);
  await faultProof(f.proxy);
  assert.equal((await f.source.store.deliveryStatus(f.outbound.id, record.originInboxId, record.originDocumentId)).isCommitted, false);
  await f.source.store.retry(routeAuthorization(f.outbound));
  assert.equal((await f.run()).routes[0].status, "confirmed");
});

test("actual sender process killed after receipt persistence recovers retirement without retransmitting bytes", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.source.store.publish(input, "sender-crash");
  const original = await stateFor(f.source, "sender-crash");
  const runner = await startProtocolFaultChild(f.context, { mode: "runner", home: f.source.home, peerId: f.source.peerId, token: f.token, caPath: f.tls.caPath });
  await runner.command({ type: "arm" });
  const sending = runner.command({ type: "run", routeIds: [f.outbound.id] });
  const observed = Promise.allSettled([sending]);
  const fault = await runner.waitFor("fault");
  assert.equal(fault.event, "receipt-before-retirement");
  assert.equal(fault.hits, 1);
  assert.equal(runner.messages.filter((message) => message.type === "fault").length, 1);
  const durable = await diskLedger(f.source);
  const obligation = durable.outbox[outboxKey(f.outbound.id, 1, canonicalKey(original.originInboxId, original.originDocumentId))];
  assert.equal(obligation.disposition, "pending");
  assert.equal(Object.keys(durable.receipts).length, 1);
  const receiver = await f.receiver.store.snapshot();
  assert.equal(Object.keys(receiver.records).length, 1);
  assert.equal(Object.keys(receiver.receipts).length, 1);
  await runner.stop(true);
  assert.equal((await observed)[0].status, "rejected");
  const before = await serverStatus(f.receiverServer);
  const restarted = new ManagedSyncStore(f.source.home);
  await restarted.recover();
  const result = await f.run(f.source, f.outbound, { store: restarted });
  assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
  assert.equal(result.routes[0].transferred, 0);
  assert.equal(restarted.counters.htmlOpens, 0);
  assert.deepEqual((await f.receiver.store.snapshot()).receipts, receiver.receipts);
  assert.equal((await serverStatus(f.receiverServer)).storage.bodyTransfers, before.storage.bodyTransfers);
});

test("five unchanged wire passes open, hash and transfer zero managed HTML with positive calibration", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.source.store.publish(input, "no-op-wire");
  const runner = await startProtocolFaultChild(f.context, { mode: "runner", home: f.source.home, peerId: f.source.peerId, token: f.token, caPath: f.tls.caPath });
  const first = await runner.command({ type: "run", routeIds: [f.outbound.id] });
  assert.equal(first.error, undefined);
  assert.ok(Number(first.htmlReadOpens) > 0, "filesystem read-open probe must observe the actual first transfer");
  const receiverBefore = await serverStatus(f.receiverServer);
  assert.ok(Number(receiverBefore.storage.hashPasses) > 0);
  assert.ok(Number(receiverBefore.storage.bodyTransfers) > 0);
  const before = parseObject(first.counters, "source counters");
  for (let pass = 0; pass < 5; pass += 1) {
    const reply = await runner.command({ type: "run", routeIds: [f.outbound.id] });
    assert.equal(reply.error, undefined);
    const result = parseObject(reply.result, "reconciliation result");
    assert.ok(Array.isArray(result.routes));
    assert.equal(parseObject(result.routes[0], "route result").status, "confirmed");
    assert.equal(reply.htmlReadOpens, first.htmlReadOpens);
    const counters = parseObject(reply.counters, "source counters");
    for (const key of ["htmlOpens", "htmlBytes", "hashPasses", "bodyTransfers"]) {
      assert.equal(counters[key], before[key], key);
    }
  }

  const receiverAfter = await serverStatus(f.receiverServer);
  for (const key of ["htmlOpens", "htmlBytes", "hashPasses", "bodyTransfers"]) {
    assert.equal(receiverAfter.storage[key], receiverBefore.storage[key], key);
  }

  const calibrated = await runner.command({ type: "read", localId: "no-op-wire" });
  assert.equal(calibrated.result, bytes.length);
  assert.ok(Number(calibrated.htmlReadOpens) > Number(first.htmlReadOpens), "explicit reader oracle must increment the same filesystem probe");
  t.diagnostic("Five actual HTTPS passes: zero additional managed HTML read opens, bytes, hashes or transfers; explicit oracle read counted separately");
});

test("cross-process local revoke after remote commit fences all later starts and cannot retract remote custody", { timeout: 20_000 }, async (t) => {
  const f = await pair(t, { proxy: true });
  assert.ok(f.proxy);
  await f.source.store.publish(input, "revoke-after-commit");
  await f.proxy.command({ type: "arm", pathname: "/sync/v1/body", method: "PUT", kind: "pause" });
  const runner = await startProtocolFaultChild(f.context, { mode: "runner", home: f.source.home, peerId: f.source.peerId, token: f.token, caPath: f.tls.caPath });
  const sending = runner.command({ type: "run", routeIds: [f.outbound.id] });
  const observed = Promise.allSettled([sending]);
  await f.proxy.waitFor("paused");
  const committed = await f.receiver.store.snapshot();
  assert.equal(Object.keys(committed.receipts).length, 1);
  await new ManagedSyncStore(f.source.home).revokeRoute(f.outbound.id, 1);
  const reply = await sending;
  await observed;
  assert.equal(reply.error, undefined);
  const result = parseObject(reply.result, "reconciliation result");
  assert.ok(Array.isArray(result.routes));
  assert.equal(parseObject(result.routes[0], "route result").status, "aborted");
  const before = parseObject((await f.proxy.command({ type: "status" })).starts, "proxy starts");
  let resolutions = 0;
  const credentials = () => {
    resolutions += 1;
    return f.credentials();
  };
  const client = new SyncClient(f.source.store, f.source.peerId, credentials);
  for (let pass = 0; pass < 5; pass += 1) {
    const revoked = await f.run(f.source, f.outbound, { credentials });
    assert.equal(revoked.counters.requests, 0);
    assert.equal(revoked.routes[0].status, "detached");
    for (const endpoint of ["identity", "manifest", "holdings", "offer"] satisfies Parameters<SyncClient["json"]>[1][]) {
      await assert.rejects(client.json(routeAuthorization(f.outbound), endpoint, {}, (value) => value, WIRE_LIMITS.identity), /route authorization/);
    }
  }

  assert.equal(resolutions, 0);
  assert.deepEqual(parseObject((await f.proxy.command({ type: "status" })).starts, "proxy starts"), before);
  await faultProof(f.proxy);
  await f.proxy.command({ type: "release" });
  assert.deepEqual((await f.receiver.store.snapshot()).receipts, committed.receipts);
  const local = (await f.receiver.store.listDocuments())[0];
  assert.deepEqual((await f.receiver.store.getDocument(local.id))?.originalBytes, bytes);
});

test("abort while authenticated offer is pending prevents new starts while retaining a durable retry", { timeout: 20_000 }, async (t) => {
  const f = await pair(t, { proxy: true });
  assert.ok(f.proxy);
  await f.source.store.publish(input, "abort-fence");
  await f.proxy.command({ type: "arm", pathname: "/sync/v1/offer", method: "POST", kind: "pause" });
  const controller = new AbortController();
  const sending = f.run(f.source, f.outbound, { signal: controller.signal });
  const observed = Promise.allSettled([sending]);
  await f.proxy.waitFor("paused");
  controller.abort();
  assert.equal((await sending).routes[0].status, "aborted");
  await observed;
  const before = parseObject((await f.proxy.command({ type: "status" })).starts, "proxy starts");
  let resolutions = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const result = await f.run(f.source, f.outbound, { signal: controller.signal, credentials: () => {
      resolutions += 1;
      return f.credentials();
    } });
    assert.equal(result.routes[0].status, "aborted");
    assert.equal(result.counters.requests, 0);
  }

  assert.equal(resolutions, 0);
  assert.deepEqual(parseObject((await f.proxy.command({ type: "status" })).starts, "proxy starts"), before);
  assert.equal(Object.values((await diskLedger(f.source)).outbox)[0].disposition, "pending");
  assert.equal(Object.keys((await f.receiver.store.snapshot()).receipts).length, 0);
  await faultProof(f.proxy);
  await f.proxy.command({ type: "release" });
  assert.equal((await f.run()).routes[0].status, "confirmed");
});

test("full copied store and explicit restore quarantine block before credentials or network", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  await f.source.store.publish(input, "clone-body");
  const runner = await startProtocolFaultChild(f.context, { mode: "runner", home: f.source.home, peerId: f.source.peerId, token: f.token, caPath: f.tls.caPath });
  const reply = await runner.command({ type: "run", routeIds: [f.outbound.id] });
  assert.equal(reply.error, undefined);
  const result = parseObject(reply.result, "clone setup reconciliation");
  assert.ok(Array.isArray(result.routes));
  assert.equal(parseObject(result.routes[0], "clone setup route").status, "confirmed");

  // A confirmed pass can still retire authorization checks. Copy an offline home.
  await runner.stop();
  await f.source.store.recover();
  const cloneHome = path.join(f.root, "full-clone");
  await cp(f.source.home, cloneHome, { recursive: true });
  const clone = new ManagedSyncStore(cloneHome);
  const before = await serverStatus(f.receiverServer);
  let resolutions = 0;
  const credentials = () => {
    resolutions += 1;
    return f.credentials();
  };
  await assert.rejects(f.run(f.source, f.outbound, { store: clone, credentials }), /anchor|copied|moved/);
  assert.equal(resolutions, 0);
  await clone.quarantineRestore();
  const restored = await clone.snapshot();
  assert.equal(restored.worker.ownerQuarantined, true);
  assert.equal(Object.keys(restored.receipts).length, 0);
  assert.equal(Object.keys(restored.checkpoints).length, 0);
  assert.equal(Object.keys(restored.historyCheckpoints).length, 0);
  assert.equal(Object.keys(restored.records).length, 1);
  for (let pass = 0; pass < 3; pass += 1) {
    const result = await f.run(f.source, f.outbound, { store: clone, credentials });
    assert.equal(result.routes[0].status, "blocked");
    assert.equal(result.counters.requests, 0);
  }

  assert.equal(resolutions, 0);
  assert.equal((await serverStatus(f.receiverServer)).network.requests, before.network.requests);
});

async function waitUntil(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }

  assert.fail(`Timed out waiting for ${label}`);
}

function partialBody(url: string, f: Pair, binding: RequestBinding, transferId: string, byteLength: number) {
  let status = 0;
  const target = new URL(`/sync/v1/body?transferId=${transferId}`, url);
  assert.equal(target.hostname, "127.0.0.1");
  const pending = https.request(target, { method: "PUT", ca: f.ca, agent: false, headers: { authorization: `Bearer ${f.token}`,
    [BINDING_HEADER]: Buffer.from(JSON.stringify(binding)).toString("base64url"), "content-type": "application/octet-stream", "content-length": String(byteLength) } });
  const outcome = new Promise<number>((resolve) => {
    pending.on("response", (response) => {
      status = response.statusCode ?? 0;
      response.resume();
      response.once("end", () => resolve(status));
      response.once("error", () => resolve(status));
    });
    pending.once("error", () => resolve(status));
    pending.once("close", () => resolve(status));
  });
  const timer = setTimeout(() => pending.destroy(new Error("Partial synthetic body deadline")), 15_000);
  pending.once("close", () => clearTimeout(timer));
  pending.write(bytes.subarray(0, 4));

  return { pending, outcome };
}

test("protocol fixture teardown reaps every application before removing its shared store", { timeout: 15_000 }, async (t) => {
  const applications: Awaited<ReturnType<typeof application>>[] = [];
  const originalRemove = fs.rm;
  let root: string | undefined;
  let removalChecks = 0;
  const writersAtRemoval: number[] = [];
  const remove = mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (root !== undefined && args[0] === root) {
      removalChecks += 1;
      for (const app of applications) {
        const pid = app.pid;
        assert.ok(pid);

        try {
          process.kill(pid, 0);
          writersAtRemoval.push(pid);
        } catch (error) {
          assert.ok(error instanceof Error && "code" in error && error.code === "ESRCH");
        }
      }

      // Record unsafe ordering, then stop the real writers so a red assertion cannot leak children.
      await Promise.all(applications.map((app) => app.stop()));
    }

    return originalRemove(...args);
  });

  try {
    const f = await pair(t);
    root = f.root;
    applications.push(f.receiverServer);
    applications.push(await application(f.context, f.receiver, f.tls, f.token));
    applications.push(await application(f.context, f.receiver, f.tls, f.token));
  } finally {
    t.after(async () => {
      try {
        await Promise.all(applications.map((app) => app.stop()));
        if (root !== undefined) {
          await originalRemove(root, { recursive: true, force: true });
        }
      } finally {
        remove.mock.restore();
      }

      assert.equal(removalChecks, 1);
      assert.deepEqual(writersAtRemoval, [], "Every fixture writer must be reaped before shared store removal begins");
    });
  }
});

for (const quota of ["bytes", "files"]) {
  test(`real concurrent HTTPS streams share the staging ${quota} quota across application processes`, { timeout: 30_000 }, async (t) => {
    const f = await pair(t);
    assert.equal((await f.run()).routes[0].status, "confirmed");
    await f.source.store.publish(input, "reserved-wire");
    const base = await stateFor(f.source, "reserved-wire");
    const key = await readFile(path.join(f.source.home, "sync", `owner-${base.originInboxId}.pem`), "utf8");
    const state = quota === "bytes" ? signOriginState({ ...base, byteLength: 10 * 1024 * 1024 }, key) : base;
    const count = quota === "bytes" ? 6 : 16;
    const servers: Awaited<ReturnType<typeof application>>[] = [];
    for (let index = 0; index < Math.ceil((count + 1) / 4); index += 1) {
      servers.push(await application(f.context, f.receiver, f.tls, f.token, 15_000));
    }

    const binding = await bindingFor(f.source, f.outbound);
    const staging = path.join(f.receiver.home, "sync", "staging");
    const streams: ReturnType<typeof partialBody>[] = [];
    try {
      const preparedOffers: Awaited<ReturnType<typeof request>>[] = [];
      if (quota === "files") {
        for (let index = 0; index < count; index += 1) {
          const server = servers[Math.floor(index / 4)];
          preparedOffers.push(await request(server.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: state }))));
        }
      }

      for (let index = 0; index < count; index += 1) {
        const server = servers[Math.floor(index / 4)];
        const offered = preparedOffers[index] ?? await request(server.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: state })));
        assert.equal(offered.status, 200);
        const offer = parseOfferResponse(decodeJson(offered.body));
        assert.equal(offer.status, "needs-body");
        if (offer.status !== "needs-body") {
          throw new Error("Expected application transfer reservation");
        }

        if (index === 0) {
          await server.command({ type: "arm-stage-lease-gap" });
        }

        streams.push(partialBody(server.url, f, binding, offer.transferId, state.byteLength));
        if (index === 0) {
          try {
            const fault = await server.waitFor("fault");
            assert.equal(fault.event, "directory-flushed");
            assert.equal(fault.hits, 1);
            assert.equal(server.messages.filter((message) => message.type === "fault").length, 1);
            const partial = await readdir(staging);
            assert.equal(partial.filter((name) => name.endsWith(".lease")).length, 1);
            assert.equal(partial.filter((name) => name.endsWith(".stage")).length, 0,
              "a durable lease alone does not establish a completed reservation pair");
          } finally {
            await server.command({ type: "release" });
          }
        }

        await waitUntil(async () => {
          const names = await readdir(staging);
          const leases = names.filter((name) => name.endsWith(".lease"));
          return names.length === (index + 1) * 2 && leases.length === index + 1 &&
            leases.every((lease) => names.includes(lease.slice(0, -6)));
        }, "complete shared stage reservation pairs");
      }

      const names = await readdir(staging);
      assert.equal(names.length, count * 2);
      const leases = names.filter((name) => name.endsWith(".lease"));
      const oldest = path.join(staging, leases[0]);
      const unknownOwner = parseObject(decodeJson(await readFile(oldest)), "stage lease");
      unknownOwner.start = null;
      await writeFile(oldest, JSON.stringify(unknownOwner));
      for (const name of names) {
        await utimes(path.join(staging, name), new Date(0), new Date(0));
      }

      await new ManagedSyncStore(f.receiver.home).recover();
      assert.equal((await readdir(staging)).length, count * 2, "age must not steal live or unknown-start owners");
      const spare = servers[Math.floor(count / 4)];
      const offered = await request(spare.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: state })));
      const offer = parseOfferResponse(decodeJson(offered.body));
      if (offer.status !== "needs-body") {
        throw new Error("Expected an offered overflow transfer");
      }

      const overflow = partialBody(spare.url, f, binding, offer.transferId, state.byteLength);
      streams.push(overflow);
      assert.equal(await overflow.outcome, 413);
      assert.equal((await readdir(staging)).length, count * 2);
      assert.equal(Object.keys((await f.receiver.store.snapshot()).receipts).length, 0);
    } finally {
      for (const stream of streams) {
        stream.pending.destroy();
      }

      await Promise.all(streams.map((stream) => stream.outcome));
      await waitUntil(async () => (await readdir(staging)).length === 0, "aborted HTTPS reservation cleanup");
    }

    assert.equal(Object.keys((await f.receiver.store.snapshot()).records).length, 0);
    assert.equal((await readdir(path.join(f.receiver.home, "sync", "bodies"))).length, 0);
    t.diagnostic(`${count} concurrent partial application streams; overflow 413; aged live/unknown-start leases retained; all aborted stages removed`);
  });
}

test("partial HTTPS stage survives live recovery and is reclaimed only after its application owner dies", { timeout: 20_000 }, async (t) => {
  const f = await pair(t);
  assert.equal((await f.run()).routes[0].status, "confirmed");
  await f.source.store.publish(input, "dead-stage-owner");
  const state = await stateFor(f.source, "dead-stage-owner");
  const binding = await bindingFor(f.source, f.outbound);
  const offered = await request(f.receiverServer.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: state })));
  const offer = parseOfferResponse(decodeJson(offered.body));
  if (offer.status !== "needs-body") {
    throw new Error("Expected application transfer");
  }

  const stream = partialBody(f.receiverServer.url, f, binding, offer.transferId, state.byteLength);
  const staging = path.join(f.receiver.home, "sync", "staging");
  try {
    await waitUntil(async () => (await readdir(staging)).length === 2, "partial body stage and lease");
    await new ManagedSyncStore(f.receiver.home).recover();
    assert.equal((await readdir(staging)).length, 2);
    await f.receiverServer.stop(true);
    assert.equal(await stream.outcome, 0);
    await new ManagedSyncStore(f.receiver.home).recover();
    assert.equal((await readdir(staging)).length, 0);
    const restarted = await application(f.context, f.receiver, f.tls, f.token);
    const response = await request(restarted.url, f.ca, f.token, binding, "/sync/v1/offer", Buffer.from(JSON.stringify({ descriptor: state })));
    const retry = parseOfferResponse(decodeJson(response.body));
    if (retry.status !== "needs-body") {
      throw new Error("Crash before commit cannot produce custody");
    }

    const installed = await request(restarted.url, f.ca, f.token, binding, `/sync/v1/body?transferId=${retry.transferId}`, bytes, "PUT");
    assert.equal(installed.status, 200);
    assert.equal(parseOfferResponse(decodeJson(installed.body)).status, "committed");
    assert.equal(Object.keys((await f.receiver.store.snapshot()).records).length, 1);
  } finally {
    stream.pending.destroy();
    await stream.outcome;
  }
});
