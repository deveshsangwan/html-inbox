import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CommandInvocation, CommandRunner } from "./command-runner";
import { cp, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test as nodeTest } from "node:test";
import { canonicalKey, parseObject, parseString, stateFingerprint, verifyOriginState } from "./sync-model";
import type { SyncRoute } from "./sync-model";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore, toOriginState } from "./sync-store";
import { availablePort } from "./test-fixtures";
import { assertLoopbackClosed, startSyncApplication } from "./sync-protocol-fixture";
import { createSyncSupervisorDefinition, inspectSyncSupervisor, renderSyncSupervisor } from "./sync-supervisor";
import type { SyncSupervisorDefinition } from "./sync-supervisor";
import {
  assertReceiverCommitted, createCliPair, createOwnedPullPair, createWorkerFixture, exists, isPidGone,
  onlyOriginal, parsePublication, syntheticBytes, waitUntil, writePrivateJson,
  startClockWorker, startOwnedSentinel, startRecordingEndpoint,
} from "./sync-worker-fault-fixtures";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

test("managed CLI distinguishes explicit local-only from blocked target and pins each saved intent", { timeout: 40_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const source = await f.inbox("source");
  await f.configure(source, defaultRuntimeConfig());
  const local = await f.publish(source);
  assert.equal(local.delivery.state, "local-only");
  assert.deepEqual(local.local, { durable: true, queued: false });
  assert.equal(local.delivery.receipt, null);
  const initial = await onlyOriginal(source);
  assert.equal(initial.ledger.publicationIntents[initial.key], null);
  assert.equal(Object.keys(initial.ledger.outbox).length, 0);

  const target = { peerId: randomUUID(), destinationInboxId: randomUUID() };
  await f.json(["sync", "target", "set", target.destinationInboxId, "--peer", target.peerId, "--inbox", source.name]);
  const blocked = await f.publish(source, [], 3);
  assert.equal(blocked.delivery.state, "blocked");
  assert.deepEqual(blocked.delivery.target, target);
  assert.equal(blocked.local.durable, true);
  assert.equal(blocked.delivery.receipt, null);
  const configured = await source.store.snapshot();
  const targeted = Object.values(configured.records).find((record) => record.localId !== initial.record.localId);
  assert.ok(targeted);
  const targetedKey = canonicalKey(targeted.originInboxId, targeted.originDocumentId);
  assert.deepEqual(configured.publicationIntents[targetedKey], target);
  assert.equal(configured.worker.enabled, false);

  await f.json(["sync", "target", "clear", "--inbox", source.name]);
  await f.json(["sync", "status", "--document", targeted.localId, "--inbox", source.name]);
  const afterClear = await source.store.snapshot();
  assert.equal(afterClear.runtime?.config.intendedTarget, null);
  assert.deepEqual(afterClear.publicationIntents[targetedKey], target, "target clear cannot redirect an already saved publication");
  assert.equal((await source.store.getDocument(targeted.localId))?.originalBytes.equals(syntheticBytes), true);
});

test("active relay-only intended route blocks a new local original while other-target obligation remains durable", { timeout: 60_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  const upstream = await f.publish(f.source);
  const server = await f.inbox("server");
  const serverId = (await server.store.snapshot()).inboxId;
  await f.configure(server, { ...f.sourceConfig, intendedTarget: null });
  const token = (await readFile(f.sourceConfig.credentials.token, "utf8")).trim();
  const listener = await startSyncApplication(t, { home: server.home, peerId: serverId, ...f.tls.trusted, token });
  f.resources.push(() => listener.stop());
  await f.configure(f.destination, { ...f.sourceConfig, intendedTarget: { peerId: serverId, destinationInboxId: serverId } });
  const onward: SyncRoute = { ...f.route, id: randomUUID(), sourceInboxId: f.destinationId, peerId: serverId,
    destinationInboxId: serverId, peerUrl: listener.url, localInboxName: f.destination.name };
  await f.addRoute(server, { ...onward, direction: "inbound", peerId: f.destinationId, peerUrl: f.server.url, localInboxName: server.name });
  await f.addRoute(f.destination, onward);
  await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
  await waitUntil("authorized relay reaches intended server", () => f.destination.store.deliveryStatus(onward.id, f.sourceId, upstream.document.originDocumentId), (delivery) => delivery.isCommitted, 12_000);
  await assertReceiverCommitted(server, f.sourceId, upstream.document.originDocumentId);
  await f.json(["sync", "pause", "--inbox", f.destination.name]);
  const relay = await f.destination.store.snapshot();
  assert.equal(relay.routes[onward.id].state, "active");
  assert.equal(relay.routes[onward.id].allowedOrigins.some((grant) => grant.inboxId === f.destinationId), false);
  const localGrant = relay.originKeys.find((grant) => grant.inboxId === f.destinationId);
  assert.ok(localGrant);

  const otherTarget: SyncRoute = { ...f.route, id: randomUUID(), sourceInboxId: f.destinationId,
    destinationInboxId: f.sourceId, peerId: f.sourceId, peerUrl: "https://127.0.0.1:1",
    localInboxName: f.destination.name, allowedOrigins: [localGrant] };
  await f.addRoute(f.source, { ...otherTarget, direction: "inbound", peerId: f.destinationId, peerUrl: f.server.url, localInboxName: f.source.name });
  await f.addRoute(f.destination, otherTarget);
  const publication = await f.publish(f.destination, ["--wait-ms", "1000"], 3);
  assert.equal(publication.delivery.state, "blocked");
  assert.match(String(publication.delivery.reason), /authorized|route/i);
  assert.deepEqual(publication.delivery.target, { peerId: serverId, destinationInboxId: serverId });
  assert.deepEqual(publication.local, { durable: true, queued: true });
  const saved = await f.destination.store.snapshot();
  const key = canonicalKey(f.destinationId, publication.document.originDocumentId);
  const obligations = Object.values(saved.outbox).filter((entry) => entry.canonicalKey === key);
  assert.ok(obligations.some((entry) => entry.routeId === otherTarget.id && entry.disposition !== "retired"));
  assert.equal(obligations.some((entry) => entry.routeId === onward.id), false);
  assert.equal((await server.store.snapshot()).records[key], undefined);
  assert.equal((await f.destination.store.getDocument(publication.document.localId))?.originalBytes.equals(syntheticBytes), true);
});

test("receiver worker independently pulls periodically while source push is paused and both viewers are stopped", { timeout: 50_000 }, async (t) => {
  const f = await createOwnedPullPair(t);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
  await waitUntil("both production workers establish terminal history", async () => ({
    source: await f.source.store.snapshot(), destination: await f.destination.store.snapshot(),
  }), (state) => state.source.routes[f.route.id].state === "active" && state.destination.routes[f.route.id].state === "active");
  await f.json(["sync", "pause", "--inbox", f.source.name]);
  await f.publish(f.source, [], 2);
  const { record } = await onlyOriginal(f.source);
  await f.json(["viewer", "stop", "--inbox", f.source.name]);
  await f.json(["viewer", "stop", "--inbox", f.destination.name]);
  await waitUntil("independent periodic receiver pull", () => f.destination.store.listDocuments(), (documents) => documents.length === 1, 12_000);
  const received = await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  assert.equal((await f.source.store.snapshot()).worker.retryPaused, true);
  assert.ok(Object.keys(received.ledger.checkpoints).length > 0, "receiver independently completed a whole pull cut");
  assert.ok(Object.keys(received.ledger.historyCheckpoints).length > 0);
  await f.rememberWorker(f.source);
  await f.rememberWorker(f.destination);
});

test("three owned workers retain offline onward deletion through source and relay restart with viewers stopped", { timeout: 90_000 }, async (t) => {
  const f = await createOwnedPullPair(t);
  const third = await f.inbox("third");
  const thirdId = (await third.store.snapshot()).inboxId;
  const thirdPort = await availablePort();
  const thirdUrl = `https://127.0.0.1:${thirdPort}`;
  f.resources.push(() => assertLoopbackClosed(thirdUrl));
  await f.configure(third, { ...f.destinationConfig, listener: { host: "127.0.0.1", port: thirdPort, tlsRef: "listener" } });
  await f.configure(f.source, { ...f.sourceConfig, timings: { ...f.sourceConfig.timings, foregroundMs: 10_000 } });
  const unrelated = await f.publish(third);
  await f.json(["viewer", "stop", "--inbox", third.name]);
  const grant = (await f.source.store.snapshot()).originKeys.find((entry) => entry.inboxId === f.sourceId);
  assert.ok(grant);
  const onward = { ...f.route, id: randomUUID(), peerId: thirdId, peerUrl: thirdUrl, sourceInboxId: f.destinationId,
    destinationInboxId: thirdId, localInboxName: f.destination.name, allowedOrigins: [grant] };
  const outgoingFile = await writePrivateJson(path.join(f.root, "onward.json"), { schemaVersion: 1, expectedRevision: 0, route: onward });
  const incomingFile = await writePrivateJson(path.join(f.root, "onward-inbound.json"), { schemaVersion: 1, expectedRevision: 0,
    route: { ...onward, direction: "inbound", peerId: f.destinationId, peerUrl: f.destinationUrl, localInboxName: third.name } });
  await f.json(["sync", "mapping", "add", "--config", outgoingFile, "--inbox", f.destination.name]);
  await f.json(["sync", "mapping", "add", "--config", incomingFile, "--inbox", third.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);

  const publication = await f.publish(f.source);
  assert.equal(publication.delivery.state, "confirmed");
  assert.equal(publication.delivery.receipt?.destinationInboxId, f.destinationId);
  assert.equal(publication.onward.awaited, false);
  const key = canonicalKey(f.sourceId, publication.document.originDocumentId);
  const atRelay = await assertReceiverCommitted(f.destination, f.sourceId, publication.document.originDocumentId);
  assert.equal((await third.store.snapshot()).records[key], undefined, "A only waits for B while C has no runtime");
  assert.ok(Object.values(atRelay.ledger.outbox).some((entry) => entry.routeId === onward.id && entry.canonicalKey === key && entry.disposition !== "confirmed" && entry.disposition !== "retired"));
  await f.json(["viewer", "stop", "--inbox", f.source.name]);
  await f.json(["viewer", "stop", "--inbox", f.destination.name]);
  const sourceOwner = await f.rememberWorker(f.source);
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "start", "--inbox", f.source.name]);
  assert.notEqual((await f.rememberWorker(f.source)).processId, sourceOwner.processId);
  await waitUntil("original source worker exits", async () => isPidGone(sourceOwner.pid), Boolean);
  assert.equal((await f.source.store.snapshot()).records[key].signature, atRelay.record.signature);

  await f.json(["sync", "worker", "enable", "--inbox", third.name]);
  await f.json(["sync", "retry", "--route", onward.id, "--inbox", f.destination.name]);
  await waitUntil("third production worker receives canonical bytes", () => third.store.listDocuments(), (documents) => documents.length === 2, 12_000);
  const atThird = await assertReceiverCommitted(third, f.sourceId, publication.document.originDocumentId);
  assert.equal(atThird.record.signature, atRelay.record.signature);
  await waitUntil("relay persists onward live custody", () => f.destination.store.deliveryStatus(onward.id, f.sourceId, publication.document.originDocumentId), (delivery) => delivery.isCommitted, 12_000);
  await f.json(["sync", "worker", "stop", "--inbox", third.name]);
  await assertLoopbackClosed(thirdUrl);

  await f.run(["delete", publication.document.localId, "--force", "--inbox", f.source.name], 0);
  const originTerminal = (await f.source.store.snapshot()).records[key];
  assert.equal(originTerminal.state, "deleted");
  const signedTerminal = toOriginState(originTerminal);
  verifyOriginState(signedTerminal, grant.publicKey);
  const terminalFingerprint = stateFingerprint(signedTerminal);
  const pending = await waitUntil("relay durably retains terminal and offline onward obligation", () => f.destination.store.snapshot(), (ledger) =>
    ledger.records[key]?.state === "deleted" && Object.values(ledger.outbox).some((entry) => entry.routeId === onward.id && entry.canonicalKey === key && entry.fingerprint === terminalFingerprint && entry.disposition === "pending"), 12_000);
  assert.deepEqual(toOriginState(pending.records[key]), signedTerminal);
  assert.equal((await third.store.snapshot()).records[key].state, "live", "offline C has not received deletion yet");
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);
  await assertLoopbackClosed(f.sourceUrl);

  const relayOwner = await f.rememberWorker(f.destination);
  await f.json(["sync", "worker", "stop", "--inbox", f.destination.name]);
  await f.json(["sync", "worker", "start", "--inbox", f.destination.name]);
  assert.notEqual((await f.rememberWorker(f.destination)).processId, relayOwner.processId);
  await waitUntil("original relay worker exits", async () => isPidGone(relayOwner.pid), Boolean);
  assert.deepEqual(toOriginState((await f.destination.store.snapshot()).records[key]), signedTerminal);
  await f.json(["sync", "worker", "start", "--inbox", third.name]);
  await f.json(["sync", "retry", "--route", onward.id, "--inbox", f.destination.name]);
  const completed = await waitUntil("restarted relay alone forwards signed deletion", () => third.store.snapshot(), (ledger) => ledger.records[key]?.state === "deleted", 12_000);
  assert.deepEqual(toOriginState(completed.records[key]), signedTerminal);
  verifyOriginState(toOriginState(completed.records[key]), grant.publicKey);
  assert.equal(await third.store.getDocument(atThird.record.localId), null);
  assert.equal((await third.store.getDocument(unrelated.document.localId))?.originalBytes.equals(syntheticBytes), true);
  assert.equal((await third.store.listDocuments()).length, 1);
  assert.ok(Object.values(completed.receipts).some((receipt) => receipt.routeId === onward.id && receipt.fingerprint === terminalFingerprint && receipt.disposition === "deleted"));
  await waitUntil("relay persists terminal delivery receipt", () => f.destination.store.snapshot(), (ledger) =>
    Object.values(ledger.outbox).some((entry) => entry.routeId === onward.id && entry.fingerprint === terminalFingerprint && entry.disposition === "confirmed" && entry.receiptDisposition === "deleted"), 12_000);
  assert.equal(parseObject((await f.json(["sync", "worker", "status", "--inbox", f.source.name])).worker, "stopped source").running, false);
  for (const selected of [f.source, f.destination, third]) {
    assert.equal((await f.json(["viewer", "status", "--inbox", selected.name])).state, "stopped");
  }
});

test("listening receiver admits new inbound route and rotates revision credentials without a manual worker restart", { timeout: 60_000 }, async (t) => {
  const f = await createOwnedPullPair(t);
  const rotatedFile = path.join(f.root, "rotated-token");
  const nextFile = path.join(f.root, "next-token");
  await writeFile(rotatedFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
  await writeFile(nextFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
  const references = { rotated: rotatedFile, next: nextFile };
  await f.configure(f.source, { ...f.sourceConfig, timings: { ...f.sourceConfig.timings, foregroundMs: 10_000 }, credentials: { ...f.sourceConfig.credentials, ...references } });
  await f.configure(f.destination, { ...f.destinationConfig, credentials: { ...f.destinationConfig.credentials, ...references } });
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
  await waitUntil("initial live route", () => f.source.store.snapshot(), (ledger) => ledger.routes[f.route.id].state === "active");
  let receiverOwner = await f.rememberWorker(f.destination);
  const publication = await f.publish(f.source);
  const route = { ...f.route, id: randomUUID(), credentialRef: "rotated" };

  async function verifyReceiverTransition() {
    const replacement = await f.rememberWorker(f.destination);
    const status = await f.json(["sync", "worker", "status", "--inbox", f.destination.name]);
    const worker = parseObject(status.worker, "verified receiver worker status");
    assert.equal(worker.running, true);
    assert.equal(parseObject(worker.ingestion, "receiver ingestion").state, "listening");
    if (replacement.processId !== receiverOwner.processId) {
      await waitUntil("automatically replaced owned receiver exits", async () => isPidGone(receiverOwner.pid), Boolean);
      if (replacement.controlOrigin !== receiverOwner.controlOrigin) await assertLoopbackClosed(receiverOwner.controlOrigin);
    }

    receiverOwner = replacement;
  }

  async function mappingFile(fields: typeof route, expectedRevision: number) {
    return writePrivateJson(path.join(f.root, `${randomUUID()}.mapping.json`), { schemaVersion: 1, expectedRevision, route: fields });
  }

  const inbound = { ...route, direction: "inbound", peerId: f.sourceId, peerUrl: f.sourceUrl, localInboxName: f.destination.name };
  const inboundFile = await mappingFile(inbound, 0);
  await f.json(["sync", "mapping", "add", "--inbox", f.destination.name, "--config", inboundFile]);
  const outboundFile = await mappingFile(route, 0);
  await f.json(["sync", "mapping", "add", "--inbox", f.source.name, "--config", outboundFile]);
  await f.json(["sync", "run", "--route", route.id, "--inbox", f.source.name]);
  await waitUntil("new inbound grant on existing listener", () => f.source.store.deliveryStatus(route.id, f.sourceId, publication.document.originDocumentId), (delivery) => delivery.isCommitted);
  await verifyReceiverTransition();

  const rotatedInbound = await mappingFile({ ...inbound, credentialRef: "next" }, 1);
  await f.json(["sync", "mapping", "reconnect", route.id, "--revision", "1", "--config", rotatedInbound, "--inbox", f.destination.name]);
  const staleCredentialOutbound = await mappingFile(route, 1);
  await f.json(["sync", "mapping", "reconnect", route.id, "--revision", "1", "--config", staleCredentialOutbound, "--inbox", f.source.name]);
  await f.run(["sync", "run", "--route", route.id, "--inbox", f.source.name, "--json"]);
  await waitUntil("new revision rejects former token", () => f.source.store.snapshot(), (ledger) => ledger.routeRetries[route.id]?.blocked === true);
  assert.equal((await f.source.store.deliveryStatus(route.id, f.sourceId, publication.document.originDocumentId)).isCommitted, false);
  await verifyReceiverTransition();

  await writeFile(rotatedFile, await readFile(nextFile));
  await f.json(["sync", "retry", "--route", route.id, "--inbox", f.source.name]);
  await waitUntil("fresh credential reaches new receiver revision", () => f.source.store.deliveryStatus(route.id, f.sourceId, publication.document.originDocumentId), (delivery) => delivery.isCommitted);
  const received = await assertReceiverCommitted(f.destination, f.sourceId, publication.document.originDocumentId);
  assert.ok(received.receipts.some((receipt) => receipt.routeId === route.id && receipt.revision === 2 && receipt.disposition === "committed"));
  await verifyReceiverTransition();
  await f.json(["sync", "run", "--route", f.route.id, "--inbox", f.source.name]);
  assert.equal((await f.source.store.deliveryStatus(f.route.id, f.sourceId, publication.document.originDocumentId)).isCommitted, true, "unrelated route retains its custody state");
});

test("owned foreground fixture supervisor restarts a crashed worker and retained queue without viewer dependence", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.json(["sync", "pause", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.publish(f.source, ["--wait-ms", "1000"], 2);
  const { record } = await onlyOriginal(f.source);
  await f.json(["viewer", "stop", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);

  const command = ["sync", "worker", "start", "--foreground", "--inbox", f.source.name, "--json"];
  const first = f.launch(command, { timeoutMs: 40_000 });
  const recordPath = path.join(f.source.home, "sync", "worker", "runtime.json");
  await waitUntil("first foreground fixture worker", async () => {
    if (!await exists(recordPath)) return null;
    return parseObject(JSON.parse(await readFile(recordPath, "utf8")), "foreground owner");
  }, (owner) => owner?.pid === first.child.pid);
  const previous = await f.rememberWorker(f.source);
  first.child.kill("SIGKILL");
  assert.equal((await first.completion).signal, "SIGKILL");
  assert.equal(isPidGone(previous.pid), true);

  // Restart is provided by this owned fixture; no OS boot or service manager is involved.
  const restarted = f.launch(command, { timeoutMs: 40_000 });
  await waitUntil("replacement foreground fixture worker", async () => {
    if (!await exists(recordPath)) return null;
    return parseObject(JSON.parse(await readFile(recordPath, "utf8")), "replacement owner");
  }, (owner) => owner?.pid === restarted.child.pid);
  assert.notEqual((await f.rememberWorker(f.source)).processId, previous.processId);
  await f.json(["sync", "resume", "--inbox", f.source.name]);
  await waitUntil("retained queue after worker crash", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);
  assert.equal((await restarted.completion).code, 0);
});

test("actual CLI duplicate routes confirm one existing destination copy and keep originals", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.publish(f.destination);
  const original = await onlyOriginal(f.destination);
  const duplicate = { ...f.route, id: randomUUID() };
  await f.addRoute(f.source, duplicate);
  await f.addRoute(f.destination, { ...duplicate, direction: "inbound", peerId: f.sourceId, peerUrl: "https://127.0.0.1:1", localInboxName: f.destination.name });
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  const publication = await f.publish(f.source);
  assert.equal(publication.delivery.state, "confirmed");
  assert.equal(publication.delivery.receipt?.destinationInboxId, f.destinationId);
  assert.equal(publication.delivery.receipt?.disposition, "committed");
  const { record, key } = await onlyOriginal(f.source);
  await f.json(["sync", "run", "--inbox", f.source.name]);

  const received = await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  assert.equal(Object.keys(received.ledger.records).length, 2);
  assert.ok(received.ledger.records[original.key]);
  assert.equal(received.record.contributions.length, 2);
  assert.equal((await f.destination.store.listDocuments()).length, 2);
  assert.equal((await f.source.store.snapshot()).publicationIntents[key]?.destinationInboxId, f.destinationId);
  assert.equal((await f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId)).isCommitted, true);
  const status = await f.json(["sync", "worker", "status", "--inbox", f.source.name]);
  assert.doesNotMatch(JSON.stringify(status), /controlToken|BEGIN PRIVATE KEY|Bearer /);
});

test("deadline preserves durable pending work and worker delivers after publisher and viewer exit", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t, [{ id: "before-commit", route: "body", kind: "stall-request", afterBytes: 1, times: 1 }]);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  const owner = await f.rememberWorker(f.source);
  const startedAt = Date.now();
  let publisherFinished = false;
  const pending = f.publish(f.source, ["--wait-ms", "3000", "--request-timeout-ms", "5000"], 2).finally(() => { publisherFinished = true; });
  await f.proxy.waitForEvent((event) => event.type === "fault-hit" && event.faultId === "before-commit");
  assert.equal(publisherFinished, false, "the intended request cut is reached during foreground waiting");
  const result = await pending;
  assert.equal(result.delivery.state, "pending");
  assert.equal(result.local.durable, true);
  assert.equal(result.local.queued, true);
  assert.equal(result.delivery.receipt, null);
  assert.ok(Date.now() - startedAt < 10_000, "overall wait remains finite including runtime work");
  const { ledger, record, key } = await onlyOriginal(f.source);
  assert.equal(ledger.worker.retryPaused, false);
  assert.equal(ledger.worker.enabled, true);
  assert.equal((await f.source.store.getDocument(record.localId))?.originalBytes.equals(syntheticBytes), true);
  const obligation = Object.values(ledger.outbox).find((entry) => entry.routeId === f.route.id && entry.canonicalKey === key && entry.fingerprint === stateFingerprint(record));
  assert.ok(obligation);
  assert.ok(obligation.disposition === "pending" || obligation.disposition === "confirmed");
  // Background delivery can finish between the CLI result and this snapshot.
  if (obligation.disposition === "confirmed") {
    assert.equal((await f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId)).isCommitted, true);
    await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  }

  await f.json(["viewer", "stop", "--inbox", f.source.name]);
  await waitUntil("background custody after foreground timeout", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted, 12_000);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  assert.equal((await f.rememberWorker(f.source)).processId, owner.processId);
  assert.equal((await f.proxy.stats()).faultHits["before-commit"], 1);
});

for (const commitState of ["before", "after"]) {
  test(`SIGINT ${commitState} receiver commit preserves saved result and independent retries`, { timeout: 50_000 }, async (t) => {
    const f = await createCliPair(t, [{ id: "cancel-cut", route: "body", kind: commitState === "before" ? "stall-request" : "pause-response", afterBytes: 1, times: 1 }]);
    await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
    const publisher = f.launch([...(await f.publicationArgs(f.source, ["--wait-ms", "15000"])), "--json"]);
    const hit = await f.proxy.waitForEvent((event) => event.type === "fault-hit" && event.faultId === "cancel-cut");
    assert.equal(hit.type, "fault-hit");
    const { record } = await onlyOriginal(f.source);
    if (commitState === "after") {
      await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
    } else {
      assert.equal((await f.destination.store.listDocuments()).length, 0);
      assert.equal(Object.values((await f.destination.store.snapshot()).receipts).some((receipt) => receipt.disposition === "committed"), false);
    }

    publisher.child.kill("SIGINT");
    const result = await publisher.completion;
    assert.equal(result.code, 130, result.stderr);
    const saved = parsePublication(JSON.parse(result.stdout));
    assert.equal(saved.delivery.cancelled, true);
    assert.equal(saved.local.durable, true);
    assert.equal(saved.delivery.state, "pending");
    assert.equal(saved.delivery.receipt, null);
    await f.rememberViewer(f.source);
    const interrupted = await f.source.store.snapshot();
    assert.equal(interrupted.worker.retryPaused, false);
    assert.equal(interrupted.worker.enabled, true);
    assert.ok(Object.values(interrupted.outbox).every((entry) => entry.attempts === 0), "cancellation consumes no transient attempt allowance");
    assert.equal((await f.source.store.getDocument(record.localId))?.originalBytes.equals(syntheticBytes), true);

    if (commitState === "after") f.proxy.release(hit.requestId);
    await f.json(["viewer", "stop", "--inbox", f.source.name]);
    await waitUntil("background retry resolves cancelled foreground", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted, 12_000);
    const received = await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
    assert.equal(Object.keys(received.ledger.records).length, 1);
    assert.equal((await f.proxy.stats()).faultHits["cancel-cut"], 1);
  });
}

test("paused CLI run is silent and resume schedules the retained queue", { timeout: 40_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.json(["sync", "pause", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.publish(f.source, ["--wait-ms", "1000"], 2);
  const { ledger, record } = await onlyOriginal(f.source);
  assert.equal(ledger.worker.retryPaused, true);
  const before = (await f.proxy.stats()).routes;
  await f.json(["sync", "run", "--route", f.route.id, "--inbox", f.source.name]);
  await f.json(["sync", "worker", "wake", "--inbox", f.source.name]);
  await delay(1250);
  assert.deepEqual((await f.proxy.stats()).routes, before, "pause covers every independently scheduled endpoint");

  await f.json(["sync", "resume", "--inbox", f.source.name]);
  await waitUntil("resume delivery", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
});

test("mapping removal is quiet through timers wake retry restart and fresh reconnect applies offline deletion first", { timeout: 60_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.publish(f.source);
  const { record } = await onlyOriginal(f.source);
  const received = await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  await f.json(["sync", "mapping", "remove", f.route.id, "--revision", "1", "--inbox", f.source.name]);
  await f.json(["sync", "mapping", "remove", f.route.id, "--revision", "1", "--inbox", f.destination.name]);
  const detached = await f.destination.store.snapshot();
  assert.equal(detached.routes[f.route.id].state, "detached");
  assert.equal(detached.records[canonicalKey(f.sourceId, record.originDocumentId)].contributions[0]?.state, "detached");
  assert.equal((await f.destination.store.getDocument(received.record.localId))?.originalBytes.equals(syntheticBytes), true);
  const before = (await f.proxy.stats()).routes;

  const token = f.sourceConfig.credentials.token;
  await rename(token, `${token}.offline`);
  await f.json(["sync", "worker", "wake", "--inbox", f.source.name]);
  await f.run(["sync", "retry", "--route", f.route.id, "--inbox", f.source.name, "--json"]);
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "start", "--inbox", f.source.name]);
  await delay(1250);
  assert.deepEqual((await f.proxy.stats()).routes, before, "removed route opens no endpoint across timer, wake, retry or restart");
  await rename(`${token}.offline`, token);
  await f.run(["delete", record.localId, "--force", "--inbox", f.source.name], 0);
  assert.equal((await f.source.store.snapshot()).records[canonicalKey(f.sourceId, record.originDocumentId)].state, "deleted");
  assert.equal((await f.destination.store.snapshot()).records[canonicalKey(f.sourceId, record.originDocumentId)].state, "live");

  const outboundRevision = (await f.source.store.snapshot()).routes[f.route.id].revision;
  const inboundRevision = (await f.destination.store.snapshot()).routes[f.route.id].revision;
  assert.equal(outboundRevision, inboundRevision);
  const inbound: SyncRoute = { ...f.route, direction: "inbound", peerId: f.sourceId, peerUrl: "https://127.0.0.1:1", localInboxName: f.destination.name };
  const inboundFile = await f.mappingFile(inbound, inboundRevision);
  await f.json(["sync", "mapping", "reconnect", f.route.id, "--revision", String(inboundRevision), "--config", inboundFile, "--inbox", f.destination.name]);
  const outboundFile = await f.mappingFile(f.route, outboundRevision);
  await f.json(["sync", "mapping", "reconnect", f.route.id, "--revision", String(outboundRevision), "--config", outboundFile, "--inbox", f.source.name]);
  await f.json(["sync", "retry", "--route", f.route.id, "--inbox", f.source.name]);
  await waitUntil("fresh revision terminal reconciliation", () => f.destination.store.snapshot(), (ledger) => ledger.records[canonicalKey(f.sourceId, record.originDocumentId)]?.state === "deleted");
  assert.equal(await f.destination.store.getDocument(received.record.localId), null);
  assert.equal((await f.proxy.stats()).routes.body.starts, before.body.starts, "reconnect sends tombstone before any stale body can return");
});

test("headless enrollment works and capable anchored viewer switches format without a restart", { timeout: 40_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const headless = await f.inbox("headless", false);
  assert.equal(await exists(path.join(headless.home, "viewer.json")), false);
  await f.json(["sync", "enroll", "--inbox", headless.name, "--yes"]);
  assert.equal((await headless.store.snapshot()).migration.phase, "complete");
  assert.equal(await exists(path.join(headless.home, "viewer.json")), false, "enrollment itself does not start a reader");

  const active = await f.inbox("active", false);
  await f.run(["viewer", "--inbox", active.name], 0);
  const before = await f.rememberViewer(active);
  const owner = parseObject(JSON.parse(await readFile(path.join(active.home, "viewer.json"), "utf8")), "capable viewer ownership");
  assert.ok(owner.localOwner);
  await f.json(["sync", "enroll", "--inbox", active.name, "--yes"]);
  await f.configure(active, defaultRuntimeConfig());
  const publication = await f.publish(active);
  const after = await f.rememberViewer(active);
  assert.equal(after.pid, before.pid);
  const liveOwner = parseObject(JSON.parse(await readFile(path.join(active.home, "viewer.json"), "utf8")), "retained capable viewer");
  assert.equal(liveOwner.processId, owner.processId);
  const response = await fetch(`${parseString(after.url)}/documents/${publication.document.localId}/content`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), syntheticBytes);
});

test("actual pinned old viewer blocks enrollment before migration and before old control probe", { timeout: 40_000 }, async (t) => {
  const baselineCli = process.env.HTML_INBOX_BASELINE_CLI;
  if (!baselineCli) {
    t.skip("An untouched compiled b843e126 CLI must be supplied through HTML_INBOX_BASELINE_CLI");
    return;
  }

  const f = await createWorkerFixture(t);
  const source = await f.inbox("source", false);
  const old = f.launch(["viewer", "--inbox", source.name], { entry: baselineCli });
  assert.equal((await old.completion).code, 0);
  const recordPath = path.join(source.home, "viewer.json");
  const oldRecord = parseObject(JSON.parse(await readFile(recordPath, "utf8")), "old viewer record");
  const endpoint = await startRecordingEndpoint(f);
  const oldControl = new URL(parseString(oldRecord.controlUrl));
  await writePrivateJson(recordPath, { ...oldRecord, controlUrl: `${endpoint.url}${oldControl.pathname}` });
  f.resources.push(() => writePrivateJson(recordPath, oldRecord));
  try {
    const result = await f.run(["sync", "enroll", "--inbox", source.name, "--yes", "--json"]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(endpoint.requests, 0, "unanchored legacy control is never queried to discover ownership");
    assert.equal(await exists(path.join(source.home, "sync", "ledger.json")), false);
    assert.equal(await exists(path.join(source.home, "sync", "migration.json")), false);
    assert.equal((await lstat(path.join(source.home, "documents"))).isDirectory(), true, "no managed format barrier replaces the legacy directory");
  } finally {
    await writePrivateJson(recordPath, oldRecord);
    const stopped = await f.launch(["viewer", "stop", "--inbox", source.name, "--json"], { entry: baselineCli }).completion;
    assert.equal(stopped.code, 0, stopped.stderr);
    const pid = oldRecord.pid;
    assert.equal(typeof pid, "number");
    if (typeof pid === "number") await waitUntil("owned old viewer exit", async () => isPidGone(pid), Boolean);
    const config = parseObject(oldRecord.config, "old viewer listener");
    assert.equal(typeof config.port, "number");
    await assertLoopbackClosed(`http://127.0.0.1:${config.port}`);
    await assertLoopbackClosed(oldControl.origin);
  }
});

test("copied managed home and runtime records block before control or credential access and leave original worker alive", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  const owner = await f.rememberWorker(f.source);
  await f.json(["sync", "pause", "--inbox", f.source.name]);
  const sentinel = await startOwnedSentinel(f);
  const endpoint = await startRecordingEndpoint(f);
  const copiedHome = path.join(f.root, "copied");
  await cp(f.source.home, copiedHome, { recursive: true });
  const copiedRecord = path.join(copiedHome, "sync", "worker", "runtime.json");
  await writePrivateJson(copiedRecord, { ...owner, pid: sentinel.pid, controlOrigin: endpoint.url });
  const token = f.sourceConfig.credentials.token;
  await rename(token, `${token}.unavailable`);
  const before = (await f.proxy.stats()).routes;

  try {
    for (const args of [
      ["sync", "status"], ["sync", "run"], ["sync", "worker", "status"], ["sync", "worker", "start"],
      ["sync", "worker", "stop"], ["viewer", "status"], ["viewer", "stop"],
    ]) {
      const result = await f.run([...args, "--home", copiedHome, "--json"]);
      assert.equal(result.code, 1, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout + result.stderr, /unavailable|ENOENT.*token/, "home anchor rejects before credential resolution");
    }

    assert.equal(endpoint.requests, 0);
    assert.equal(isPidGone(sentinel.pid), false, "saved PID replacement remains untouched");
    assert.deepEqual((await f.proxy.stats()).routes, before);
  } finally {
    await rename(`${token}.unavailable`, token);
  }

  assert.equal((await f.rememberWorker(f.source)).processId, owner.processId);
  assert.equal(isPidGone(sentinel.pid), false);
});

test("offline copied-home quarantine and fresh fork require expected identity and retain inherited terminals without authority", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  const retained = await f.publish(f.source, ["--wait-ms", "1000"], 2);
  const deleted = await f.publish(f.source, ["--wait-ms", "1000"], 2);
  await f.run(["delete", deleted.document.localId, "--force", "--inbox", f.source.name], 0);
  await f.json(["viewer", "stop", "--inbox", f.source.name]);
  const original = await f.source.store.snapshot();
  const originalCatalog = await f.run(["inbox", "list", "--json"], 0);
  const copiedHome = path.join(f.root, "forked-copy");
  await cp(f.source.home, copiedHome, { recursive: true });
  const ledgerPath = path.join(copiedHome, "sync", "ledger.json");
  const before = await readFile(ledgerPath);
  const traffic = (await f.proxy.stats()).routes;
  await f.json(["sync", "restore", "inspect", "--home", copiedHome]);

  const wrongIdentity = await f.run(["sync", "restore", "quarantine", "--home", copiedHome, "--expect-inbox", randomUUID(), "--yes", "--json"]);
  assert.equal(wrongIdentity.code, 1);
  assert.deepEqual(await readFile(ledgerPath), before);
  await f.json(["sync", "restore", "quarantine", "--home", copiedHome, "--expect-inbox", f.sourceId, "--yes"]);
  const copied = new ManagedSyncStore(copiedHome);
  const quarantined = await copied.snapshot();
  assert.equal(quarantined.worker.ownerQuarantined, true);
  assert.equal(quarantined.worker.enabled, false);
  assert.equal(quarantined.runtime, null);
  assert.equal(Object.keys(quarantined.publicationIntents).length, 0);
  assert.ok(Object.values(quarantined.routes).every((route) => route.state === "blocked"));

  await f.json(["sync", "fork", "--home", copiedHome, "--expect-inbox", f.sourceId, "--yes"]);
  const forked = await new ManagedSyncStore(copiedHome).snapshot();
  assert.notEqual(forked.inboxId, f.sourceId);
  assert.notEqual(forked.historyEpoch, original.historyEpoch);
  assert.equal(forked.runtime, null);
  assert.equal(forked.worker.enabled, false);
  assert.equal(forked.worker.ownerQuarantined, false);
  assert.deepEqual(forked.routes, {});
  assert.deepEqual(forked.receipts, {});
  assert.deepEqual(forked.checkpoints, {});
  assert.deepEqual(forked.outbox, {});
  assert.equal(forked.records[canonicalKey(f.sourceId, deleted.document.originDocumentId)].state, "deleted");
  assert.equal(forked.records[canonicalKey(f.sourceId, retained.document.originDocumentId)].originInboxId, f.sourceId);
  assert.ok(Object.values(forked.records).every((record) => record.contributions.length === 0));
  assert.equal(await exists(path.join(copiedHome, "sync", "worker", "runtime.json")), false);
  assert.deepEqual((await f.proxy.stats()).routes, traffic);
  assert.deepEqual(await f.source.store.snapshot(), original, "offline copy maintenance never changes original owner");
  assert.equal((await f.run(["inbox", "list", "--json"], 0)).stdout, originalCatalog.stdout);
});

test("saved PID reuse never signals unrelated sentinel and malformed worker ownership blocks startup", { timeout: 40_000 }, async (t) => {
  if (process.platform !== "linux") {
    t.skip("Saved PID replacement requires Linux process-start evidence");
    return;
  }

  const f = await createWorkerFixture(t);
  const source = await f.inbox("source");
  await f.configure(source, defaultRuntimeConfig());
  await f.json(["sync", "worker", "enable", "--inbox", source.name]);
  const original = await f.rememberWorker(source);
  await f.json(["sync", "worker", "stop", "--inbox", source.name]);
  const sentinel = await startOwnedSentinel(f);
  const endpoint = await startRecordingEndpoint(f);
  const workerDirectory = path.join(source.home, "sync", "worker");
  const recordPath = path.join(workerDirectory, "runtime.json");
  const lockPath = path.join(workerDirectory, "lifetime.lock");
  const stale = { ...original, pid: sentinel.pid, start: "0", controlOrigin: endpoint.url };
  await writePrivateJson(recordPath, stale);
  await writePrivateJson(lockPath, { token: original.processId, pid: sentinel.pid, start: "0" });
  await f.json(["sync", "worker", "start", "--inbox", source.name]);
  assert.notEqual((await f.rememberWorker(source)).processId, original.processId);
  assert.equal(endpoint.requests, 0);
  assert.equal(isPidGone(sentinel.pid), false);
  await f.json(["sync", "worker", "stop", "--inbox", source.name]);

  await writePrivateJson(recordPath, { ...stale, controlOrigin: `${endpoint.url}/unsafe-path` });
  try {
    const result = await f.run(["sync", "worker", "start", "--inbox", source.name, "--json"]);
    assert.equal(result.code, 1);
    assert.equal(endpoint.requests, 0);
    assert.equal(isPidGone(sentinel.pid), false);
  } finally {
    await rm(recordPath, { force: true });
    await rm(lockPath, { force: true });
  }

  await writePrivateJson(lockPath, { token: randomUUID(), pid: sentinel.pid, start: null });
  try {
    const result = await f.run(["sync", "worker", "start", "--inbox", source.name, "--json"]);
    assert.equal(result.code, 1, "live lifetime owner without a proven runtime remains blocked");
    assert.equal(isPidGone(sentinel.pid), false);
    assert.equal(endpoint.requests, 0);
  } finally {
    await rm(lockPath, { force: true });
  }
});

test("owned worker wake repairs lost acknowledged body with physically empty outbox and receiver pull disabled", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.publish(f.source);
  const { record } = await onlyOriginal(f.source);
  const received = await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);

  // This idle-ledger edit simulates completed-outbox cleanup; it is not a production command.
  const ledgerPath = path.join(f.source.home, "sync", "ledger.json");
  const idle = await f.source.store.snapshot();
  assert.ok(Object.values(idle.outbox).every((entry) => entry.disposition === "confirmed"));
  await writePrivateJson(ledgerPath, { ...idle, outbox: {} });
  assert.ok(received.record.bodyFile);
  await rm(path.join(f.destination.home, "sync", "bodies", received.record.bodyFile));
  assert.equal(await f.destination.store.getDocument(received.record.localId), null);
  assert.equal((await f.destination.store.snapshot()).worker.enabled, false, "only real ingestion fixture is running at receiver");

  const before = (await f.proxy.stats()).routes.body?.starts ?? 0;
  await f.json(["sync", "worker", "start", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "wake", "--inbox", f.source.name]);
  await waitUntil("worker recreates missing acknowledged body", () => f.destination.store.getDocument(received.record.localId), (document) => document !== null);
  await waitUntil("repair custody persistence", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted);
  assert.ok((await f.proxy.stats()).routes.body.starts > before);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
});

test("CLI start races keep one owned runtime and detached startup does not imply boot supervision", { timeout: 40_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const source = await f.inbox("source");
  await f.configure(source, defaultRuntimeConfig());
  await f.json(["sync", "worker", "startup", "--inbox", source.name]);
  assert.equal(await exists(path.join(source.home, "sync", "worker", "runtime.json")), false);
  await f.json(["sync", "worker", "enable", "--inbox", source.name]);
  const owner = await f.rememberWorker(source);
  const starts = await Promise.all(Array.from({ length: 4 }, () => f.run(["sync", "worker", "start", "--inbox", source.name, "--json"])));
  assert.ok(starts.every((result) => result.code === 0), JSON.stringify(starts));
  assert.equal((await f.rememberWorker(source)).processId, owner.processId);
  const status = await f.json(["sync", "worker", "status", "--inbox", source.name]);
  assert.equal((await source.store.snapshot()).worker.bootSupervised, false);
  assert.doesNotMatch(JSON.stringify(status), /"bootSupervised":true/);

  await f.json(["sync", "worker", "disable", "--inbox", source.name]);
  assert.equal((await source.store.snapshot()).worker.enabled, false);
  assert.equal(await exists(path.join(source.home, "sync", "worker", "runtime.json")), false);
  await f.json(["sync", "worker", "startup", "--inbox", source.name]);
  assert.equal(await exists(path.join(source.home, "sync", "worker", "runtime.json")), false);
});

test("CLI supervisor render emits exact foreground commands without starting workers or installing services", { timeout: 30_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const source = await f.inbox("source");
  await f.configure(source, defaultRuntimeConfig());
  const ledger = await source.store.snapshot();
  for (const platform of ["systemd", "launchd"]) {
    const result = await f.run(["sync", "worker", "supervisor", "render", "--platform", platform, "--user", "agent", "--inbox", source.name], 0);
    assert.ok(result.stdout.includes(process.execPath));
    assert.ok(result.stdout.includes(path.join(__dirname, "index.js")));
    assert.ok(result.stdout.includes(source.home));
    assert.ok(result.stdout.includes(ledger.inboxId));
    assert.match(result.stdout, /foreground/);
    assert.doesNotMatch(result.stdout, /controlToken|BEGIN PRIVATE KEY|Bearer /);
    assert.equal(await exists(path.join(source.home, "sync", "worker", "runtime.json")), false);
  }

  const status = await f.json(["sync", "worker", "status", "--inbox", source.name]);
  assert.doesNotMatch(JSON.stringify(status), /"bootSupervised":true/);
  assert.equal((await source.store.snapshot()).worker.enabled, false);
});

test("supervisor inspection uses only recording runners and copied home blocks before manager calls", { timeout: 30_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const source = await f.inbox("source");
  const calls: CommandInvocation[] = [];
  const runner: CommandRunner = { async run(invocation) {
    calls.push(invocation);
    return { code: 1, signal: null, stdout: "", stderr: "synthetic manager unavailable" };
  } };
  const platforms: SyncSupervisorDefinition["platform"][] = ["systemd", "launchd"];
  for (const platform of platforms) {
    const definition = await createSyncSupervisorDefinition(source.home, platform, "agent", path.join(__dirname, "index.js"));
    const file = path.join(f.root, `${platform}.definition`);
    await writeFile(file, renderSyncSupervisor(definition), { mode: 0o600 });
    const status = await inspectSyncSupervisor(source.home, file, runner);
    assert.equal(status.bootSupervised, false);
    assert.equal(status.manager, "unknown");
    assert.ok(status.setupReasons.length > 0);
  }

  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.timeoutMs > 0 && call.timeoutMs <= 5000));
  const copied = path.join(f.root, "copied");
  await cp(source.home, copied, { recursive: true });
  const before = calls.length;
  await assert.rejects(inspectSyncSupervisor(copied, path.join(f.root, "systemd.definition"), runner), /anchor|copied|ownership|home/i);
  assert.equal(calls.length, before, "copied identity rejects before the recording manager boundary");
});

test("blocked authentication retries survive worker polling and only explicit retry resumes delivery", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  const tokenFile = f.sourceConfig.credentials.token;
  const correctToken = await readFile(tokenFile);
  await writeFile(tokenFile, randomBytes(48).toString("base64url"));
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  const publication = await f.publish(f.source, ["--wait-ms", "3000"], 3);
  assert.equal(publication.delivery.state, "blocked");
  const { record } = await onlyOriginal(f.source);
  const before = await f.source.store.snapshot();
  const entry = before.routeRetries[f.route.id];
  assert.ok(entry);
  assert.equal(entry.blocked, true);
  const starts = (await f.proxy.stats()).routes;
  await f.json(["sync", "worker", "wake", "--inbox", f.source.name]);
  await f.json(["sync", "status", "--document", record.localId, "--inbox", f.source.name]);
  await delay(1250);
  assert.deepEqual((await f.source.store.snapshot()).routeRetries[f.route.id], entry);
  assert.deepEqual((await f.proxy.stats()).routes, starts);

  await writeFile(tokenFile, correctToken);
  await f.json(["sync", "retry", "--route", f.route.id, "--inbox", f.source.name]);
  await waitUntil("explicit retry after corrected credentials", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted, 12_000);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
});

test("injected scheduling gap makes actual owned worker catch up before its long periodic interval", { timeout: 50_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.configure(f.source, { ...f.sourceConfig, timings: { ...f.sourceConfig.timings, reconcileMs: 300_000 } });
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "stop", "--inbox", f.source.name]);
  const startedAt = Date.now();
  const worker = await startClockWorker(f, f.source.home);
  await waitUntil("initial owned worker pass completes", () => f.source.store.snapshot(), (ledger) => (ledger.worker.lastRunAt ?? 0) >= startedAt);
  await f.json(["sync", "pause", "--inbox", f.source.name]);
  await f.publish(f.source, ["--wait-ms", "1000"], 2);
  const { record } = await onlyOriginal(f.source);
  await f.json(["viewer", "stop", "--inbox", f.source.name]);
  const before = (await f.proxy.stats()).routes.body.starts;

  // The narrow store mutation removes pause without issuing a wake; the clock hook is the only trigger.
  await f.source.store.setRetryPaused(false);
  const gapStartedAt = Date.now();
  let custodyWaitStartedAt: number | undefined;
  try {
    await worker.gap();
    custodyWaitStartedAt = Date.now();
    await waitUntil("scheduling gap catch-up custody", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, record.originDocumentId), (delivery) => delivery.isCommitted);
  } catch (error) {
    try {
      const failedAt = Date.now();
      const [snapshot, proxy] = await Promise.allSettled([f.source.store.snapshot(), f.proxy.stats()]);
      const ledger = snapshot.status === "fulfilled" ? snapshot.value : undefined;
      const route = ledger?.routes[f.route.id];
      const retry = ledger?.routeRetries[f.route.id];
      const pending = ledger && Object.values(ledger.outbox).filter((entry) => entry.routeId === f.route.id && entry.disposition === "pending");
      t.diagnostic(JSON.stringify({ kind: "scheduling-gap-custody-failure", startedAt, gapStartedAt, custodyWaitStartedAt, failedAt,
        sourceSnapshotAvailable: !!ledger, proxyStatsAvailable: proxy.status === "fulfilled",
        worker: ledger && { enabled: ledger.worker.enabled, retryPaused: ledger.worker.retryPaused, lastRunAt: ledger.worker.lastRunAt },
        route: route && { revision: route.revision, state: route.state },
        retry: retry && { attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt, blocked: retry.blocked,
          lastErrorSHA256: retry.lastError === null ? null : createHash("sha256").update(retry.lastError).digest("hex") },
        pending: pending && { count: pending.length, due: pending.filter((entry) => entry.nextAttemptAt <= failedAt).length },
        workerEvents: worker.messages.slice(-32).map((event) => ({ type: ["ready", "pass", "gap", "closed"].find((type) => event.type === type) ?? "unknown" })),
        bodyStartsBeforeGap: before, bodyStartsAfterFailure: proxy.status === "fulfilled" ? proxy.value.routes.body.starts : undefined,
      }));
    } finally {
      // Failure observation must preserve the original application error.
      throw error;
    }
  }

  assert.ok((await f.proxy.stats()).routes.body.starts > before);
  assert.equal(worker.messages.filter((message) => message.type === "gap").length, 1);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
});
