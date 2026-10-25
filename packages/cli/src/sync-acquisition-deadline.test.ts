import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import platformTest, { mock, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SyncClient } from "./sync-client";
import { classifySyncFailure, parseRemoteFailure } from "./sync-failure";
import { acquireSyncOwnership, processStart, readSyncOwnership, StoreLockQueueDeadlineError, withStoreLock } from "./sync-files";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import { canonicalKey } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { opaqueToken, parseIdentityResponse, SyncProtocolError, WIRE_LIMITS } from "./sync-wire";

// Managed storage requires POSIX directory durability; portable coverage remains separate.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const bytes = Buffer.from("<!doctype html><html><body>queue deadline fixture</body></html>");

if (process.argv[2] === "--gate-b-acquisition-worker") {
  platformTest("queue worker child", { timeout: 35_000 }, (t) => runWorkerScenario(process.argv[3], t));
} else {
  registerAcquisitionTests();
}

function registerAcquisitionTests() {
  test("initial client queue expiry is retryable before credentials, requests or custody", { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "html-inbox-acquisition-deadline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, "source");
    const store = new ManagedSyncStore(home);
    await store.enroll();
    const identity = await store.snapshot();
    const route = await store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId: randomUUID(),
      peerUrl: "https://127.0.0.1:1", sourceInboxId: identity.inboxId, destinationInboxId: randomUUID(), localInboxName: "synthetic",
      readerAudience: "synthetic", allowedOrigins: identity.originKeys, credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null });
    await store.publish({ originalBytes: bytes, title: "Queue deadline", type: "report", sourceFileName: "fixture.html" }, "saved");
    const before = await store.snapshot();

    let credentialCalls = 0;
    const client = new SyncClient(store, identity.inboxId, () => {
      credentialCalls += 1;
      throw new Error("A failed initial admission must not resolve credentials");
    });
    const openAttempt = store.openRouteAttempt.bind(store);
    let holdHits = 0;
    let admissionFailure: unknown;
    let requestRemainingMs: number | undefined;
    t.mock.method(store, "openRouteAttempt", async (...args: Parameters<typeof store.openRouteAttempt>) => {
      let acquired = () => {};
      const ready = new Promise<void>((resolve) => { acquired = resolve; });
      const holder = withStoreLock(path.join(home, "sync"), 1000, async () => {
        holdHits += 1;
        acquired();
        await delay(140);
      });
      // Observe holder failure even if acquisition fails before the ready notification.
      await Promise.race([ready, holder]);

      try {
        return await openAttempt(...args);
      } catch (error) {
        admissionFailure = error;
        requestRemainingMs = args[2] === undefined ? undefined : args[2] - Date.now();
        throw error;
      } finally {
        await holder;
      }
    });

    const startedAt = Date.now();
    const deadlineAt = startedAt + 300;
    let requestFailure: unknown;
    try {
      await client.json(routeAuthorization(route), "identity", { nonce: opaqueToken() }, parseIdentityResponse, WIRE_LIMITS.identity,
        { requestMs: 100, deadlineAt });
    } catch (error) {
      requestFailure = error;
    }

    const remainingPassMs = deadlineAt - Date.now();
    t.diagnostic(JSON.stringify({ holdHits, requestRemainingMs, remainingPassMs, credentialCalls, requests: client.counters.requests,
      admissionError: admissionFailure instanceof Error ? admissionFailure.message : null, failure: classifySyncFailure(requestFailure) }));
    assert.equal(holdHits, 1);
    assert.ok(admissionFailure instanceof StoreLockQueueDeadlineError);
    assert.equal(admissionFailure.message, "Managed store lock deadline exceeded", "the real local queue timer must be the reached origin");
    assert.ok(remainingPassMs > 0, "whole-pass expiry cannot satisfy the local scheduling regression");
    assert.ok(Date.now() - startedAt < 1500);
    assert.equal(credentialCalls, 0);
    assert.equal(client.counters.requests, 0);
    assert.deepEqual(await store.snapshot(), before);
    assert.deepEqual((await store.getDocument("saved"))?.originalBytes, bytes);
    assert.equal(Object.keys(before.receipts).length, 0);
    assert.equal(Object.keys(before.historyCheckpoints).length, 0);
    assert.ok(Object.values(before.outbox).some((entry) => entry.routeId === route.id && entry.disposition !== "retired"));

    assert.ok(requestFailure instanceof SyncProtocolError, "a proven initial queue expiry must be a retryable local protocol outcome");
    assert.equal(requestFailure.status, 503);
    assert.equal(requestFailure.code, "local-acquisition-deadline");
    assert.equal(requestFailure.cause, admissionFailure);
    assert.deepEqual(classifySyncFailure(requestFailure), { kind: "retry", code: "local-acquisition-deadline" });
  });

  test("only a top-level initial queue marker is translated; causes, aggregates and remote claims remain blocked", async (t) => {
    const { store, route, identity } = await localRoute(t);
    const marker = new StoreLockQueueDeadlineError();
    const io = Object.assign(new Error("synthetic I/O failure"), { code: "EIO" });
    const aggregate = new AggregateError([marker, io], "operation and cleanup failed");
    const negatives = [new Error(marker.message), { name: "StoreLockQueueDeadlineError", message: marker.message },
      new Error("wrapped queue failure", { cause: marker }), aggregate, io,
      Object.assign(new Error("synthetic capacity failure"), { code: "ENOSPC" }),
      new SyncProtocolError(403, "unauthorized"), new SyncProtocolError(409, "peer-identity-conflict")];
    let credentialCalls = 0;
    const client = new SyncClient(store, identity.inboxId, () => { credentialCalls += 1; throw new Error("unexpected credentials"); });

    for (const failure of negatives) {
      const intercepted = t.mock.method(store, "openRouteAttempt", async () => { throw failure; });
      try {
        await assert.rejects(client.json(routeAuthorization(route), "identity", {}, parseIdentityResponse, WIRE_LIMITS.identity),
          (error: unknown) => error === failure);
        assert.equal(classifySyncFailure(failure).kind, "blocked");
      } finally {
        intercepted.mock.restore();
      }
    }

    assert.deepEqual(aggregate.errors, [marker, io]);
    assert.deepEqual(classifySyncFailure(marker), { kind: "blocked", code: "local-validation-or-storage-failed" });
    assert.throws(() => parseRemoteFailure({ error: "local-acquisition-deadline" }, 503));
    assert.equal(credentialCalls, 0);
    assert.equal(client.counters.requests, 0);

    const controller = new AbortController();
    const reason = new Error("explicit caller stop");
    controller.abort(reason);
    const intercepted = t.mock.method(store, "openRouteAttempt", async () => { throw marker; });
    await assert.rejects(client.json(routeAuthorization(route), "identity", {}, parseIdentityResponse, WIRE_LIMITS.identity,
      { signal: controller.signal }), (error: unknown) => error === reason);
    intercepted.mock.restore();
    t.mock.method(store, "openRouteAttempt", async () => { throw io; });
    await assert.rejects(client.json(routeAuthorization(route), "identity", {}, parseIdentityResponse, WIRE_LIMITS.identity,
      { signal: controller.signal }), (error: unknown) => error === io, "unrelated failures keep their identity even with an aborted caller");
  });

  test("an expired local queue callback never runs after its holder releases", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "html-inbox-queue-no-late-work-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let release = () => {};
    let acquired = () => {};
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withStoreLock(root, 1000, async () => { acquired(); await held; });
    let expiredCalls = 0;
    let successorCalls = 0;
    try {
      await Promise.race([ready, holder]);
      await assert.rejects(withStoreLock(root, 100, async () => { expiredCalls += 1; }), StoreLockQueueDeadlineError);
    } finally {
      release();
      await holder;
    }

    await withStoreLock(root, 1000, async () => { successorCalls += 1; });
    assert.equal(expiredCalls, 0);
    assert.equal(successorCalls, 1);
  });

  test("an explicit abort during real initial queue waiting preserves its reason with pass time remaining", async (t) => {
    const { home, store, route, identity } = await localRoute(t);
    const controller = new AbortController();
    const reason = new Error("caller cancelled during admission");
    const open = store.openRouteAttempt.bind(store);
    let holdHits = 0;
    let cause: unknown;
    t.mock.method(store, "openRouteAttempt", async (...args: Parameters<typeof open>) => {
      let acquired = () => {};
      const ready = new Promise<void>((resolve) => { acquired = resolve; });
      const holder = withStoreLock(path.join(home, "sync"), 1000, async () => { holdHits += 1; acquired(); await delay(140); });
      await Promise.race([ready, holder]);
      const abort = setTimeout(() => controller.abort(reason), 20);
      try {
        return await open(...args);
      } catch (error) {
        cause = error;
        throw error;
      } finally {
        clearTimeout(abort);
        await holder;
      }
    });
    const client = new SyncClient(store, identity.inboxId, () => { throw new Error("unexpected credentials"); });
    const deadlineAt = Date.now() + 300;
    await assert.rejects(client.json(routeAuthorization(route), "identity", {}, parseIdentityResponse, WIRE_LIMITS.identity,
      { signal: controller.signal, requestMs: 100, deadlineAt }), (error: unknown) => error === reason);
    assert.ok(cause instanceof StoreLockQueueDeadlineError);
    assert.equal(holdHits, 1);
    assert.ok(Date.now() < deadlineAt);
    assert.equal(client.counters.requests, 0);
  });

  test("a real filesystem ownership deadline remains raw and keeps the existing owner", async (t) => {
    const { home, store, route, identity } = await localRoute(t);
    const before = await store.snapshot();
    const lockPath = path.join(home, "sync", "mutation.lock");
    const holder = await acquireSyncOwnership(lockPath, Date.now() + 1000);
    const client = new SyncClient(store, identity.inboxId, () => { throw new Error("unexpected credentials"); });
    let admissionFailure: unknown;
    const open = store.openRouteAttempt.bind(store);
    t.mock.method(store, "openRouteAttempt", async (...args: Parameters<typeof open>) => {
      try { return await open(...args); } catch (error) { admissionFailure = error; throw error; }
    });
    try {
      await assert.rejects(client.json(routeAuthorization(route), "identity", {}, parseIdentityResponse, WIRE_LIMITS.identity,
        { requestMs: 100, deadlineAt: Date.now() + 300 }), (error: unknown) => {
          assert.equal(error, admissionFailure);
          assert.ok(error instanceof Error);
          assert.equal(error instanceof StoreLockQueueDeadlineError, false);
          assert.equal(error instanceof SyncProtocolError, false);
          assert.equal(classifySyncFailure(error).kind, "blocked");
          return true;
        });
      assert.deepEqual(await readSyncOwnership(lockPath), holder.owner);
      assert.equal(client.counters.requests, 0);
    } finally {
      await holder.release();
    }

    assert.deepEqual(await store.snapshot(), before);
  });

  test("owned worker persists queue backoff through restart, blocks at its limit, and retries into real idempotent custody", { timeout: 45_000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "html-inbox-queue-worker-"));
    const child = spawn(process.execPath, [__filename, "--gate-b-acquisition-worker", root], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root,
        XDG_DATA_HOME: root, ZDOTDIR: root, HTML_INBOX_HOME: root } });
    const start = child.pid ? await processStart(child.pid) : null;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 40_000);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timeout));
    t.diagnostic(output.trim());
    t.diagnostic(JSON.stringify({ childPid: child.pid, childStart: start, ...result, timedOut }));

    assert.equal(timedOut, false);
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, output);
    assert.equal(child.pid ? await processStart(child.pid) : null, null);
    const ports: unknown = JSON.parse(await readFile(path.join(root, "ports.json"), "utf8"));
    assert.ok(Array.isArray(ports));
    for (const url of ports) {
      assert.equal(typeof url, "string");
      await assertLoopbackClosed(url);
      t.diagnostic(`reaped child listener rebound: ${url}`);
    }

    await rm(root, { recursive: true, force: true });
  });
}

async function localRoute(t: Pick<TestContext, "after">) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-queue-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "source");
  const store = new ManagedSyncStore(home);
  await store.enroll();
  const identity = await store.snapshot();
  const route = await store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId: randomUUID(),
    peerUrl: "https://127.0.0.1:1", sourceInboxId: identity.inboxId, destinationInboxId: randomUUID(), localInboxName: "synthetic",
    readerAudience: "synthetic", allowedOrigins: identity.originKeys, credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null });
  return { home, store, identity, route };
}

async function runWorkerScenario(root: string, t: TestContext) {
  assert.ok(path.isAbsolute(root));
  const tls = await createSyncHttpsCredentials(t);
  const sourceHome = path.join(root, "source");
  const source = new ManagedSyncStore(sourceHome);
  const receiver = new ManagedSyncStore(path.join(root, "receiver"));
  await source.enroll();
  await receiver.enroll();
  const sourceIdentity = await source.snapshot();
  const receiverIdentity = await receiver.snapshot();
  const token = opaqueToken();
  const key = await readFile(tls.trusted.keyPath);
  const cert = await readFile(tls.trusted.certPath);
  const server = createSyncIngestionServer({ store: receiver, peerId: receiverIdentity.inboxId, key, cert,
    host: "127.0.0.1", port: 0, credentials: () => ({ token }) });
  const { url: address } = await server.start();
  const ports = [address];
  let worker: Awaited<ReturnType<typeof startOwnedSyncWorker>> | undefined;
  try {
    const route = await source.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId: receiverIdentity.inboxId,
      peerUrl: address, sourceInboxId: sourceIdentity.inboxId, destinationInboxId: receiverIdentity.inboxId, localInboxName: "synthetic",
      readerAudience: "synthetic", allowedOrigins: sourceIdentity.originKeys, credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null });
    await receiver.configureRoute({ ...route, direction: "inbound", peerId: sourceIdentity.inboxId, peerUrl: "https://127.0.0.1:1" });
    await source.publish({ originalBytes: bytes, title: "Queue custody", type: "report", sourceFileName: "fixture.html" }, "saved");
    const authorization = routeAuthorization(route);
    const before = await source.snapshot();
    const ca = await readFile(tls.caPath);

    let laterHits = 0;
    const communicate = source.startCommunication.bind(source);
    const later = mock.method(source, "startCommunication", async (...args: Parameters<typeof communicate>) => {
      laterHits += 1;
      if (laterHits !== 2) return communicate(...args);

      return holdQueue(sourceHome, 140, () => communicate(...args));
    });
    const client = new SyncClient(source, sourceIdentity.inboxId, () => { throw new Error("later queue expiry resolved credentials"); });
    try {
      await assert.rejects(client.json(authorization, "identity", {}, parseIdentityResponse, WIRE_LIMITS.identity,
        { requestMs: 100, deadlineAt: Date.now() + 300 }), (error: unknown) => {
          assert.ok(error instanceof StoreLockQueueDeadlineError);
          assert.equal(classifySyncFailure(error).kind, "blocked");
          return true;
        });
    } finally {
      later.mock.restore();
    }
    assert.equal(laterHits, 2);
    assert.equal(client.counters.requests, 0);
    assert.deepEqual(await source.snapshot(), before);
    console.log(JSON.stringify({ laterCommunicationQueueHits: 1, requests: client.counters.requests, classification: "blocked" }));

    const open = source.openRouteAttempt.bind(source);
    let passHoldHits = 0;
    let passAdmissions = 0;
    const passExpiry = mock.method(source, "openRouteAttempt", async (...args: Parameters<typeof open>) => {
      passAdmissions += 1;
      if (passAdmissions !== 2) return open(...args);

      passHoldHits += 1;
      return holdQueue(sourceHome, 340, () => open(...args));
    });
    try {
      const result = await reconcileSyncRoutes({ store: source, peerId: sourceIdentity.inboxId, routeIds: [route.id],
        credentials: () => ({ token, ca }), requestMs: 100, deadlineMs: 300 });
      assert.equal(result.routes[0]?.status, "aborted");
      assert.equal(result.counters.requests, 0);
      assert.equal(passHoldHits, 1);
      assert.deepEqual(await source.snapshot(), before);
      console.log(JSON.stringify({ wholePassQueueHits: passHoldHits, result }));
    } finally {
      passExpiry.mock.restore();
    }

    const tokenPath = path.join(root, "token");
    await writeFile(tokenPath, token, { mode: 0o600 });
    // Allow release and final selection after queue expiry; the separate whole-pass negative keeps its 300 ms bound.
    const queuePassMs = 1000;
    const config = defaultRuntimeConfig();
    config.credentials = { token: tokenPath };
    config.trust = { ca: tls.caPath };
    config.timings.requestMs = 100;
    config.timings.passMs = queuePassMs;
    await source.configureRuntime(config);
    await source.setWorkerEnabled(true);

    const realNow = Date.now;
    let offset = 0;
    mock.method(Date, "now", () => realNow() + offset);
    let queueHits = 0;
    let admissions = 0;
    type TicketObservation = {
      startedAt: number;
      recentAdmissions: { ordinal: number; elapsedMs: number; requestMarginMs: number | null; queueSelected: boolean; parentAborted: boolean }[];
    };
    let ticketObservation: TicketObservation | undefined;
    const originalOpen = ManagedSyncStore.prototype.openRouteAttempt;
    const queueFault = mock.method(ManagedSyncStore.prototype, "openRouteAttempt", async function (this: ManagedSyncStore,
      ...args: Parameters<typeof originalOpen>) {
      if (this === receiver) return originalOpen.call(this, ...args);

      admissions += 1;
      if (ticketObservation) {
        if (ticketObservation.recentAdmissions.length === 4) ticketObservation.recentAdmissions.shift();
        ticketObservation.recentAdmissions.push({ ordinal: admissions, elapsedMs: performance.now() - ticketObservation.startedAt,
          requestMarginMs: args[2] === undefined ? null : args[2] - Date.now(), queueSelected: admissions % 2 === 0,
          parentAborted: args[1]?.aborted ?? false });
      }

      if (admissions % 2 !== 0) return originalOpen.call(this, ...args);

      queueHits += 1;
      return holdQueue(sourceHome, 140, () => originalOpen.call(this, ...args));
    });

    async function startWorker() {
      const started = await startOwnedSyncWorker(sourceHome, { temporary: true });
      ports.push(started.record.controlOrigin);
      return started;
    }

    async function runTicket(current: Awaited<ReturnType<typeof startOwnedSyncWorker>>, requestMs = 100, passMs = queuePassMs) {
      const ticketId = randomUUID();
      const observation: TicketObservation = { startedAt: performance.now(), recentAdmissions: [] };
      const idleOffsetAtEntryMs = offset;
      const admissionsAtEntry = admissions;
      const queueHitsAtEntry = queueHits;
      const submittedDeadlineAt = Date.now() + passMs;
      ticketObservation = observation;
      current.requestRun({ ticketId, routeIds: [route.id], requestMs, deadlineAt: submittedDeadlineAt });
      const deadline = realNow() + 10_000;
      let polls = 0;

      while (realNow() < deadline) {
        polls += 1;
        const ticket = current.status().tickets.find((entry) => entry.ticketId === ticketId);
        if (ticket?.state === "complete") {
          const elapsedMs = performance.now() - observation.startedAt;
          const remainingPassMs = submittedDeadlineAt - Date.now();
          ticketObservation = undefined;
          t.diagnostic(`queue ticket completion ${JSON.stringify({ submittedDeadlineAt, elapsedMs, remainingPassMs,
            idleOffsetAtEntryMs, idleOffsetAtExitMs: offset, polls, admissionsAtEntry, admissionsAtExit: admissions,
            queueHitsAtEntry, queueHitsAtExit: queueHits, recentAdmissions: observation.recentAdmissions,
            ticketError: ticket.error?.slice(0, 64) ?? null, routeCount: ticket.routes.length,
            routes: ticket.routes.slice(0, 1).map((entry) => ({ status: entry.status, lastError: entry.lastError?.slice(0, 64) ?? null })) })}`);

          assert.equal(ticket.error, null);
          return ticket;
        }

        await delay(5);
      }

      ticketObservation = undefined;
      throw new Error("owned worker ticket did not complete within test bound");
    }

    worker = await startWorker();
    const first = await runTicket(worker);
    // Pending requires time through final result selection; observation does not make the real deadlines deterministic.
    assert.equal(first.routes[0]?.status, "pending");
    assert.equal(first.routes[0]?.lastError, "local-acquisition-deadline");
    const firstRetry = (await source.snapshot()).routeRetries[route.id];
    assert.equal(firstRetry.attempts, 1);
    assert.equal(firstRetry.blocked, false);
    assert.ok(firstRetry.nextAttemptAt > Date.now());
    worker.requestWake();
    await runTicket(worker);
    assert.equal(queueHits, 1);
    assert.deepEqual((await new ManagedSyncStore(sourceHome).snapshot()).routeRetries[route.id], firstRetry);
    const previousOwner = worker.record.processId;
    await worker.close();
    worker = await startWorker();
    assert.notEqual(worker.record.processId, previousOwner);
    assert.ok(Date.now() < firstRetry.nextAttemptAt, "native restart must finish within existing backoff to prove suppression");
    worker.requestWake();
    await runTicket(worker);
    assert.equal(queueHits, 1);
    assert.deepEqual((await source.snapshot()).routeRetries[route.id], firstRetry);
    console.log(JSON.stringify({ realWakeAndRestartSuppressed: true, queueHits, firstRetry, remainingBackoffMs: firstRetry.nextAttemptAt - Date.now() }));

    // Only idle scheduling time moves. Each queue attempt retains its real request and pass deadlines.
    for (let attempts = 2; attempts <= 20; attempts += 1) {
      const previous = (await source.snapshot()).routeRetries[route.id];
      offset += Math.max(0, previous.nextAttemptAt - Date.now() + 1);
      const ticket = await runTicket(worker);
      assert.equal(ticket.routes[0]?.status, "pending");
      assert.equal(ticket.routes[0]?.lastError, "local-acquisition-deadline");
      const ledger = await source.snapshot();
      const retry = ledger.routeRetries[route.id];
      assert.equal(retry.attempts, attempts);
      assert.equal(retry.blocked, attempts === 20);
      assert.equal(queueHits, attempts);
      assert.equal(Object.keys(ledger.receipts).length, 0);
      assert.deepEqual(ledger.outbox, before.outbox, "reconnecting history must not become an eligible live-item retry");
      console.log(JSON.stringify({ queueHits, virtualIdleOffsetMs: offset, retry }));
    }

    const exhausted = (await source.snapshot()).routeRetries[route.id];
    worker.requestWake();
    await runTicket(worker);
    await worker.close();
    worker = await startWorker();
    worker.requestWake();
    await runTicket(worker);
    assert.equal(queueHits, 20);
    assert.deepEqual((await source.snapshot()).routeRetries[route.id], exhausted);
    queueFault.mock.restore();
    await source.retry(authorization);
    const reset = await source.snapshot();
    assert.equal(reset.routeRetries[route.id], undefined);
    assert.equal(reset.routes[route.id].lastError, null);
    assert.deepEqual((await source.getDocument("saved"))?.originalBytes, bytes);
    await worker.close();
    worker = undefined;

    // Custody uses the ordinary positive-control budget after the scheduling limit is proven.
    config.timings = defaultRuntimeConfig().timings;
    await source.configureRuntime(config);
    worker = await startWorker();
    const delivered = await runTicket(worker, 5000, 30_000);
    assert.equal(delivered.routes[0]?.lastError, null);
    assert.equal(delivered.routes[0]?.status, "confirmed");
    assert.equal(delivered.routes[0]?.transferred, 1);
    assert.equal((await source.deliveryStatus(route.id, sourceIdentity.inboxId, "saved")).isCommitted, true);
    const saved = await source.snapshot();
    const received = await receiver.snapshot();
    const canonical = canonicalKey(sourceIdentity.inboxId, "saved");
    assert.ok(received.records[canonical]);
    assert.deepEqual((await receiver.getDocument(received.records[canonical].localId))?.originalBytes, bytes);
    assert.equal(Object.keys(received.receipts).length, 1);
    assert.equal(Object.keys(saved.receipts).length, 1);
    assert.ok(Object.values(saved.outbox).every((entry) => entry.disposition === "confirmed"));
    assert.equal(saved.routeRetries[route.id].attempts, 0);
    const repeated = await runTicket(worker, 5000, 30_000);
    assert.equal(repeated.routes[0]?.lastError, null);
    assert.equal(repeated.routes[0]?.status, "confirmed");
    assert.equal(repeated.routes[0]?.transferred, 0);
    assert.equal(Object.keys((await receiver.snapshot()).records).length, 1);
    assert.deepEqual((await receiver.snapshot()).receipts, received.receipts);
    assert.deepEqual((await source.snapshot()).receipts, saved.receipts);
    console.log(JSON.stringify({ zeroHoldHttps: true, delivered: delivered.routes, repeated: repeated.routes, sourceReceiptCount: 1,
      receiverReceiptCount: 1, queueHits, limitBlocked: exhausted.blocked, explicitReset: true }));
  } finally {
    await worker?.close();
    await server.close();
    mock.restoreAll();
    await writeFile(path.join(root, "ports.json"), JSON.stringify(ports));
  }
}

async function holdQueue<T>(home: string, milliseconds: number, operation: () => Promise<T>): Promise<T> {
  let acquired = () => {};
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withStoreLock(path.join(home, "sync"), 1000, async () => { acquired(); await delay(milliseconds); });
  await Promise.race([ready, holder]);
  try {
    return await operation();
  } finally {
    await holder;
  }
}
