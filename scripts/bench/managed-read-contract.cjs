// Run against independently built revisions before changing the managed read policy.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const platformTest = require('node:test');

const dist = path.resolve(process.env.HTML_INBOX_CONTRACT_DIST || path.join(__dirname, '../../packages/cli/dist'));
const { LocalDocumentBackend } = require(path.join(dist, 'backend.js'));
const { LocalDocumentSource } = require(path.join(dist, 'local-document-source.js'));
const { exportStaticSnapshot } = require(path.join(dist, 'static-export.js'));
const { ManagedSyncStore, toOriginState } = require(path.join(dist, 'sync-store.js'));
const { canonicalKey, inventoryDigest, MANIFEST_DOMAIN } = require(path.join(dist, 'sync-model.js'));

// Enrollment requires POSIX directory fsync. This probe does not qualify Windows.
const test = process.platform === 'win32' ? platformTest.skip : platformTest;
const options = {
  capability: 'AAAAAAAAAAAAAAAAAAAAAA',
  ownerId: '11111111-1111-4111-8111-111111111111',
  generatedAt: '2026-11-07T00:00:00.000Z',
};

function input(id) {
  return {
    originalBytes: Buffer.from(`<!doctype html><html><body>Contract ${id}</body></html>`),
    title: `Contract ${id}`, type: 'report', sourceFileName: `${id}.html`,
  };
}

async function fixture(t, sourceKind) {
  const root = await mkdtemp(path.join(tmpdir(), 'html-inbox-read-contract-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    t.diagnostic('synthetic fixture removed');
  });

  const home = path.join(root, 'library');
  const store = new ManagedSyncStore(home);
  await store.enroll();
  const metadata = await store.publish(input('original'), 'original');
  const ledger = await store.snapshot();
  const source = sourceKind === 'backend'
    ? new LocalDocumentBackend(home)
    : new LocalDocumentSource({ home, instanceId: ledger.inboxId });
  const outputDir = path.join(root, 'export');
  const before = await exportStaticSnapshot(source, { ...options, outputDir });

  return { root, home, store, metadata, ledger, source, outputDir, before };
}

function afterList(source, mutate) {
  let cuts = 0;

  return {
    async listDocuments() {
      const documents = await source.listDocuments();
      cuts += 1;
      assert.equal(cuts, 1, 'one actual list/body cut per complete export');
      await mutate(documents);

      return documents;
    },
    getDocument: (id) => source.getDocument(id),
  };
}

async function exportAfterCut(f, mutate) {
  return exportStaticSnapshot(afterList(f.source, mutate), { ...options, outputDir: f.outputDir });
}

async function assertPreservedOutput(f) {
  const manifest = JSON.parse(await readFile(path.join(f.outputDir, 'i', options.capability, 'snapshot-manifest.json'), 'utf8'));
  assert.deepEqual(manifest, f.before.manifest);

  for (const file of f.before.manifest.files) {
    const bytes = await readFile(path.join(f.outputDir, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.length, file.size);
  }

  const files = (await readdir(f.outputDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile());
  assert.equal(files.length, f.before.manifest.files.length + 1);
  assert.deepEqual((await readdir(f.root)).sort(), ['export', 'library']);
}

async function addImport(f) {
  const donorHome = path.join(f.root, 'donor');
  const donor = new ManagedSyncStore(donorHome);
  await donor.enroll();
  const bytes = input('imported').originalBytes;
  await donor.publish(input('imported'), 'imported');
  const origin = await donor.snapshot();
  const owner = origin.originKeys.find((grant) => grant.inboxId === origin.inboxId);
  assert(owner);
  const route = {
    id: randomUUID(), revision: 1, direction: 'inbound', peerId: origin.inboxId,
    peerUrl: 'https://peer.test/', sourceInboxId: origin.inboxId, destinationInboxId: f.ledger.inboxId,
    localInboxName: 'contract', readerAudience: 'contract', allowedOrigins: [owner],
    credentialRef: 'synthetic_token', tlsTrustRef: 'synthetic_ca', state: 'active', lastError: null,
  };
  await f.store.configureRoute(route);
  const auth = {
    routeId: route.id, revision: route.revision, peerId: route.peerId,
    sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId,
  };
  const record = origin.records[canonicalKey(origin.inboxId, 'imported')];
  const states = [toOriginState(record)];
  const nonce = randomUUID();
  await f.store.completeInventory(auth, {
    protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: origin.inboxId, routeId: route.id, revision: route.revision,
    scope: [{ inboxId: origin.inboxId, historyEpoch: origin.historyEpoch }], generation: origin.generation,
    count: states.length, descriptorDigest: inventoryDigest(states), nonce,
  }, states, nonce);
  assert.equal((await f.store.apply(auth, states[0], bytes)).status, 'committed');
  const imported = (await f.source.listDocuments()).find((metadata) => metadata.origin);
  assert(imported);

  return imported;
}

for (const sourceKind of ['backend', 'read-only source']) {
  test(`${sourceKind}: publication after the list is excluded, while the original export completes`, async (t) => {
    const f = await fixture(t, sourceKind);
    const result = await exportAfterCut(f, () => f.store.publish(input('later'), 'later'));

    assert.equal(result.manifest.documentCount, 1);
    assert.deepEqual(result.manifest, f.before.manifest);
    await assertPreservedOutput(f);
    assert.deepEqual((await f.source.listDocuments()).map((metadata) => metadata.id).sort(), ['later', 'original']);
  });

  test(`${sourceKind}: deletion before the body fetch rejects and preserves existing output`, async (t) => {
    const f = await fixture(t, sourceKind);

    await assert.rejects(exportAfterCut(f, () => f.store.deleteDocument('original')), {
      message: 'Document changed while exporting: original',
    });
    await assertPreservedOutput(f);
    assert.equal(await f.source.getDocument('original'), null);
  });

  test(`${sourceKind}: missing body before listing is omitted without inventing a tombstone`, async (t) => {
    const f = await fixture(t, sourceKind);
    const record = f.ledger.records[canonicalKey(f.ledger.inboxId, 'original')];
    assert(record.bodyFile);
    await rm(path.join(f.home, 'sync', 'bodies', record.bodyFile));
    const result = await exportStaticSnapshot(f.source, { ...options, outputDir: f.outputDir });

    assert.equal(result.manifest.documentCount, 0);
    assert.equal((await f.store.snapshot()).records[canonicalKey(f.ledger.inboxId, 'original')].state, 'live');
  });

  test(`${sourceKind}: body disappearance after listing rejects and removes staging`, async (t) => {
    const f = await fixture(t, sourceKind);
    const record = f.ledger.records[canonicalKey(f.ledger.inboxId, 'original')];
    assert(record.bodyFile);

    await assert.rejects(exportAfterCut(f, () => rm(path.join(f.home, 'sync', 'bodies', record.bodyFile))), {
      message: 'Document changed while exporting: original',
    });
    await assertPreservedOutput(f);
  });

  test(`${sourceKind}: quarantine alone permits reads; a subsequent fork blocks the old export`, async (t) => {
    const f = await fixture(t, sourceKind);
    const quarantined = await exportAfterCut(f, () => f.store.quarantineRestore());
    assert.deepEqual(quarantined.manifest, f.before.manifest);

    const expected = sourceKind === 'backend'
      ? /Document changed while exporting: original/
      : /Source instance identity does not match the selected inbox/;
    await assert.rejects(exportAfterCut(f, () => f.store.fork()), expected);
    await assertPreservedOutput(f);
  });

  test(`${sourceKind}: unexpected instance identity replacement rejects after the list`, async (t) => {
    const f = await fixture(t, sourceKind);
    const expected = sourceKind === 'backend'
      ? /Reader identity differs from managed store identity/
      : /Source instance identity does not match the selected inbox/;

    await assert.rejects(exportAfterCut(f, () => writeFile(path.join(f.home, 'instance-id'), `${randomUUID()}\n`)), expected);
    await assertPreservedOutput(f);
  });

  test(`${sourceKind}: newly unsafe ledger permissions reject after the list`, async (t) => {
    const f = await fixture(t, sourceKind);

    await assert.rejects(exportAfterCut(f, () => chmod(path.join(f.home, 'sync', 'ledger.json'), 0o644)), {
      message: 'Managed ledger must be a bounded private regular file owned by the current account',
    });
    await assertPreservedOutput(f);
  });

  test(`${sourceKind}: corruption in a later unselected descriptor remains visible`, async (t) => {
    const f = await fixture(t, sourceKind);

    await assert.rejects(exportAfterCut(f, async () => {
      await f.store.publish(input('later'), 'later');
      const ledger = await f.store.snapshot();
      ledger.records[canonicalKey(ledger.inboxId, 'later')].signature = Buffer.alloc(64).toString('base64url');
      await writeFile(path.join(f.home, 'sync', 'ledger.json'), `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    }), { message: 'Origin signature verification failed' });
    await assertPreservedOutput(f);
  });

  test(`${sourceKind}: suppression changes later batch reads; imports never reach export body reads`, async (t) => {
    const f = await fixture(t, sourceKind);
    const imported = await addImport(f);
    const documents = await f.source.listDocuments();
    assert(documents.some((metadata) => metadata.id === imported.id));

    await f.store.setSuppressed(imported.id, true);
    assert.equal(await f.source.getDocument(imported.id), null);
    await f.store.setSuppressed(imported.id, false);
    const restored = await f.source.getDocument(imported.id);
    assert(restored);
    assert.deepEqual(restored.originalBytes, input('imported').originalBytes);

    const fetched = [];
    const result = await exportStaticSnapshot({
      listDocuments: () => f.source.listDocuments(),
      getDocument(id) {
        fetched.push(id);
        return f.source.getDocument(id);
      },
    }, { ...options, outputDir: f.outputDir });

    assert.deepEqual(fetched, ['original']);
    assert.deepEqual(result.manifest, f.before.manifest);
    await rm(path.join(f.root, 'donor'), { recursive: true, force: true });
    await assertPreservedOutput(f);
  });
}
