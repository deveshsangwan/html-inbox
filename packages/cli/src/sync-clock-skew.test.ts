import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import platformTest, { type TestContext } from "node:test";
import { SyncClient, type SyncRequestOptions } from "./sync-client";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import { SYNC_LIMITS, type RouteAuthorization, type SyncRoute } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { reconcileSyncRoutes } from "./sync-reconciliation";
import { ManagedSyncStore } from "./sync-store";
import { opaqueToken, parseIdentityResponse, type IdentityResponse } from "./sync-wire";

// Managed enrollment needs POSIX directory fsync. Windows rejection is tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const bytes = Buffer.from("<!doctype html><html><body>clock skew fixture</body></html>");
const input = { originalBytes: bytes, title: "Clock skew", type: "report", sourceFileName: "clock.html" };

async function fixture(t: TestContext, offsetMs: number, direction: SyncRoute["direction"] = "outbound") {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-clock-skew-fixture-"));
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
      throw new AggregateError(failures, "Clock fixture cleanup failed");
    }

    await rm(root, { recursive: true, force: true });
    t.diagnostic(`removed fixture root ${root}`);
  });
  const tls = await createSyncHttpsCredentials({ after: (close) => {
    if (close) {
      cleanup.push(async () => { await close(t, () => {}); });
    }
  } });
  const ca = await readFile(tls.caPath);
  const token = opaqueToken();
  const localClock = { wall: Date.now(), elapsed: performance.now() };
  const remoteClock = { wall: localClock.wall + offsetMs, elapsed: localClock.elapsed };
  // Each HTTPS listener retains its own asynchronous clock context. No timestamp
  // is rewritten in the skew cases; the real handler issues its default lease.
  const clock = new AsyncLocalStorage<typeof localClock>();
  t.mock.method(Date, "now", () => (clock.getStore() ?? localClock).wall);
  t.mock.method(performance, "now", () => (clock.getStore() ?? localClock).elapsed);
  const source = new ManagedSyncStore(path.join(root, "source"));
  const receiver = new ManagedSyncStore(path.join(root, "receiver"));
  await source.enroll();
  await receiver.enroll();
  const a = await source.snapshot();
  const b = await receiver.snapshot();
  const key = await readFile(tls.trusted.keyPath);
  const cert = await readFile(tls.trusted.certPath);
  async function listen(store: ManagedSyncStore, peerId: string, serverClock: typeof localClock) {
    const server = createSyncIngestionServer({ store, peerId, credentials: () => ({ token }), host: "127.0.0.1", key, cert });
    const { url } = await clock.run(serverClock, () => server.start());
    cleanup.push(async () => { await server.close(); await assertLoopbackClosed(url); t.diagnostic(`rebound ${url}`); });
    return { server, url };
  }

  const sender = await listen(source, a.inboxId, direction === "outbound" ? localClock : remoteClock);
  const destination = await listen(receiver, b.inboxId, direction === "outbound" ? remoteClock : localClock);
  const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: destination.url,
    sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: "fixture", readerAudience: "synthetic",
    allowedOrigins: [a.originKeys[0]], credentialRef: "fixture", tlsTrustRef: "fixture", state: "reconnecting", lastError: null };
  await source.configureRoute(route);
  await receiver.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: sender.url });
  const json = SyncClient.prototype.json;
  const identities: Array<{ expiresAt: number; receivedAt: number; remainingMs: number }> = [];
  const hooks: { identity?: (response: IdentityResponse) => unknown; beforeRequest?: (endpoint: string, envelope: unknown) => void;
    afterResponse?: (endpoint: string, envelope: unknown) => void } = {};
  t.mock.method(SyncClient.prototype, "json", function<T>(this: SyncClient, authorization: RouteAuthorization,
    endpoint: Parameters<SyncClient["json"]>[1], envelope: unknown, parse: (value: unknown) => T, maximum: number, options: SyncRequestOptions = {}): Promise<T> {
    hooks.beforeRequest?.(endpoint, envelope);
    const callerClock = clock.getStore() ?? localClock;
    const responderClock = callerClock === localClock ? remoteClock : localClock;
    return json.bind(this)(authorization, endpoint, envelope, (value) => {
      if (endpoint === "identity") {
        const identity = parseIdentityResponse(value);
        callerClock.wall += 57;
        callerClock.elapsed += 57;
        identities.push({ expiresAt: identity.expiresAt, receivedAt: callerClock.wall, remainingMs: identity.expiresAt - callerClock.wall });
        assert.equal(identity.expiresAt, responderClock.wall + SYNC_LIMITS.manifestLeaseMs, "the real receiver uses its own default lease clock");
        value = hooks.identity?.(identity) ?? value;
      }

      hooks.afterResponse?.(endpoint, envelope);
      return parse(value);
    }, maximum, options);
  });

  const credentials = { token, ca };
  const runSource = () => reconcileSyncRoutes({ store: source, peerId: a.inboxId, credentials: () => credentials, routeIds: [route.id], deadlineMs: 5000 });
  const run = () => direction === "outbound" ? runSource() : reconcileSyncRoutes({ store: receiver, peerId: b.inboxId,
    credentials: () => credentials, routeIds: [route.id], deadlineMs: 5000 });
  const confirmSource = () => clock.run(direction === "outbound" ? localClock : remoteClock, runSource);
  return { source, receiver, route, server: direction === "outbound" ? destination.server : sender.server, identities, localClock, remoteClock,
    run, confirmSource, hooks, credentials };
}

for (const offsetMs of [75, -60_075, 0]) {
  test(`default HTTPS lease confirms custody with independent remote wall clock offset ${offsetMs}ms`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, offsetMs);
    await f.source.publish(input, "skewed");
    const result = await f.run();
    t.diagnostic(JSON.stringify({ offsetMs, identities: f.identities, result }));
    assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
    assert.equal(result.routes[0].transferred, 1);
    assert.equal((await f.source.deliveryStatus(f.route.id, f.route.sourceInboxId, "skewed")).isCommitted, true);
    const documents = await f.receiver.listDocuments();
    assert.equal(documents.length, 1);
    assert.deepEqual((await f.receiver.getDocument(documents[0].id))?.originalBytes, bytes);
    assert.equal(Object.keys((await f.receiver.snapshot()).receipts).length, 1);
    assert.equal(f.server.status().sessions, 0, "completion releases the remote cut despite clock skew");
    assert.equal(f.server.status().counters.activeRequests, 0);
  });
}

for (const offsetMs of [75, -60_075]) {
  test(`independent pull under ${offsetMs}ms skew creates discoverable durable custody`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, offsetMs, "inbound");
    await f.source.publish(input, "pulled");
    const result = await f.run();
    assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
    assert.equal(result.routes[0].fullyReconciled, true);
    assert.equal(result.routes[0].transferred, 1);
    assert.equal(f.server.status().sessions, 0);
    assert.equal(Object.keys((await f.receiver.snapshot()).checkpoints).length, 1);
    const document = (await f.receiver.listDocuments())[0];
    assert.deepEqual((await f.receiver.getDocument(document.id))?.originalBytes, bytes);
    assert.equal((await f.source.deliveryStatus(f.route.id, f.route.sourceInboxId, "pulled")).isCommitted, false);
    const confirmed = await f.confirmSource();
    assert.equal(confirmed.routes[0].status, "confirmed", JSON.stringify(confirmed));
    assert.equal(confirmed.routes[0].transferred, 0);
    assert.equal((await f.source.deliveryStatus(f.route.id, f.route.sourceInboxId, "pulled")).isCommitted, true);
    assert.equal((await f.receiver.listDocuments()).length, 1);
  });
}

for (const expiry of ["receiver", "local-before-identity", "local-before-page", "local-before-body", "local-before-completion"]) {
  test(`${expiry} lease expiry is bounded independently of remote timestamps and wall clock rollback`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, 75, expiry === "local-before-body" ? "inbound" : "outbound");
    await f.source.publish(input, "expiry");
    f.hooks.identity = (identity) => {
      if (expiry === "receiver") {
        f.remoteClock.wall += SYNC_LIMITS.manifestLeaseMs;
      } else if (expiry === "local-before-identity") {
        f.localClock.elapsed += SYNC_LIMITS.manifestLeaseMs;
        f.localClock.wall -= SYNC_LIMITS.manifestLeaseMs;
      }

      return { ...identity, expiresAt: Number.MAX_SAFE_INTEGER };
    };
    if (expiry === "local-before-page") {
      const inventory = f.source.inventory.bind(f.source);
      let advanced = false;
      t.mock.method(f.source, "inventory", async (...args: Parameters<typeof inventory>) => {
        const cut = await inventory(...args);
        if (!advanced) {
          advanced = true;
          f.localClock.elapsed += SYNC_LIMITS.manifestLeaseMs;
          f.localClock.wall -= SYNC_LIMITS.manifestLeaseMs;
        }

        return cut;
      });
    }

    f.hooks.afterResponse = (endpoint, envelope) => {
      if (endpoint === "manifest" && envelope !== null && typeof envelope === "object" && "op" in envelope &&
          (expiry === "local-before-body" && envelope.op === "ready" || expiry === "local-before-completion" && envelope.op === "push")) {
        f.localClock.elapsed += SYNC_LIMITS.manifestLeaseMs;
        f.localClock.wall -= SYNC_LIMITS.manifestLeaseMs;
      }
    };

    let completions = 0;
    f.hooks.beforeRequest = (endpoint, envelope) => {
      if (endpoint === "manifest" && envelope !== null && typeof envelope === "object" && "op" in envelope && envelope.op === "complete") {
        completions += 1;
      }
    };
    const result = await f.run();
    if (expiry === "local-before-completion") {
      assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
      assert.equal((await f.source.deliveryStatus(f.route.id, f.route.sourceInboxId, "expiry")).isCommitted, true);
      assert.equal(completions, 0, "an elapsed local lease cannot start completion even with an unbounded-looking remote timestamp");
    } else {
      assert.equal(result.routes[0].status, "pending", JSON.stringify(result));
      assert.equal(result.routes[0].lastError, "session-expired");
      assert.equal(result.routes[0].transferred, 0);
      assert.equal((await f.receiver.listDocuments()).length, 0);
      assert.equal(Object.keys((await f.receiver.snapshot()).receipts).length, 0);
    }

    if (expiry !== "receiver") {
      assert.equal(completions, 0);
      assert.equal(f.server.status().sessions, 1, "uncompleted cuts remain receiver-owned until their bounded expiry");
      f.remoteClock.wall += SYNC_LIMITS.manifestLeaseMs;
      // A fresh authenticated identity purges the old idle cut, even if its advertised expiry was changed by the test.
      f.hooks.identity = undefined;
      f.hooks.afterResponse = undefined;
      const retry = await f.run();
      assert.notEqual(retry.routes[0].lastError, "peer-identity-conflict");
      assert.equal(f.server.status().sessions, 0);
      assert.equal(f.server.status().cachedBytes, 0);
    }

    assert.equal(f.server.status().counters.activeRequests, 0);
  });
}

const invalidIdentity: Array<{ name: string; mutate: (response: IdentityResponse) => unknown }> = [
  { name: "request nonce", mutate: (response) => ({ ...response, requestNonce: opaqueToken() }) },
  { name: "peer", mutate: (response) => ({ ...response, peerId: randomUUID() }) },
  { name: "inbox", mutate: (response) => ({ ...response, inboxId: randomUUID() }) },
  { name: "scope", mutate: (response) => ({ ...response, scopeDigest: "0".repeat(64) }) },
  { name: "incarnation", mutate: (response) => ({ ...response, storageIncarnation: randomUUID() }) },
  { name: "challenge", mutate: (response) => ({ ...response, challengeNonce: opaqueToken() }) },
  ...[NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "60000", null].map((expiresAt) => ({
    name: `malformed expiry ${String(expiresAt)}`, mutate: (response: IdentityResponse) => ({ ...response, expiresAt }),
  })),
  { name: "extra field", mutate: (response) => ({ ...response, extra: true }) },
];

for (const control of invalidIdentity) {
  test(`clock tolerance still rejects wrong identity ${control.name}`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, 75);
    await f.source.publish(input, "invalid");
    f.hooks.identity = control.mutate;
    const result = await f.run();
    assert.equal(result.routes[0].status, "blocked", JSON.stringify(result));
    assert.equal(result.routes[0].transferred, 0);
    assert.equal((await f.source.deliveryStatus(f.route.id, f.route.sourceInboxId, "invalid")).isCommitted, false);
    assert.equal((await f.receiver.listDocuments()).length, 0);
    assert.equal(Object.keys((await f.receiver.snapshot()).receipts).length, 0);
  });
}

test("clock tolerance retains verified HTTPS rejection", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, 75);
  f.credentials.ca = Buffer.from("not a trusted certificate");
  const result = await f.run();
  assert.equal(result.routes[0].status, "blocked");
  assert.equal(result.routes[0].lastError, "tls-verification-failed");
  assert.equal(f.identities.length, 0);
  assert.equal(f.server.status().counters.requests, 0);
});
