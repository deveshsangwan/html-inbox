import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { readFile, readdir, writeFile } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { createSyncIngestionServer } from "./sync-http-server";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { acquireSyncOwnership, readSyncOwnership } from "./sync-files";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { canonicalKey, parseArray, parseInteger, parseObject, parseString, type RouteAuthorization } from "./sync-model";
import { errorCauses, shutdownFixture } from "./sync-shutdown-fixtures";
import { createWorkerFixture, createOwnedPullPair, parsePublication, assertReceiverCommitted, waitUntil, syntheticBytes, type WorkerFixture, type FixtureInbox } from "./sync-worker-fault-fixtures";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { startOwnedSyncWorker } from "./sync-worker";
import { contactWorker, parseWorkerControlStatus } from "./sync-worker-client";
import { isRouteDue } from "./sync-ledger-policy";
import { SyncClient, type SyncRequestOptions } from "./sync-client";
import { availablePort } from "./test-fixtures";
import { readViewerRecord } from "./viewer-records";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

for (const boundary of ["viewer", "status"] as const) {
  for (const signal of [false, true]) {
    test(`actual confirmed CLI ${boundary} finalization ${signal ? "SIGINT cancels its result" : "remains confirmed without signal"}`, { timeout: 20_000 }, async (t) => {
      const f = await createOwnedPullPair(t);
      await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
      await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
      const args = await f.publicationArgs(f.source, ["--wait-ms", "5000", "--json"]);
      const cli = f.launch([boundary, signal ? "signal" : "continue", ...args], { entry: path.join(__dirname, "sync-finalization-child.js"), timeoutMs: 8000 });
      const marker = path.join(f.root, "finalization-marker.json");
      const release = path.join(f.root, "finalization-release");
      const observation = await waitUntil("one confirmed finalization hold", async () => {
        try { return parseObject(JSON.parse(await readFile(marker, "utf8")), "finalization marker"); } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      }, (value) => value !== null, 5000);
      assert.ok(observation);
      assert.equal(observation.boundary, boundary);
      const held = parseObject(observation.stats, "held counters");
      assert.equal(held.holds, 1);
      assert.equal(held.confirmations, 1);
      if (signal) assert.equal(cli.child.kill("SIGINT"), true);
      await writeFile(release, "continue", { mode: 0o600 });

      const completed = await cli.completion;
      await f.rememberViewer(f.source);
      assert.equal(completed.signal, null);
      const publication = parsePublication(JSON.parse(completed.stdout));
      const custody = await assertReceiverCommitted(f.destination, f.sourceId, publication.document.originDocumentId);
      assert.equal(custody.receipts.filter((receipt) => receipt.disposition === "committed").length, 1);
      assert.equal(Object.keys(custody.ledger.records).length, 1);
      const source = await f.source.store.snapshot();
      assert.deepEqual((await f.source.store.getDocument(publication.document.localId))?.originalBytes, syntheticBytes);
      assert.equal(source.records[canonicalKey(f.sourceId, publication.document.originDocumentId)].state, "live");
      assert.equal(source.worker.retryPaused, false);
      assert.equal(source.worker.enabled, true);
      assert.ok(Object.values(source.outbox).every((entry) => entry.disposition !== "retired" && entry.disposition !== "blocked"));
      const counters = parseObject(JSON.parse(await readFile(path.join(f.root, "finalization-complete.json"), "utf8")), "completed counters");
      assert.deepEqual(counters, { lookupFaults: 2, staleObservations: 1, confirmations: 1, redundantLookups: 0, holds: 1, signals: signal ? 1 : 0, finalStatus: 1 });
      assert.equal(completed.code, signal ? 130 : 0, completed.stderr);
      assert.equal(publication.delivery.cancelled, signal);
      assert.equal(publication.delivery.state, signal ? "pending" : "confirmed");
      assert.equal(publication.delivery.retriesEnabled, true);
      if (signal) {
        assert.equal(publication.delivery.receipt, null);
        assert.equal(publication.delivery.reason, "foreground-cancelled-durable-retries-retained");
      } else {
        assert.equal(publication.delivery.receipt?.fingerprint, publication.document.fingerprint);
      }
      await assertCancellation(f.root, signal ? 1 : 0);
      t.diagnostic("one genuine confirmation, selected final await held once, exact custody retained; owned child/worker/viewer cleanup follows");
    });
  }
}

async function assertCancellation(root: string, expected: number, submitted = 1, failures = 0) {
  const evidence = parseObject(JSON.parse(await readFile(path.join(root, "finalization-cancellation.json"), "utf8")), "cancellation evidence");
  const tickets = parseArray(evidence.submitted, (value) => parseString(value), 1);
  const requests = parseArray(evidence.requests, (value) => parseObject(value, "cancel request"), 2);
  assert.equal(tickets.length, submitted);
  assert.equal(requests.length, expected);
  assert.equal(evidence.failures, failures);
  for (const request of requests) {
    const attempts = parseArray(JSON.parse(await readFile(path.join(root, "finalization-attempts.json"), "utf8")), (value) => parseString(value), 1);
    assert.equal(request.ticketId, tickets[0] ?? attempts[0], "cancel only this publication's own attempted ticket");
    const budget = parseInteger(request.budgetMs, 0, 150);
    assert.ok(budget <= 150);
  }
}

for (const action of ["signal", "signal-cancel-fails"] as const) {
  test(`early foreground cancellation is attempted once with ${action}`, { timeout: 20_000 }, async (t) => {
    const f = await createOwnedPullPair(t);
    await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
    await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
    const args = await f.publicationArgs(f.source, ["--wait-ms", "5000", "--json"]);
    const cli = f.launch(["early", action, ...args], { entry: path.join(__dirname, "sync-finalization-child.js"), timeoutMs: 8000 });
    await waitForFinalizationHold(f.root);
    assert.equal(cli.child.kill("SIGINT"), true);
    await writeFile(path.join(f.root, "finalization-release"), "continue", { mode: 0o600 });
    const completed = await cli.completion;
    await f.rememberViewer(f.source);
    assert.equal(completed.code, 130, completed.stderr);
    assert.equal(completed.signal, null);
    const publication = parsePublication(JSON.parse(completed.stdout));
    assert.equal(publication.delivery.cancelled, true);
    assert.equal(publication.delivery.receipt, null);
    await assertCancellation(f.root, 1, 1, action === "signal-cancel-fails" ? 1 : 0);
    const ledger = await f.source.store.snapshot();
    assert.equal(ledger.worker.enabled, true);
    assert.equal(ledger.worker.retryPaused, false);
    assert.deepEqual((await f.source.store.getDocument(publication.document.localId))?.originalBytes, syntheticBytes);
    assert.ok(Object.values(ledger.outbox).every((entry) => entry.disposition !== "retired"));
  });
}

for (const signal of [false, true]) {
  test(`publication without a submitted ticket ${signal ? "SIGINT" : "no signal"} never cancels background work`, { timeout: 20_000 }, async (t) => {
    const f = await createOwnedPullPair(t);
    await f.configure(f.source, { ...f.sourceConfig, intendedTarget: null });
    await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
    await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
    const args = await f.publicationArgs(f.source, ["--wait-ms", "5000", "--json"]);
    const cli = f.launch(["no-ticket", signal ? "signal" : "continue", ...args], { entry: path.join(__dirname, "sync-finalization-child.js"), timeoutMs: 8000 });
    await waitForFinalizationHold(f.root);
    if (signal) assert.equal(cli.child.kill("SIGINT"), true);
    await writeFile(path.join(f.root, "finalization-release"), "continue", { mode: 0o600 });
    const completed = await cli.completion;
    await f.rememberViewer(f.source);
    assert.equal(completed.code, signal ? 130 : 0, completed.stderr);
    assert.equal(completed.signal, null);
    const publication = parsePublication(JSON.parse(completed.stdout));
    assert.equal(publication.delivery.state, signal ? "pending" : "local-only");
    assert.equal(publication.delivery.cancelled, signal);
    await assertCancellation(f.root, 0, 0);
    const ledger = await f.source.store.snapshot();
    assert.equal(ledger.worker.enabled, true);
    assert.equal(ledger.worker.retryPaused, false);
    assert.ok(Object.values(ledger.outbox).every((entry) => entry.disposition !== "retired"));
  });
}

async function waitForFinalizationHold(root: string) {
  return waitUntil("actual finalization hold", async () => {
    try { return parseObject(JSON.parse(await readFile(path.join(root, "finalization-marker.json"), "utf8")), "finalization hold"); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }, (value) => value !== null, 5000);
}

async function prepareCompletionPublication(f: WorkerFixture, source: FixtureInbox, receiver: FixtureInbox,
  sourceWorker: Awaited<ReturnType<typeof startOwnedSyncWorker>>, destinationWorker: Awaited<ReturnType<typeof startOwnedSyncWorker>>,
  route: { id: string; revision: number }, receiverUrl: string) {
  await f.run(["viewer", "--inbox", source.name], 0);
  const viewer = await f.rememberViewer(source);
  assert.equal(viewer.state, "running");
  assert.equal(viewer.exposure, "loopback");

  const viewerRecord = await readViewerRecord(source.home, { readOnly: true });
  assert.ok(viewerRecord);
  assert.equal(viewer.pid, viewerRecord.pid);
  assert.equal(viewer.port, viewerRecord.config.port);
  assert.equal(viewerRecord.instanceId, sourceWorker.record.inboxId);

  const sourceStatus = parseWorkerControlStatus(await contactWorker(source.home, "status"));
  const destinationStatus = parseWorkerControlStatus(await contactWorker(receiver.home, "status"));
  for (const { status, record } of [
    { status: sourceStatus, record: sourceWorker.record },
    { status: destinationStatus, record: destinationWorker.record },
  ]) {
    assert.equal(status.processId, record.processId);
    assert.equal(status.inboxId, record.inboxId);
    assert.equal(status.storageIncarnation, record.storageIncarnation);
    assert.equal(status.pid, record.pid);
    assert.equal(status.configRevision, record.configRevision);
    assert.deepEqual(status.tickets, []);
  }

  assert.equal(sourceStatus.processState, "idle");
  assert.equal(destinationStatus.ingestion.state, "listening");
  assert.equal(destinationStatus.ingestion.url, receiverUrl);

  for (const inbox of [source, receiver]) {
    const ledger = await inbox.store.snapshot();
    assert.equal(ledger.worker.enabled, true);
    assert.equal(ledger.worker.retryPaused, false);

    const currentRoute = ledger.routes[route.id];
    assert.ok(currentRoute);
    assert.equal(currentRoute.id, route.id);
    assert.equal(currentRoute.revision, route.revision);
    assert.equal(currentRoute.direction, inbox === source ? "outbound" : "inbound");
    assert.equal(currentRoute.state, "reconnecting");

    assert.deepEqual(ledger.records, {});
    assert.deepEqual(ledger.receipts, {});
    assert.deepEqual(ledger.publicationIntents, {});
    assert.deepEqual(ledger.outbox, {});
    assert.deepEqual(ledger.historyCheckpoints, {});
    assert.deepEqual(ledger.checkpoints, {});

    if (inbox === source) {
      assert.equal(isRouteDue(ledger, currentRoute, Date.now()), true);
    }
  }

  return { pid: viewerRecord.pid, processId: viewerRecord.processId };
}

for (const mode of ["calibration", "viewer", "status"] as const) {
  test(`real post-custody HTTPS completion ${mode === "calibration" ? "can be aborted by exact-ticket API control" : `is aborted by late ${mode} CLI cancellation`}`, { timeout: 20_000 }, async (t) => {
    const f = await createWorkerFixture(t);
    const tls = await createSyncHttpsCredentials(t);
    const source = await f.inbox("source");
    const receiver = await f.inbox("receiver");
    const a = await source.store.snapshot();
    const b = await receiver.store.snapshot();
    const port = await availablePort();
    const receiverUrl = `https://127.0.0.1:${port}`;
    const tokenPath = path.join(f.root, "token");
    await writeFile(tokenPath, Buffer.alloc(48, 79).toString("base64url"), { mode: 0o600 });
    const references = { credentials: { token: tokenPath }, trust: { ca: tls.caPath }, tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } };
    await source.store.configureRuntime({ ...defaultRuntimeConfig(), ...references, intendedTarget: { peerId: b.inboxId, destinationInboxId: b.inboxId } });
    await receiver.store.configureRuntime({ ...defaultRuntimeConfig(), ...references, listener: { host: "127.0.0.1", port, tlsRef: "server" } });
    const route = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: receiverUrl,
      sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: source.name, readerAudience: "synthetic", allowedOrigins: a.originKeys,
      credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null };
    await source.store.configureRoute(route);
    await receiver.store.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: "https://127.0.0.1:1", localInboxName: receiver.name });
    await source.store.setWorkerEnabled(true);
    await receiver.store.setWorkerEnabled(true);

    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(`${f.root}/`)) handles.push(file);
      return file;
    });
    let completion: SyncRequestOptions | undefined;
    let starts = 0;
    let holds = 0;
    let responseClosed = false;
    let releaseResponse = () => {};
    const json = SyncClient.prototype.json;
    t.mock.method(SyncClient.prototype, "json", function<T>(this: SyncClient, auth: RouteAuthorization, endpoint: "identity" | "manifest" | "holdings" | "offer",
      envelope: unknown, parse: (value: unknown) => T, maximum: number, options: SyncRequestOptions = {}) {
      if (endpoint === "manifest" && parseObject(envelope, "manifest operation").op === "complete") {
        starts += 1;
        completion = options;
      }
      return (json<T>).call(this, auth, endpoint, envelope, parse, maximum, options);
    });
    const create = https.createServer;
    t.mock.method(https, "createServer", (...args: Parameters<typeof create>) => create(args[0], (request, response) => {
      const end = response.end.bind(response);
      t.mock.method(response, "end", (...values: Parameters<typeof end>) => {
        if (request.url === "/sync/v1/manifest" && completion && holds === 0) {
          holds += 1;
          response.once("close", () => { responseClosed = true; });
          releaseResponse = () => { releaseResponse = () => {}; end(...values); };
          return response;
        }
        return end(...values);
      });
      args[1]?.(request, response);
    }));
    const ports = [receiverUrl];
    f.resources.push(async () => {
      for (const origin of ports) await assertLoopbackClosed(origin);
      for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
    });
    const destinationWorker = await startOwnedSyncWorker(receiver.home, { temporary: true });
    ports.push(destinationWorker.record.controlOrigin);
    f.resources.push(() => destinationWorker.close());
    const sourceWorker = await startOwnedSyncWorker(source.home, { temporary: true });
    ports.push(sourceWorker.record.controlOrigin);
    f.resources.push(async () => { releaseResponse(); await sourceWorker.close(); });

    const preparedViewer = await prepareCompletionPublication(f, source, receiver, sourceWorker, destinationWorker, route, receiverUrl);
    assert.equal(starts, 0);
    assert.equal(holds, 0);

    const args = await f.publicationArgs(source, ["--wait-ms", "5000", "--json"]);
    const boundary = mode === "viewer" ? "viewer" : "status";
    const cli = f.launch([boundary, mode === "calibration" ? "continue" : "signal", ...args], { entry: path.join(__dirname, "sync-finalization-child.js"), timeoutMs: 8000 });
    const held = await waitForFinalizationHold(f.root);
    assert.ok(held);
    assert.equal(parseObject(held.stats, "held metrics").confirmations, 1);
    await waitUntil("one actual HTTPS completion response held", async () => holds, (value) => value === 1, 1000);
    assert.equal(starts, 1);
    assert.equal(responseClosed, false);
    assert.ok(completion?.signal);
    assert.ok(completion.deadlineAt);
    assert.equal(completion.signal.aborted, false);

    const observedAt = Date.now();
    const remainingBeforeAction = completion.deadlineAt - observedAt;

    assert.ok(remainingBeforeAction > 1000, `observe actual activity before ordinary request expiry: ${JSON.stringify({ mode, observedAt, deadlineAt: completion.deadlineAt, remainingBeforeAction, starts, holds, responseClosed, signalAborted: completion.signal.aborted })}`);
    const control = parseWorkerControlStatus(await contactWorker(source.home, "status"));
    assert.equal(control.tickets.length, 1);
    assert.equal(control.tickets[0].state, "running");
    t.diagnostic(JSON.stringify({ mode, starts, holds, responseClosed, signalAborted: completion.signal.aborted, remainingBeforeAction: completion.deadlineAt - Date.now() }));
    if (mode === "calibration") {
      const result = parseObject(await contactWorker(source.home, "cancel", control.tickets[0].ticketId, Math.min(completion.deadlineAt, Date.now() + 150)), "explicit cancellation control");
      assert.equal(result.cancelled, true);
    } else {
      assert.equal(cli.child.kill("SIGINT"), true);
    }
    await writeFile(path.join(f.root, "finalization-release"), "continue", { mode: 0o600 });
    const completed = await cli.completion;
    const viewer = await f.rememberViewer(source);
    assert.equal(viewer.state, "running");
    assert.equal(viewer.pid, preparedViewer.pid);
    t.diagnostic(JSON.stringify({ mode, responseClosedAfterCli: responseClosed, signalAbortedAfterCli: completion.signal.aborted, remainingAfterCli: completion.deadlineAt - Date.now() }));
    await waitUntil("held response closes from cancellation", async () => responseClosed, Boolean, 500);
    assert.equal(completion.signal.aborted, true);
    assert.ok(completion.deadlineAt - Date.now() > 500, "natural request expiry cannot satisfy cancellation");
    await assertCancellation(f.root, mode === "calibration" ? 0 : 1);
    assert.equal(completed.code, mode === "calibration" ? 0 : 130, completed.stderr);
    assert.equal(completed.signal, null);
    const publication = parsePublication(JSON.parse(completed.stdout));
    assert.equal(publication.delivery.cancelled, mode !== "calibration");
    assert.equal(publication.delivery.state, mode === "calibration" ? "confirmed" : "pending");
    if (mode !== "calibration") assert.equal(publication.delivery.receipt, null);
    const custody = await assertReceiverCommitted(receiver, a.inboxId, publication.document.originDocumentId);
    assert.equal(Object.keys(custody.ledger.records).length, 1);
    assert.equal(custody.receipts.filter((receipt) => receipt.disposition === "committed").length, 1);
    const ledger = await source.store.snapshot();
    assert.equal(ledger.worker.enabled, true);
    assert.equal(ledger.worker.retryPaused, false);
    assert.ok(Object.values(ledger.outbox).every((entry) => entry.disposition !== "retired" && entry.disposition !== "blocked"));
    const counters = parseObject(JSON.parse(await readFile(path.join(f.root, "finalization-complete.json"), "utf8")), "completion counters");
    assert.equal(counters.signals, mode === "calibration" ? 0 : 1);
    assert.equal(counters.confirmations, 1);
    assert.equal(counters.holds, 1);

    const viewerRecord = await readViewerRecord(source.home, { readOnly: true });
    assert.ok(viewerRecord);
    assert.equal(viewerRecord.pid, preparedViewer.pid);
    assert.equal(viewerRecord.processId, preparedViewer.processId);
    t.diagnostic(`one genuine custody/HTTPS completion hold; ${mode}; aborted before expiry; exact ports ${ports.join(", ")}`);
  });
}

for (const mode of ["signal", "calibration", "continue"] as const) {
  test(`actual admitted run with held ACK ${mode === "signal" ? "SIGINT cancels its HTTPS attempt" : mode === "calibration" ? "allows exact-ticket positive cancellation" : "confirms without interruption"}`, { timeout: 20_000 }, async (t) => {
    const f = await createWorkerFixture(t);
    const tls = await createSyncHttpsCredentials(t);
    const source = await f.inbox("source");
    const receiver = await f.inbox("receiver");
    const a = await source.store.snapshot();
    const b = await receiver.store.snapshot();
    const port = await availablePort();
    const receiverUrl = `https://127.0.0.1:${port}`;
    const tokenPath = path.join(f.root, "token");
    await writeFile(tokenPath, Buffer.alloc(48, 79).toString("base64url"), { mode: 0o600 });
    const references = { credentials: { token: tokenPath }, trust: { ca: tls.caPath }, tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } };
    await source.store.configureRuntime({ ...defaultRuntimeConfig(), ...references, intendedTarget: { peerId: b.inboxId, destinationInboxId: b.inboxId } });
    await receiver.store.configureRuntime({ ...defaultRuntimeConfig(), ...references, listener: { host: "127.0.0.1", port, tlsRef: "server" } });
    const route = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: receiverUrl,
      sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: source.name, readerAudience: "synthetic", allowedOrigins: a.originKeys,
      credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null };
    await source.store.configureRoute(route);
    await receiver.store.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: "https://127.0.0.1:1", localInboxName: receiver.name });
    await source.store.setWorkerEnabled(true);
    await receiver.store.setWorkerEnabled(true);

    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(`${f.root}/`)) handles.push(file);
      return file;
    });
    let completion: SyncRequestOptions | undefined;
    let starts = 0;
    let holds = 0;
    let responseClosed = false;
    let releaseResponse = () => {};
    const json = SyncClient.prototype.json;
    t.mock.method(SyncClient.prototype, "json", function<T>(this: SyncClient, auth: RouteAuthorization, endpoint: "identity" | "manifest" | "holdings" | "offer",
      envelope: unknown, parse: (value: unknown) => T, maximum: number, options: SyncRequestOptions = {}) {
      if (endpoint === "manifest" && parseObject(envelope, "manifest operation").op === "complete") {
        starts += 1;
        completion = options;
      }
      return (json<T>).call(this, auth, endpoint, envelope, parse, maximum, options);
    });
    const create = https.createServer;
    t.mock.method(https, "createServer", (...args: Parameters<typeof create>) => create(args[0], (request, response) => {
      const end = response.end.bind(response);
      t.mock.method(response, "end", (...values: Parameters<typeof end>) => {
        if (request.url === "/sync/v1/manifest" && completion && holds === 0) {
          holds += 1;
          response.once("close", () => { responseClosed = true; });
          releaseResponse = () => { releaseResponse = () => {}; end(...values); };
          return response;
        }
        return end(...values);
      });
      args[1]?.(request, response);
    }));
    let acknowledgement: { ticketId: string } | undefined;
    let acknowledgementHolds = 0;
    let acknowledgementClosed = false;
    let cancellations = 0;
    let releaseAcknowledgement = () => {};
    const createControl = http.createServer;
    t.mock.method(http, "createServer", (...args: Parameters<typeof createControl>) => createControl(args[0], (request, response) => {
      const end = response.end.bind(response);
      t.mock.method(response, "end", (...values: Parameters<typeof end>) => {
        const payload = parseObject(JSON.parse(String(values[0])), "control response");
        if (payload.ticketId && payload.cancelled !== undefined) {
          assert.equal(payload.ticketId, acknowledgement?.ticketId);
          cancellations += 1;
        }
        if (payload.ticketId && payload.state === "queued" && acknowledgementHolds === 0) {
          acknowledgement = { ticketId: parseString(payload.ticketId) };
          acknowledgementHolds += 1;
          response.once("close", () => { acknowledgementClosed = true; });
          releaseAcknowledgement = () => { releaseAcknowledgement = () => {}; if (!response.destroyed) end(...values); };
          return response;
        }
        return end(...values);
      });
      args[1]?.(request, response);
    }));
    const ports = [receiverUrl];
    f.resources.push(async () => {
      for (const origin of ports) await assertLoopbackClosed(origin);
      for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
    });
    const destinationWorker = await startOwnedSyncWorker(receiver.home, { temporary: true });
    ports.push(destinationWorker.record.controlOrigin);
    f.resources.push(() => destinationWorker.close());
    const sourceWorker = await startOwnedSyncWorker(source.home, { temporary: true });
    ports.push(sourceWorker.record.controlOrigin);
    f.resources.push(async () => { releaseAcknowledgement(); releaseResponse(); await sourceWorker.close(); });

    const preparedViewer = await prepareCompletionPublication(f, source, receiver, sourceWorker, destinationWorker, route, receiverUrl);
    assert.equal(starts, 0);
    assert.equal(holds, 0);
    assert.equal(acknowledgementHolds, 0);

    const args = await f.publicationArgs(source, ["--wait-ms", "5000", "--json"]);
    const cli = f.launch(["ack", mode === "signal" ? "signal" : "continue", ...args], { entry: path.join(__dirname, "sync-finalization-child.js"), timeoutMs: 8000 });
    await waitUntil("actual run acknowledgement and HTTPS completion held", async () => [acknowledgementHolds, holds],
      (value) => value[0] === 1 && value[1] === 1, 4000);
    assert.ok(acknowledgement);
    assert.equal(starts, 1);
    assert.ok(completion?.signal);
    assert.ok(completion.deadlineAt);
    assert.equal(completion.signal.aborted, false);
    assert.equal(responseClosed, false);
    assert.equal(acknowledgementClosed, false);
    const control = parseWorkerControlStatus(await contactWorker(source.home, "status"));
    assert.equal(control.tickets.length, 1);
    assert.equal(control.tickets[0].ticketId, acknowledgement.ticketId);
    assert.equal(control.tickets[0].state, "running");
    assert.ok(completion.deadlineAt - Date.now() > 2000);
    t.diagnostic(JSON.stringify({ mode, acknowledgementHolds, starts, holds, remainingBeforeAction: completion.deadlineAt - Date.now(), ports }));

    if (mode === "signal") {
      assert.equal(cli.child.kill("SIGINT"), true);
    } else if (mode === "calibration") {
      const started = Date.now();
      const cancelled = parseObject(await contactWorker(source.home, "cancel", acknowledgement.ticketId, Math.min(completion.deadlineAt, Date.now() + 150)), "cancellation calibration");
      assert.equal(cancelled.cancelled, true);
      await waitUntil("same bounded cancellation closes actual request", async () => responseClosed, Boolean, 500);
      assert.equal(completion.signal.aborted, true);
      t.diagnostic(JSON.stringify({ calibrationMs: Date.now() - started }));
      releaseAcknowledgement();
    } else {
      releaseAcknowledgement();
      releaseResponse();
    }

    const completed = await cli.completion;
    const viewer = await f.rememberViewer(source);
    assert.equal(viewer.state, "running");
    assert.equal(viewer.pid, preparedViewer.pid);
    assert.equal(completed.code, mode === "signal" ? 130 : 0, completed.stderr);
    assert.equal(completed.signal, null);
    const publication = parsePublication(JSON.parse(completed.stdout));
    assert.equal(publication.delivery.cancelled, mode === "signal");
    assert.equal(publication.delivery.state, mode === "signal" ? "pending" : "confirmed");
    if (mode === "signal") {
      assert.equal(publication.delivery.receipt, null);
      assert.equal(acknowledgementClosed, true, "SIGINT aborts the real unacknowledged run socket");
      await waitUntil("CLI itself cancels its admitted own request", async () => responseClosed, Boolean, 500);
      assert.equal(completion.signal.aborted, true);
    }
    assert.ok(completion.deadlineAt - Date.now() > 500, "ordinary expiry cannot satisfy the held request regression");
    assert.equal(cancellations, mode === "continue" ? 0 : 1);
    await assertCancellation(f.root, mode === "signal" ? 1 : 0, mode === "signal" ? 0 : 1);
    const attempts = parseArray(JSON.parse(await readFile(path.join(f.root, "finalization-attempts.json"), "utf8")), (value) => parseString(value), 1);
    assert.deepEqual(attempts, [acknowledgement.ticketId]);
    const counters = parseObject(JSON.parse(await readFile(path.join(f.root, "finalization-complete.json"), "utf8")), "completion counters");
    assert.equal(counters.signals, mode === "signal" ? 1 : 0);
    assert.equal(counters.holds, 0);
    assert.equal(counters.confirmations, mode === "signal" ? 0 : 1);
    assert.equal(counters.redundantLookups, 0);
    const custody = await assertReceiverCommitted(receiver, a.inboxId, publication.document.originDocumentId);
    assert.equal(Object.keys(custody.ledger.records).length, 1);
    assert.equal(custody.receipts.filter((receipt) => receipt.disposition === "committed").length, 1);
    assert.deepEqual((await source.store.getDocument(publication.document.localId))?.originalBytes, syntheticBytes);
    const ledger = await source.store.snapshot();
    assert.equal(ledger.worker.enabled, true);
    assert.equal(ledger.worker.retryPaused, false);
    assert.ok(Object.values(ledger.outbox).every((entry) => entry.disposition !== "retired" && entry.disposition !== "blocked"));

    const viewerRecord = await readViewerRecord(source.home, { readOnly: true });
    assert.ok(viewerRecord);
    assert.equal(viewerRecord.pid, preparedViewer.pid);
    assert.equal(viewerRecord.processId, preparedViewer.processId);
    t.diagnostic(JSON.stringify({ mode, acknowledgementHolds, holds, cancellations, responseClosed, signalAborted: completion.signal.aborted, remainingAfterCli: completion.deadlineAt - Date.now() }));
  });
}

async function ingestionFixture(t: TestContext, port = 0) {
  const f = await shutdownFixture(t);
  const tls = await createSyncHttpsCredentials(t);
  const create = https.createServer;
  let native: ReturnType<typeof https.createServer> | undefined;
  t.mock.method(https, "createServer", (...args: Parameters<typeof create>) => { native = create(...args); return native; });
  const app = createSyncIngestionServer({ store: f.store, peerId: (await f.store.snapshot()).inboxId,
    key: await readFile(tls.trusted.keyPath), cert: await readFile(tls.trusted.certPath), host: "127.0.0.1", port,
    requestMs: 300, credentials: () => { throw new Error("No route authorized in binding fixture"); } });
  assert.ok(native);
  const server = native;
  let listeningEvents = 0;
  server.on("listening", () => {
    listeningEvents += 1;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    f.ports.push(`https://127.0.0.1:${address.port}`);
  });
  f.cleanup.push(async () => {
    await app.close().catch(() => {});
    const leaked = server.listening;
    // A red disposes the captured server only after recording public failure.
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(leaked, false, "public close must leave no native listener");
  });
  return { ...f, app, server, get listeningEvents() { return listeningEvents; } };
}

test("immediate start and close rejects start after native binding and releases the actual port", { timeout: 5000 }, async (t) => {
  const f = await ingestionFixture(t);
  const starting = f.app.start();
  const rejected = assert.rejects(starting, /closed/);
  const closing = f.app.close();
  assert.equal(f.app.close(), closing);
  await Promise.all([closing, rejected]);
  assert.equal(f.listeningEvents, 1);
  assert.equal(f.app.status().listening, false);
  await f.app.close();
});

test("duplicate pending start never invokes a second native listen", { timeout: 5000 }, async (t) => {
  const f = await ingestionFixture(t);
  const listen = f.server.listen.bind(f.server);
  const calls = t.mock.method(f.server, "listen", listen);
  const starting = f.app.start();
  const duplicate = assert.rejects(f.app.start(), /started|closed/);
  await starting;
  await duplicate;
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(f.listeningEvents, 1);
  await f.app.close();
  assert.equal(f.app.status().listening, false);
});

test("close before start is stable and ordered start close remains normal", { timeout: 5000 }, async (t) => {
  const f = await ingestionFixture(t);
  const closing = f.app.close();
  assert.equal(f.app.close(), closing);
  await closing;
  await assert.rejects(f.app.start(), /closed/);
  assert.equal(f.listeningEvents, 0);
  assert.equal(f.app.status().listening, false);
});

test("ordered start and close releases its actual port", { timeout: 5000 }, async (t) => {
  const f = await ingestionFixture(t);
  const started = await f.app.start();
  assert.equal(f.listeningEvents, 1);
  await f.app.close();
  await assertLoopbackClosed(started.url);
  await assert.rejects(f.app.start(), /started|closed/);
});

test("actual EADDRINUSE preserves binding error and the owned unrelated listener", { timeout: 5000 }, async (t) => {
  const sentinel = net.createServer((socket) => socket.end("synthetic sentinel"));
  await new Promise<void>((resolve, reject) => { sentinel.once("error", reject); sentinel.listen(0, "127.0.0.1", resolve); });
  const address = sentinel.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => sentinel.close((error) => error ? reject(error) : resolve()));
    await assertLoopbackClosed(`http://127.0.0.1:${address.port}`);
  });
  const f = await ingestionFixture(t, address.port);
  const rejected = assert.rejects(f.app.start(), { code: "EADDRINUSE" });
  await f.app.close();
  await rejected;
  assert.equal(f.listeningEvents, 0);
  assert.equal(sentinel.listening, true);
  const observed = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(address.port, "127.0.0.1");
    let bytes = "";
    socket.on("data", (chunk: Buffer) => { bytes += chunk.toString(); });
    socket.once("end", () => resolve(bytes));
    socket.once("error", reject);
  });
  assert.equal(observed, "synthetic sentinel");
});

test("held native listening callback times out close honestly then cleans up after binding settles", { timeout: 5000 }, async (t) => {
  const f = await ingestionFixture(t);
  const emit = f.server.emit.bind(f.server);
  let release = () => {};
  let hits = 0;
  t.mock.method(f.server, "emit", (event: string, ...args: unknown[]) => {
    if (event === "listening") {
      hits += 1;
      release = () => { release = () => {}; emit(event, ...args); };
      return true;
    }
    return emit(event, ...args);
  });
  f.cleanup.push(async () => { release(); });
  const rejected = assert.rejects(f.app.start(), /closed/);
  await waitUntil("actual native listening event", async () => hits, (value) => value === 1, 1000);
  assert.equal(f.server.listening, true);
  const closing = f.app.close();
  await assert.rejects(closing, /did not drain/);
  assert.equal(f.app.close(), closing);
  release();
  await rejected;
  await waitUntil("eventual listener teardown", async () => f.server.listening, (value) => !value, 1000);
  await assert.rejects(f.app.close(), /did not drain/);
  assert.equal(hits, 1);
  assert.equal(f.listeningEvents, 1);
});

for (const validation of [false, true]) {
  test(`portable snapshot ${validation ? "validation plus close" : "close-only"} failure retains causes and closes actual descriptors`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const lock = path.join(await f.directory("portable"), "catalog.lock");
    const ownership = await acquireSyncOwnership(lock, Date.now() + 1000, undefined, { mode: "portable" });
    const bytes = await readFile(lock);
    const info = await fs.lstat(lock);
    const held = f.handles.find((file) => file.fd !== -1);
    assert.ok(held);
    const inspectError = Object.assign(new Error("synthetic portable owner stat EIO"), { code: "EIO" });
    const closeError = new Error("synthetic portable snapshot first-close failure");
    let inspections = 0;
    const inspection = validation ? t.mock.method(held, "stat", async () => { inspections += 1; throw inspectError; }) : undefined;
    const open = fs.open;
    let closes = 0;
    let snapshots = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (args[0] === lock) {
        snapshots += 1;
        const close = file.close.bind(file);
        t.mock.method(file, "close", async () => { closes += 1; if (closes === 1) throw closeError; await close(); });
      }
      return file;
    });
    const releasing = ownership.release();
    await assert.rejects(releasing, (error: unknown) => {
      assert.ok(errorCauses(error).includes(closeError));
      if (validation) assert.ok(errorCauses(error).includes(inspectError));
      return true;
    });
    assert.equal(ownership.release(), releasing);
    await assert.rejects(ownership.release());
    const disposing = ownership.closeHandles();
    assert.equal(ownership.closeHandles(), disposing);
    await disposing;
    assert.equal(inspections, validation ? 1 : 0);
    assert.equal(snapshots, 1);
    assert.equal(closes, 2);
    inspection?.mock.restore();
    await f.assertHandlesClosed();
    assert.deepEqual(await readFile(lock), bytes);
    assert.equal((await fs.lstat(lock)).ino, info.ino);
    assert.deepEqual(await readdir(path.dirname(lock)), ["catalog.lock"]);
  });
}

for (const fault of ["none", "first-close", "permanent-close", "invalid"] as const) {
  test(`ownership reader ${fault} preserves unknown on cleanup failure and bounds disposal`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const lock = path.join(await f.directory("reader"), "owner.lock");
    const owner = { schemaVersion: 2, token: randomUUID(), pid: process.pid, start: null };
    const bytes = fault === "invalid" ? "{unknown" : JSON.stringify(owner);
    await writeFile(lock, bytes, { mode: 0o600 });
    const info = await fs.lstat(lock);
    const open = fs.open;
    let closes = 0;
    let snapshot: Awaited<ReturnType<typeof fs.open>> | undefined;
    let restore = () => {};
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (args[0] === lock) {
        snapshot = file;
        const close = file.close.bind(file);
        const mock = t.mock.method(file, "close", async () => {
          closes += 1;
          if (fault === "permanent-close" || fault === "first-close" && closes === 1) throw new Error("synthetic ownership snapshot close failure");
          await close();
        });
        restore = () => mock.mock.restore();
      }
      return file;
    });
    const result = await readSyncOwnership(lock);
    assert.equal(result?.token ?? null, fault === "none" ? owner.token : null);
    assert.equal(closes, fault === "first-close" || fault === "permanent-close" ? 2 : 1);
    assert.ok(snapshot);
    if (fault === "permanent-close") {
      assert.notEqual(snapshot.fd, -1, "permanent OS close failure remains honest uncertainty");
      restore();
      await snapshot.close();
    }
    await assert.rejects(snapshot.stat(), { code: "EBADF" });
    await f.assertHandlesClosed();
    assert.equal(await readFile(lock, "utf8"), bytes);
    assert.equal((await fs.lstat(lock)).ino, info.ino);
  });
}
