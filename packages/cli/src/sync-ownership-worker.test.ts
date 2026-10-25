import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { acquireSyncOwnership, createStorageCounters, DurableFiles, processStart, readSyncOwnership } from "./sync-files";
import { assertExactKeys, canonicalKey, parseObject, parseString, parseUuid, stateFingerprint } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { routeAuthorization } from "./sync-reconciliation";
import { contactWorker, parseWorkerControlStatus } from "./sync-worker-client";
import { readWorkerRecordOffline, workerPaths } from "./sync-worker-records";
import { createOwnedPullPair, createWorkerFixture, isPidGone, syntheticBytes, waitUntil, type WorkerFixture } from "./sync-worker-fault-fixtures";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { availablePort } from "./test-fixtures";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

async function foreground(t: TestContext, f: WorkerFixture, selected: { home: string }, stage = "created", inherited = false) {
  await new DurableFiles(createStorageCounters(), {}, selected.home).directory(workerPaths(selected.home).directory);
  const exclusion = inherited ? await acquireSyncOwnership(workerPaths(selected.home).startup, Date.now() + 1000) : null;
  const child = spawn(process.execPath, [path.join(__dirname, "sync-ownership-worker-child.js"), selected.home, stage], {
    cwd: f.root, env: { ...f.env, ...(exclusion ? { HTML_INBOX_SYNC_START_LOCK: exclusion.owner.token } : {}) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: Record<string, unknown>[] = [];
  let stderr = "";
  let stdout = "";
  let exited = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); }));
  child.once("exit", () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.connected) child.disconnect();
  });
  child.on("message", (message: unknown) => messages.push(parseObject(message, "worker fixture IPC")));
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const lifetime = setTimeout(() => child.kill("SIGKILL"), 40_000);

  async function waitFor(type: string) {
    return waitUntil(`foreground ${type}: ${stderr}`, async () => {
      const failure = messages.find((message) => message.type === "mutation-cut-failed");
      if (failure) throw new Error(`Foreground cut failed: ${JSON.stringify(failure)}`);
      if (exited) throw new Error(`Foreground exited before ${type}: ${stderr} ${stdout}`);
      return messages.find((message) => message.type === type);
    }, (message) => Boolean(message), 10_000).then((message) => { assert.ok(message); return message; });
  }

  async function cleanup() {
    if (!exited) {
      try { await contactWorker(selected.home, "stop", null, Date.now() + 3000); } catch { /* A deliberate kill or earlier fixture disable may already have stopped it. */ }
      if (child.connected) child.disconnect();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
      try { await closed; } finally { clearTimeout(timeout); }
    }
    clearTimeout(lifetime);
    assert.ok(child.pid);
    assert.equal(isPidGone(child.pid), true);
  }
  f.resources.push(cleanup);
  try {
    const ready = await waitFor("sync-worker-ready");
    assert.equal(ready.pid, child.pid);
    const record = await readWorkerRecordOffline(selected.home);
    assert.ok(record);
    assert.equal(record.processId, ready.processId);
    assert.equal((await readSyncOwnership(workerPaths(selected.home).lifetime))?.token, ready.processId);
    const status = parseWorkerControlStatus(await contactWorker(selected.home, "status"));
    assert.equal(status.pid, child.pid);
    await f.rememberWorker(selected);
    t.diagnostic(`retained foreground child ${child.pid}, ready, inherited startup=${inherited}; fixture-only 30000ms lease on loopback`);
    return { child, record, cleanup, waitFor, diagnostics: () => ({ stderr, stdout, exited, exitCode: child.exitCode, signalCode: child.signalCode }), async arm() {
      child.send({ type: "arm" });
      await waitFor("armed");
    }, async cutPausedMutation(operationId: string) {
      child.send({ type: "cut-paused-mutation", operationId });
      const cut = await waitFor("mutation-cut");
      const producers = messages.filter((message) => message.type === "mutation-producer");
      assert.equal(producers.length, 1);
      const producer = producers[0];
      assert.equal(producer.operationId, operationId);
      assert.equal(producer.operationCount, 1);
      assert.equal(producer.method, "setRetryPaused");
      assert.equal(producer.paused, true);
      assert.equal(producer.alreadyPaused, true);
      assert.equal(producer.pid, child.pid);
      assert.equal(messages.filter((message) => message.type === "mutation-cut").length, 1);
      assert.equal(cut.operationId, operationId);
      assert.equal(cut.scopeId, operationId);
      assert.equal(cut.operationCount, 1);
      assert.equal(cut.pid, child.pid);
      assert.equal(cut.stage, stage);
      t.diagnostic(JSON.stringify(producer));
      return cut;
    }, async kill() {
      assert.equal(messages.some((message) => message.type === "mutation-cut-failed"), false);
      child.kill("SIGKILL");
      assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
      clearTimeout(lifetime);
      assert.equal(isPidGone(record.pid), true);
      await assertLoopbackClosed(record.controlOrigin);
      if (status.ingestion.url) await assertLoopbackClosed(status.ingestion.url);
      t.diagnostic(`SIGKILL child ${record.pid} reaped; exact control ${record.controlOrigin} and ingestion ${status.ingestion.url} ports rebound`);
    } };
  } finally { await exclusion?.release(); }
}

test("ready retained real foreground CLI cuts its next empty mutation candidate, reaps and restarts both listeners", { timeout: 30_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const tls = await createSyncHttpsCredentials(t);
  const inbox = await f.inbox("only");
  const port = await availablePort();
  await f.configure(inbox, { schemaVersion: 1, intendedTarget: null, listener: { host: "127.0.0.1", port, tlsRef: "listener" },
    timings: { foregroundMs: 1000, requestMs: 1000, reconcileMs: 1000, passMs: 3000 }, credentials: {}, trust: {},
    tls: { listener: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } });
  await inbox.store.setWorkerEnabled(true);
  const first = await foreground(t, f, inbox, "created", true);
  await waitUntil("first worker pass complete", () => inbox.store.snapshot(), (ledger) => ledger.worker.lastRunAt !== null);
  await first.arm();
  await contactWorker(inbox.home, "wake");
  const cut = await first.waitFor("mutation-cut");
  assert.equal(cut.hits, 1);
  assert.equal(cut.candidateOpens, 1);
  assert.equal(cut.bytes, 0);
  assert.equal(cut.nlink, 1);
  assert.equal(cut.canonical, null);
  assert.equal((await lstat(parseString(cut.candidate))).ino, cut.ino);
  await first.kill();
  t.diagnostic(JSON.stringify(cut));
  const restarted = await foreground(t, f, inbox);
  assert.notEqual(restarted.record.processId, first.record.processId);
  assert.equal(parseWorkerControlStatus(await contactWorker(inbox.home, "status")).ingestion.state, "listening");
  await restarted.cleanup();
  await assertLoopbackClosed(`http://127.0.0.1:${port}`);
});

for (const stage of ["created", "linked"]) {
  test(`seeded pending publication survives real foreground ${stage} cut and autonomously reaches intended custody`, { timeout: 40_000 }, async (t) => {
    const f = await createOwnedPullPair(t);
    await f.destination.store.setRetryPaused(true);
    await f.destination.store.setWorkerEnabled(true);
    await f.source.store.setWorkerEnabled(true);
    const destination = await foreground(t, f, f.destination);
    const source = await foreground(t, f, f.source, stage);
    await waitUntil("explicit setup handshake without early source startup attempts", () => f.source.store.snapshot(),
      (ledger) => ledger.routes[f.route.id].state === "active" && ledger.worker.lastRunAt !== null);
    await f.source.store.setRetryPaused(true);
    await contactWorker(f.source.home, "quiesce");
    const metadata = await f.source.store.publish({ originalBytes: syntheticBytes, title: "pending exact bytes", type: "report", sourceFileName: "pending.html" }, "pending");
    await f.source.store.publish({ originalBytes: syntheticBytes, title: "blocked preserved", type: "report", sourceFileName: "blocked.html" }, "blocked");
    const initial = await f.source.store.snapshot();
    const route = initial.routes[f.route.id];
    const blockedKey = canonicalKey(initial.inboxId, "blocked");
    await f.source.store.updateAttempt(routeAuthorization(route), blockedKey, { nextAttemptAt: 0, lastError: "fixture-blocked", blocked: true });
    const seeded = await f.source.store.snapshot();
    const key = canonicalKey(seeded.inboxId, metadata.id);
    const blockedBefore = Object.values(seeded.outbox).find((entry) => entry.canonicalKey === blockedKey);
    assert.ok(blockedBefore);
    assert.equal(blockedBefore.disposition, "blocked");
    assert.equal(Object.values(seeded.outbox).find((entry) => entry.canonicalKey === key)?.disposition, "pending");
    assert.equal((await f.destination.store.listDocuments()).length, 0);
    // Hold an idempotent test-only pause mutation in the actual worker process.
    // The parent must reap that owner before unpause can acquire its linked lock.
    const cut = await source.cutPausedMutation(randomUUID());
    assert.equal(cut.hits, 1);
    assert.equal(cut.candidateOpens, 1);
    const candidatePath = parseString(cut.candidate);
    const lockPath = path.join(f.source.home, "sync", "mutation.lock");
    const candidate = await lstat(candidatePath);
    assert.equal(candidate.ino, cut.ino);
    assert.equal(candidate.dev, cut.dev);
    assert.equal(candidate.size, cut.bytes);
    assert.equal(candidate.nlink, cut.nlink);
    assert.equal(source.child.exitCode, null);
    assert.equal(source.child.signalCode, null);
    assert.equal(isPidGone(source.record.pid), false);
    await assert.rejects(lstat(`${lockPath}.reap`), { code: "ENOENT" });
    if (stage === "created") {
      assert.equal(cut.canonical, null);
      assert.equal(cut.bytes, 0);
      assert.equal(cut.nlink, 1);
      await assert.rejects(lstat(lockPath), { code: "ENOENT" });
    } else {
      const canonical = parseObject(cut.canonical, "linked canonical");
      assert.equal(canonical.ino, cut.ino);
      assert.equal(canonical.dev, cut.dev);
      assert.equal(canonical.nlink, 2);
      assert.equal(cut.nlink, 2);
      assert.ok(parseString(canonical.content).includes('"schemaVersion":2'));
      const current = await lstat(lockPath);
      assert.equal(current.dev, candidate.dev);
      assert.equal(current.ino, candidate.ino);
      assert.equal(current.nlink, 2);
      for (const info of [candidate, current]) {
        assert.equal(info.isFile(), true);
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal(info.uid, process.getuid?.());
      }
      const bytes = await readFile(lockPath, "utf8");
      assert.equal(bytes, canonical.content);
      assert.equal(await readFile(candidatePath, "utf8"), bytes);
      const owner = parseObject(JSON.parse(bytes), "linked owner");
      assertExactKeys(owner, ["schemaVersion", "token", "pid", "start"]);
      assert.equal(owner.schemaVersion, 2);
      parseUuid(owner.token);
      assert.equal(owner.pid, source.record.pid);
      const start = await processStart(source.record.pid);
      if (process.platform === "linux") assert.ok(start);
      assert.equal(owner.start, start);
      assert.deepEqual(await readSyncOwnership(lockPath), { token: owner.token, pid: owner.pid, start: owner.start });
    }

    const sourceAtCut = await f.source.store.snapshot();
    const receiverAtCut = await f.destination.store.snapshot();
    assert.equal(sourceAtCut.worker.retryPaused, true);
    assert.deepEqual(sourceAtCut.records[key], seeded.records[key]);
    assert.deepEqual(Object.values(sourceAtCut.outbox).find((entry) => entry.canonicalKey === key),
      Object.values(seeded.outbox).find((entry) => entry.canonicalKey === key));
    assert.deepEqual(Object.values(sourceAtCut.outbox).find((entry) => entry.canonicalKey === blockedKey), blockedBefore);
    assert.equal(receiverAtCut.worker.retryPaused, true);
    assert.equal(receiverAtCut.records[key], undefined);
    assert.equal((await f.destination.store.listDocuments()).length, 0);
    assert.equal(await f.destination.store.getDocument(metadata.id), null);
    const fingerprint = stateFingerprint(seeded.records[key]);
    assert.equal(Object.values(sourceAtCut.receipts).some((entry) => entry.fingerprint === fingerprint), false);
    assert.equal(Object.values(receiverAtCut.receipts).some((entry) => entry.fingerprint === fingerprint), false);
    t.diagnostic(JSON.stringify({ cut, pendingAtCut: true, blockedUnchanged: true, sourcePaused: true, receiverPaused: true,
      receiverRecordAbsent: true, receiverBodyAbsent: true, senderReceiptAbsent: true, receiverReceiptAbsent: true }));

    await source.kill();
    t.diagnostic(JSON.stringify(cut));
    await f.source.store.setRetryPaused(false);
    const restarted = await foreground(t, f, f.source);
    assert.notEqual(restarted.record.processId, source.record.processId);
    if (stage === "linked") await assert.rejects(lstat(parseString(cut.candidate)), { code: "ENOENT" });
    assert.notEqual((await readSyncOwnership(path.join(f.source.home, "sync", "mutation.lock")))?.pid, source.record.pid);
    try {
      await waitUntil("autonomous intended-server committed receipt", () => f.source.store.deliveryStatus(f.route.id, initial.inboxId, metadata.id), (status) => status.isCommitted, 12_000);
    } catch (error) {
      const sender = await f.source.store.snapshot();
      const receiver = await f.destination.store.snapshot();
      t.diagnostic(JSON.stringify({ queueFailure: String(error), senderPidGone: isPidGone(restarted.record.pid), receiverPidGone: isPidGone(destination.record.pid),
        senderWorker: sender.worker, receiverWorker: receiver.worker, senderProcess: restarted.diagnostics(), receiverProcess: destination.diagnostics(), route: sender.routes[f.route.id], retry: sender.routeRetries[f.route.id],
        outbox: Object.values(sender.outbox), receiverRecords: Object.keys(receiver.records) }));
      throw error;
    }
    const sourceLedger = await f.source.store.snapshot();
    const destinationLedger = await f.destination.store.snapshot();
    const received = destinationLedger.records[key];
    assert.ok(received);
    assert.deepEqual((await f.destination.store.getDocument(received.localId))?.originalBytes, syntheticBytes);
    assert.equal(Object.keys(destinationLedger.records).filter((identity) => identity === key).length, 1);
    const status = await f.source.store.deliveryStatus(f.route.id, initial.inboxId, metadata.id);
    assert.equal(status.isCommitted, true);
    const receipt = Object.values(sourceLedger.receipts).find((entry) => entry.fingerprint === stateFingerprint(seeded.records[key]));
    assert.ok(receipt);
    assert.equal(receipt.receiverInboxId, destinationLedger.inboxId);
    assert.equal(receipt.destinationInboxId, destinationLedger.inboxId);
    assert.equal(receipt.storageIncarnation, destinationLedger.storageIncarnation);
    assert.equal(Object.values(sourceLedger.outbox).find((entry) => entry.canonicalKey === key)?.disposition, "confirmed", "pending obligation durably retired to confirmed");
    assert.deepEqual(Object.values(sourceLedger.outbox).find((entry) => entry.canonicalKey === blockedKey),
      { ...blockedBefore, receiverStorageIncarnation: destinationLedger.storageIncarnation });
    assert.equal(destinationLedger.worker.retryPaused, true);
    assert.equal(Object.values(destinationLedger.records).some((record) => record.originDocumentId === "blocked"), false);
    await restarted.cleanup();
    await destination.kill();
    const pausedRestart = await foreground(t, f, f.destination);
    assert.equal((await f.destination.store.snapshot()).worker.retryPaused, true);
    await pausedRestart.cleanup();
    await assertLoopbackClosed(f.sourceUrl);
    await assertLoopbackClosed(f.destinationUrl);
    t.diagnostic(`exact ${syntheticBytes.length} bytes, one canonical receiver, intended current receipt, confirmed outbox; blocked item and paused receiver preserved`);
  });
}
