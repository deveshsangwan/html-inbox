// Run separately with --expose-gc. No test-mock call history may retain the observed objects.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { setImmediate: nextTurn } = require('node:timers/promises');
const test = require('node:test');
const dist = path.resolve(process.env.HTML_INBOX_CONTRACT_DIST || path.join(__dirname, '../../packages/cli/dist'));
const ledgerModule = require(path.join(dist, 'sync-ledger.js'));
const ledgerReader = require(path.join(dist, 'sync-ledger-reader.js'));
const { ManagedSyncStore } = require(path.join(dist, 'sync-store.js'));

test('escaped methods retain neither checked ledger nor ledger buffers after success, failure or cancellation', async (t) => {
  assert.equal(typeof global.gc, 'function', 'run this script with --expose-gc');
  const root = await fs.mkdtemp(path.join(tmpdir(), 'html-inbox-view-retention-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
    t.diagnostic('retention fixture removed');
  });
  const store = new ManagedSyncStore(path.join(root, 'library'));
  await store.enroll();
  await store.publish({ originalBytes: Buffer.from('<!doctype html><html><body>retention</body></html>'),
    title: 'Retention', type: 'report', sourceFileName: 'retention.html' }, 'original');
  const parse = ledgerModule.parseLedger;
  const readBytes = ledgerReader.readManagedLedgerBytes;
  const ledgers = [];
  const buffers = [];
  ledgerModule.parseLedger = (...args) => {
    const ledger = parse(...args);
    ledgers.push(new WeakRef(ledger));
    return ledger;
  };
  ledgerReader.readManagedLedgerBytes = async (...args) => {
    const bytes = await readBytes(...args);
    buffers.push(new WeakRef(bytes));
    return bytes;
  };

  const retained = [];
  try {
    for (const outcome of ['success', 'failure', 'cancel']) {
      const controller = new AbortController();
      const reason = new Error(outcome);
      const operation = store.withReadView(async (view) => {
        retained.push(view);
        await view.getDocumentMetadata('original');
        await view.getDocumentMetadata('original');
        if (outcome === 'failure') throw reason;
        if (outcome === 'cancel') controller.abort(reason);
      }, controller.signal);

      if (outcome === 'success') await operation;
      else await assert.rejects(operation, (error) => error === reason);
    }
  } finally {
    ledgerModule.parseLedger = parse;
    ledgerReader.readManagedLedgerBytes = readBytes;
  }

  assert.equal(ledgers.length, 3, 'one new private checked ledger for each callback');
  assert.equal(buffers.length, 6, 'every read still obtains complete current bytes');
  for (const view of retained) {
    await assert.rejects(view.listDocuments(), /view is closed/);
    await assert.rejects(view.getDocumentMetadata('original'), /view is closed/);
    await assert.rejects(view.getDocument('original'), /view is closed/);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await nextTurn();
    global.gc();
  }

  assert(ledgers.every((reference) => reference.deref() === undefined), 'escaped views released every parsed ledger');
  assert(buffers.every((reference) => reference.deref() === undefined), 'escaped views released every ledger buffer');
  assert.equal(retained.length, 3, 'views remain strongly retained during the disposal assertions');
});
