import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { formatDocumentTable } from "./cli-display";
import { parseDocumentMetadata, type PublishInput } from "./documents";
import { inspectInboxHome } from "./inbox-home";
import { LocalDocumentSource } from "./local-document-source";
import { exportStaticSnapshot } from "./static-export";
import { createOneShotStorageFault, type StorageEvent } from "./sync-files";
import { outboxKey } from "./sync-ledger";
import { MANIFEST_DOMAIN, SYNC_LIMITS, canonicalKey, inventoryDigest, metadataEncoding, parseOriginState, parseRoute, sha256, signOriginState, stateEncoding, stateFingerprint, verifyOriginState,
  type CompleteInventory, type OriginState, type RouteAuthorization, type SyncRoute } from "./sync-model";
import { MANAGED_FORMAT_BARRIER, ManagedSyncStore, toOriginState } from "./sync-store";
import { renderDocumentShell, renderIndex } from "./viewer-render";

// Managed durability requires POSIX directory fsync; Windows opt-in rejection has its own active regression.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const input: PublishInput = { originalBytes: Buffer.from("\ufeff<!doctype html>\r\n<html><body>owned π</body></html>\r\n"), title: "  Exact title  ", type: "report", sourceFileName: "original.html" };

async function temporaryHome(t: TestContext) {
  const parent = await mkdtemp(path.join(tmpdir(), "html-inbox-storage-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return path.join(parent, "inbox");
}

async function enrolled(t: TestContext) {
  const home = await temporaryHome(t);
  const store = new ManagedSyncStore(home);
  await store.enroll();
  return { home, store };
}

async function routeBetween(source: ManagedSyncStore, destination: ManagedSyncStore, options: Partial<SyncRoute> = {}) {
  const a = await source.snapshot();
  const b = await destination.snapshot();
  const owner = a.originKeys.find((grant) => grant.inboxId === a.inboxId);
  assert.ok(owner);
  const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "inbound", peerId: randomUUID(), peerUrl: "https://peer.test/", sourceInboxId: a.inboxId, destinationInboxId: b.inboxId,
    localInboxName: "synthetic", readerAudience: "synthetic local reader", allowedOrigins: [{ ...owner }], credentialRef: "synthetic_credential", tlsTrustRef: "synthetic_ca", state: "active", lastError: null, ...options };
  await destination.configureRoute(route);
  if (route.direction === "inbound" && route.allowedOrigins.every((grant) => grant.inboxId === route.sourceInboxId || grant.completeHistory)) {
    const states = Object.values(a.records).filter((state) => route.allowedOrigins.some((grant) => grant.inboxId === state.originInboxId)).map(toOriginState);
    const evidence = { ...completion(route, states), generation: 0 };
    await destination.completeInventory(authorization(route), evidence, states, evidence.nonce);
  }

  return { route, auth: authorization(route) };
}

function authorization(route: SyncRoute): RouteAuthorization {
  return { routeId: route.id, revision: route.revision, peerId: route.peerId, sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId };
}

async function stateFor(store: ManagedSyncStore, documentId: string): Promise<OriginState> {
  const ledger = await store.snapshot();
  const record = ledger.records[canonicalKey(ledger.inboxId, documentId)];
  assert.ok(record);
  return parseOriginState({ originInboxId: record.originInboxId, originDocumentId: record.originDocumentId, historyEpoch: record.historyEpoch, version: record.version,
    state: record.state, metadata: record.metadata, sha256: record.sha256, byteLength: record.byteLength, metadataSha256: record.metadataSha256, signature: record.signature });
}

function completion(route: SyncRoute, states: OriginState[], nonce = "fresh_nonce"): CompleteInventory {
  return { protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: route.peerId, routeId: route.id, revision: route.revision,
    scope: route.allowedOrigins.map((grant) => ({ inboxId: grant.inboxId, historyEpoch: grant.historyEpoch })), generation: 20, count: states.length, descriptorDigest: inventoryDigest(states), nonce };
}

test("enrollment evacuates before enumeration, preserves legacy case and exact original bytes, and blocks prepared old writers", async (t) => {
  const home = await temporaryHome(t);
  const first = new LocalDocumentBackend(home, () => {}, () => "Case_ID");
  const firstMetadata = await first.publish(input);
  const firstEntry = await lstat(path.join(home, "documents", "Case_ID"));
  const caseAlias = await lstat(path.join(home, "documents", "case_ID")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;

    throw error;
  });
  if (caseAlias) {
    assert.equal(caseAlias.dev, firstEntry.dev);
    assert.equal(caseAlias.ino, firstEntry.ino);
  }

  // Legacy directory names can alias by case; managed canonical identities must remain distinct.
  const secondId = caseAlias ? "Other_ID" : "case_ID";
  const second = new LocalDocumentBackend(home, () => {}, () => secondId);
  await second.publish(input);
  const oldStaging = path.join(home, "documents", ".staging", "late");
  await mkdir(oldStaging);
  await writeFile(path.join(oldStaging, "index.html"), input.originalBytes);
  const store = new ManagedSyncStore(home, { testHooks: { async onEvent(event) {
    if (event === "migration-enumeration") {
      assert.equal((await lstat(path.join(home, "documents"))).isFile(), true);
      assert.equal(await readFile(path.join(home, "documents"), "utf8"), MANAGED_FORMAT_BARRIER);
    }
  } } });
  await store.enroll();
  await assert.rejects(rename(oldStaging, path.join(home, "documents", "late")), /ENOTDIR|ENOENT/);
  const ledger = await store.snapshot();
  assert.equal(Object.keys(ledger.records).length, 2);
  assert.equal(store.counters.hashPasses, 2);
  assert.deepEqual(ledger.records[canonicalKey(ledger.inboxId, "Case_ID")].metadata, firstMetadata);
  assert.equal(ledger.records[canonicalKey(ledger.inboxId, "Case_ID")].sha256, sha256(input.originalBytes));
  assert.deepEqual((await first.getDocument("Case_ID"))?.originalBytes, input.originalBytes);
  assert.deepEqual((await inspectInboxHome(home)).instanceId, ledger.inboxId);
  await store.enroll();
  assert.equal(Object.keys((await store.snapshot()).records).length, 2);
});

test("managed canonical identities preserve case-only document IDs on every supported filesystem", async (t) => {
  const { store } = await enrolled(t);
  const secondBytes = Buffer.from("<!doctype html><html><body>different case identity</body></html>");
  const first = await store.publish(input, "Case_ID");
  const second = await store.publish({ ...input, originalBytes: secondBytes }, "case_ID");
  const ledger = await store.snapshot();

  assert.equal(Object.keys(ledger.records).length, 2);
  assert.notEqual(canonicalKey(ledger.inboxId, "Case_ID"), canonicalKey(ledger.inboxId, "case_ID"));
  assert.equal(ledger.records[canonicalKey(ledger.inboxId, "Case_ID")].sha256, sha256(input.originalBytes));
  assert.equal(ledger.records[canonicalKey(ledger.inboxId, "case_ID")].sha256, sha256(secondBytes));
  assert.deepEqual((await store.getDocument(first.id))?.originalBytes, input.originalBytes);
  assert.deepEqual((await store.getDocument(second.id))?.originalBytes, secondBytes);
});

test("managed publication owns caller bytes before its first await and queues creation/deletion atomically", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const link = await routeBetween(a.store, b.store);
  await configureReadyOutbound(a.store, { ...link.route, direction: "outbound" });
  const mutable = Buffer.from(input.originalBytes);
  const publication = a.store.publish({ ...input, originalBytes: mutable }, "owned");
  mutable.fill(120);
  const metadata = await publication;
  assert.deepEqual((await a.store.getDocument(metadata.id))?.originalBytes, input.originalBytes);
  let ledger = await a.store.snapshot();
  const key = canonicalKey(ledger.inboxId, "owned");
  assert.equal(ledger.records[key].sha256, sha256(input.originalBytes));
  assert.equal(ledger.outbox[outboxKey(link.route.id, 1, key)].fingerprint, stateFingerprint(ledger.records[key]));
  assert.equal(a.store.counters.hashPasses, 1);
  const deletion = await a.store.deleteDocument(metadata.id);
  assert.equal(deletion?.reclaimedBytes, 0);
  ledger = await a.store.snapshot();
  assert.equal(ledger.records[key].state, "deleted");
  assert.equal(ledger.outbox[outboxKey(link.route.id, 1, key)].fingerprint, stateFingerprint(ledger.records[key]));
  assert.ok(ledger.records[key].bodyFile);
  await assert.rejects(a.store.publish(input, "owned"), /identity already exists/);
});

test("strict descriptors bind exact metadata, epoch, byte length and domain-separated Ed25519 state", async (t) => {
  const a = await enrolled(t);
  await a.store.publish(input, "Report");
  const state = await stateFor(a.store, "Report");
  const ledger = await a.store.snapshot();
  verifyOriginState(state, ledger.originKeys[0].publicKey);
  assert.equal(metadataEncoding(state.metadata), JSON.stringify([1, "Report", input.title, input.type, state.metadata.createdAt, input.sourceFileName]));
  assert.ok(stateEncoding(state).toString().startsWith('["html-inbox/sync/v1/origin-state",1,'));
  assert.throws(() => parseOriginState({ ...state, metadata: { ...state.metadata, extra: true } }), /fields/);
  assert.throws(() => parseOriginState({ ...state, metadata: { ...state.metadata, title: "changed" } }), /fingerprint/);
  assert.throws(() => verifyOriginState({ ...state, version: state.version + 1 }, ledger.originKeys[0].publicKey), /signature/);
  assert.throws(() => parseOriginState({ ...state, bodyFile: "../../secret" }), /fields/);
  assert.throws(() => parseOriginState({ ...state, byteLength: SYNC_LIMITS.htmlBytes + 1 }), /integer/);
  const reversedMetadata = { sourceFileName: state.metadata.sourceFileName, createdAt: state.metadata.createdAt, type: state.metadata.type, title: state.metadata.title, id: state.metadata.id, schemaVersion: 1 };
  assert.deepEqual(parseOriginState({ ...state, metadata: reversedMetadata }), state);
});

test("same bare ID and hash from three origins stay distinct; duplicate memberships share one row", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const c = await enrolled(t);
  await a.store.publish(input, "same");
  await b.store.publish(input, "same");
  await c.store.publish(input, "same");
  const ab = await routeBetween(a.store, b.store);
  const ab2 = await routeBetween(a.store, b.store);
  const cb = await routeBetween(c.store, b.store);
  const state = await stateFor(a.store, "same");
  const first = await b.store.apply(ab.auth, state, input.originalBytes);
  assert.equal(first.status, "committed");
  await b.store.apply(ab2.auth, state);
  await b.store.apply(cb.auth, await stateFor(c.store, "same"), input.originalBytes);
  const documents = await b.store.listDocuments();
  assert.equal(documents.length, 3);
  assert.equal(new Set(documents.map((metadata) => metadata.id)).size, 3);
  const imported = documents.find((metadata) => metadata.origin?.inboxId === state.originInboxId);
  assert.ok(imported?.origin);
  assert.equal(imported.origin.originalMetadata.id, "same");
  assert.notEqual(imported.id, "same");
  assert.deepEqual(parseDocumentMetadata(imported), imported);
  assert.equal((await b.store.snapshot()).records[canonicalKey(state.originInboxId, "same")].contributions.length, 2);
  await b.store.revokeRoute(ab.route.id, 1);
  assert.equal((await b.store.getDocumentMetadata(imported.id))?.origin?.detached, false);
  await b.store.revokeRoute(ab2.route.id, 1);
  assert.equal((await b.store.getDocumentMetadata(imported.id))?.origin?.detached, true);
});

test("five unchanged scans after restart open/hash/transfer zero HTML bytes; missing body never becomes a tombstone or loses historical receipt", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "noop");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "noop");
  await b.store.apply(ab.auth, state, input.originalBytes);
  const reader = new ManagedSyncStore(b.home);
  await reader.recover();
  for (let scan = 0; scan < 5; scan += 1) {
    await reader.listDocuments();
    const result = await reader.apply(ab.auth, state);
    assert.equal(result.status, "committed");
    assert.equal((await reader.holdings(ab.auth, [{ originInboxId: state.originInboxId, originDocumentId: "noop" }]))[0].available, true);
  }

  assert.equal(reader.counters.htmlOpens, 0);
  assert.equal(reader.counters.htmlBytes, 0);
  assert.equal(reader.counters.hashPasses, 0);
  assert.equal(reader.counters.bodyTransfers, 0);
  const ledger = await reader.snapshot();
  const filename = ledger.records[canonicalKey(state.originInboxId, "noop")].bodyFile;
  assert.ok(filename);
  await rm(path.join(b.home, "sync", "bodies", filename));
  const holding = (await reader.holdings(ab.auth, [{ originInboxId: state.originInboxId, originDocumentId: "noop" }]))[0];
  assert.equal(holding.available, false);
  assert.equal(holding.receipts.length, 1);
  assert.equal(holding.state?.state, "live");
  assert.equal((await reader.apply(ab.auth, state)).status, "needs-body");
  assert.equal((await reader.apply(ab.auth, state, input.originalBytes)).status, "committed");
});

test("suppression survives retries, detachment and authoritative deletion dominates every stale live contribution", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "hidden");
  const ab = await routeBetween(a.store, b.store);
  const second = await routeBetween(a.store, b.store);
  const live = await stateFor(a.store, "hidden");
  await b.store.apply(ab.auth, live, input.originalBytes);
  await b.store.apply(second.auth, live);
  const localId = (await b.store.listDocuments())[0].id;
  assert.equal((await b.store.deleteDocument(localId))?.reclaimedBytes, 0);
  assert.equal((await b.store.apply(ab.auth, live)).status, "suppressed");
  assert.equal((await b.store.listDocuments()).length, 0);
  await b.store.revokeRoute(ab.route.id, 1);
  await a.store.deleteDocument("hidden");
  const tombstone = await stateFor(a.store, "hidden");
  assert.equal((await b.store.apply(second.auth, tombstone)).status, "deleted");
  assert.equal((await b.store.apply(second.auth, live, input.originalBytes)).status, "superseded");
  await b.store.setSuppressed(localId, false);
  assert.equal((await b.store.listDocuments()).length, 0);
  assert.equal((await b.store.snapshot()).records[canonicalKey(live.originInboxId, "hidden")].state, "deleted");
});

test("route revision revocation during private staging fences the final body/ledger commit", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "late");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "late");
  const receiver = new ManagedSyncStore(b.home, { testHooks: { async onEvent(event) {
    if (event === "body-flushed") {
      await b.store.revokeRoute(ab.route.id, 1);
    }
  } } });
  await assert.rejects(receiver.apply(ab.auth, state, input.originalBytes), /Revoked|stale/);
  assert.equal(Object.keys((await b.store.snapshot()).records).length, 0);
  assert.equal((await readdir(path.join(b.home, "sync", "bodies"))).length, 0);
});

test("fresh outbound revisions expose terminal inventory while reconnecting; inbound activation applies tombstones first", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "deleted_offline");
  await a.store.publish(input, "retained");
  const ab = await routeBetween(a.store, b.store);
  await configureReadyOutbound(a.store, { ...ab.route, direction: "outbound" });
  const stale = await stateFor(a.store, "deleted_offline");
  await b.store.apply(ab.auth, stale, input.originalBytes);
  await b.store.apply(ab.auth, await stateFor(a.store, "retained"), input.originalBytes);
  await a.store.revokeRoute(ab.route.id, 1);
  await b.store.revokeRoute(ab.route.id, 1);
  await a.store.deleteDocument("deleted_offline");
  const outbound = await a.store.configureRoute({ ...ab.route, direction: "outbound", revision: 3 });
  const inbound = await b.store.configureRoute({ ...ab.route, revision: 3 });
  assert.equal(outbound.state, "reconnecting");
  assert.equal(inbound.state, "reconnecting");
  const cut = await a.store.inventory(authorization(outbound));
  assert.equal(cut.states.length, 2);
  assert.equal(cut.states.find((state) => state.originDocumentId === "deleted_offline")?.state, "deleted");
  await assert.rejects(a.store.pinOutgoing(authorization(outbound), stale.originInboxId, "retained"), /scope/);
  await assert.rejects(b.store.apply(authorization(inbound), stale), /terminal inventory/);
  const evidence = { ...completion(inbound, cut.states), generation: cut.generation };
  await assert.rejects(b.store.completeInventory(authorization(inbound), { ...evidence, count: 1 }, cut.states, evidence.nonce), /Incomplete/);
  await b.store.completeInventory(authorization(inbound), evidence, cut.states, evidence.nonce);
  const visible = await b.store.listDocuments();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].origin?.documentId, "retained");
  assert.equal(visible[0].origin?.detached, false);
  assert.equal((await b.store.apply(authorization(inbound), stale)).status, "superseded");
});

test("relay signature trust and complete-history delegation are separate", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const c = await enrolled(t);
  await a.store.publish(input, "relay");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "relay");
  await b.store.apply(ab.auth, state, input.originalBytes);
  const bc = await routeBetween(b.store, c.store, { allowedOrigins: [{ ...(await a.store.snapshot()).originKeys[0], redistribute: true, completeHistory: false }] });
  await assert.rejects(c.store.apply(bc.auth, state, input.originalBytes), /terminal inventory/);
  await assert.rejects(c.store.completeInventory(bc.auth, completion(bc.route, [state]), [state], "fresh_nonce"), /delegation/);
  const forgedPair = generateKeyPairSync("ed25519");
  const forged = signOriginState({ ...state, state: "deleted", version: state.version + 1 }, forgedPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  await assert.rejects(c.store.apply(bc.auth, forged), /signature/);
});

test("stream installation verifies actual bounded chunks and retries never reread body", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "stream");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "stream");
  async function* chunks(bytes: Buffer) { yield bytes.subarray(0, 9); yield bytes.subarray(9); }
  const corrupt = Buffer.from(input.originalBytes);
  corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(b.store.applyStream(ab.auth, state, chunks(corrupt)), /digest/);
  assert.equal(Object.keys((await b.store.snapshot()).records).length, 0);
  assert.equal((await b.store.applyStream(ab.auth, state, chunks(input.originalBytes))).status, "committed");
  assert.equal(b.store.counters.hashPasses, 2);
  assert.equal(b.store.counters.bodyTransfers, 2);
  assert.equal(b.store.counters.htmlOpens, 0);
});

test("historical receipt persistence precedes sender retirement and repair recreates confirmed obligation", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "ack");
  const ab = await routeBetween(a.store, b.store);
  await configureReadyOutbound(a.store, { ...ab.route, direction: "outbound" });
  const state = await stateFor(a.store, "ack");
  const received = await b.store.apply(ab.auth, state, input.originalBytes);
  assert.notEqual(received.status, "needs-body");
  if (received.status === "needs-body") return;
  const fault = createOneShotStorageFault("receipt-before-retirement");
  const sender = new ManagedSyncStore(a.home, { testHooks: fault.hooks });
  await assert.rejects(sender.acknowledge(ab.auth, received.receipt), /Injected/);
  const key = canonicalKey(state.originInboxId, "ack");
  let ledger = await a.store.snapshot();
  assert.equal(Object.values(ledger.receipts).length, 1);
  assert.equal(ledger.outbox[outboxKey(ab.route.id, 1, key)].disposition, "pending");
  await sender.acknowledge(ab.auth, received.receipt);
  ledger = await a.store.snapshot();
  assert.equal(ledger.outbox[outboxKey(ab.route.id, 1, key)].disposition, "confirmed");
  await sender.reconcileHoldings(ab.auth, [{ originInboxId: state.originInboxId, originDocumentId: "ack", fingerprint: stateFingerprint(state), available: false, storageIncarnation: received.receipt.storageIncarnation }]);
  assert.equal((await sender.snapshot()).outbox[outboxKey(ab.route.id, 1, key)].disposition, "pending");
  assert.deepEqual(fault.proof(), { event: "receipt-before-retirement", armed: false, hits: 1 });
});

for (const event of ["migration-intent", "migration-evacuated", "migration-barrier"] satisfies StorageEvent[]) {
  test(`migration fault at ${event} recovers repeatedly without enumerating a writable old path`, async (t) => {
    const home = await temporaryHome(t);
    await new LocalDocumentBackend(home, () => {}, () => "legacy").publish(input);
    const fault = createOneShotStorageFault(event);
    const store = new ManagedSyncStore(home, { testHooks: fault.hooks });
    await assert.rejects(store.enroll(), /Injected/);
    assert.equal(fault.proof().hits, 1);
    const recovered = new ManagedSyncStore(home);
    await recovered.recover();
    await recovered.recover();
    assert.equal((await recovered.listDocuments()).length, 1);
    assert.deepEqual((await recovered.getDocument("legacy"))?.originalBytes, input.originalBytes);
    assert.equal((await lstat(path.join(home, "documents"))).isFile(), true);
  });
}

for (const event of ["body-staged", "body-flushed", "body-installed", "body-directory-flushed", "ledger-temp-written", "ledger-temp-fsynced", "ledger-renamed", "ledger-dir-fsynced"] satisfies StorageEvent[]) {
  test(`publication fault at ${event} exposes only a complete durable ledger cut and retains final bodies`, async (t) => {
    const { home } = await enrolled(t);
    const fault = createOneShotStorageFault(event);
    const store = new ManagedSyncStore(home, { testHooks: fault.hooks });
    await assert.rejects(store.publish(input, "crash"), /Injected/);
    assert.equal(fault.proof().hits, 1);
    if (["body-installed", "body-directory-flushed", "ledger-renamed", "ledger-dir-fsynced"].includes(event)) {
      await assert.rejects(store.publish(input, "must_recover"), /recovery/);
      await assert.rejects(new ManagedSyncStore(home).publish(input, "cannot_bypass_with_new_instance"), /recovery/);
    }

    const recovered = new ManagedSyncStore(home);
    await recovered.recover();
    const documents = await recovered.listDocuments();
    assert.equal(documents.length, event === "ledger-renamed" || event === "ledger-dir-fsynced" ? 1 : 0);
    if (documents.length) {
      assert.deepEqual((await recovered.getDocument(documents[0].id))?.originalBytes, input.originalBytes);
    }

    await recovered.publish(input, "after_recovery");
    assert.ok((await recovered.getDocument("after_recovery"))?.originalBytes);
  });
}

test("post-commit receipt loss returns no success and a retry recovers the exact receipt", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "lost_receipt");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "lost_receipt");
  const fault = createOneShotStorageFault("committed-before-receipt");
  const receiver = new ManagedSyncStore(b.home, { testHooks: fault.hooks });
  await assert.rejects(receiver.apply(ab.auth, state, input.originalBytes), /Injected/);
  assert.equal((await b.store.listDocuments()).length, 1);
  const prior = Object.values((await b.store.snapshot()).receipts)[0];
  const retry = await receiver.apply(ab.auth, state);
  assert.notEqual(retry.status, "needs-body");
  if (retry.status !== "needs-body") assert.deepEqual(retry.receipt, prior);
});

test("unknown/corrupt legacy candidates block enrollment rather than disappearing from inventory", async (t) => {
  const home = await temporaryHome(t);
  await new LocalDocumentBackend(home, () => {}, () => "good").publish(input);
  await mkdir(path.join(home, "documents", "corrupt"));
  const store = new ManagedSyncStore(home);
  await assert.rejects(store.enroll(), /ENOENT/);
  assert.equal((await lstat(path.join(home, "documents"))).isFile(), true);
  await assert.rejects(store.snapshot(), /incomplete/);
  await assert.rejects(new LocalDocumentBackend(home).publish(input), /ENOENT/);
});

test("copy/move anchor mismatches fail closed; restore quarantines owner and communication, fresh fork retains detached origin identity", async (t) => {
  const a = await enrolled(t);
  await a.store.publish(input, "inherited");
  const original = await a.store.snapshot();
  const copyHome = path.join(path.dirname(a.home), "copy");
  await cp(a.home, copyHome, { recursive: true });
  const copied = new ManagedSyncStore(copyHome);
  await assert.rejects(copied.listDocuments(), /Copied or moved/);
  await assert.rejects(copied.publish(input), /Copied or moved/);
  await copied.quarantineRestore();
  let ledger = await copied.snapshot();
  assert.notEqual(ledger.storageIncarnation, original.storageIncarnation);
  assert.equal(ledger.worker.ownerQuarantined, true);
  await assert.rejects(copied.publish(input), /quarantine/);
  assert.equal(Object.keys(ledger.receipts).length, 0);
  const fork = await copied.fork();
  assert.notEqual(fork.inboxId, original.inboxId);
  const inherited = (await copied.listDocuments())[0];
  assert.equal(inherited.origin?.inboxId, original.inboxId);
  assert.equal(inherited.origin?.detached, true);
  await assert.rejects(stat(path.join(copyHome, "sync", `owner-${original.inboxId}.pem`)), /ENOENT/);
  await copied.publish(input, "future");
  ledger = await copied.snapshot();
  assert.equal(ledger.records[canonicalKey(fork.inboxId, "future")].originInboxId, fork.inboxId);
  assert.equal((await a.store.snapshot()).inboxId, original.inboxId);
});

test("managed source remains read-only, obeys its selected byte bound, and exports exclude imported members", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "imported");
  await b.store.publish(input, "native");
  const ab = await routeBetween(a.store, b.store);
  await b.store.apply(ab.auth, await stateFor(a.store, "imported"), input.originalBytes);
  const ledger = await b.store.snapshot();
  const paths = [path.join(b.home, "sync"), path.join(b.home, "sync", "ledger.json"), path.join(b.home, "documents")];
  const before = await Promise.all(paths.map((file) => stat(file)));
  const source = new LocalDocumentSource({ home: b.home, instanceId: ledger.inboxId });
  const documents = await source.listDocuments();
  assert.equal(documents.length, 2);
  assert.match(formatDocumentTable(documents), /\[origin /);
  for (const metadata of documents) assert.ok(await source.getDocument(metadata.id));
  const limited = new LocalDocumentSource({ home: b.home, instanceId: ledger.inboxId }, 10);
  await assert.rejects(limited.listDocuments(), /byte limit/);
  await assert.rejects(limited.getDocumentMetadata(documents[0].id), /byte limit/);
  await assert.rejects(limited.getDocument(documents[0].id), /byte limit/);
  const after = await Promise.all(paths.map((file) => stat(file)));
  assert.deepEqual(after.map((info) => [info.mode, info.mtimeMs, info.ctimeMs]), before.map((info) => [info.mode, info.mtimeMs, info.ctimeMs]));
  const outputDir = path.join(path.dirname(b.home), "snapshot");
  const snapshot = await exportStaticSnapshot(source, { outputDir });
  assert.equal(snapshot.manifest.documentCount, 1);
  const imported = documents.find((metadata) => metadata.origin);
  assert.ok(imported);
  assert.match(renderIndex(documents, "imported"), /inbox-badge/);
  assert.match(renderDocumentShell(imported), /Origin/);
  assert.equal(parseDocumentMetadata(imported).origin?.documentId, "imported");
});

test("managed preparation hardens a permissive precreated directory and explicit audit quarantines same-length drift", async (t) => {
  const home = await temporaryHome(t);
  await mkdir(path.join(home, "sync"), { recursive: true, mode: 0o755 });
  await chmod(path.join(home, "sync"), 0o755);
  const store = new ManagedSyncStore(home);
  await store.enroll();
  assert.equal((await stat(path.join(home, "sync"))).mode & 0o077, 0);
  await store.publish(input, "drift");
  const ledger = await store.snapshot();
  const record = ledger.records[canonicalKey(ledger.inboxId, "drift")];
  assert.ok(record.bodyFile);
  const bytes = Buffer.from(input.originalBytes);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(path.join(home, "sync", "bodies", record.bodyFile), bytes);
  const audit = await store.audit();
  assert.deepEqual(audit.conflicts, [canonicalKey(ledger.inboxId, "drift")]);
  assert.equal((await store.snapshot()).records[canonicalKey(ledger.inboxId, "drift")].sha256, record.sha256);
  await assert.rejects(store.publish(input, "blocked"), /quarantine/);
});

test("malformed routes reject plaintext, URL credentials, arbitrary paths, duplicate scope and target replacement", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const { route } = await routeBetween(a.store, b.store);
  assert.throws(() => parseRoute({}), /fields/);
  for (const peerUrl of ["http://peer.test/", "https://user:password@peer.test/", "https://peer.test/inbound-path", "https://peer.test/?path=secret", "https://peer.test/#fragment"]) {
    assert.throws(() => parseRoute({ ...route, peerUrl }), /HTTPS origin/);
  }

  assert.throws(() => parseRoute({ ...route, inboundPath: "/arbitrary/path" }), /fields/);
  assert.throws(() => parseRoute({ ...route, allowedOrigins: [...route.allowedOrigins, ...route.allowedOrigins] }), /Duplicate/);
  await assert.rejects(b.store.configureRoute({ ...route, id: randomUUID(), destinationInboxId: randomUUID() }), /different local inbox/);
  assert.notEqual(canonicalKey(route.sourceInboxId, "Case"), canonicalKey(route.sourceInboxId, "case"));
  assert.throws(() => parseDocumentMetadata({ schemaVersion: 1, id: "safe", title: "x", type: "x", createdAt: new Date().toISOString(), sourceFileName: "x", origin: { inboxId: "fake" } }), /origin/);
});

test("legacy unknown metadata is never silently projected into a signed managed descriptor", async (t) => {
  const home = await temporaryHome(t);
  const metadata = await new LocalDocumentBackend(home, () => {}, () => "extras").publish(input);
  await writeFile(path.join(home, "documents", "extras", "metadata.json"), JSON.stringify({ ...metadata, arbitraryOrigin: "must not disappear" }));
  assert.deepEqual(await new LocalDocumentBackend(home).getDocumentMetadata("extras"), metadata);
  const store = new ManagedSyncStore(home);
  await assert.rejects(store.enroll(), /unsupported fields/);
  assert.equal((await lstat(path.join(home, "documents"))).isFile(), true);
  await assert.rejects(store.snapshot(), /incomplete/);
});

test("a valid owner signature cannot overwrite immutable metadata/body or conflict at the same state version", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "immutable");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "immutable");
  await b.store.apply(ab.auth, state, input.originalBytes);
  const privateKey = await readFile(path.join(a.home, "sync", `owner-${state.originInboxId}.pem`), "utf8");
  const changedMetadata = { ...state.metadata, title: "conflicting title" };
  const changed = signOriginState({ ...state, metadata: changedMetadata, metadataSha256: sha256(metadataEncoding(changedMetadata)) }, privateKey);
  await assert.rejects(b.store.apply(ab.auth, changed), /Immutable/);
  const conflictingState = signOriginState({ ...state, state: "deleted" }, privateKey);
  await assert.rejects(b.store.apply(ab.auth, conflictingState), /same version/);
  const tombstone = signOriginState({ ...state, state: "deleted", version: state.version + 1 }, privateKey);
  await b.store.apply(ab.auth, tombstone);
  const invalidResurrection = signOriginState({ ...state, version: state.version + 2 }, privateKey);
  assert.equal((await b.store.apply(ab.auth, invalidResurrection)).status, "superseded");
  assert.equal((await b.store.listDocuments()).length, 0);
});

test("independent local store instances serialize concurrent publications without losing obligations", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const ab = await routeBetween(a.store, b.store);
  await configureReadyOutbound(a.store, { ...ab.route, direction: "outbound" });
  await Promise.all(Array.from({ length: 12 }, (_, index) => new ManagedSyncStore(a.home).publish(input, `concurrent_${index}`)));
  const ledger = await a.store.snapshot();
  assert.equal(Object.keys(ledger.records).length, 12);
  assert.equal(Object.keys(ledger.outbox).length, 12);
  assert.equal(new Set(Object.values(ledger.records).map((record) => record.version)).size, 12);
});

test("enrollment beneath a canonical root-owned parent supports directory fsync without requiring parent ownership", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-storage-direct-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ManagedSyncStore(home);
  await store.enroll();
  await store.publish(input, "direct");
  assert.equal((await store.listDocuments()).length, 1);
  assert.ok((store.counters.events["directory-flushed"] ?? 0) > 0);
});

test("a repaired receiver incarnation rejects a previously valid historical receipt", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "incarnation");
  const ab = await routeBetween(a.store, b.store);
  await configureReadyOutbound(a.store, { ...ab.route, direction: "outbound" });
  const state = await stateFor(a.store, "incarnation");
  const result = await b.store.apply(ab.auth, state, input.originalBytes);
  assert.notEqual(result.status, "needs-body");
  if (result.status === "needs-body") return;
  await a.store.acknowledge(ab.auth, result.receipt);
  await a.store.reconcileHoldings(ab.auth, [{ originInboxId: state.originInboxId, originDocumentId: state.originDocumentId,
    fingerprint: stateFingerprint(state), available: false, storageIncarnation: randomUUID() }]);
  await assert.rejects(a.store.acknowledge(ab.auth, result.receipt), /replaced receiver/);
});

test("unexpected reader identity replacement is never silently repaired or followed by a mutation", async (t) => {
  const a = await enrolled(t);
  await a.store.publish(input, "before_replacement");
  const replacement = randomUUID();
  await writeFile(path.join(a.home, "instance-id"), replacement);
  await assert.rejects(a.store.listDocuments(), /Reader identity/);
  await assert.rejects(a.store.publish(input, "after_replacement"), /Reader identity/);
  await assert.rejects(new ManagedSyncStore(a.home).recover(), /Reader identity/);
  assert.equal(await readFile(path.join(a.home, "instance-id"), "utf8"), replacement);
});

test("onward intent is atomic with relay installation and stays blocked until complete history, then receipts terminate repeats", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const c = await enrolled(t);
  await a.store.publish(input, "onward");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "onward");
  const bc = await routeBetween(b.store, c.store, { allowedOrigins: [{ ...(await a.store.snapshot()).originKeys[0], redistribute: true, completeHistory: true }] });
  await configureReadyOutbound(b.store, { ...bc.route, direction: "outbound" }, false);
  await b.store.apply(ab.auth, state, input.originalBytes);
  const key = outboxKey(bc.route.id, 1, canonicalKey(state.originInboxId, state.originDocumentId));
  assert.equal((await b.store.snapshot()).outbox[key].disposition, "blocked");
  await b.store.retry(bc.auth);
  assert.equal((await b.store.snapshot()).outbox[key].disposition, "blocked");
  await b.store.completeInventory(ab.auth, completion(ab.route, [state]), [state], "fresh_nonce");
  await activateOutbound(b.store, { ...bc.route, direction: "outbound" });
  assert.equal((await b.store.snapshot()).outbox[key].disposition, "pending");
  const bytes = (await b.store.pinOutgoing(bc.auth, state.originInboxId, state.originDocumentId))?.originalBytes;
  assert.ok(bytes);
  const result = await c.store.apply(bc.auth, state, bytes);
  assert.notEqual(result.status, "needs-body");
  if (result.status === "needs-body") return;
  await b.store.acknowledge(bc.auth, result.receipt);
  await b.store.apply(ab.auth, state);
  assert.equal((await b.store.snapshot()).outbox[key].disposition, "confirmed");
  assert.equal((await c.store.listDocuments()).length, 1);
});

test("a relay cannot attest an empty origin scope without a trusted complete-history checkpoint", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  const c = await enrolled(t);
  const bc = await routeBetween(b.store, c.store, { allowedOrigins: [{ ...(await a.store.snapshot()).originKeys[0], redistribute: true, completeHistory: true }] });
  await configureReadyOutbound(b.store, { ...bc.route, direction: "outbound" }, false);
  await assert.rejects(b.store.inventory(bc.auth), /trusted origin history/);
  const ab = await routeBetween(a.store, b.store);
  await b.store.completeInventory(ab.auth, completion(ab.route, []), [], "fresh_nonce");
  assert.deepEqual((await b.store.inventory(bc.auth)).states, []);
});

test("older terminal offers never roll a stored terminal version backward", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "terminal_order");
  const ab = await routeBetween(a.store, b.store);
  const state = await stateFor(a.store, "terminal_order");
  const privateKey = await readFile(path.join(a.home, "sync", `owner-${state.originInboxId}.pem`), "utf8");
  const newer = signOriginState({ ...state, state: "deleted", version: 4 }, privateKey);
  const older = signOriginState({ ...state, state: "deleted", version: 3 }, privateKey);
  await b.store.apply(ab.auth, newer);
  assert.equal((await b.store.apply(ab.auth, older)).status, "superseded");
  assert.equal((await b.store.snapshot()).records[canonicalKey(state.originInboxId, state.originDocumentId)].version, 4);
});

test("the ledger reserves terminal space at its metadata quota so owner deletion remains possible", async (t) => {
  const a = await enrolled(t);
  const b = await enrolled(t);
  await a.store.publish(input, "at_quota");
  const ab = await routeBetween(a.store, b.store);
  await configureReadyOutbound(a.store, { ...ab.route, direction: "outbound" });
  await a.store.revokeRoute(ab.route.id, 1);
  const ledger = await a.store.snapshot();
  const route = ledger.routes[ab.route.id];
  route.revision = 40_000;
  ledger.generation = 100;
  ledger.outbox = {};
  const key = canonicalKey(ledger.inboxId, "at_quota");
  const fingerprint = stateFingerprint(ledger.records[key]);
  const targetBytes = SYNC_LIMITS.ledgerBytes - 128;
  let serializedBytes = Buffer.byteLength(JSON.stringify(ledger));
  let entries = 0;
  let previousKey = "";
  for (let revision = 1; revision < route.revision; revision += 1) {
    const entryKey = outboxKey(route.id, revision, key);
    const entry: import("./sync-ledger").OutboxEntry = { routeId: route.id, revision, canonicalKey: key, fingerprint, receiverStorageIncarnation: null, attempts: 0, nextAttemptAt: 0,
      lastError: "x".repeat(2048), disposition: "retired" };
    const overhead = Buffer.byteLength(JSON.stringify(entryKey)) + 1 + Buffer.byteLength(JSON.stringify({ ...entry, lastError: "" })) + (entries ? 1 : 0);
    let remaining = targetBytes - serializedBytes;
    if (remaining < overhead + 1) {
      const previous = ledger.outbox[previousKey];
      assert.ok(previous?.lastError);
      previous.lastError = previous.lastError.slice(0, -512);
      serializedBytes -= 512;
      remaining += 512;
    }

    const errorBytes = Math.min(2048, remaining - overhead);
    entry.lastError = "x".repeat(errorBytes);
    ledger.outbox[entryKey] = entry;
    serializedBytes += overhead + errorBytes;
    entries += 1;
    previousKey = entryKey;
    if (serializedBytes === targetBytes) break;
  }

  assert.equal(Buffer.byteLength(JSON.stringify(ledger)), targetBytes);
  await writeFile(path.join(a.home, "sync", "ledger.json"), JSON.stringify(ledger));
  await a.store.recover();
  await assert.rejects(a.store.setWorkerState({ ...ledger.worker, lastError: "x".repeat(100) }), /reserved terminal-state space/);
  assert.equal((await a.store.deleteDocument("at_quota"))?.reclaimedBytes, 0);
  assert.equal((await a.store.snapshot()).records[key].state, "deleted");
});

async function configureReadyOutbound(store: ManagedSyncStore, route: SyncRoute, activate = true) {
  const configured = await store.configureRoute(route);
  if (activate) await activateOutbound(store, configured);
  return configured;
}

async function activateOutbound(store: ManagedSyncStore, route: SyncRoute) {
  const cut = await store.inventory(authorization(route));
  const evidence = { ...completion(route, cut.states), generation: cut.generation };
  await store.activateOutbound(authorization(route), { kind: "terminal-inventory-ready", evidence, ackNonce: "local_pending_nonce",
    receiverPeerId: route.peerId, destinationInboxId: route.destinationInboxId, storageIncarnation: randomUUID() }, evidence, "local_pending_nonce", route.peerId);
}
