import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import tls from "node:tls";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { SyncClient } from "./sync-client";
import { withStoreLock } from "./sync-files";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import { parseObject, type OriginGrant, type SyncRoute } from "./sync-model";
import { startProtocolFaultChild } from "./sync-protocol-fault-child";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { BINDING_HEADER, opaqueToken, parseIdentityResponse, parseManifestPage, SyncProtocolError, WIRE_LIMITS } from "./sync-wire";

// Managed enrollment needs POSIX durability; portable TLS fixtures remain tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const input = { originalBytes: Buffer.from("<!doctype html><html><body>transport fixture</body></html>"), title: "Transport fixture", type: "report", sourceFileName: "fixture.html" };

async function until<T>(read: () => Promise<T> | T, accepts: (value: T) => boolean, label: string, milliseconds = 6000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await read();
    if (accepts(value)) {
      return value;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  throw new Error(`Transport regression deadline: ${label}`);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-transport-regression-"));
  const cleanup: Array<() => void | Promise<void>> = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    for (const close of cleanup.reverse()) {
      await close();
    }
  });
  const context: Pick<TestContext, "after" | "diagnostic"> = { after(close) {
    if (close) {
      cleanup.push(async () => { await close(t, () => {}); });
    }
  }, diagnostic(message) { t.diagnostic(message); } };
  const certificates = await createSyncHttpsCredentials(context);
  const ca = await readFile(certificates.caPath);
  const key = await readFile(certificates.trusted.keyPath);
  const cert = await readFile(certificates.trusted.certPath);
  const token = opaqueToken();
  async function store(name: string) {
    const result = new ManagedSyncStore(path.join(root, name));
    await result.enroll();
    return result;
  }

  async function listen(store: ManagedSyncStore, options: { requestMs?: number; leaseMs?: number } = {}) {
    const server = createSyncIngestionServer({ store, peerId: (await store.snapshot()).inboxId, credentials: () => ({ token }), key, cert,
      host: "127.0.0.1", ...options });
    const { url } = await server.start();
    cleanup.push(async () => { await server.close(); await assertLoopbackClosed(url); });
    return { server, url };
  }

  async function connect(source: ManagedSyncStore, receiver: ManagedSyncStore, sourceUrl: string, receiverUrl: string, grant?: OriginGrant) {
    const a = await source.snapshot();
    const b = await receiver.snapshot();
    const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: receiverUrl,
      sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, allowedOrigins: [grant ?? a.originKeys[0]], localInboxName: "fixture",
      readerAudience: "synthetic", credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null };
    return { outbound: await source.configureRoute(route), inbound: await receiver.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: sourceUrl }) };
  }

  async function worker(store: ManagedSyncStore) {
    const tokenPath = path.join(root, `token-${randomUUID()}`);
    await writeFile(tokenPath, token, { mode: 0o600 });
    const defaults = defaultRuntimeConfig();
    await store.configureRuntime({ ...defaults, credentials: { token: tokenPath }, trust: { ca: certificates.caPath },
      timings: { ...defaults.timings, reconcileMs: 1000, requestMs: 1000 } });
    await store.setWorkerEnabled(true);
    const owned = await startOwnedSyncWorker((await store.snapshot()).ownerAnchor.home);
    cleanup.push(async () => { await owned.close(); await assertLoopbackClosed(owned.record.controlOrigin); });
    return owned;
  }

  async function run(store: ManagedSyncStore, route: SyncRoute, requestMs = 1000) {
    return reconcileSyncRoutes({ store, peerId: (await store.snapshot()).inboxId, credentials: () => ({ token, ca }), routeIds: [route.id], requestMs, deadlineMs: 4000 });
  }

  async function runIsolated(store: ManagedSyncStore, route: SyncRoute, requestMs = 1000) {
    const ledger = await store.snapshot();
    const runner = await startProtocolFaultChild(context, { mode: "runner", home: ledger.ownerAnchor.home, peerId: ledger.inboxId, token, caPath: certificates.caPath });
    const reply = await runner.command({ type: "run", routeIds: [route.id], requestMs, deadlineMs: 4000 });
    await runner.stop();
    await store.recover();

    assert.equal(reply.error, undefined);
    const result = parseObject(reply.result, "runner reconciliation");
    assert.ok(Array.isArray(result.routes));
    return { routes: result.routes.map((value) => parseObject(value, "runner route result")) };
  }

  async function preparePull(receiver: ManagedSyncStore, route: SyncRoute) {
    const ledger = await receiver.snapshot();
    const client = new SyncClient(receiver, ledger.inboxId, () => ({ token, ca }));
    const auth = routeAuthorization(route);
    const nonce = opaqueToken();
    const session = await client.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
    const page = await client.json(auth, "manifest", { op: "pull", sessionId: session.sessionId, cursor: null }, parseManifestPage, WIRE_LIMITS.page);
    assert.equal(page.descriptors.length, 1);
    await receiver.completeInventory(auth, page.evidence, page.descriptors, nonce);
    await client.json(auth, "manifest", { op: "ready", sessionId: session.sessionId, ready: { kind: "terminal-inventory-ready", evidence: page.evidence,
      ackNonce: session.challengeNonce, receiverPeerId: ledger.inboxId, destinationInboxId: ledger.inboxId,
      storageIncarnation: ledger.storageIncarnation } }, (value) => value, WIRE_LIMITS.identity);
    return { client, auth, session, state: page.descriptors[0] };
  }

  return { root, store, listen, connect, worker, run, runIsolated, preparePull, ca, key, cert, token };
}

test("owned worker recovers from sixteen real pre-auth requests without explicit retry", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const source = await f.store("source");
  const receiver = await f.store("receiver");
  const target = await f.listen(receiver, { requestMs: 4000 });
  const route = await f.connect(source, receiver, "https://127.0.0.1:1", target.url);
  await source.publish(input, "pressure");
  const sourceLedger = await source.snapshot();
  const receiverHome = (await receiver.snapshot()).ownerAnchor.home;
  let release = () => {};
  let acquired = () => {};
  const held = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lock = withStoreLock(path.join(receiverHome, "sync"), 1000, async () => { acquired(); await gate; });
  await held;
  const origin = new URL(target.url);
  const socket = tls.connect({ host: "127.0.0.1", port: Number(origin.port), ca: f.ca, rejectUnauthorized: true });
  socket.on("error", () => {});
  socket.on("data", () => {});
  t.after(async () => { release(); socket.destroy(); await lock; });
  await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
  const binding = Buffer.from(JSON.stringify({ protocolVersion: 1, routeId: route.outbound.id, revision: 1, callerPeerId: sourceLedger.inboxId,
    targetPeerId: route.outbound.peerId, sourceInboxId: route.outbound.sourceInboxId, destinationInboxId: route.outbound.destinationInboxId,
    callerStorageIncarnation: sourceLedger.storageIncarnation })).toString("base64url");
  const pressureToken = opaqueToken();
  for (let count = 0; count < WIRE_LIMITS.concurrent; count += 1) {
    const body = JSON.stringify({ nonce: opaqueToken() });
    socket.write(`POST /sync/v1/identity HTTP/1.1\r\nHost: ${origin.host}\r\nAuthorization: Bearer ${pressureToken}\r\n${BINDING_HEADER}: ${binding}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  try {
    await until(() => target.server.status().counters.activeRequests, (count) => count === 16, "sixteen held requests");
    await f.worker(source);
    const failed = await until(() => source.snapshot(), (ledger) => !!ledger.routeRetries[route.outbound.id], "admission attempt");
    assert.equal(target.server.status().counters.requests, 17, "exactly one worker admission attempt hits sixteen held requests");
    assert.equal(failed.routeRetries[route.outbound.id].lastError, "request-capacity");
    assert.equal(failed.routeRetries[route.outbound.id].blocked, false);
    assert.equal(target.server.status().sessions, 0, "capacity reply establishes no session or grant");
    assert.equal((await source.deliveryStatus(route.outbound.id, sourceLedger.inboxId, "pressure")).isCommitted, false);
  } finally {
    release();
    socket.destroy();
    await lock;
  }

  await until(() => receiver.listDocuments(), (documents) => documents.length === 1, "autonomous pressure recovery");
  await until(() => source.deliveryStatus(route.outbound.id, sourceLedger.inboxId, "pressure"), (delivery) => delivery.isCommitted, "real committed receipt");
  const invalidClient = new SyncClient(source, sourceLedger.inboxId, () => ({ token: pressureToken, ca: f.ca }));
  await assert.rejects(invalidClient.json(routeAuthorization(route.outbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity),
    (error: unknown) => error instanceof SyncProtocolError && error.status === 403 && error.code === "unauthorized");
});

for (const fault of ["truncated", "malformed"] as const) {
  test(`receiver worker handles a ${fault} genuine history error with the correct retry semantics`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const a = await f.store("a");
    const b = await f.store("b");
    const c = await f.store("c");
    const relay = await f.listen(b);
    let hits = 0;
    let requests = 0;
    const upstreamStatuses: number[] = [];
    const sockets = new Set<import("node:stream").Duplex>();
    const proxy = https.createServer({ key: f.key, cert: f.cert }, (request, response) => {
      requests += 1;
      const outgoing = https.request(new URL(request.url ?? "/", relay.url), { method: request.method, headers: request.headers, ca: f.ca,
        rejectUnauthorized: true, agent: false }, (incoming) => {
        upstreamStatuses.push(incoming.statusCode ?? 0);
        if (!hits && incoming.statusCode === 409) {
          hits += 1;
          if (fault === "malformed") {
            const body = JSON.stringify({ error: "trusted-history-unavailable", extra: true });
            incoming.resume();
            response.writeHead(409, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
            response.end(body);
            return;
          }

          response.writeHead(409, incoming.headers);
          incoming.once("data", (chunk: Buffer) => { response.write(chunk.subarray(0, 8), () => response.destroy()); });
          incoming.resume();
          return;
        }

        response.writeHead(incoming.statusCode ?? 503, incoming.headers);
        incoming.pipe(response);
      });
      outgoing.on("error", () => response.destroy());
      request.pipe(outgoing);
    });
    proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const proxyUrl = `https://127.0.0.1:${address.port}`;
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await assertLoopbackClosed(proxyUrl); });
    const ab = await f.connect(a, b, "https://127.0.0.1:1", relay.url);
    const bc = await f.connect(b, c, proxyUrl, "https://127.0.0.1:1", { ...(await a.snapshot()).originKeys[0], redistribute: true });
    await f.worker(c);
    const initial = await until(() => c.snapshot(), (ledger) => !!ledger.routeRetries[bc.inbound.id], "first interrupted/error result");
    assert.equal(hits, 1);
    assert.deepEqual(upstreamStatuses, [409]);
    assert.equal(initial.routeRetries[bc.inbound.id].lastError, fault === "truncated" ? "response-truncated" : "invalid-response-envelope");
    assert.equal(initial.routeRetries[bc.inbound.id].blocked, fault === "malformed");
    assert.equal((await c.listDocuments()).length, 0);
    assert.equal(Object.keys(initial.checkpoints).length, 0);
    await a.publish(input, "upstream-ready");
    assert.equal((await f.run(a, ab.outbound)).routes[0].status, "confirmed");
    if (fault === "truncated") {
      await until(() => c.listDocuments(), (documents) => documents.length === 1, "automatic independent pull after interruption");
    } else {
      const before = requests;
      await new Promise<void>((resolve) => setTimeout(resolve, 2200));
      assert.equal(requests, before, "complete malformed response remains blocked across periodic checks");
      assert.equal((await c.listDocuments()).length, 0);
    }

    assert.equal(hits, 1);
  });
}

test("an already closed body response never begins pinning or retains an attempt", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const source = await f.store("source");
  const receiver = await f.store("receiver");
  let bodyResponse: ServerResponse | undefined;
  const createServer = https.createServer;
  t.mock.method(https, "createServer", (options: https.ServerOptions, listener: (request: import("node:http").IncomingMessage, response: ServerResponse) => void) =>
    createServer(options, (request, response) => { if (request.method === "GET") bodyResponse = response; listener(request, response); }));
  const endpoint = await f.listen(source);
  const routes = await f.connect(source, receiver, endpoint.url, "https://127.0.0.1:1");
  await source.publish(input, "preclosed-body");
  const { client, auth, session, state } = await f.preparePull(receiver, routes.inbound);
  const openAttempt = source.openRouteAttempt.bind(source);
  const pin = source.pinOutgoing.bind(source);
  let pins = 0;
  let closedBeforeReturn = 0;
  t.mock.method(source, "openRouteAttempt", async (...args: Parameters<typeof openAttempt>) => {
    const attempt = await openAttempt(...args);
    const response = bodyResponse;
    if (response && !response.closed) {
      await new Promise<void>((resolve) => { response.once("close", resolve); response.destroy(); });
      closedBeforeReturn += 1;
    }

    return attempt;
  });
  t.mock.method(source, "pinOutgoing", (...args: Parameters<typeof pin>) => { pins += 1; return pin(...args); });
  t.after(() => { if (endpoint.server.status().counters.activeRequests) bodyResponse?.emit("close"); });
  await assert.rejects(client.pullBody(auth, session.sessionId, state));
  await until(() => endpoint.server.status().counters.activeRequests, (count) => count === 0, "preclosed request drained", 600);
  assert.equal(closedBeforeReturn, 1);
  assert.equal(pins, 0);
  await source.quiesceRoute(routes.outbound.id, Date.now() + 600);
  assert.equal(Object.keys((await receiver.snapshot()).receipts).length, 0);
});

test("a genuine active body retains its busy lease through expiry and then commits exact bytes", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const source = await f.store("source");
  const receiver = await f.store("receiver");
  const endpoint = await f.listen(source, { requestMs: 5000, leaseMs: 1500 });
  const routes = await f.connect(source, receiver, endpoint.url, "https://127.0.0.1:1");
  await source.publish(input, "active-body");
  const { client, auth, session, state } = await f.preparePull(receiver, routes.inbound);
  const pin = source.pinOutgoing.bind(source);
  let release = () => {};
  let entered = () => {};
  const reachedPin = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(release);
  let pins = 0;
  t.mock.method(source, "pinOutgoing", async (...args: Parameters<typeof pin>) => { pins += 1; entered(); await gate; return pin(...args); });
  const pulling = client.pullBody(auth, session.sessionId, state, { requestMs: 4000 });
  try {
    await reachedPin;
    await assert.rejects(client.json(auth, "manifest", { op: "complete", sessionId: session.sessionId }, (value) => value, WIRE_LIMITS.identity),
      (error: unknown) => error instanceof SyncProtocolError && error.status === 403);
    await until(() => Date.now(), (now) => now > session.expiresAt + 30, "busy lease past expiry");
    assert.equal(endpoint.server.status().sessions, 1, "expiry cannot purge the active body cut");
    assert.equal(endpoint.server.status().counters.activeRequests, 1);
  } finally {
    release();
  }

  const result = await pulling;
  assert.equal(pins, 1);
  assert.equal(result.status, "committed");
  assert.deepEqual((await receiver.listDocuments()).length, 1);
  const document = (await receiver.listDocuments())[0];
  assert.deepEqual((await receiver.getDocument(document.id))?.originalBytes, input.originalBytes);
  await until(() => endpoint.server.status(), (status) => status.sessions === 0 && status.counters.activeRequests === 0 && status.sockets === 0, "completed expired busy lease released");
  await source.quiesceRoute(routes.outbound.id, Date.now() + 600);
});

for (const termination of ["disconnect", "quiesce", "server-close"] as const) {
  test(`${termination} releases the body response attempt while the actual store lock remains held`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const source = await f.store("source");
    const receiver = await f.store("receiver");
    let bodyResponse: ServerResponse | undefined;
    const createServer = https.createServer;
    t.mock.method(https, "createServer", (options: https.ServerOptions, listener: (request: import("node:http").IncomingMessage, response: ServerResponse) => void) =>
      createServer(options, (request, response) => { if (request.method === "GET") bodyResponse = response; listener(request, response); }));
    const endpoint = await f.listen(source, { requestMs: 1000, leaseMs: 1400 });
    const routes = await f.connect(source, receiver, endpoint.url, "https://127.0.0.1:1");
    await source.publish(input, "interrupted-body");
    const sourceHome = (await source.snapshot()).ownerAnchor.home;
    const { client, auth, session, state } = await f.preparePull(receiver, routes.inbound);
    const record = Object.values((await source.snapshot()).records)[0];
    assert.ok(record.bodyFile);
    const bodyPath = path.join(sourceHome, "sync", "bodies", record.bodyFile);
    const open = fs.open;
    let openedPins = 0;
    let closedPins = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === bodyPath) {
        openedPins += 1;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { await close(); closedPins += 1; });
      }

      return handle;
    });
    const pin = source.pinOutgoing.bind(source);
    let release = () => {};
    let entered = () => {};
    const reachedPin = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let heldLock: Promise<void> | undefined;
    let pinned: ReturnType<typeof pin> | undefined;
    let pins = 0;
    t.mock.method(source, "pinOutgoing", async (...args: Parameters<typeof pin>) => {
      pins += 1;
      let acquired = () => {};
      const held = new Promise<void>((resolve) => { acquired = resolve; });
      heldLock = withStoreLock(path.join(sourceHome, "sync"), 1000, async () => { acquired(); await gate; });
      await held;
      const pending = pin(...args);
      pinned = pending;
      entered();
      return pending;
    });
    t.after(async () => {
      release();
      await heldLock;
      // Original red cleanup settles only the retained fixture response; it is never a production fix.
      if (endpoint.server.status().counters.activeRequests) {
        bodyResponse?.emit("close");
      }
    });
    const pulling = assert.rejects(client.pullBody(auth, session.sessionId, state, { requestMs: termination === "disconnect" ? 250 : 3000 }));
    await reachedPin;
    try {
      if (termination === "quiesce") {
        await source.quiesceRoute(routes.outbound.id, Date.now() + 600);
      }

      if (termination === "server-close") {
        await endpoint.server.close();
      }

      await pulling;
      assert.equal(pins, 1);
      await until(() => bodyResponse?.destroyed, (destroyed) => destroyed === true, "owned response closed");
      await until(() => endpoint.server.status().counters.activeRequests, (count) => count === 0, "closed response releases attempt before pin lock", 600);
      await source.quiesceRoute(routes.outbound.id, Date.now() + 600);
    } finally {
      release();
      await heldLock;
      await pinned;
    }

    await until(() => endpoint.server.status(), (status) => status.sessions === 0 && status.sockets === 0 && status.counters.activeRequests === 0, "expired/released interrupted session");
    assert.equal((await receiver.listDocuments()).length, 0);
    assert.equal(Object.keys((await receiver.snapshot()).receipts).length, 0);
    assert.ok(bodyResponse);
    assert.equal(bodyResponse.listenerCount("close"), 0);
    assert.equal(bodyResponse.headersSent, false, "a completed late pin cannot send headers or bytes after termination");
    assert.equal(openedPins, 1);
    assert.equal(closedPins, openedPins, "the bounded late pin closes its actual body handle");
    if (termination !== "server-close") {
      t.mock.restoreAll();
      assert.equal((await f.runIsolated(receiver, routes.inbound)).routes[0].status, "confirmed", "fresh admission succeeds without restarting the server");
      assert.equal((await receiver.listDocuments()).length, 1);
    }
  });
}
