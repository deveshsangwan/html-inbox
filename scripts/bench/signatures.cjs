const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

let dist = path.resolve(__dirname, '../../packages/cli/dist');
const load = name => require(path.join(dist, name));

function instrumentCrypto(signatureMode) {
  const counters = { parsedKeys: 0, verifications: 0, signatureCalls: 0, signatureHits: 0, signatureMisses: 0 };
  const originalPublicKey = crypto.createPublicKey;
  const originalVerify = crypto.verify;
  crypto.createPublicKey = function (...args) {
    counters.parsedKeys += 1;
    return originalPublicKey(...args);
  };
  crypto.verify = function (...args) {
    counters.verifications += 1;
    return originalVerify(...args);
  };

  const instances = new Set();
  let cacheLimits;
  const modulePath = path.join(dist, 'sync-signatures.js');
  const hasCache = existsSync(modulePath);
  assert.ok(hasCache || signatureMode === 'full', 'keys comparison requires the candidate cache module');
  if (hasCache) {
    const { OriginSignatureVerifier, ORIGIN_SIGNATURE_CACHE_LIMITS } = require(modulePath);
    cacheLimits = ORIGIN_SIGNATURE_CACHE_LIMITS;
    const originalKey = OriginSignatureVerifier.prototype.parsePublicKey;
    const originalVerification = OriginSignatureVerifier.prototype.verify;
    OriginSignatureVerifier.prototype.parsePublicKey = function (...args) {
      instances.add(this);
      return originalKey.apply(this, args);
    };
    OriginSignatureVerifier.prototype.verify = function (publicKey, signature, bytes) {
      instances.add(this);
      counters.signatureCalls += 1;
      const before = counters.verifications;
      let completed = false;
      try {
        if (signatureMode === 'keys') {
          const key = this.parsePublicKey(publicKey);
          if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, key, Buffer.from(signature, 'base64url'))) {
            throw new Error('Origin signature verification failed');
          }
        } else {
          originalVerification.call(this, publicKey, signature, bytes);
        }

        completed = true;
      } finally {
        if (completed && counters.verifications === before) counters.signatureHits += 1;
        else counters.signatureMisses += 1;
      }

    };
  }

  return {
    counters, hasCache,
    usage: () => [...instances].map(instance => {
      const usage = instance.usage();
      assert.ok(usage.keys <= cacheLimits.keys);
      assert.ok(usage.keyBytes <= cacheLimits.keyBytes);
      assert.ok(usage.verifications <= cacheLimits.verifications);
      assert.ok(usage.verificationBytes <= cacheLimits.verificationBytes);

      return usage;
    }),
  };
}

function difference(after, before) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]]));
}

async function assertPortReleased(port) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}

async function waitTicket(worker, ticketId) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const ticket = worker.status().tickets.find(entry => entry.ticketId === ticketId);
    if (ticket?.state === 'complete' || ticket?.state === 'cancelled') return ticket;

    await delay(5);
  }

  throw new Error('Owned signature benchmark worker ticket exceeded its production pass deadline');
}

async function assertReceiver(store, expected, bytes) {
  const ledger = await store.snapshot();
  const records = Object.values(ledger.records);
  assert.equal(records.length, expected.length);
  assert.equal(Object.keys(ledger.receipts).length, expected.length);
  assert.deepEqual(records.map(record => record.originDocumentId).sort(), expected.map(record => record.originDocumentId).sort());
  for (const record of records) {
    const source = expected.find(entry => entry.originDocumentId === record.originDocumentId);
    assert.ok(source);
    assert.deepEqual(load('sync-store.js').toOriginState(record), load('sync-store.js').toOriginState(source));
    assert.equal(typeof record.bodyFile, 'string');
    const document = await store.getDocument(record.localId);
    assert.ok(document);
    assert.deepEqual(document.originalBytes, bytes);
  }
}

async function workerWorkload({ root, source, expected, bytes, count, measure }) {
  const { ManagedSyncStore } = load('sync-store.js');
  const { createSyncHttpsCredentials } = load('sync-https-fixtures.js');
  const { createSyncIngestionServer } = load('sync-http-server.js');
  const { defaultRuntimeConfig } = load('sync-runtime-config.js');
  const receiver = new ManagedSyncStore(path.join(root, 'receiver'));
  const cleanups = [];
  const tls = await createSyncHttpsCredentials({ after: cleanup => cleanups.push(cleanup) });
  let server;
  let worker;
  let serverPort;
  let controlPort;
  try {
    const ca = await fs.readFile(tls.caPath);
    const token = load('sync-wire.js').opaqueToken();
    const tokenPath = path.join(root, 'synthetic-token');
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    const credentials = () => ({ token, ca });
    const receiverLedger = await receiver.snapshot();
    server = createSyncIngestionServer({ store: receiver, peerId: receiverLedger.inboxId, credentials,
      key: await fs.readFile(tls.trusted.keyPath), cert: await fs.readFile(tls.trusted.certPath) });
    const { url } = await server.start();
    serverPort = Number(new URL(url).port);
    const sourceLedger = await source.snapshot();
    const owner = sourceLedger.originKeys.find(grant => grant.inboxId === sourceLedger.inboxId);
    assert.ok(owner);
    const route = { id: crypto.randomUUID(), revision: 1, direction: 'outbound', peerId: receiverLedger.inboxId, peerUrl: url,
      sourceInboxId: sourceLedger.inboxId, destinationInboxId: receiverLedger.inboxId, localInboxName: 'signature-benchmark',
      readerAudience: 'synthetic signature benchmark', allowedOrigins: [owner], credentialRef: 'synthetic_token', tlsTrustRef: 'synthetic_ca', state: 'active', lastError: null };
    await source.configureRoute(route);
    await receiver.configureRoute({ ...route, direction: 'inbound', peerId: sourceLedger.inboxId, peerUrl: 'https://127.0.0.1:1' });
    await source.configureRuntime({ ...defaultRuntimeConfig(),
      timings: { foregroundMs: 30_000, requestMs: 30_000, reconcileMs: 300_000, passMs: 60_000 },
      credentials: { synthetic_token: tokenPath }, trust: { synthetic_ca: tls.caPath } });
    await source.setWorkerEnabled(true);

    // Populate custody through public validating operations. These are actual receiver
    // receipts, not evidence of an initial TLS transfer. Timing covers a later confirmed no-op.
    const { routeAuthorization, reconcileSyncRoutes } = load('sync-reconciliation.js');
    const outbound = routeAuthorization(route);
    const inbound = { ...outbound, peerId: sourceLedger.inboxId };
    const cut = await source.inventory(outbound);
    const nonce = crypto.randomUUID();
    const evidence = load('sync-wire.js').createEvidence(route, sourceLedger.inboxId, nonce, cut);
    await receiver.completeInventory(inbound, evidence, cut.states, nonce);
    for (const state of cut.states) {
      const applied = await receiver.apply(inbound, state, bytes);
      assert.equal(applied.status, 'committed');
      await source.acknowledge(outbound, applied.receipt);
    }

    await assertReceiver(receiver, expected, bytes);
    const preparation = await reconcileSyncRoutes({ store: source, peerId: sourceLedger.inboxId,
      credentials, routeIds: [route.id], deadlineMs: 300_000, requestMs: 30_000 });
    assert.equal(preparation.routes.length, 1);
    assert.equal(preparation.routes[0].status, 'confirmed', JSON.stringify(preparation));
    assert.equal(preparation.routes[0].transferred, 0);
    await assertReceiver(receiver, expected, bytes);

    await measure(`signatures/worker-startup/${count}`, async () => {
      worker = await load('sync-worker.js').startOwnedSyncWorker(sourceLedger.ownerAnchor.home, { temporary: true });
      controlPort = Number(new URL(worker.record.controlOrigin).port);
      return { scope: 'configured temporary owned runtime, real credential files, no automatic background pass' };
    });

    async function runPass(label, expectedTransfers) {
      await measure(`signatures/${label}/${count}`, async () => {
        const before = server.status().counters;
        const ticketId = crypto.randomUUID();
        worker.requestRun({ ticketId, routeIds: [route.id], deadlineAt: Date.now() + 60_000, requestMs: 30_000 });
        const ticket = await waitTicket(worker, ticketId);
        assert.equal(ticket.state, 'complete', JSON.stringify(ticket));
        assert.equal(ticket.error, null, JSON.stringify(ticket));
        assert.equal(ticket.routes.length, 1, JSON.stringify(ticket));
        assert.equal(ticket.routes[0].status, 'confirmed', JSON.stringify(ticket));
        assert.equal(ticket.routes[0].transferred, expectedTransfers, JSON.stringify(ticket));

        return { wire: difference(server.status().counters, before), transferred: expectedTransfers,
          scope: 'sender worker plus authenticated TLS receiver in the same process',
          preparation: 'public completeInventory/apply/acknowledge created actual custody, then confirmed real TLS reconciliation with zero transfers' };
      });
    }

    await assertReceiver(receiver, expected, bytes);
    await runPass('worker-noop-validated-custody', 0);
    await assertReceiver(receiver, expected, bytes);
    await measure(`signatures/worker-idle/${count}`, async () => {
      await delay(1000);
      assert.equal(worker.status().processState, 'idle');
      return { interval_ms: 1000 };
    });
    await measure(`signatures/worker-close/${count}`, async () => {
      await worker.close();
      worker = undefined;
      assert.equal(await load('sync-worker-records.js').readWorkerRecordOffline(sourceLedger.ownerAnchor.home), null);
      return { worker_record_removed: true };
    });
  } finally {
    try {
      await worker?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    }

    if (server) {
      assert.equal(server.status().listening, false);
      assert.equal(server.status().sockets, 0);
    }
    if (controlPort !== undefined) await assertPortReleased(controlPort);
    if (serverPort !== undefined) await assertPortReleased(serverPort);
  }
}

async function churnWorkload({ root, count, measure }) {
  const { ManagedSyncStore } = load('sync-store.js');
  const { parseLedger } = load('sync-ledger.js');
  const { signOriginState } = load('sync-model.js');
  const home = path.join(root, 'churn');
  const ledgerPath = path.join(home, 'sync', 'ledger.json');
  const ledger = parseLedger(JSON.parse(await fs.readFile(ledgerPath, 'utf8')));
  const privateKey = await fs.readFile(path.join(home, 'sync', `owner-${ledger.inboxId}.pem`), 'utf8');
  const store = new ManagedSyncStore(home);
  const rounds = count >= 1000 ? Math.ceil(18_000 / count) : 3;
  for (let round = 0; round < rounds; round += 1) {
    for (const record of Object.values(ledger.records)) {
      Object.assign(record, signOriginState({ ...record, version: ledger.nextOriginVersion++ }, privateKey));
    }

    ledger.generation += 1;
    await fs.writeFile(`${ledgerPath}.replacement`, JSON.stringify(ledger), { mode: 0o600 });
    await fs.rename(`${ledgerPath}.replacement`, ledgerPath);
    await measure(`signatures/churn-miss/${count}`, async () => {
      assert.deepEqual(await store.snapshot(), ledger);
      return { round, rounds, records: count };
    });
    await measure(`signatures/churn-repeat/${count}`, async () => {
      assert.deepEqual(await store.snapshot(), ledger);
      return { round, rounds, records: count };
    });
  }

  if (!count) return;

  await measure(`signatures/adversarial/${count}`, async () => {
    for (const corruption of ['signature', 'signed-field', 'public-key']) {
      const changed = structuredClone(ledger);
      const record = Object.values(changed.records)[0];
      if (corruption === 'signature') record.signature = Buffer.alloc(64).toString('base64url');
      else if (corruption === 'signed-field') record.sha256 = record.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      else changed.originKeys[0].publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();

      await fs.writeFile(ledgerPath, JSON.stringify(changed));
      await assert.rejects(store.snapshot(), /signature verification failed/);
      await assert.rejects(store.listDocuments(), /signature verification failed/);
      await assert.rejects(store.getDocument(record.localId), /signature verification failed/);
      await fs.writeFile(ledgerPath, JSON.stringify(ledger));
      assert.deepEqual(await store.snapshot(), ledger);
    }

    return { rejected: ['signature', 'signed-field', 'public-key'], global_snapshot_validation: true };
  });
}

async function runSignatures({ root, count, size, record, seed, html, setup, historyOnly = false, signatureMode = 'full', implementationDist }) {
  if (implementationDist) dist = path.resolve(implementationDist);

  assert.ok(['full', 'keys'].includes(signatureMode), 'signature mode must be full or keys');
  if (setup) {
    const { ManagedSyncStore } = load('sync-store.js');
    for (const name of ['source', 'churn']) {
      const home = path.join(root, name);
      await seed(home, count, size);
      await new ManagedSyncStore(home).enroll();
    }

    await new ManagedSyncStore(path.join(root, 'receiver')).enroll();
    return;
  }

  // Install counting wrappers before importing production code, including sync-model's singleton.
  const instrumentation = instrumentCrypto(signatureMode);
  const { ManagedSyncStore } = load('sync-store.js');
  const sourceHome = path.join(root, 'source');
  const source = new ManagedSyncStore(sourceHome);
  const expected = JSON.parse(await fs.readFile(path.join(sourceHome, 'sync', 'ledger.json'), 'utf8'));
  const expectedRecords = Object.values(expected.records);
  const bytes = Buffer.from(html(size));
  const measure = async (label, operation) => {
    const memoryBeforeGc = process.memoryUsage();
    global.gc?.();
    const memoryBefore = process.memoryUsage();
    const cryptoBefore = { ...instrumentation.counters };
    await record(label, operation, () => {
      const memoryAfter = process.memoryUsage();
      global.gc?.();
      return { crypto: difference(instrumentation.counters, cryptoBefore), cache_usage: instrumentation.usage(),
        signature_mode: instrumentation.hasCache ? signatureMode : 'uncached-parent',
        memory_before_gc: memoryBeforeGc, memory_before: memoryBefore, memory_after: memoryAfter,
        memory_after_gc: process.memoryUsage(), process_peak_rss_kib: process.resourceUsage().maxRSS,
        gc_excluded_from_operation_timing: true };
    });
  };

  await measure(`signatures/snapshot-cold/${count}`, async () => {
    assert.deepEqual(await source.snapshot(), expected);
    return { records: count, scope: 'first production snapshot in a fresh process; filesystem cache uncontrolled/warm' };
  });
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await measure(`signatures/snapshot-warm/${count}`, async () => {
      assert.deepEqual(await source.snapshot(), expected);
      return { iteration, records: count };
    });
  }

  await measure(`signatures/list/${count}`, async () => {
    const documents = await source.listDocuments();
    const expectedMetadata = expectedRecords.map(record => record.metadata).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    assert.deepEqual(documents, expectedMetadata);
    return { records: count, behavior: 'exact complete metadata and ordering' };
  });
  if (count) {
    await measure(`signatures/get/${count}`, async () => {
      const document = await source.getDocument(expectedRecords[0].localId);
      assert.ok(document);
      assert.deepEqual(document.metadata, expectedRecords[0].metadata);
      assert.deepEqual(document.originalBytes, bytes);
      return { bytes: size, behavior: 'full managed read, exact metadata and body' };
    });
  }

  if (!historyOnly) {
    await workerWorkload({ root, source, expected: expectedRecords, bytes, count, measure });
  }
  await churnWorkload({ root, count, measure });
}

module.exports = { runSignatures };
