// Derived from the frozen 42232780 baseline probe. Every export cut below enters the actual view.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const platformTest = require('node:test');
const fs = require('node:fs/promises');
const dist = path.resolve(process.env.HTML_INBOX_CONTRACT_DIST || path.join(__dirname, '../../packages/cli/dist'));
const ledgerModule = require(path.join(dist, 'sync-ledger.js'));
const ledgerReader = require(path.join(dist, 'sync-ledger-reader.js'));
const model = require(path.join(dist, 'sync-model.js'));
const { withDocumentReadView } = require(path.join(dist, 'document-read-view.js'));
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
  const root = await mkdtemp(path.join(tmpdir(), 'html-inbox-view-contract-'));
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
  return {
    listDocuments() { throw new Error('Export bypassed the actual view'); },
    getDocument() { throw new Error('Export bypassed the actual view'); },
    async withReadView(operation) {
      let entered = 0;
      let cuts = 0;
      try {
        return await source.withReadView(async (view) => {
          entered += 1;
          return operation({
            async listDocuments() {
              const documents = await view.listDocuments();
              cuts += 1;
              await mutate(documents);
              return documents;
            },
            getDocument: (id) => view.getDocument(id),
          });
        });
      } finally {
        assert.equal(entered, 1, 'actual callback view entered exactly once');
        assert.equal(cuts, 1, 'mutation injected inside the view after its list');
      }
    },
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
  test(`actual view ${sourceKind}: publication after the list is excluded, while the original export completes`, async (t) => {
    const f = await fixture(t, sourceKind);
    const result = await exportAfterCut(f, () => f.store.publish(input('later'), 'later'));

    assert.equal(result.manifest.documentCount, 1);
    assert.deepEqual(result.manifest, f.before.manifest);
    await assertPreservedOutput(f);
    assert.deepEqual((await f.source.listDocuments()).map((metadata) => metadata.id).sort(), ['later', 'original']);
  });

  test(`actual view ${sourceKind}: deletion before the body fetch rejects and preserves existing output`, async (t) => {
    const f = await fixture(t, sourceKind);

    await assert.rejects(exportAfterCut(f, () => f.store.deleteDocument('original')), {
      message: 'Document changed while exporting: original',
    });
    await assertPreservedOutput(f);
    assert.equal(await f.source.getDocument('original'), null);
  });

  test(`actual view ${sourceKind}: missing body before listing is omitted without inventing a tombstone`, async (t) => {
    const f = await fixture(t, sourceKind);
    const record = f.ledger.records[canonicalKey(f.ledger.inboxId, 'original')];
    assert(record.bodyFile);
    await rm(path.join(f.home, 'sync', 'bodies', record.bodyFile));
    const result = await exportStaticSnapshot(f.source, { ...options, outputDir: f.outputDir });

    assert.equal(result.manifest.documentCount, 0);
    assert.equal((await f.store.snapshot()).records[canonicalKey(f.ledger.inboxId, 'original')].state, 'live');
  });

  test(`actual view ${sourceKind}: body disappearance after listing rejects and removes staging`, async (t) => {
    const f = await fixture(t, sourceKind);
    const record = f.ledger.records[canonicalKey(f.ledger.inboxId, 'original')];
    assert(record.bodyFile);

    await assert.rejects(exportAfterCut(f, () => rm(path.join(f.home, 'sync', 'bodies', record.bodyFile))), {
      message: 'Document changed while exporting: original',
    });
    await assertPreservedOutput(f);
  });

  test(`actual view ${sourceKind}: quarantine alone permits reads; a subsequent fork blocks the old export`, async (t) => {
    const f = await fixture(t, sourceKind);
    const quarantined = await exportAfterCut(f, () => f.store.quarantineRestore());
    assert.deepEqual(quarantined.manifest, f.before.manifest);

    const expected = sourceKind === 'backend'
      ? /Document changed while exporting: original/
      : /Source instance identity does not match the selected inbox/;
    await assert.rejects(exportAfterCut(f, () => f.store.fork()), expected);
    await assertPreservedOutput(f);
  });

  test(`actual view ${sourceKind}: unexpected instance identity replacement rejects after the list`, async (t) => {
    const f = await fixture(t, sourceKind);
    const expected = sourceKind === 'backend'
      ? /Reader identity differs from managed store identity/
      : /Source instance identity does not match the selected inbox/;

    await assert.rejects(exportAfterCut(f, () => writeFile(path.join(f.home, 'instance-id'), `${randomUUID()}\n`)), expected);
    await assertPreservedOutput(f);
  });

  test(`actual view ${sourceKind}: newly unsafe ledger permissions reject after the list`, async (t) => {
    const f = await fixture(t, sourceKind);

    await assert.rejects(exportAfterCut(f, () => chmod(path.join(f.home, 'sync', 'ledger.json'), 0o644)), {
      message: 'Managed ledger must be a bounded private regular file owned by the current account',
    });
    await assertPreservedOutput(f);
  });

  test(`actual view ${sourceKind}: corruption in a later unselected descriptor remains visible`, async (t) => {
    const f = await fixture(t, sourceKind);

    await assert.rejects(exportAfterCut(f, async () => {
      await f.store.publish(input('later'), 'later');
      const ledger = await f.store.snapshot();
      ledger.records[canonicalKey(ledger.inboxId, 'later')].signature = Buffer.alloc(64).toString('base64url');
      await writeFile(path.join(f.home, 'sync', 'ledger.json'), `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    }), { message: 'Origin signature verification failed' });
    await assertPreservedOutput(f);
  });

  test(`actual view ${sourceKind}: suppression changes later batch reads; imports never reach export body reads`, async (t) => {
    const f = await fixture(t, sourceKind);
    const imported = await addImport(f);
    await f.source.withReadView(async (view) => {
      const documents = await view.listDocuments();
      assert(documents.some((metadata) => metadata.id === imported.id));
      await f.store.setSuppressed(imported.id, true);
      assert.equal(await view.getDocument(imported.id), null);
      await f.store.setSuppressed(imported.id, false);
      const restored = await view.getDocument(imported.id);
      assert(restored);
      assert.deepEqual(restored.originalBytes, input('imported').originalBytes);
    });

    const fetched = [];
    let entered = 0;
    const result = await exportStaticSnapshot({
      listDocuments() { throw new Error('Export bypassed the actual view'); },
      getDocument() { throw new Error('Export bypassed the actual view'); },
      withReadView(operation) {
        return f.source.withReadView(async (view) => {
          entered += 1;
          return operation({
            listDocuments: () => view.listDocuments(),
            getDocument(id) {
              fetched.push(id);
              return view.getDocument(id);
            },
          });
        });
      },
    }, { ...options, outputDir: f.outputDir });

    assert.equal(entered, 1);
    assert.deepEqual(fetched, ['original']);
    assert.deepEqual(result.manifest, f.before.manifest);
    await rm(path.join(f.root, 'donor'), { recursive: true, force: true });
    await assertPreservedOutput(f);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

for (const sourceKind of ['backend', 'read-only source']) {
  test(`${sourceKind}: actual view reuses validation only, and direct reads remain independent`, async (t) => {
    const f = await fixture(t, sourceKind);
    const parser = t.mock.method(ledgerModule, 'parseLedger');
    const reader = t.mock.method(ledgerReader, 'readManagedLedgerBytes');
    const verifier = t.mock.method(model, 'verifyOriginState');
    try {
      await f.source.withReadView(async (view) => {
        assert.deepEqual(Object.keys(view).sort(), ['getDocument', 'getDocumentMetadata', 'listDocuments']);
        assert.equal((await view.listDocuments()).length, 1);
        assert.equal((await view.getDocumentMetadata('original')).title, f.metadata.title);
        assert.deepEqual((await view.getDocument('original')).originalBytes, input('original').originalBytes);
        assert.equal(reader.mock.callCount(), 3, 'complete checked ledger bytes read for all three operations');
        assert.equal(parser.mock.callCount(), 1);
        assert.equal(verifier.mock.callCount(), 1);
      });

      await f.source.withReadView(async (view) => { await view.listDocuments(); });
      assert.equal(parser.mock.callCount(), 2, 'new callbacks do not share verified state');
      await f.source.listDocuments();
      await f.source.getDocument('original');
      assert.equal(parser.mock.callCount(), 4, 'ordinary operations each validate independently');
    } finally {
      t.mock.restoreAll();
    }
  });

  test(`${sourceKind}: returned nested metadata and ordinary snapshots cannot mutate private checked state`, async (t) => {
    const f = await fixture(t, sourceKind);
    const imported = await addImport(f);
    await f.source.withReadView(async (view) => {
      const documents = await view.listDocuments();
      documents[0].title = 'caller mutation';
      const metadata = await view.getDocumentMetadata(imported.id);
      assert(metadata?.origin);
      metadata.origin.originalMetadata.title = 'nested caller mutation';
      metadata.origin.inboxId = randomUUID();
      const snapshot = await f.store.snapshot();
      snapshot.records[canonicalKey(f.ledger.inboxId, 'original')].metadata.title = 'public snapshot mutation';

      const original = await view.getDocument('original');
      assert.equal(original.metadata.title, f.metadata.title);
      const fresh = await view.getDocumentMetadata(imported.id);
      assert.deepEqual(fresh, imported);
    });
  });

  test(`${sourceKind}: complete-byte changes refresh ID maps even with unchanged generation, inode and mtime`, async (t) => {
    const f = await fixture(t, sourceKind);
    await f.source.withReadView(async (view) => {
      await view.listDocuments();
      const filename = path.join(f.home, 'sync', 'ledger.json');
      const before = await fs.stat(filename);
      const ledger = JSON.parse(await readFile(filename, 'utf8'));
      const record = ledger.records[canonicalKey(ledger.inboxId, 'original')];
      record.localId = 'renamedx';
      await writeFile(filename, `${JSON.stringify(ledger)}\n`);
      await fs.utimes(filename, before.atime, before.mtime);
      const after = await fs.stat(filename);
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      assert.equal(ledger.generation, f.ledger.generation);
      assert.equal(await view.getDocument('original'), null);
      const renamed = await view.getDocument('renamedx');
      assert.equal(renamed.metadata.id, 'renamedx');
      assert.deepEqual(renamed.originalBytes, input('original').originalBytes);
    });
  });

  test(`${sourceKind}: handled invalid new ledger cannot fall back to the prior checked cut`, async (t) => {
    const f = await fixture(t, sourceKind);
    await f.source.withReadView(async (view) => {
      await view.listDocuments();
      const filename = path.join(f.home, 'sync', 'ledger.json');
      const saved = await readFile(filename);
      await writeFile(filename, '{');
      await assert.rejects(view.getDocument('original'), SyntaxError);
      await assert.rejects(view.getDocumentMetadata('original'), SyntaxError);
      await writeFile(filename, saved);
      assert.deepEqual((await view.getDocument('original')).originalBytes, input('original').originalBytes);
      await f.store.deleteDocument('original');
      assert.equal(await view.getDocument('original'), null);
    });
  });

  test(`${sourceKind}: the format barrier is rechecked despite equal complete ledger bytes`, async (t) => {
    const f = await fixture(t, sourceKind);
    await f.source.withReadView(async (view) => {
      await view.listDocuments();
      await writeFile(path.join(f.home, 'documents'), 'invalid barrier');
      await assert.rejects(view.getDocument('original'), { message: 'Managed format barrier is missing or invalid' });
    });
  });
}

for (const target of ['ledger', 'body']) {
  for (const outcome of ['success', 'callback failure', 'cancel', 'read failure', 'close failure']) {
    test(`actual managed view bounds admission and drains an opened ${target} handle on ${outcome}`, async (t) => {
      const f = await fixture(t, 'backend');
      const entered = deferred();
      const release = deferred();
      const callbackDone = deferred();
      const open = fs.open;
      let armed = true;
      let heldHandle;
      let closeCalls = 0;
      let opensAtCut = 0;
      const filename = target === 'ledger' ? path.join(f.home, 'sync', 'ledger.json')
        : path.join(f.home, 'sync', 'bodies', f.ledger.records[canonicalKey(f.ledger.inboxId, 'original')].bodyFile);
      const reason = new Error(outcome);
      const controller = new AbortController();
      const intercepted = t.mock.method(fs, 'open', async (...args) => {
        const handle = await open(...args);
        if (args[0] === filename && armed) {
          armed = false;
          heldHandle = handle;
          const close = handle.close.bind(handle);
          t.mock.method(handle, 'close', async () => {
            closeCalls += 1;
            await close();
            if (outcome === 'close failure') throw reason;
          });
          if (outcome === 'read failure') {
            t.mock.method(handle, 'read', async () => { throw reason; });
          }
          opensAtCut = intercepted.mock.callCount();
          entered.resolve();
          await release.promise;
        }
        return handle;
      });
      let escaped;
      let admitted;
      let settled = false;
      const scope = f.source.withReadView(async (view) => {
        escaped = view;
        admitted = target === 'ledger' ? view.listDocuments() : view.getDocument('original');
        // The caller observes the read rejection, even when callback completion races it.
        void admitted.catch(() => {});
        await Promise.race([entered.promise, admitted.then(
          () => { throw new Error('Required opened-handle cut was not reached'); },
          (error) => { throw error; },
        )]);
        for (let index = 0; index < 8; index += 1) {
          await assert.rejects(view.getDocument('original'), /already has an active read/);
        }
        if (outcome === 'cancel') controller.abort(reason);
        callbackDone.resolve();
        if (outcome === 'callback failure') throw reason;
      }, controller.signal);
      const result = scope.then((value) => { settled = true; callbackDone.resolve(); return value; },
        (error) => { settled = true; callbackDone.resolve(); throw error; });
      void result.catch(() => {});

      try {
        await callbackDone.promise;
        await Promise.resolve();
        assert.equal(settled, false, 'callback completion must drain the admitted native read');
        assert.equal(closeCalls, 0);
        assert(heldHandle);
        assert.equal(intercepted.mock.callCount(), opensAtCut, 'rejected admission did not open more files');
        release.resolve();
        if (outcome === 'success') {
          await result;
          if (target === 'ledger') assert.equal((await admitted).length, 1);
          else assert.deepEqual((await admitted).originalBytes, input('original').originalBytes);
        } else {
          await assert.rejects(result, (error) => error === reason);
        }
        assert.equal(closeCalls, 1, 'native handle closed before the scope settled');
        await assert.rejects(escaped.listDocuments(), /view is closed/);
        await assert.rejects(escaped.getDocumentMetadata('original'), /view is closed/);
        await assert.rejects(escaped.getDocument('original'), /view is closed/);
      } finally {
        release.resolve();
        await result.catch(() => {});
        t.mock.restoreAll();
      }
    });
  }
}

test('callback and admitted-read failures both survive drain and disposal', async () => {
  const entered = deferred();
  const release = deferred();
  const callbackError = new Error('callback primary');
  const readError = new Error('read drain failure');
  let disposed = 0;
  let escaped;
  const scope = withDocumentReadView({
    async listDocuments() { entered.resolve(); await release.promise; throw readError; },
    async getDocumentMetadata() { return null; },
    async getDocument() { return null; },
  }, async (view) => {
    escaped = view;
    void view.listDocuments().catch(() => {});
    await entered.promise;
    throw callbackError;
  }, undefined, () => { disposed += 1; });
  const verdict = assert.rejects(scope, (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [callbackError, readError]);
    return true;
  });
  await entered.promise;
  release.resolve();
  await verdict;
  assert.equal(disposed, 1);
  await assert.rejects(escaped.listDocuments(), /view is closed/);
});

test('already cancelled scopes dispose without invoking their callback or admitting a read', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before entry');
  controller.abort(reason);
  let disposed = 0;
  await assert.rejects(withDocumentReadView({
    async listDocuments() { assert.fail('read was admitted'); },
    async getDocumentMetadata() { assert.fail('read was admitted'); },
    async getDocument() { assert.fail('read was admitted'); },
  }, async () => { assert.fail('callback was invoked'); }, controller.signal, () => { disposed += 1; }),
  (error) => error === reason);
  assert.equal(disposed, 1);
});

test('actual read-only view keeps the selected byte limit on every read method', async (t) => {
  const f = await fixture(t, 'read-only source');
  const limited = new LocalDocumentSource({ home: f.home, instanceId: f.ledger.inboxId }, 10);
  await limited.withReadView(async (view) => {
    await assert.rejects(view.listDocuments(), /Source file exceeds its byte limit/);
    await assert.rejects(view.getDocumentMetadata('original'), /Source file exceeds its byte limit/);
    await assert.rejects(view.getDocument('original'), /Source file exceeds its byte limit/);
    assert.equal(await view.getDocument('../invalid'), null);
  });
});

test('legacy callback reads preserve export output and switch safely when enrollment completes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'html-inbox-view-legacy-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
    t.diagnostic('legacy transition fixture removed');
  });
  const home = path.join(root, 'library');
  const backend = new LocalDocumentBackend(home, () => {}, () => 'original');
  await backend.publish(input('original'));
  const direct = { listDocuments: () => backend.listDocuments(), getDocument: (id) => backend.getDocument(id) };
  const fallback = await exportStaticSnapshot(direct, { ...options, outputDir: path.join(root, 'fallback') });
  const scoped = await exportStaticSnapshot(backend, { ...options, outputDir: path.join(root, 'scoped') });
  assert.deepEqual(scoped.manifest, fallback.manifest);
  await backend.withReadView(async (view) => {
    assert.equal((await view.listDocuments()).length, 1);
    await new ManagedSyncStore(home).enroll();
    assert.deepEqual((await view.getDocument('original')).originalBytes, input('original').originalBytes);
  });
});

for (const sourceKind of ['backend', 'read-only source']) {
  test(`${sourceKind}: routine body reads retain the existing same-length drift behavior`, async (t) => {
    const f = await fixture(t, sourceKind);
    const record = f.ledger.records[canonicalKey(f.ledger.inboxId, 'original')];
    assert(record.bodyFile);
    const changed = Buffer.from(input('original').originalBytes);
    changed[changed.length - 1] ^= 1;
    await f.source.withReadView(async (view) => {
      await view.listDocuments();
      await writeFile(path.join(f.home, 'sync', 'bodies', record.bodyFile), changed);
      assert.deepEqual((await view.getDocument('original')).originalBytes, changed);
      assert.deepEqual((await f.source.getDocument('original')).originalBytes, changed);
      assert.equal((await f.store.snapshot()).records[canonicalKey(f.ledger.inboxId, 'original')].sha256, record.sha256);
    });
  });
}
