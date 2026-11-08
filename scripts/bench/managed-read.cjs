// Companion for run.py. This process owns no subprocess, listener or worker.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const CAPABILITY = 'AAAAAAAAAAAAAAAAAAAAAA';
const OWNER = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-11-07T00:00:00.000Z';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function body(id, kind, size) {
  const head = `<!doctype html><html><head><title>${kind} ${id}</title></head><body><h1>${kind} ${id}</h1><p>`;
  const tail = '</p></body></html>';
  assert(size >= Buffer.byteLength(head + tail));
  return Buffer.from(head + 'x'.repeat(size - Buffer.byteLength(head + tail)) + tail);
}

async function seedLegacy(home, count, size, kind, parseMetadata) {
  for (let index = 0; index < count; index += 1) {
    const id = `bench-${String(index).padStart(5, '0')}`;
    const directory = path.join(home, 'documents', id);
    const metadata = parseMetadata({ schemaVersion: 1, id, title: `${kind} ${id}`, type: 'report',
      createdAt: CREATED_AT, sourceFileName: `${kind}-${id}.html` });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'index.html'), body(id, kind, size), { mode: 0o600 });
  }
}

async function seed(dist, root, count, size, mixed) {
  const { parseDocumentMetadata } = require(path.join(dist, 'documents.js'));
  const { ManagedSyncStore, toOriginState } = require(path.join(dist, 'sync-store.js'));
  const { canonicalKey, inventoryDigest, MANIFEST_DOMAIN } = require(path.join(dist, 'sync-model.js'));
  const home = path.join(root, 'library');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await seedLegacy(home, count, size, 'owned', parseDocumentMetadata);
  const store = new ManagedSyncStore(home);
  // Enrollment performs the real migration, validation, signing and durable commits.
  await store.enroll();

  if (mixed) {
    assert.equal(count, 2);
    const donorHome = path.join(root, 'donor');
    await fs.mkdir(donorHome, { mode: 0o700 });
    await seedLegacy(donorHome, 2, size, 'foreign', parseDocumentMetadata);
    const donor = new ManagedSyncStore(donorHome);
    await donor.enroll();
    const origin = await donor.snapshot();
    const local = await store.snapshot();
    const grant = origin.originKeys.find((entry) => entry.inboxId === origin.inboxId);
    assert(grant);
    const route = { id: randomUUID(), revision: 1, direction: 'inbound', peerId: origin.inboxId,
      peerUrl: 'https://127.0.0.1:1/', sourceInboxId: origin.inboxId, destinationInboxId: local.inboxId,
      localInboxName: 'benchmark', readerAudience: 'synthetic managed reads', allowedOrigins: [grant],
      credentialRef: 'synthetic_token', tlsTrustRef: 'synthetic_ca', state: 'active', lastError: null };
    await store.configureRoute(route);
    const auth = { routeId: route.id, revision: 1, peerId: route.peerId,
      sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId };
    const states = Object.values(origin.records).map(toOriginState);
    const nonce = randomUUID();
    await store.completeInventory(auth, { protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: origin.inboxId,
      routeId: route.id, revision: 1, scope: [{ inboxId: origin.inboxId, historyEpoch: origin.historyEpoch }],
      generation: origin.generation, count: states.length, descriptorDigest: inventoryDigest(states), nonce }, states, nonce);
    for (const state of states) {
      const bytes = body(state.originDocumentId, 'foreign', size);
      assert.equal((await store.apply(auth, state, bytes)).status, 'committed');
    }
    const imported = (await store.listDocuments()).find((metadata) => metadata.origin?.documentId === 'bench-00001');
    assert(imported);
    await store.setSuppressed(imported.id, true);
    await store.deleteDocument('bench-00001');
    const mixedLedger = await store.snapshot();
    assert.equal(mixedLedger.records[canonicalKey(local.inboxId, 'bench-00001')].state, 'deleted');
    assert.equal(mixedLedger.records[canonicalKey(origin.inboxId, 'bench-00001')].suppressed, true);
    assert.equal(await store.getDocument(imported.id), null);
    assert.equal(await store.getDocument('bench-00001'), null);
  }

  const documents = [];
  for (const metadata of await store.listDocuments()) {
    const document = await store.getDocument(metadata.id);
    assert(document);
    const expected = body(metadata.origin?.documentId ?? metadata.id, metadata.origin ? 'foreign' : 'owned', size);
    assert.deepEqual(document.originalBytes, expected);
    documents.push({ metadata, bytes: expected.length, sha256: digest(expected) });
  }
  if (mixed) {
    assert.equal(documents.length, 2);
    assert.equal(documents.filter((entry) => entry.metadata.origin).length, 1);
  } else {
    assert.equal(documents.length, count);
  }
  const spec = { schemaVersion: 1, home, size, mixed, documents,
    ledgerSha256: digest(await fs.readFile(path.join(home, 'sync', 'ledger.json'))) };
  await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify(spec, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ seeded: true, ownedVisible: documents.filter((entry) => !entry.metadata.origin).length,
    visible: documents.length, legacyMetadataCreatedAt: CREATED_AT, ledgerSha256: spec.ledgerSha256 }));
}

async function completeBatch(source) {
  const consume = async (reader) => {
    const documents = [];
    for (const metadata of await reader.listDocuments()) {
      const document = await reader.getDocument(metadata.id);
      assert(document, `Batch document disappeared: ${metadata.id}`);
      assert.deepEqual(document.metadata, metadata);
      documents.push({ metadata: document.metadata, bytes: document.originalBytes.length, sha256: digest(document.originalBytes) });
    }
    return documents;
  };
  return source.withReadView ? source.withReadView(consume) : consume(source);
}

async function main() {
  const [mode, distValue, rootValue, value, sizeValue, mixedValue] = process.argv.slice(2);
  const dist = path.resolve(distValue);
  const root = path.resolve(rootValue);
  if (mode === 'seed') return seed(dist, root, Number(value), Number(sizeValue), mixedValue === 'mixed');

  const spec = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'));
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.home, path.join(root, 'library'));
  const { LocalDocumentBackend } = require(path.join(dist, 'backend.js'));
  const source = new LocalDocumentBackend(spec.home);
  const usesView = typeof source.withReadView === 'function';
  assert.equal(usesView, value === 'candidate', 'Candidate must use its real callback API; parent uses ordinary reads');

  if (mode === 'api-export') {
    const { exportStaticSnapshot } = require(path.join(dist, 'static-export.js'));
    const result = await exportStaticSnapshot(source, { outputDir: sizeValue, capability: CAPABILITY,
      ownerId: OWNER, generatedAt: CREATED_AT, appearance: 'system' });
    console.log(JSON.stringify(result));
    return;
  }
  assert.equal(mode, 'batch');
  const cpu = process.cpuUsage();
  const start = performance.now();
  const documents = await completeBatch(source);
  const wall = performance.now() - start;
  const used = process.cpuUsage(cpu);
  assert.deepEqual(documents, spec.documents);
  console.log(JSON.stringify({ label: 'managed-read/complete-batch', wall_ms: wall,
    cpu_ms: (used.user + used.system) / 1000, rss_bytes: process.memoryUsage().rss,
    usesView, documents, scope: 'complete serial list + all body reads + metadata equality + whole-body digests + view drain; module/input setup excluded' }));
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { body, completeBatch };
