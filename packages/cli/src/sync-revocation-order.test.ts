import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest from "node:test";
import { SyncClient } from "./sync-client";
import { createSyncHttpsCredentials, startSyncHttpsProxy } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import { parseObject, type SyncRoute } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { ManagedSyncStore } from "./sync-store";
import { opaqueToken, WIRE_LIMITS } from "./sync-wire";

// Managed storage requires POSIX durability; ordinary Windows behavior remains separately tested.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const bytes = Buffer.from("<!doctype html><html><body>revocation order fixture</body></html>");

test("durable external revocation aborts the whole pass when the inner watcher observes it first", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-revocation-order-"));
  const cleanup: Array<() => void | Promise<void>> = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    for (const close of cleanup.reverse()) {
      await close();
    }
  });
  const fixtureContext = { after: (close?: Parameters<typeof t.after>[0]) => {
    if (close) {
      cleanup.push(async () => { await close(t, () => {}); });
    }
  } };
  const tls = await createSyncHttpsCredentials(fixtureContext);
  const sourceHome = path.join(root, "source");
  const source = new ManagedSyncStore(sourceHome);
  const receiver = new ManagedSyncStore(path.join(root, "receiver"));
  await source.enroll();
  await receiver.enroll();
  const a = await source.snapshot();
  const b = await receiver.snapshot();
  const token = opaqueToken();
  const ca = await readFile(tls.caPath);
  const server = createSyncIngestionServer({ store: receiver, peerId: b.inboxId, credentials: () => ({ token }), host: "127.0.0.1",
    key: await readFile(tls.trusted.keyPath), cert: await readFile(tls.trusted.certPath) });
  const { url } = await server.start();
  cleanup.push(async () => { await server.close(); await assertLoopbackClosed(url); });
  const proxy = await startSyncHttpsProxy(fixtureContext, { upstreamUrl: url, upstreamCaPath: tls.caPath, server: tls.trusted, directory: tls.directory,
    routes: [{ label: "committed-body", pathname: "/sync/v1/body", method: "PUT" }],
    faults: [{ id: "hold-committed-ack", route: "committed-body", kind: "pause-response" }] });
  cleanup.push(() => assertLoopbackClosed(proxy.url));
  // Stop must precede rebind even though both are registered in the same owned stack.
  cleanup.push(async () => { await proxy.stop(); });
  const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: proxy.url, sourceInboxId: a.inboxId,
    destinationInboxId: b.inboxId, localInboxName: "fixture", readerAudience: "synthetic", allowedOrigins: [a.originKeys[0]],
    credentialRef: "fixture", tlsTrustRef: "fixture", state: "reconnecting", lastError: null };
  await source.configureRoute(route);
  await receiver.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: "https://127.0.0.1:1" });
  await source.publish({ originalBytes: bytes, title: "Revocation fixture", type: "report", sourceFileName: "fixture.html" }, "committed-before-revoke");

  const interval = globalThis.setInterval;
  let delayedWatchers = 0;
  let delayedChecks = 0;
  t.mock.method(globalThis, "setInterval", (callback: () => void, milliseconds?: number) => {
    if (milliseconds === 50 && delayedWatchers === 0) {
      delayedWatchers += 1;
      return interval(() => { delayedChecks += 1; }, milliseconds);
    }

    return interval(callback, milliseconds);
  });
  const open = source.openRouteAttempt.bind(source);
  let outer: Awaited<ReturnType<typeof open>> | undefined;
  let innerAborts = 0;
  t.mock.method(source, "openRouteAttempt", async (...args: Parameters<typeof open>) => {
    const attempt = await open(...args);
    if (!outer) {
      outer = attempt;
    } else {
      attempt.signal.addEventListener("abort", () => { innerAborts += 1; }, { once: true });
    }

    return attempt;
  });
  const setError = source.setRouteError.bind(source);
  let revoked = false;
  let staleErrorWrites = 0;
  t.mock.method(source, "setRouteError", (...args: Parameters<typeof setError>) => {
    if (revoked) staleErrorWrites += 1;
    return setError(...args);
  });
  let credentialResolutions = 0;
  const credentials = () => { credentialResolutions += 1; return { token, ca }; };
  const sending = reconcileSyncRoutes({ store: source, peerId: a.inboxId, credentials, routeIds: [route.id], requestMs: 2000, deadlineMs: 8000 });
  const observed = Promise.allSettled([sending]);
  const paused = await proxy.waitForEvent((event) => event.type === "fault-hit" && event.faultId === "hold-committed-ack");
  assert.equal(paused.type, "fault-hit");
  const committed = await receiver.snapshot();
  assert.equal(Object.keys(committed.receipts).length, 1);
  // The ACK remains held, so no successful pass bookkeeping can occur in this window.
  revoked = true;
  const resolutionsAtRevoke = credentialResolutions;
  const revokeScript = `const {ManagedSyncStore}=require(process.argv[1]);
new ManagedSyncStore(process.argv[2]).revokeRoute(process.argv[3],1).then(()=>console.log(JSON.stringify({pid:process.pid,revision:2}))).catch(error=>{console.error(error.message);process.exitCode=1;});`;
  let revokerPid: number | undefined;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", revokeScript, path.join(__dirname, "sync-store.js"), sourceHome, route.id], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, ZDOTDIR: root }, timeout: 5000, maxBuffer: 8192,
    }, (error, output, diagnostics) => error ? reject(new Error(diagnostics, { cause: error })) : resolve(output));
    revokerPid = child.pid;
  });
  const external = parseObject(JSON.parse(stdout), "external revoker result");
  assert.equal(external.pid, revokerPid);
  assert.equal(external.revision, 2);
  const exitedPid = revokerPid;
  assert.ok(exitedPid);
  assert.throws(() => process.kill(exitedPid, 0), { code: "ESRCH" });
  const result = await sending;
  await observed;
  assert.equal(delayedWatchers, 1);
  assert.ok(delayedChecks > 0, "the real outer watcher scheduling gap was exercised");
  assert.ok(innerAborts > 0, "an actual inner attempt observed the durable fence");
  t.diagnostic(JSON.stringify({ status: result.routes[0].status, outerAborted: outer?.signal.aborted, innerAborts, delayedWatchers,
    delayedChecks, staleErrorWrites, lastError: result.routes[0].lastError }));
  assert.equal(result.routes[0].status, "aborted");
  assert.equal(outer?.signal.aborted, true);
  assert.equal(staleErrorWrites, 0);
  const before = await proxy.stats();
  assert.equal(before.faultHits["hold-committed-ack"], 1);
  assert.equal(proxy.events.filter((event) => event.type === "fault-hit").length, 1);
  const client = new SyncClient(source, a.inboxId, credentials);
  for (let pass = 0; pass < 3; pass += 1) {
    const detached = await reconcileSyncRoutes({ store: source, peerId: a.inboxId, credentials, routeIds: [route.id] });
    assert.equal(detached.routes[0].status, "detached");
    assert.equal(detached.counters.requests, 0);
    for (const endpoint of ["identity", "manifest", "holdings", "offer"] satisfies Parameters<SyncClient["json"]>[1][]) {
      await assert.rejects(client.json(routeAuthorization(route), endpoint, {}, (value) => value, WIRE_LIMITS.identity), /route authorization/);
    }
  }

  assert.equal(credentialResolutions, resolutionsAtRevoke);
  assert.deepEqual((await proxy.stats()).routes, before.routes);
  assert.deepEqual((await receiver.snapshot()).receipts, committed.receipts);
  const document = (await receiver.listDocuments())[0];
  assert.deepEqual((await receiver.getDocument(document.id))?.originalBytes, bytes);
  const local = await source.snapshot();
  assert.equal(local.routes[route.id].revision, 2);
  assert.equal(local.routes[route.id].state, "detached");
  assert.ok(Object.values(local.outbox).every((entry) => entry.disposition === "retired"));
  assert.equal(local.routes[route.id].lastError, null);
});

for (const revokeBeforeError of [true, false]) {
  test(revokeBeforeError ? "revocation first observed by history-error bookkeeping finalizes as aborted" :
    "an unrevoked complete history error remains blocked", { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "html-inbox-revocation-history-"));
    const cleanup: Array<() => void | Promise<void>> = [() => rm(root, { recursive: true, force: true })];
    t.after(async () => {
      for (const close of cleanup.reverse()) {
        await close();
      }
    });
    const fixtureContext = { after: (close?: Parameters<typeof t.after>[0]) => {
      if (close) {
        cleanup.push(async () => { await close(t, () => {}); });
      }
    } };
    const tls = await createSyncHttpsCredentials(fixtureContext);
    const owner = new ManagedSyncStore(path.join(root, "owner"));
    const relay = new ManagedSyncStore(path.join(root, "relay"));
    const receiverHome = path.join(root, "receiver");
    const receiver = new ManagedSyncStore(receiverHome);
    for (const store of [owner, relay, receiver]) {
      await store.enroll();
    }

    const origin = await owner.snapshot();
    const source = await relay.snapshot();
    const destination = await receiver.snapshot();
    const token = opaqueToken();
    const ca = await readFile(tls.caPath);
    const server = createSyncIngestionServer({ store: relay, peerId: source.inboxId, credentials: () => ({ token }), host: "127.0.0.1",
      key: await readFile(tls.trusted.keyPath), cert: await readFile(tls.trusted.certPath), requestMs: 5000 });
    const { url } = await server.start();
    cleanup.push(async () => {
      await server.close();
      await assertLoopbackClosed(url);
    });
    const proxy = await startSyncHttpsProxy(fixtureContext, { upstreamUrl: url, upstreamCaPath: tls.caPath, server: tls.trusted,
      directory: tls.directory, routes: [{ label: "history-identity", pathname: "/sync/v1/identity", method: "POST" }],
      faults: [{ id: "hold-complete-history-error", route: "history-identity", kind: "pause-response" }] });
    cleanup.push(async () => {
      await proxy.stop();
      await assertLoopbackClosed(proxy.url);
    });
    const outgoing: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: destination.inboxId,
      peerUrl: "https://127.0.0.1:1", sourceInboxId: source.inboxId, destinationInboxId: destination.inboxId,
      allowedOrigins: [{ ...origin.originKeys[0], redistribute: true }], localInboxName: "fixture", readerAudience: "synthetic",
      credentialRef: "fixture", tlsTrustRef: "fixture", state: "reconnecting", lastError: null };
    await relay.configureRoute(outgoing);
    const incoming = await receiver.configureRoute({ ...outgoing, direction: "inbound", peerId: source.inboxId, peerUrl: proxy.url });

    // Delay only receiver watcher notifications; server watchers and absolute deadlines remain real.
    const receiverWatcher = new AsyncLocalStorage<boolean>();
    const interval = globalThis.setInterval;
    let delayedWatchers = 0;
    let delayedTicks = 0;
    let serverWatchers = 0;
    t.mock.method(globalThis, "setInterval", (callback: () => void, milliseconds?: number) => {
      if (milliseconds === 50 && receiverWatcher.getStore()) {
        delayedWatchers += 1;
        return interval(() => { delayedTicks += 1; }, milliseconds);
      }

      if (milliseconds === 50) {
        serverWatchers += 1;
      }

      return interval(callback, milliseconds);
    });
    const open = receiver.openRouteAttempt.bind(receiver);
    const attempts: Array<Awaited<ReturnType<typeof open>>> = [];
    t.mock.method(receiver, "openRouteAttempt", async (...args: Parameters<typeof open>) => {
      const attempt = await receiverWatcher.run(true, () => open(...args));
      attempts.push(attempt);
      return attempt;
    });
    const setError = receiver.setRouteError.bind(receiver);
    const errorCalls: Array<{ beforeAbort: boolean; afterAbort: boolean; persisted: boolean }> = [];
    t.mock.method(receiver, "setRouteError", async (...args: Parameters<typeof setError>) => {
      const call = { beforeAbort: attempts[0].signal.aborted, afterAbort: false, persisted: false };
      errorCalls.push(call);
      try {
        await setError(...args);
        call.persisted = true;
      } finally {
        call.afterAbort = attempts[0].signal.aborted;
      }
    });
    let credentialResolutions = 0;
    const credentials = () => {
      credentialResolutions += 1;
      return { token, ca };
    };
    const running = reconcileSyncRoutes({ store: receiver, peerId: destination.inboxId, credentials, routeIds: [incoming.id],
      requestMs: 3000, deadlineMs: 6000 });
    const observed = Promise.allSettled([running]);
    const held = await proxy.waitForEvent((event) => event.type === "fault-hit" && event.faultId === "hold-complete-history-error");
    assert.ok(held.type === "fault-hit");
    const response = proxy.events.find((event) => event.type === "upstream-response" && event.requestId === held.requestId);
    assert.ok(response?.type === "upstream-response");
    assert.equal(response.statusCode, 409);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((attempt) => !attempt.signal.aborted));

    if (revokeBeforeError) {
      const script = `new (require(process.argv[1]).ManagedSyncStore)(process.argv[2]).revokeRoute(process.argv[3],1).then(()=>console.log(JSON.stringify({pid:process.pid,revision:2}))).catch(error=>{console.error(error.message);process.exitCode=1;});`;
      let revokerPid: number | undefined;
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, ["-e", script, path.join(__dirname, "sync-store.js"), receiverHome, incoming.id], {
          cwd: root, env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, ZDOTDIR: root }, timeout: 4000, maxBuffer: 8192,
        }, (error, output, diagnostics) => error ? reject(new Error(diagnostics, { cause: error })) : resolve(output));
        revokerPid = child.pid;
      });
      const external = parseObject(JSON.parse(stdout), "external revoker result");
      assert.equal(external.pid, revokerPid);
      assert.equal(external.revision, 2);
      const exitedPid = revokerPid;
      assert.ok(exitedPid);
      assert.throws(() => process.kill(exitedPid, 0), { code: "ESRCH" });
    }

    const durableBeforeError = await receiver.snapshot();
    assert.equal(durableBeforeError.routes[incoming.id].state, revokeBeforeError ? "detached" : "reconnecting");
    assert.ok(attempts.every((attempt) => !attempt.signal.aborted), "bookkeeping must be the first receiver observer of the fence");
    proxy.release(held.requestId);
    const result = await running;
    await observed;
    const stats = await proxy.stats();
    assert.equal(stats.faultHits["hold-complete-history-error"], 1);
    assert.equal(proxy.events.filter((event) => event.type === "fault-hit").length, 1);
    assert.equal(delayedWatchers, 2);
    assert.ok(serverWatchers > 0, "the real server watcher is not delayed");
    assert.equal(attempts[1].signal.aborted, false, "the complete error closes the inner attempt before revocation is observed");
    assert.deepEqual(errorCalls, [{ beforeAbort: false, afterAbort: revokeBeforeError, persisted: !revokeBeforeError }]);
    t.diagnostic(JSON.stringify({ revokeBeforeError, status: result.routes[0].status, lastError: result.routes[0].lastError,
      outerAborted: attempts[0].signal.aborted, errorCalls, delayedWatchers, delayedTicks, serverWatchers }));
    assert.equal(result.routes[0].status, revokeBeforeError ? "aborted" : "blocked");
    assert.equal(result.routes[0].lastError, "trusted-history-unavailable");
    assert.equal(attempts[0].signal.aborted, revokeBeforeError);
    const final = await receiver.snapshot();
    assert.equal(final.routes[incoming.id].lastError, revokeBeforeError ? null : "trusted-history-unavailable");
    assert.equal(Object.keys(final.records).length, 0);
    assert.equal(Object.keys(final.receipts).length, 0);
    assert.equal(credentialResolutions, 1);

    if (revokeBeforeError) {
      for (let pass = 0; pass < 3; pass += 1) {
        const later = await reconcileSyncRoutes({ store: receiver, peerId: destination.inboxId, credentials, routeIds: [incoming.id] });
        assert.equal(later.routes[0].status, "detached");
        assert.equal(later.counters.requests, 0);
      }

      assert.equal(credentialResolutions, 1);
      assert.deepEqual((await proxy.stats()).routes, stats.routes);
      assert.equal(final.routes[incoming.id].revision, 2);
      assert.equal(final.routes[incoming.id].state, "detached");
    }
  });
}
