import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import https from "node:https";
import platformTest, { type TestContext } from "node:test";
import { createInbox, withCatalogIdentityTransition } from "./inbox-catalog";
import { SyncClient } from "./sync-client";
import { createStorageCounters, DurableFiles } from "./sync-files";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import { canonicalKey, SYNC_HISTORY_UNAVAILABLE, type OriginGrant, type SyncRoute } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { opaqueToken, parseHoldingsResponse, parseIdentityResponse, SyncProtocolError, WIRE_LIMITS } from "./sync-wire";
import { classifySyncFailure, parseRemoteFailure } from "./sync-failure";
import { maintainSyncIdentity } from "./sync-maintenance";

// Managed opt-in requires POSIX directory durability. Windows rejection remains actively tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const input = { originalBytes: Buffer.from("<!doctype html><html><body>review fixture</body></html>"), title: "Restricted fixture", type: "report", sourceFileName: "fixture.html" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-review-regression-"));
  const cleanup: Array<() => void | Promise<void>> = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    for (const close of cleanup.reverse()) {
      await close();
    }
  });
  const tls = await createSyncHttpsCredentials({ after: (close) => {
    if (close) {
      cleanup.push(async () => { await close(t, () => {}); });
    }
  } });
  const ca = await readFile(tls.caPath);
  const token = opaqueToken();
  async function store(name: string) {
    const result = new ManagedSyncStore(path.join(root, name));
    await result.enroll();
    return result;
  }

  async function listen(store: ManagedSyncStore, leaseMs = 60_000) {
    const server = createSyncIngestionServer({ store, peerId: (await store.snapshot()).inboxId, credentials: () => ({ token }),
      key: await readFile(tls.trusted.keyPath), cert: await readFile(tls.trusted.certPath), host: "127.0.0.1", leaseMs });
    const { url } = await server.start();
    cleanup.push(async () => { await server.close(); await assertLoopbackClosed(url); });
    return { server, url };
  }

  async function connect(a: ManagedSyncStore, b: ManagedSyncStore, aUrl: string, bUrl: string, grant?: OriginGrant) {
    const source = await a.snapshot();
    const destination = await b.snapshot();
    const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: destination.inboxId, peerUrl: bUrl,
      sourceInboxId: source.inboxId, destinationInboxId: destination.inboxId, allowedOrigins: [grant ?? source.originKeys[0]], localInboxName: "fixture",
      readerAudience: "synthetic", credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null };
    return { outbound: await a.configureRoute(route), inbound: await b.configureRoute({ ...route, direction: "inbound", peerId: source.inboxId, peerUrl: aUrl }) };
  }

  async function run(store: ManagedSyncStore, routes: SyncRoute[]) {
    return reconcileSyncRoutes({ store, peerId: (await store.snapshot()).inboxId, credentials: () => ({ token, ca }), routeIds: routes.map((route) => route.id), deadlineMs: 10_000 });
  }

  async function worker(store: ManagedSyncStore) {
    const tokenPath = path.join(root, `token-${randomUUID()}`);
    await writeFile(tokenPath, token, { mode: 0o600 });
    const defaults = defaultRuntimeConfig();
    await store.configureRuntime({ ...defaults, credentials: { token: tokenPath }, trust: { ca: tls.caPath }, timings: { ...defaults.timings, reconcileMs: 1000 } });
    await store.setWorkerEnabled(true);
    const owned = await startOwnedSyncWorker((await store.snapshot()).ownerAnchor.home);
    cleanup.push(async () => { await owned.close(); await assertLoopbackClosed(owned.record.controlOrigin); });
    return owned;
  }

  return { root, store, listen, connect, run, worker, token, ca, tls };
}

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string, milliseconds = 8000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  throw new Error(`Review regression timed out: ${label}`);
}

test("existing catalog intent is flushed before a retry may mutate identity, including EIO and ENOSPC", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-review-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "catalog");
  const home = path.join(root, "inbox");
  const entry = await createInbox("fixture", home, catalog);
  const journal = path.join(catalog, "identity-transition.json");
  const originalOpen = fs.open;
  let phase = "initial";
  let failures = 0;
  const syncs: string[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => {
      const file = String(args[0]);
      syncs.push(file);
      if (phase === "initial" && file === catalog || phase === "retry-file" && file === journal || phase === "retry-directory" && file === catalog) {
        failures += 1;
        throw Object.assign(new Error(`Injected ${phase} durability failure`), { code: phase === "retry-file" ? "ENOSPC" : "EIO" });
      }

      return sync();
    });
    return handle;
  });
  let mutations = 0;
  const operation = async () => { mutations += 1; };
  await assert.rejects(withCatalogIdentityTransition(home, entry.instanceId, operation, catalog), /Injected initial/);
  const intended = JSON.parse(await readFile(journal, "utf8"));
  for (const retryPhase of ["retry-file", "retry-directory"]) {
    phase = retryPhase;
    await assert.rejects(withCatalogIdentityTransition(home, entry.instanceId, operation, catalog), /Injected retry/);
    assert.equal(mutations, 0, "failed intent durability must precede every identity callback");
    assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), intended);
  }

  phase = "success";
  syncs.length = 0;
  await withCatalogIdentityTransition(home, entry.instanceId, async (transition) => {
    assert.equal(transition.newInboxId, intended.newInboxId);
    assert.ok(syncs.indexOf(journal) >= 0 && syncs.indexOf(catalog) > syncs.indexOf(journal));
    assert.equal(new DurableFiles(createStorageCounters(), {}, catalog).uncertain, false);
    mutations += 1;
  }, catalog);
  assert.equal(failures, 3);
  assert.equal(mutations, 1);
});

test("fork recovery baselines uncertain catalog intent before a durable new-ledger cut and retains the chosen UUID", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-review-fork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "catalog");
  const home = path.join(root, "inbox");
  const entry = await createInbox("fixture", home, catalog);
  await new ManagedSyncStore(home).enroll();
  const previousCatalog = process.env.HTML_INBOX_CATALOG_HOME;
  process.env.HTML_INBOX_CATALOG_HOME = catalog;
  t.after(() => {
    if (previousCatalog === undefined) delete process.env.HTML_INBOX_CATALOG_HOME;
    else process.env.HTML_INBOX_CATALOG_HOME = previousCatalog;
  });
  const originalOpen = fs.open;
  let phase = "initial";
  let initialFailures = 0;
  let ledgerCuts = 0;
  let chosenId: string | undefined;
  const syncs: string[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => {
      const file = String(args[0]);
      syncs.push(file);
      if (phase === "initial" && file === catalog) {
        initialFailures += 1;
        throw Object.assign(new Error("Injected catalog fsync EIO"), { code: "EIO" });
      }

      await sync();
      // Lock release also flushes this directory; the ledger crash cut is one-shot.
      if (phase === "retry" && ledgerCuts === 0 && file === path.join(home, "sync")) {
        const ledger = JSON.parse(await readFile(path.join(home, "sync", "ledger.json"), "utf8"));
        if (ledger.inboxId === chosenId) {
          ledgerCuts += 1;
          throw new Error("Cut after durable fork ledger");
        }
      }
    });
    return handle;
  });
  await assert.rejects(maintainSyncIdentity(home, entry.instanceId, "fork"), /Injected catalog/);
  const journal = path.join(catalog, "identity-transition.json");
  chosenId = JSON.parse(await readFile(journal, "utf8")).newInboxId;
  phase = "retry";
  syncs.length = 0;
  await assert.rejects(maintainSyncIdentity(home, entry.instanceId, "fork"), /Cut after durable/);
  assert.equal(initialFailures, 1);
  assert.equal(ledgerCuts, 1);
  assert.ok(syncs.indexOf(journal) >= 0 && syncs.indexOf(catalog) > syncs.indexOf(journal));
  assert.equal(JSON.parse(await readFile(path.join(home, "sync", "ledger.json"), "utf8")).inboxId, chosenId);
  assert.equal((await readFile(path.join(home, "instance-id"), "utf8")).trim(), entry.instanceId);
  phase = "recover";
  await maintainSyncIdentity(home, entry.instanceId, "fork");
  assert.equal((await new ManagedSyncStore(home).snapshot()).inboxId, chosenId);
});

// This case accumulates twenty independently bounded reconciliation calls.
test("successful push and pull sessions release capacity across more than eight multiroute passes", { timeout: 120_000 }, async (t) => {
  const startedAt = performance.now();
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  const as = await f.listen(a);
  const bs = await f.listen(b);
  const first = await f.connect(a, b, as.url, bs.url);
  const second = await f.connect(a, b, as.url, bs.url);
  for (let index = 0; index < 10; index += 1) {
    await a.publish(input, `item-${index}`);
    const pushStartedAt = performance.now();
    const pushed = await f.run(a, [first.outbound, second.outbound]);
    assert.ok(pushed.routes.every((route) => route.status === "confirmed"), JSON.stringify(pushed));
    t.diagnostic(JSON.stringify({ iteration: index + 1, phase: "push", elapsedMs: performance.now() - startedAt,
      durationMs: performance.now() - pushStartedAt, requests: pushed.counters.requests, sessions: bs.server.status().sessions }));
    const pullStartedAt = performance.now();
    const pulled = await f.run(b, [first.inbound, second.inbound]);
    assert.ok(pulled.routes.every((route) => route.status === "confirmed"), JSON.stringify(pulled));
    assert.equal(bs.server.status().sessions, 0);
    assert.equal(as.server.status().sessions, 0);
    t.diagnostic(JSON.stringify({ iteration: index + 1, phase: "pull", elapsedMs: performance.now() - startedAt,
      durationMs: performance.now() - pullStartedAt, requests: pulled.counters.requests,
      sourceSessions: as.server.status().sessions, destinationSessions: bs.server.status().sessions }));
  }

  assert.equal((await b.listDocuments()).length, 10);
});

test("receiver worker waits for remote relay history and catches up autonomously", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  const c = await f.store("c");
  const bs = await f.listen(b);
  const ab = await f.connect(a, b, "https://127.0.0.1:1", bs.url);
  const bc = await f.connect(b, c, bs.url, "https://127.0.0.1:1", { ...(await a.snapshot()).originKeys[0], redistribute: true });
  await f.worker(c);
  const waiting = await until(() => c.snapshot(), (ledger) => !!ledger.routeRetries[bc.inbound.id], "initial history wait");
  assert.equal(waiting.routeRetries[bc.inbound.id].lastError, SYNC_HISTORY_UNAVAILABLE);
  assert.equal(waiting.routeRetries[bc.inbound.id].attempts, 0);
  assert.equal(waiting.routeRetries[bc.inbound.id].blocked, false);
  assert.equal((await c.listDocuments()).length, 0);
  assert.equal(Object.keys(waiting.checkpoints).length, 0);
  assert.equal(waiting.routes[bc.inbound.id].state, "reconnecting");
  await a.publish(input, "later-history");
  assert.equal((await f.run(a, [ab.outbound])).routes[0].status, "confirmed");
  await until(() => c.listDocuments(), (documents) => documents.length === 1, "autonomous independent pull");
  assert.equal((await c.snapshot()).routes[bc.inbound.id].state, "active");
});

test("temporary session admission stays bounded and a one-second periodic worker recovers without retry reset", { timeout: 25_000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  const bs = await f.listen(b);
  const routes = await f.connect(a, b, "https://127.0.0.1:1", bs.url);
  const client = new SyncClient(a, (await a.snapshot()).inboxId, () => ({ token: f.token, ca: f.ca }));
  const sessions = [];
  for (let count = 0; count < WIRE_LIMITS.sessions; count += 1) {
    sessions.push(await client.json(routeAuthorization(routes.outbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity));
  }

  assert.equal(bs.server.status().sessions, WIRE_LIMITS.sessions);
  await a.publish(input, "admission");
  const worker = await f.worker(a);
  const pressure = await until(() => a.snapshot(), (ledger) => !!ledger.routeRetries[routes.outbound.id], "bounded admission retry");
  assert.equal(pressure.routeRetries[routes.outbound.id].lastError, "session-capacity");
  assert.equal(pressure.routeRetries[routes.outbound.id].blocked, false);
  assert.equal(bs.server.status().sessions, WIRE_LIMITS.sessions);
  await client.json(routeAuthorization(routes.outbound), "manifest", { op: "complete", sessionId: sessions[0].sessionId }, (value) => value, WIRE_LIMITS.identity);
  await until(() => b.listDocuments(), (documents) => documents.length === 1, "admission pressure cleared");
  const startRequests = bs.server.status().counters.requests;
  await until(async () => bs.server.status(), (status) => status.counters.requests >= startRequests + 9 * 4 &&
    status.sessions === WIRE_LIMITS.sessions - 1 && status.counters.activeRequests === 0, "nine completed healthy periodic sessions", 15_000);
  await worker.close();
  assert.equal(bs.server.status().sessions, WIRE_LIMITS.sessions - 1);
  assert.equal((await a.snapshot()).routeRetries[routes.outbound.id].blocked, false);
});

test("concurrent pull identities reserve at most eight inventory leases before store reads complete", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  const as = await f.listen(a);
  const routes = await f.connect(a, b, as.url, "https://127.0.0.1:1");
  const client = new SyncClient(b, (await b.snapshot()).inboxId, () => ({ token: f.token, ca: f.ca }));
  const inventory = a.inventory.bind(a);
  let entered = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(release);
  t.mock.method(a, "inventory", async (authorization: unknown) => {
    entered += 1;
    await gate;
    return inventory(authorization);
  });
  const pending = Promise.allSettled(Array.from({ length: 12 }, () => client.json(routeAuthorization(routes.inbound), "identity",
    { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity)));
  try {
    await until(async () => entered, (count) => count >= 8, "reserved concurrent inventory leases");
    assert.equal(as.server.status().sessions, WIRE_LIMITS.sessions);
    assert.equal(entered, WIRE_LIMITS.sessions);
  } finally {
    release();
  }

  const results = await pending;
  const admitted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const denied = results.filter((result) => result.status === "rejected");
  assert.equal(admitted.length, 8);
  assert.equal(denied.length, 4);
  for (const result of denied) {
    assert.ok(result.status === "rejected" && result.reason instanceof SyncProtocolError && result.reason.code === "session-capacity");
  }

  for (const session of admitted) {
    await client.json(routeAuthorization(routes.inbound), "manifest", { op: "complete", sessionId: session.sessionId }, (value) => value, WIRE_LIMITS.identity);
  }

  assert.equal(as.server.status().sessions, 0);
});

platformTest("remote retry hints require exact recognized code, envelope and HTTP status", () => {
  assert.equal(classifySyncFailure(parseRemoteFailure({ error: SYNC_HISTORY_UNAVAILABLE }, 409)).kind, "history");
  assert.equal(classifySyncFailure(parseRemoteFailure({ error: "session-capacity" }, 503)).kind, "retry");
  assert.equal(classifySyncFailure(parseRemoteFailure({ error: "inventory-limit" }, 413)).kind, "blocked");
  for (const status of [401, 403, 500, 503]) {
    assert.throws(() => parseRemoteFailure({ error: SYNC_HISTORY_UNAVAILABLE }, status));
    assert.notEqual(classifySyncFailure(new SyncProtocolError(status, SYNC_HISTORY_UNAVAILABLE)).kind, "history");
  }

  for (const envelope of [{ error: SYNC_HISTORY_UNAVAILABLE, extra: true }, { error: "unknown" }, { error: 42 }, null]) {
    assert.throws(() => parseRemoteFailure(envelope, 409));
  }
});

test("actual TLS error envelopes cannot turn authorization, malformed or oversized errors into history retries", async (t) => {
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  let status = 409;
  let body = "";
  const server = https.createServer({ key: await readFile(f.tls.trusted.keyPath), cert: await readFile(f.tls.trusted.certPath) }, (request, response) => {
    request.resume();
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `https://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await assertLoopbackClosed(url); });
  const routes = await f.connect(a, b, "https://127.0.0.1:1", url);
  const client = new SyncClient(a, (await a.snapshot()).inboxId, () => ({ token: f.token, ca: f.ca }));
  for (const sample of [
    { status: 401, body: JSON.stringify({ error: SYNC_HISTORY_UNAVAILABLE }), kind: "blocked" },
    { status: 403, body: JSON.stringify({ error: SYNC_HISTORY_UNAVAILABLE }), kind: "blocked" },
    { status: 409, body: JSON.stringify({ error: SYNC_HISTORY_UNAVAILABLE, extra: true }), kind: "blocked" },
    { status: 503, body: JSON.stringify({ error: "unrecognized" }), kind: "blocked" },
    { status: 409, body: "{", kind: "blocked" },
    { status: 503, body: `{"error":"${"x".repeat(2048)}"}`, kind: "blocked" },
    { status: 409, body: JSON.stringify({ error: SYNC_HISTORY_UNAVAILABLE }), kind: "history" },
  ]) {
    status = sample.status;
    body = sample.body;
    await assert.rejects(client.json(routeAuthorization(routes.outbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity),
      (error: unknown) => classifySyncFailure(error).kind === sample.kind);
  }
});

test("holdings rejects forbidden live and terminal origins before looking up known or absent identities", async (t) => {
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  const bs = await f.listen(b);
  await b.publish(input, "live");
  await b.publish(input, "terminal");
  await b.deleteDocument("terminal");
  const bLedger = await b.snapshot();
  const routes = await f.connect(a, b, "https://127.0.0.1:1", bs.url, { ...bLedger.originKeys[0], redistribute: false });
  const client = new SyncClient(a, (await a.snapshot()).inboxId, () => ({ token: f.token, ca: f.ca }));
  for (const id of ["live", "terminal", "absent"]) {
    const identities = [{ originInboxId: bLedger.inboxId, originDocumentId: id }];
    await assert.rejects(b.holdings(routeAuthorization(routes.inbound), identities), /Origin or redistribution/);
    await assert.rejects(client.json(routeAuthorization(routes.outbound), "holdings", { identities }, parseHoldingsResponse, WIRE_LIMITS.holdings),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 403 && error.message === "unauthorized");
  }

  const allowed = await f.connect(a, b, "https://127.0.0.1:1", bs.url, { ...bLedger.originKeys[0], redistribute: true });
  const identities = ["live", "terminal", "absent"].map((originDocumentId) => ({ originInboxId: bLedger.inboxId, originDocumentId }));
  const holdings = await b.holdings(routeAuthorization(allowed.inbound), identities);
  assert.deepEqual(holdings.map((holding) => holding.state?.state ?? null), ["live", "deleted", null]);
  const ledger = await b.snapshot();
  ledger.routes[allowed.inbound.id].allowedOrigins[0].historyEpoch = randomUUID();
  await writeFile(path.join(ledger.ownerAnchor.home, "sync", "ledger.json"), JSON.stringify(ledger));
  for (const identity of identities) {
    await assert.rejects(b.holdings(routeAuthorization(allowed.inbound), [identity]), /Origin or redistribution/);
  }
});

test("audit after actual worker retry bookkeeping durably fences routes and invalidates attempts", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.store("a");
  const b = await f.store("b");
  const bs = await f.listen(b);
  const routes = await f.connect(a, b, "https://127.0.0.1:1", bs.url);
  await a.publish(input, "drift");
  await a.publish(input, "terminal");
  await a.deleteDocument("terminal");
  const worker = await f.worker(a);
  const before = await until(() => a.snapshot(), (ledger) => !!ledger.routeRetries[routes.outbound.id], "actual worker bookkeeping");
  await worker.close();
  const attempt = await a.openRouteAttempt(routeAuthorization(routes.outbound));
  try {
    const record = before.records[canonicalKey(before.inboxId, "drift")];
    assert.ok(record.bodyFile);
    await writeFile(path.join(before.ownerAnchor.home, "sync", "bodies", record.bodyFile), input.originalBytes.toString().replace("review", "REVIEW"));
    const result = await a.audit();
    assert.deepEqual(result.conflicts, [canonicalKey(before.inboxId, "drift")]);
    assert.equal(attempt.signal.aborted, true);
    const reopened = await new ManagedSyncStore(before.ownerAnchor.home).snapshot();
    assert.equal(reopened.worker.ownerQuarantined, true);
    assert.equal(reopened.routes[routes.outbound.id].revision, routes.outbound.revision + 1);
    assert.equal(reopened.routes[routes.outbound.id].state, "blocked");
    assert.equal(reopened.routeRetries[routes.outbound.id], undefined);
    assert.ok(Object.values(reopened.outbox).every((entry) => entry.disposition === "retired"));
    assert.deepEqual(reopened.records[canonicalKey(before.inboxId, "terminal")], before.records[canonicalKey(before.inboxId, "terminal")]);
    await assert.rejects(a.openRouteAttempt(routeAuthorization(routes.outbound)), /quarantine|Revoked/);
  } finally {
    await attempt.close();
  }
});
