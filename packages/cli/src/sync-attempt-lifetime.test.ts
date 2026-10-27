import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { constants, lstatSync } from "node:fs";
import fs, { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { TimerOptions } from "node:timers";
import timers from "node:timers/promises";
import platformTest from "node:test";
import { SyncClient } from "./sync-client";
import * as locks from "./sync-files";
import { errorCauses, holdWatcherRelease, latch, lifetimeFixture, observeWatchers, ownershipHolder, reached,
  type WatcherCheck } from "./sync-attempt-lifetime-fixtures";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { opaqueToken, parseIdentityResponse, parseManifestPage, WIRE_LIMITS } from "./sync-wire";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const bytes = Buffer.from("<!doctype html><html><body>real attempt lifetime</body></html>");
const input = { originalBytes: bytes, title: "Attempt lifetime", type: "report", sourceFileName: "attempt.html" };

for (const releaseFirst of [false, true]) {
  test(`attempt close ${releaseFirst ? "control follows" : "joins"} the actual ownership release flush`, { timeout: 10_000 }, async (t) => {
    const f = await lifetimeFixture(t);
    const route = (await f.connect()).outbound;
    const observer = observeWatchers(t, f);
    const probe = holdWatcherRelease(t, f, observer, f.source);
    const attempt = await f.source.openRouteAttempt(routeAuthorization(route));
    await reached(probe.entered, "real watcher release flush held");
    assert.equal(probe.hits(), 1);
    assert.equal(probe.selected()?.acquired, true);

    if (releaseFirst) {
      probe.release();
      await Promise.all([...observer.pending]);
    }

    const closing = attempt.close();
    assert.equal(attempt.close(), closing, "concurrent close returns the same promise");
    const closed = Promise.resolve(closing).then(() => { probe.events.push("attempt-closed"); });
    if (!releaseFirst) {
      await Promise.resolve();
      assert.equal(probe.events.includes("attempt-closed"), false, "a real outstanding release owns close completion");
      probe.release();
    }

    await reached(closed, "close joined native release");
    assert.equal(attempt.close(), closing, "later close retains the same outcome");
    assert.equal(attempt.signal.aborted, false, "ordinary close is not public cancellation");
    assert.ok(probe.events.lastIndexOf("release-flush-return") < probe.events.indexOf("attempt-closed"));
    assert.ok(probe.handles.length >= 3);
    assert.ok(probe.handles.every((handle) => handle.fd === -1), "real ownership and inspection handles closed");
    await assert.rejects(lstat(path.join(f.sourceHome, "sync/mutation.lock")), { code: "ENOENT" });
    assert.equal((await readdir(path.join(f.sourceHome, "sync"))).some((name) => name.includes(".owner-")), false);
  });
}

test("close retires a real pre-enqueue watcher and caches its promise before abort reentrancy", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const route = (await f.connect()).outbound;
  const observer = observeWatchers(t, f);
  const entered = latch();
  const release = latch();
  let selected: WatcherCheck | undefined;
  let reentered: ReturnType<Awaited<ReturnType<typeof f.source.openRouteAttempt>>["close"]> | undefined;
  let abortNotifications = 0;
  observer.hooks.beforeEnqueue = async (check) => {
    if (selected) return;

    selected = check;
    assert.ok(check.signal, "the actual watcher supplied its own queue signal");
    check.signal.addEventListener("abort", () => { abortNotifications += 1; reentered = attempt.close(); }, { once: true });
    entered.release();
    await reached(release.promise, "pre-enqueue watcher released");
  };
  f.cleanup.push(release.release);
  const attempt = await f.source.openRouteAttempt(routeAuthorization(route));
  await reached(entered.promise, "real interval callback reached pre-enqueue seam");
  const closing = attempt.close();
  assert.equal(reentered, closing, "synchronous abort notification observes the cached close");
  assert.equal(abortNotifications, 1);
  release.release();
  await reached(Promise.resolve(closing), "pre-enqueue producer joined");
  assert.ok(selected);
  assert.equal(selected.acquired, false);
  assert.equal(selected.settled, true);
  assert.equal(selected.error, selected.signal?.reason);
  assert.equal(attempt.signal.aborted, false);
  await assert.rejects(lstat(path.join(f.sourceHome, "sync/mutation.lock")), { code: "ENOENT" });
});

test("cancelled watcher queue entries neither wait for nor bypass an unrelated real holder", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const route = (await f.connect()).outbound;
  const observer = observeWatchers(t, f);
  const attempt = await f.source.openRouteAttempt(routeAuthorization(route));
  const held = latch();
  const release = latch();
  const enqueued = latch();
  const directory = path.join(f.sourceHome, "sync");
  let selected: WatcherCheck | undefined;
  observer.hooks.enqueued = (check) => { selected ??= check; enqueued.release(); };

  const holder = locks.withStoreLock(directory, 1000, async () => { held.release(); await reached(release.promise, "unrelated holder released"); });
  f.cleanup.push(async () => { release.release(); await holder; });
  await reached(held.promise, "unrelated actual canonical lock acquired");
  const owner = await locks.readSyncOwnership(path.join(directory, "mutation.lock"));
  await reached(enqueued.promise, "watcher entered genuine local queue");
  let successorCalls = 0;
  const successor = locks.withStoreLock(directory, 1000, async () => { successorCalls += 1; });
  f.cleanup.push(async () => { release.release(); await successor; });
  await reached(Promise.resolve(attempt.close()), "queue cancellation without holder release");
  assert.ok(selected);
  assert.equal(selected.acquired, false);
  assert.equal(selected.settled, true);
  assert.equal(successorCalls, 0);
  assert.deepEqual(await locks.readSyncOwnership(path.join(directory, "mutation.lock")), owner);
  assert.equal(attempt.signal.aborted, false);
  release.release();
  await Promise.all([holder, successor]);
  assert.equal(successorCalls, 1);
});

test("an already-fired native interval delivered after close cannot admit another check", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const route = (await f.connect()).outbound;
  const observer = observeWatchers(t, f);
  const fired = latch();
  let deliver: (() => void) | undefined;
  observer.hooks.timer = (_store, callback) => { deliver ??= callback; fired.release(); };
  const attempt = await f.source.openRouteAttempt(routeAuthorization(route));
  await reached(fired.promise, "original native interval fired before delayed delivery");
  await attempt.close();
  assert.ok(deliver);
  deliver();
  await Promise.resolve();
  assert.equal(observer.checks.length, 0, "closed admission rejects the original delayed callback");
  assert.equal(attempt.signal.aborted, false);
});

for (const owner of ["client", "pass", "pass-cancel", "final-snapshot-cancel"] as const) {
  test(`${owner} owns its actual watcher until the finalizer joins`, { timeout: 10_000 }, async (t) => {
    const f = await lifetimeFixture(t);
    const requestGate = latch();
    const nativeServer = https.createServer;
    t.mock.method(https, "createServer", (options: https.ServerOptions, handler: (request: IncomingMessage, response: ServerResponse) => void) =>
      nativeServer(options, (request, response) => { void requestGate.promise.then(() => handler(request, response)); }));
    const endpoint = await f.listen(f.receiver);
    const route = (await f.connect(endpoint.url)).outbound;
    if (owner !== "client") await f.source.publish(input, "owned");
    const observer = observeWatchers(t, f);
    const entered = latch();
    const release = latch();
    const closing = latch();
    const controller = new AbortController();
    let selected: WatcherCheck | undefined;
    let closeComplete = false;
    let snapshotHits = 0;
    observer.hooks.beforeEnqueue = async (check) => {
      if (selected || check.attempt !== observer.attempts.find((attempt) => attempt.store === f.source)?.id) return;

      selected = check;
      entered.release();
      await reached(release.promise, "owner's pre-enqueue watcher released");
    };
    observer.hooks.closing = (id, _store, result) => {
      if (id !== selected?.attempt) return;

      closing.release();
      void Promise.resolve(result).then(() => { closeComplete = true; });
    };
    const snapshot = f.source.snapshot.bind(f.source);
    if (owner === "final-snapshot-cancel") {
      t.mock.method(f.source, "snapshot", async () => {
        const actual = await snapshot();
        if (closeComplete && snapshotHits === 0) {
          snapshotHits += 1;
          controller.abort(new Error("cancel during actual final snapshot"));
        }

        return actual;
      });
    }
    f.cleanup.push(() => { requestGate.release(); release.release(); });
    const client = new SyncClient(f.source, f.a.inboxId, () => ({ token: f.token, ca: endpoint.ca }));
    const running = owner === "client"
      ? client.json(routeAuthorization(route), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity, { requestMs: 1000 })
      : reconcileSyncRoutes({ store: f.source, peerId: f.a.inboxId, routeIds: [route.id], credentials: () => ({ token: f.token, ca: endpoint.ca }),
        signal: controller.signal, requestMs: 1000, deadlineMs: 5000 });
    let returned = false;
    const observed = running.then((value) => { returned = true; return value; });
    void observed.catch(() => {});
    f.cleanup.push(async () => { requestGate.release(); release.release(); await Promise.allSettled([observed]); });
    await reached(entered.promise, "owning source watcher's actual callback");
    requestGate.release();
    await reached(closing.promise, "real owner's close finalizer");
    assert.equal(returned, false, "the owner cannot finish while its admitted producer is held");
    if (owner === "pass-cancel") controller.abort(new Error("cancel during actual close drain"));
    release.release();
    const result = await reached(observed, "owner settled after producer");
    assert.ok(selected);
    assert.equal(selected.settled, true);
    assert.equal(selected.acquired, false);
    if ("routes" in result) {
      assert.equal(result.routes[0].status, owner === "pass" ? "confirmed" : "aborted");
      assert.equal((await f.source.deliveryStatus(route.id, f.a.inboxId, "owned")).isCommitted, true);
      const documents = await f.receiver.listDocuments();
      assert.equal(documents.length, 1);
      assert.deepEqual((await f.receiver.getDocument(documents[0].id))?.originalBytes, bytes);
      assert.equal(Object.keys((await f.receiver.snapshot()).receipts).length, 1);
    }

    if (owner === "final-snapshot-cancel") assert.equal(snapshotHits, 1);
  });
}

test("HTTPS handler and server close retain an actual watcher after the response is sent", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const endpoint = await f.listen(f.source);
  const routes = await f.connect("https://127.0.0.1:1", endpoint.url);
  const observer = observeWatchers(t, f);
  const entered = latch();
  const release = latch();
  const closedAttempt = latch();
  const inventory = f.source.inventory.bind(f.source);
  const inventoryEntered = latch();
  let selected: WatcherCheck | undefined;
  observer.hooks.beforeEnqueue = async (check) => {
    if (check.store !== f.source || selected) return;

    selected = check;
    entered.release();
    await reached(release.promise, "HTTP watcher's pre-enqueue release");
  };
  observer.hooks.closing = (id) => { if (id === selected?.attempt) closedAttempt.release(); };
  t.mock.method(f.source, "inventory", async (...args: Parameters<typeof inventory>) => {
    inventoryEntered.release();
    await reached(entered.promise, "HTTP watcher admitted while actual inventory waits");
    return inventory(...args);
  });
  f.cleanup.push(release.release);
  const client = new SyncClient(f.receiver, f.b.inboxId, () => ({ token: f.token, ca: endpoint.ca }));
  const request = client.json(routeAuthorization(routes.inbound), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity);
  void request.catch(() => {});
  f.cleanup.push(async () => { release.release(); await Promise.allSettled([request]); });
  await reached(inventoryEntered.promise, "real identity reached inventory");
  await reached(closedAttempt.promise, "handler entered close after real response");
  assert.equal(endpoint.server.status().counters.activeRequests, 1);
  let returned = false;
  const closing = endpoint.server.close().then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false);
  release.release();
  await Promise.all([reached(closing, "server joins handler watcher"), request]);
  assert.equal(endpoint.server.status().counters.activeRequests, 0);
  assert.equal(endpoint.server.status().listening, false);
});

test("late pin remains independent while a genuinely queued server watcher drains within existing bounds", { timeout: 15_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  let response: ServerResponse | undefined;
  const createServer = https.createServer;
  t.mock.method(https, "createServer", (options: https.ServerOptions, handler: (request: IncomingMessage, response: ServerResponse) => void) =>
    createServer(options, (request, outgoing) => { if (request.method === "GET") response = outgoing; handler(request, outgoing); }));
  const endpoint = await f.listen(f.source, 1000);
  const routes = await f.connect("https://127.0.0.1:1", endpoint.url);
  await f.source.publish(input, "late-pin");
  const auth = routeAuthorization(routes.inbound);
  const client = new SyncClient(f.receiver, f.b.inboxId, () => ({ token: f.token, ca: endpoint.ca }));
  const nonce = opaqueToken();
  const identity = await client.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity);
  const page = await client.json(auth, "manifest", { op: "pull", sessionId: identity.sessionId, cursor: null }, parseManifestPage, WIRE_LIMITS.page);
  await f.receiver.completeInventory(auth, page.evidence, page.descriptors, nonce);
  await client.json(auth, "manifest", { op: "ready", sessionId: identity.sessionId, ready: { kind: "terminal-inventory-ready", evidence: page.evidence,
    ackNonce: identity.challengeNonce, receiverPeerId: f.b.inboxId, destinationInboxId: f.b.inboxId, storageIncarnation: f.b.storageIncarnation } }, (value) => value, WIRE_LIMITS.identity);
  const observer = observeWatchers(t, f);
  const pin = f.source.pinOutgoing.bind(f.source);
  const held = latch();
  const release = latch();
  const queued = latch();
  let holder: Promise<void> | undefined;
  let pinned: ReturnType<typeof pin> | undefined;
  let selected: WatcherCheck | undefined;
  t.mock.method(f.source, "pinOutgoing", async (...args: Parameters<typeof pin>) => {
    holder = locks.withStoreLock(path.join(f.sourceHome, "sync"), 1000, async () => { held.release(); await reached(release.promise, "pin's unrelated holder released"); });
    await held.promise;
    pinned = pin(...args);
    return pinned;
  });
  observer.hooks.enqueued = (check) => {
    if (check.store === f.source && !selected) { selected = check; queued.release(); }
  };
  f.cleanup.push(async () => { release.release(); await Promise.allSettled([holder, pinned]); });
  const pulling = assert.rejects(client.pullBody(auth, identity.sessionId, page.descriptors[0], { requestMs: 3000 }));
  void pulling.catch(() => {});
  f.cleanup.push(async () => { release.release(); await pulling; });
  await reached(queued.promise, "real server watcher entered queue behind actual held pin lock");
  await endpoint.server.close();
  await pulling;
  await f.source.quiesceRoute(routes.outbound.id, Date.now() + 600);
  assert.ok(selected);
  assert.equal(selected.settled, true);
  assert.equal(selected.acquired, false);
  assert.equal(endpoint.server.status().counters.activeRequests, 0);
  assert.ok(await locks.readSyncOwnership(path.join(f.sourceHome, "sync/mutation.lock")), "unrelated holder is still genuinely held");
  release.release();
  await Promise.all([holder, pinned]);
  assert.ok(response);
  assert.equal(response.headersSent, false);
  assert.equal((await f.receiver.listDocuments()).length, 0);
  assert.equal(Object.keys((await f.receiver.snapshot()).receipts).length, 0);
});

for (const mode of ["managed", "portable"] as const) {
  test(`${mode} real retry cancellation returns the exact reason after owned cleanup`, { timeout: 10_000 }, async (t) => {
    const f = await lifetimeFixture(t);
    const lockPath = path.join(f.sourceHome, "sync/mutation.lock");
    const holder = await ownershipHolder(f, lockPath, mode);
    const originalOwner = await locks.readSyncOwnership(lockPath);
    assert.equal(originalOwner?.pid, holder.child.pid);
    const controller = new AbortController();
    const reason = new Error("owned retry stop");
    const entered = latch();
    const nativeDelay = timers.setTimeout;
    let hits = 0;
    let nativeError: unknown;
    t.mock.method(timers, "setTimeout", <T = void>(milliseconds?: number, value?: T, options?: TimerOptions): Promise<T> => {
      const waiting = nativeDelay<T>(milliseconds, value, options);
      if (options?.signal === controller.signal) {
        hits += 1;
        entered.release();
        void waiting.catch((error: unknown) => { nativeError = error; });
      }

      return waiting;
    });
    const acquiring = locks.acquireSyncOwnership(lockPath, Date.now() + 1000, controller.signal, { mode });
    const rejected = assert.rejects(acquiring, (error: unknown) => error === reason);
    await reached(entered.promise, "real acquisition retry timer entered");
    controller.abort(reason);
    await rejected;
    assert.equal(hits, 1);
    assert.ok(nativeError instanceof Error);
    assert.equal(nativeError.name, "AbortError");
    assert.equal(nativeError.cause, reason);
    assert.deepEqual(await locks.readSyncOwnership(lockPath), originalOwner);
    assert.equal((await readdir(path.dirname(lockPath))).some((name) => name.includes(".owner-")), false);
    await holder.stop();
  });
}

for (const fault of ["unrelated-abort", "io", "aggregate"] as const) {
  test(`timer normalization preserves the original ${fault} rejection`, { timeout: 10_000 }, async (t) => {
    const f = await lifetimeFixture(t);
    const lockPath = path.join(f.sourceHome, "sync/mutation.lock");
    const holder = await ownershipHolder(f, lockPath);
    const controller = new AbortController();
    const stop = new Error("private stop");
    const io = Object.assign(new Error("actual timer seam I/O control"), { code: "EIO" });
    const compound = Object.assign(new AggregateError([stop, io], "compound must remain compound", { cause: stop }), { name: "AbortError", code: "ABORT_ERR" });
    const nativeDelay = timers.setTimeout;
    let original: unknown;
    let hits = 0;
    t.mock.method(timers, "setTimeout", <T = void>(milliseconds?: number, value?: T, options?: TimerOptions): Promise<T> => {
      if (options?.signal !== controller.signal) return nativeDelay<T>(milliseconds, value, options);

      hits += 1;
      controller.abort(stop);
      if (fault !== "unrelated-abort") {
        original = fault === "io" ? io : compound;
        return Promise.reject(original);
      }

      const foreign = new AbortController();
      foreign.abort(new Error("unrelated native timer stop"));
      const waiting = nativeDelay<T>(milliseconds, value, { signal: foreign.signal });
      void waiting.catch((error: unknown) => { original = error; });
      return waiting;
    });
    await assert.rejects(locks.acquireSyncOwnership(lockPath, Date.now() + 1000, controller.signal), (error: unknown) => error === original);
    assert.equal(hits, 1);
    assert.notEqual(original, stop);
    await holder.stop();
  });
}

test("an abort-shaped filesystem failure never enters retry-only normalization", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const controller = new AbortController();
  const stop = new Error("owned stop during candidate I/O");
  const failure = Object.assign(new Error("filesystem abort-shaped failure", { cause: stop }), { name: "AbortError", code: "ABORT_ERR" });
  const nativeOpen = fs.open;
  let hits = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await nativeOpen(...args);
    if (String(args[0]).includes(".mutation.lock.owner-") && typeof args[1] === "number" && (args[1] & constants.O_EXCL) !== 0) {
      const sync = file.sync.bind(file);
      t.mock.method(file, "sync", async () => {
        await sync();
        if (hits === 0) { hits += 1; controller.abort(stop); throw failure; }
      });
    }

    return file;
  });
  await assert.rejects(locks.acquireSyncOwnership(path.join(f.sourceHome, "sync/mutation.lock"), Date.now() + 1000, controller.signal), (error: unknown) => error === failure);
  assert.equal(hits, 1);
  assert.equal((await readdir(path.join(f.sourceHome, "sync"))).some((name) => name.includes(".owner-")), false);
});

for (const closeFault of [false, true]) {
  test(`normal close ${closeFault ? "preserves a retry-stop plus handle-close failure" : "joins a pure native retry stop"}`, { timeout: 10_000 }, async (t) => {
    const f = await lifetimeFixture(t);
    const route = (await f.connect()).outbound;
    const observer = observeWatchers(t, f);
    const attempt = await f.source.openRouteAttempt(routeAuthorization(route));
    const entered = latch();
    const nativeDelay = timers.setTimeout;
    const nativeOpen = fs.open;
    const failure = new Error("retained handle closed then rejected");
    let selected: WatcherCheck | undefined;
    let closeHits = 0;
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    t.mock.method(timers, "setTimeout", <T = void>(milliseconds?: number, value?: T, options?: TimerOptions): Promise<T> => {
      const waiting = nativeDelay<T>(milliseconds, value, options);
      const check = observer.current();
      if (check && options?.signal === check.signal) { selected = check; entered.release(); }
      return waiting;
    });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await nativeOpen(...args);
      const check = observer.current();
      if (check && String(args[0]).includes(".mutation.lock.owner-") && typeof args[1] === "number" && (args[1] & constants.O_EXCL) === 0) {
        handles.push(file);
        const close = file.close.bind(file);
        t.mock.method(file, "close", async () => {
          await close();
          if (closeFault && check.signal?.aborted && closeHits === 0) { closeHits += 1; throw failure; }
        });
      }

      return file;
    });
    const holder = await ownershipHolder(f, path.join(f.sourceHome, "sync/mutation.lock"));
    const originalOwner = await locks.readSyncOwnership(path.join(f.sourceHome, "sync/mutation.lock"));
    await reached(entered.promise, "real watcher entered contested native retry");
    await attempt.close();
    assert.ok(selected);
    assert.equal(closeHits, closeFault ? 1 : 0);
    if (closeFault) {
      assert.ok(selected.error instanceof AggregateError);
      assert.ok(errorCauses(selected.error).includes(selected.signal?.reason));
      assert.ok(errorCauses(selected.error).includes(failure));
    } else {
      assert.equal(selected.error, selected.signal?.reason);
    }

    assert.equal(attempt.signal.aborted, closeFault, "only the real compound failure takes the existing public abort path");
    assert.ok(handles.length > 0);
    assert.ok(handles.every((handle) => handle.fd === -1));
    assert.deepEqual(await locks.readSyncOwnership(path.join(f.sourceHome, "sync/mutation.lock")), originalOwner);
    await holder.stop();
  });
}

test("a real acquisition-success handoff closed before protected work still releases its owner", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const route = (await f.connect()).outbound;
  const observer = observeWatchers(t, f);
  const cut = latch();
  const lockPath = path.join(f.sourceHome, "sync/mutation.lock");
  let target: number | undefined;
  let hits = 0;
  let witness: { ino: number; size: number } | undefined;
  let hookError: unknown;
  let closing: Promise<void> | undefined;
  const attempt = await f.source.openRouteAttempt(routeAuthorization(route));
  const hook = createHook({ init(id, type) {
    if (type !== "PROMISE" || target !== undefined || !observer.current()) return;

    const stack = new Error().stack ?? "";
    if (stack.includes("at acquireSyncOwnership") && stack.includes("at withProcessLock")) target = id;
  }, promiseResolve(id) {
    if (id !== target || hits !== 0) return;

    hits += 1;
    try {
      const info = lstatSync(lockPath);
      witness = { ino: info.ino, size: info.size };
      closing = Promise.resolve(attempt.close());
    } catch (error) { hookError = error; }
    cut.release();
  } });
  hook.enable();
  f.cleanup.push(() => { hook.disable(); });
  try {
    await reached(cut.promise, "actual ownership promise resolved with canonical still held");
    assert.equal(hookError, undefined);
    assert.ok(witness && witness.size > 0);
    assert.ok(closing);
    await closing;
  } finally {
    hook.disable();
    await attempt.close();
  }

  assert.equal(hits, 1);
  assert.equal(observer.checks.length, 1);
  assert.equal(observer.checks[0].acquired, false, "post-acquire stop is checked inside ownership cleanup scope");
  assert.equal(observer.checks[0].error, observer.checks[0].signal?.reason);
  assert.equal(attempt.signal.aborted, false);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

for (const state of ["revoked", "paused", "unknown", "unsafe"] as const) {
  test(`watcher close preserves ${state} fencing and ownership evidence`, { timeout: 10_000 }, async (t) => {
    const f = await lifetimeFixture(t);
    const route = (await f.connect()).outbound;
    const observer = observeWatchers(t, f);
    const entered = latch();
    const release = latch();
    let selected: WatcherCheck | undefined;
    observer.hooks.beforeEnqueue = async (check) => {
      if (selected) return;

      selected = check;
      entered.release();
      await reached(release.promise, "negative ownership watcher admitted");
    };
    f.cleanup.push(release.release);
    const attempt = await f.source.openRouteAttempt(routeAuthorization(route), undefined, undefined, true);
    await reached(entered.promise, "real watcher before ownership negative");
    const lockPath = path.join(f.sourceHome, "sync/mutation.lock");
    let evidence: Buffer | undefined;
    if (state === "revoked") await f.source.revokeRoute(route.id, route.revision);
    else if (state === "paused") await f.source.setRetryPaused(true);
    else {
      evidence = Buffer.from(state === "unknown" ? "" : "untrusted owner bytes");
      await writeFile(lockPath, evidence, { mode: state === "unsafe" ? 0o644 : 0o600 });
      await assert.rejects(locks.acquireSyncOwnership(lockPath, Date.now() + 60), /unknown or live owners/);
    }

    if (state === "paused") {
      const aborted = latch();
      attempt.signal.addEventListener("abort", aborted.release, { once: true });
      release.release();
      await reached(aborted.promise, "real watcher observes persistent pause");
    }

    const closing = attempt.close();
    release.release();
    await closing;
    assert.ok(selected);
    assert.equal(selected.acquired, state === "paused");
    assert.equal(attempt.signal.aborted, state === "revoked" || state === "paused", "private close alone does not invent a public abort");
    if (evidence) {
      assert.deepEqual(await readFile(lockPath), evidence);
      assert.equal((await lstat(lockPath)).mode & 0o777, state === "unsafe" ? 0o644 : 0o600);
    }
  });
}

test("draining registry entries retain cancellation listeners and cannot erase a newer attempt", { timeout: 10_000 }, async (t) => {
  const f = await lifetimeFixture(t);
  const route = (await f.connect()).outbound;
  const observer = observeWatchers(t, f);
  const entered = latch();
  const release = latch();
  const parent = new AbortController();
  let selected: WatcherCheck | undefined;
  observer.hooks.beforeEnqueue = async (check) => {
    if (selected) return;

    selected = check;
    entered.release();
    await reached(release.promise, "retained registry producer released");
  };
  f.cleanup.push(release.release);
  const old = await f.source.openRouteAttempt(routeAuthorization(route), parent.signal);
  await reached(entered.promise, "old attempt's actual watcher entered");
  const closing = old.close();
  parent.abort(new Error("parent cancelled while join retained listener"));
  assert.equal(old.signal.aborted, true);
  await assert.rejects(f.source.quiesceRoute(route.id, Date.now() + 40), /quiescence deadline/, "the draining old entry is still visible");
  const fresh = await f.source.openRouteAttempt(routeAuthorization(route));
  let notifications = 0;
  fresh.signal.addEventListener("abort", () => { notifications += 1; });
  await assert.rejects(f.source.quiesceRoute(route.id, Date.now() + 40), /quiescence deadline/);
  assert.equal(notifications, 1);
  release.release();
  await closing;
  await assert.rejects(f.source.quiesceRoute(route.id, Date.now() + 40), /quiescence deadline/, "the newer live entry survived the old unregister");
  assert.equal(notifications, 1, "an already-aborted controller emits no second notification");
  await fresh.close();
  await f.source.quiesceRoute(route.id, Date.now() + 600);
});
