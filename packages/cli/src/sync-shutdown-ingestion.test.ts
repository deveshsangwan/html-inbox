import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import platformTest, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedSyncStore } from "./sync-store";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { reconcileSyncRoutes } from "./sync-reconciliation";
import { acquireSyncOwnership, readSyncOwnership } from "./sync-files";
import { canonicalKey, parseAuthorization, parseObject } from "./sync-model";
import { workerPaths, readWorkerRecordOffline } from "./sync-worker-records";
import { availablePort } from "./test-fixtures";
import { errorCauses, shutdownFixture } from "./sync-shutdown-fixtures";
import { waitUntil } from "./sync-worker-fault-fixtures";
import { startProtocolFaultChild } from "./sync-protocol-fault-child";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const originalBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>admitted mutation π</body></html>\r\n");
const input = { originalBytes, title: "Admitted mutation", type: "report", sourceFileName: "synthetic.html" };

for (const operation of ["terminal", "body", "history", "activation"] as const) {
  for (const timeout of [false, true]) {
    test(`real HTTPS ${operation} ${timeout ? "times out with retained authority" : "settles before successful worker close"}`, { timeout: 10_000 }, async (t) => {
      const f = await shutdownFixture(t);
      const tls = await createSyncHttpsCredentials(t);
      const remote = new ManagedSyncStore(path.join(f.root, "remote"));
      await remote.enroll();
      const localLedger = await f.store.snapshot();
      const remoteLedger = await remote.snapshot();
      const isPull = operation === "activation";
      const source = isPull ? f.store : remote;
      const receiver = isPull ? remote : f.store;
      const sourceId = isPull ? localLedger.inboxId : remoteLedger.inboxId;
      const receiverId = isPull ? remoteLedger.inboxId : localLedger.inboxId;
      const sourceLedger = isPull ? localLedger : remoteLedger;
      const port = await availablePort();
      const url = `https://127.0.0.1:${port}`;
      f.ports.push(url);
      const token = Buffer.alloc(48, 73).toString("base64url");
      const tokenFile = path.join(f.root, "token");
      await writeFile(tokenFile, token, { mode: 0o600 });
      const ca = await readFile(tls.caPath);
      const route = { id: randomUUID(), revision: 1, direction: "outbound", peerId: receiverId,
        peerUrl: isPull ? "https://127.0.0.1:1" : url, sourceInboxId: sourceId, destinationInboxId: receiverId,
        localInboxName: "fixture", readerAudience: "synthetic", allowedOrigins: sourceLedger.originKeys,
        credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null };
      await source.configureRoute(route);
      await receiver.configureRoute({ ...route, direction: "inbound", peerId: sourceId, peerUrl: isPull ? url : "https://127.0.0.1:1" });
      const defaults = defaultRuntimeConfig();
      const requestMs = timeout ? 400 : 2000;
      await f.store.configureRuntime({ ...defaults, listener: { host: "127.0.0.1", port, tlsRef: "server" },
        timings: { ...defaults.timings, requestMs }, credentials: { token: tokenFile }, trust: { ca: tls.caPath },
        tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } });
      let notifications = 0;
      const worker = await f.worker({ temporary: true, onFatalStop: () => { notifications += 1; } });
      const paths = workerPaths(f.home);
      const ownershipHandles = f.handles.filter((file) => {
        const name = f.handlePaths.get(file);
        return file.fd !== -1 && name !== undefined && (name === paths.directory || path.dirname(name) === paths.directory);
      });
      assert.equal(ownershipHandles.length, 2, "capture the actual retained lifetime file and directory handles");
      let sourceRunner: Awaited<ReturnType<typeof startProtocolFaultChild>> | undefined;
      if (operation === "body" && !timeout) {
        const context: Pick<TestContext, "after" | "diagnostic"> = { after(close) {
          if (close) {
            f.cleanup.push(async () => {
              await close(t, () => {});
              await remote.recover();
            });
          }
        }, diagnostic(message) { t.diagnostic(message); } };
        sourceRunner = await startProtocolFaultChild(context, { mode: "runner", home: remoteLedger.ownerAnchor.home,
          peerId: sourceId, token, caPath: tls.caPath });
      }

      async function run() {
        if (!sourceRunner) {
          return reconcileSyncRoutes({ store: isPull ? receiver : source, peerId: isPull ? receiverId : sourceId,
            credentials: () => ({ token, ca }), routeIds: [route.id], requestMs: 3000, deadlineMs: 5000 });
        }

        const reply = await sourceRunner.command({ type: "run", routeIds: [route.id], requestMs: 3000, deadlineMs: 5000 });
        assert.equal(reply.error, undefined);
        const result = parseObject(reply.result, "source reconciliation");
        assert.ok(Array.isArray(result.routes));
        return { ...result, routes: result.routes.map((value) => parseObject(value, "source route result")) };
      }

      const id = "admitted-mutation";
      await source.publish(input, id);
      if (operation === "terminal") {
        assert.equal((await run()).routes[0].status, "confirmed");
        assert.deepEqual((await receiver.getDocument((await receiver.listDocuments())[0].id))?.originalBytes, originalBytes);
        await source.deleteDocument(id);
      }

      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      let mutationFinished = false;
      async function hold() { hits += 1; await gate; }
      if (operation === "terminal") {
        const apply = ManagedSyncStore.prototype.apply;
        t.mock.method(ManagedSyncStore.prototype, "apply", async function (this: ManagedSyncStore, ...args: Parameters<typeof apply>) {
          await hold();
          try { return await apply.apply(this, args); } finally { mutationFinished = true; }
        });
      } else if (operation === "body") {
        const applyStream = ManagedSyncStore.prototype.applyStream;
        t.mock.method(ManagedSyncStore.prototype, "applyStream", async function (this: ManagedSyncStore, auth: unknown, state: unknown, chunks: AsyncIterable<Uint8Array>) {
          async function* heldChunks() {
            for await (const chunk of chunks) yield chunk;
            // Hold after real network bytes are consumed, before real staging
            // verification/finalization. Socket destruction cannot undo those bytes.
            await hold();
          }

          try { return await applyStream.call(this, auth, state, heldChunks()); } finally { mutationFinished = true; }
        });
      } else if (operation === "history") {
        const complete = ManagedSyncStore.prototype.completeInventory;
        t.mock.method(ManagedSyncStore.prototype, "completeInventory", async function (this: ManagedSyncStore, ...args: Parameters<typeof complete>) {
          await hold();
          try { return await complete.apply(this, args); } finally { mutationFinished = true; }
        });
      } else {
        const activate = ManagedSyncStore.prototype.activateOutbound;
        t.mock.method(ManagedSyncStore.prototype, "activateOutbound", async function (this: ManagedSyncStore, ...args: Parameters<typeof activate>) {
          await hold();
          try { return await activate.apply(this, args); } finally { mutationFinished = true; }
        });
      }

      const running = run();
      void running.catch(() => {});
      let passObservation: { state: "pending" | "fulfilled" | "rejected";
        routes?: { status: string | null; lastError: string | null; historyReady: boolean | null }[];
        counters?: Record<string, number>; errorName?: string | null; errorCode?: string | null } = { state: "pending" };
      const boundedCode = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value) ? value : null;
      void running.then((result) => {
        passObservation = { state: "fulfilled" };
        try {
          passObservation.routes = result.routes.slice(0, 1).map((value) => ({ status: boundedCode(value.status),
            lastError: boundedCode(value.lastError), historyReady: typeof value.historyReady === "boolean" ? value.historyReady : null }));
          const counters = "counters" in result ? result.counters : undefined;
          if (counters && typeof counters === "object") {
            passObservation.counters = {};
            for (const name of ["requests", "requestBytes", "responseBytes"]) {
              const value: unknown = Reflect.get(counters, name);
              if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) passObservation.counters[name] = value;
            }
          }
        } catch {
          // Observing a result must not reject or alter the original pass.
        }
      }, (error: unknown) => {
        passObservation = { state: "rejected" };
        try {
          if (error instanceof Error) passObservation.errorName = boundedCode(error.name);
          if (error && typeof error === "object" && "code" in error) passObservation.errorCode = boundedCode(error.code);
        } catch {
          // Error metadata is optional; the original rejection remains intact.
        }
      });
      f.cleanup.push(async () => {
        release();
        if (!sourceRunner) {
          await running.catch(() => {});
          return;
        }

        const results = await Promise.allSettled([running, worker.close()]);
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "Source command or admitted receiver cleanup failed");
      });
      const observationStarted = performance.now();
      let reads = 0;
      let lastValue: number | null = null;
      let lastReadElapsedMs = 0;
      const observeAdmission = () => t.diagnostic(`admission observation ${JSON.stringify({ operation, timeout, reads, lastValue,
        lastReadElapsedMs, elapsedMs: performance.now() - observationStarted, pass: passObservation })}`);
      try {
        await waitUntil("real admitted mutation seam", async () => {
          const value = hits;
          reads += 1;
          lastValue = value;
          lastReadElapsedMs = performance.now() - observationStarted;
          return value;
        }, (value) => value === 1, 4000);
      } catch (error) {
        try { observeAdmission(); } finally { throw error; }
      }
      assert.equal(hits, 1);
      const ownerBytes = await readFile(paths.lifetime);
      const before = await f.store.snapshot();
      let settled = false;
      const closing = worker.close();
      void closing.then(() => { settled = true; }, () => { settled = true; });
      assert.equal(worker.close(), closing);
      if (timeout) {
        const started = Date.now();
        await assert.rejects(closing, (error: unknown) => errorCauses(error).some((cause) => cause instanceof Error && /did not drain/.test(cause.message)));
        assert.ok(Date.now() - started < requestMs + 1000, "shutdown remains bounded by requestMs");
        assert.equal(notifications, 1);
        assert.equal(mutationFinished, false);
        assert.deepEqual(await readFile(paths.lifetime), ownerBytes);
        assert.equal((await readSyncOwnership(paths.lifetime))?.token, worker.record.processId);
        assert.ok(await readWorkerRecordOffline(f.home));
        await assert.rejects(acquireSyncOwnership(paths.lifetime, Date.now() + 100), /deadline/);
        for (const file of ownershipHandles) await assert.rejects(file.stat(), { code: "EBADF" });
      } else {
        await delay(40);
        assert.equal(settled, false, "closing sockets is not settlement of the admitted mutation");
        assert.equal(mutationFinished, false);
        assert.deepEqual(await readFile(paths.lifetime), ownerBytes);
        assert.ok(await readWorkerRecordOffline(f.home));
      }

      release();
      await running;
      await waitUntil("actual admitted mutation completion", async () => mutationFinished, Boolean);
      if (!timeout) {
        await closing;
        assert.equal(notifications, 0);
        assert.equal(await readWorkerRecordOffline(f.home), null);
        await assert.rejects(readFile(paths.lifetime), { code: "ENOENT" });
      }

      const after = await f.store.snapshot();
      assert.ok(after.generation > before.generation, "the held real store mutation completed");
      if (operation === "terminal") {
        assert.equal(after.records[canonicalKey(sourceId, id)].state, "deleted");
        assert.ok(Object.values(after.receipts).some((receipt) => receipt.disposition === "deleted"));
      } else if (operation === "body") {
        const record = after.records[canonicalKey(sourceId, id)];
        assert.ok(record);
        assert.deepEqual((await f.store.getDocument(record.localId))?.originalBytes, originalBytes);
        assert.ok(Object.values(after.receipts).some((receipt) => receipt.disposition === "committed"));
        assert.equal(Object.values(after.records).filter((entry) => entry.originInboxId === sourceId && entry.originDocumentId === id).length, 1);
      } else if (operation === "history") {
        assert.equal(Object.keys(after.historyCheckpoints).length, 1);
      } else {
        assert.equal(after.routes[route.id].state, "active");
        assert.deepEqual((await f.store.getDocument(id))?.originalBytes, originalBytes);
      }

      await delay(30);
      assert.equal((await f.store.snapshot()).generation, after.generation, "successful quiescence permits no later admitted store mutation");
      await waitUntil("completed route inspections dispose their handles", async () => f.handles.filter((file) => file.fd !== -1).length, (count) => count === 0, 1000);
      await f.assertHandlesClosed();
      observeAdmission();
      t.diagnostic(`one real ${operation} hold; ${timeout ? "failed close retained authority" : "successful close waited for settlement"}; exact listeners rebound during teardown`);
    });
  }
}

for (const fault of ["none", "read", "handler-cleanup"] as const) {
  test(`closed body response detaches its real late pin with ${fault}`, { timeout: 10_000 }, async (t) => {
    const f = await shutdownFixture(t);
    const tls = await createSyncHttpsCredentials(t);
    const receiver = new ManagedSyncStore(path.join(f.root, "receiver"));
    await receiver.enroll();
    const a = await f.store.snapshot();
    const b = await receiver.snapshot();
    const port = await availablePort();
    const url = `https://127.0.0.1:${port}`;
    f.ports.push(url);
    const token = Buffer.alloc(48, 37).toString("base64url");
    const tokenFile = path.join(f.root, "token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const ca = await readFile(tls.caPath);
    const route = await f.store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId,
      peerUrl: "https://127.0.0.1:1", sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, allowedOrigins: a.originKeys,
      localInboxName: "fixture", readerAudience: "synthetic", credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null });
    await receiver.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: url });
    await f.store.configureRuntime({ ...defaultRuntimeConfig(), listener: { host: "127.0.0.1", port, tlsRef: "server" },
      credentials: { token: tokenFile }, trust: { ca: tls.caPath }, tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } });
    let notified = 0;
    const worker = await f.worker({ temporary: true, onFatalStop: () => { notified += 1; } });
    await f.store.publish(input, "late-pin");
    const record = (await f.store.snapshot()).records[canonicalKey(a.inboxId, "late-pin")];
    assert.ok(record.bodyFile);
    const bodyPath = path.join(f.home, "sync", "bodies", record.bodyFile);
    const open = fs.open;
    const readError = Object.assign(new Error("synthetic detached body read EIO"), { code: "EIO" });
    let reads = 0;
    const bodyHandles: Awaited<ReturnType<typeof fs.open>>[] = [];
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === bodyPath) {
        bodyHandles.push(file);
        if (fault === "read") t.mock.method(file, "read", async () => { reads += 1; throw readError; });
      }

      return file;
    });
    const pin = ManagedSyncStore.prototype.pinOutgoing;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hits = 0;
    let cleanupFaults = 0;
    const cleanupError = new Error("synthetic admitted handler cleanup failure");
    if (fault === "handler-cleanup") {
      const attempt = ManagedSyncStore.prototype.openRouteAttempt;
      t.mock.method(ManagedSyncStore.prototype, "openRouteAttempt", async function (this: ManagedSyncStore, ...args: Parameters<typeof attempt>) {
        const opened = await attempt.apply(this, args);
        const isLocal = parseAuthorization(args[0]).peerId === b.inboxId;
        return { ...opened, async close() {
          await opened.close();
          if (isLocal && hits === 1 && cleanupFaults === 0) {
            cleanupFaults += 1;
            throw cleanupError;
          }
        } };
      });
    }

    let pinned: ReturnType<typeof pin> | undefined;
    t.mock.method(ManagedSyncStore.prototype, "pinOutgoing", function (this: ManagedSyncStore, ...args: Parameters<typeof pin>) {
      hits += 1;
      pinned = gate.then(() => pin.apply(this, args));
      return pinned;
    });
    const running = reconcileSyncRoutes({ store: receiver, peerId: b.inboxId, credentials: () => ({ token, ca }), routeIds: [route.id], requestMs: 3000, deadlineMs: 5000 });
    void running.catch(() => {});
    f.cleanup.push(async () => { release(); await running.catch(() => {}); await pinned?.catch(() => {}); });
    await waitUntil("actual GET body pin held", async () => hits, (value) => value === 1);
    if (fault === "handler-cleanup") await assert.rejects(worker.close(), (error: unknown) => errorCauses(error).includes(cleanupError));
    else await worker.close();
    assert.equal(bodyHandles.length, 0, "close does not wait for or begin the detached pin");
    assert.equal(notified, fault === "handler-cleanup" ? 1 : 0);
    const atClose = worker.status().ingestion;
    assert.ok("counters" in atClose);
    const responseBytes = atClose.counters.responseBytes;
    assert.equal(atClose.counters.activeRequests, 0);
    if (fault === "handler-cleanup") {
      assert.equal(cleanupFaults, 1);
      assert.ok(await readWorkerRecordOffline(f.home));
      assert.equal((await readSyncOwnership(workerPaths(f.home).lifetime))?.token, worker.record.processId);
    } else assert.equal(await readWorkerRecordOffline(f.home), null);
    release();
    assert.ok(pinned);
    if (fault === "read") {
      await assert.rejects(pinned, (error: unknown) => errorCauses(error).includes(readError));
      assert.equal(reads, 1);
    } else {
      assert.deepEqual((await pinned)?.originalBytes, originalBytes);
    }

    await running;
    assert.equal(bodyHandles.length, 1);
    await assert.rejects(bodyHandles[0].stat(), { code: "EBADF" });
    const after = worker.status().ingestion;
    assert.ok("counters" in after);
    assert.equal(after.counters.responseBytes, responseBytes, "late success or read failure cannot send bytes");
    assert.equal(Object.keys((await receiver.snapshot()).receipts).length, 0);
    assert.equal(notified, fault === "handler-cleanup" ? 1 : 0);
    await waitUntil("late pin and route inspection handles close", async () => f.handles.filter((file) => file.fd !== -1).length, (count) => count === 0, 1000);
    await f.assertHandlesClosed();
  });
}
