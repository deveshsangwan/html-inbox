const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const { createSyncHttpsCredentials } = require("../../packages/cli/dist/sync-https-fixtures.js");
const { createSyncIngestionServer } = require("../../packages/cli/dist/sync-http-server.js");
const { reconcileSyncRoutes } = require("../../packages/cli/dist/sync-reconciliation.js");
const { canonicalKey } = require("../../packages/cli/dist/sync-model.js");
const { ManagedSyncStore } = require("../../packages/cli/dist/sync-store.js");
const { opaqueToken } = require("../../packages/cli/dist/sync-wire.js");

function storageCounters(store) {
  const counters = store.counters;
  return {
    commits: counters.events["ledger-renamed"] ?? 0,
    htmlOpens: counters.htmlOpens,
    htmlBytesRead: counters.htmlBytes,
    hashPasses: counters.hashPasses,
    bodyTransfers: counters.bodyTransfers,
  };
}

function difference(after, before) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]]));
}

// Equal-size bodies with a per-document label, so swapped bodies or receipts fail the checks.
function peerInput(index, size) {
  const head = `<!doctype html><html><head><title>Peer benchmark</title></head><body>document-${index} `;
  const tail = "</body></html>";
  assert.ok(size >= head.length + tail.length, "Peer fixture size is too small");

  return { originalBytes: Buffer.from(head + "x".repeat(size - head.length - tail.length) + tail),
    title: `Peer benchmark ${index}`, type: "report", sourceFileName: "fixture.html" };
}

async function assertDocuments(store, inputs) {
  const expected = new Map(inputs.map((input) => [input.title, input.originalBytes]));
  const documents = await store.listDocuments();
  assert.deepEqual(documents.map((metadata) => metadata.title).sort(), [...expected.keys()].sort());

  for (const metadata of documents) {
    const document = await store.getDocument(metadata.id);
    assert.ok(document);
    assert.deepEqual(document.originalBytes, expected.get(metadata.title));
  }
}

// The receiver must hold each document's own bytes, and records plus committed receipts on this route
// revision that carry the sender's canonical identities and body/metadata hashes.
async function assertReceived(source, destination, route, inputs) {
  await assertDocuments(destination, inputs);
  const sent = (await source.snapshot()).records;
  const received = await destination.snapshot();
  const expectedKeys = Object.keys(sent).sort();
  assert.deepEqual(Object.keys(received.records).sort(), expectedKeys);
  for (const [key, record] of Object.entries(sent)) {
    assert.equal(received.records[key].sha256, record.sha256, key);
    assert.equal(received.records[key].metadataSha256, record.metadataSha256, key);
  }

  const receiptKeys = [];
  for (const receipt of Object.values(received.receipts)) {
    const { originState } = receipt;
    const key = canonicalKey(originState.originInboxId, originState.originDocumentId);
    assert.equal(receipt.routeId, route.id);
    assert.equal(receipt.revision, route.revision);
    assert.equal(receipt.disposition, "committed", key);
    assert.equal(originState.sha256, sent[key]?.sha256, key);
    assert.equal(originState.metadataSha256, sent[key]?.metadataSha256, key);
    receiptKeys.push(key);
  }
  assert.deepEqual(receiptKeys.sort(), expectedKeys);

  return received;
}

// Both peers run in this process, so caller CPU measurements include sender and receiver.
async function runSync({ root, count, size = 10240, samples = 3, record, mode = "sync" }) {
  const cleanups = [];
  // Managed-only runs never open a connection, so they skip generating TLS credentials.
  const tls = mode === "sync" ? await createSyncHttpsCredentials({ after: (cleanup) => cleanups.push(cleanup) }) : null;
  // Sync runs label their source-store setup separately, so managed samples come from managed runs only.
  const setup = mode === "sync" ? "peer/source-" : "managed/";
  try {
    const inputs = Array.from({ length: count }, (_, index) => peerInput(index, size));

    for (let sample = 0; sample < samples; sample += 1) {
      const source = new ManagedSyncStore(path.join(root, `source-${sample}`));
      await record(`${setup}enroll/${count}`, async () => {
        await source.enroll();
        return { source: storageCounters(source) };
      });
      await record(`${setup}publish/${count}`, async () => {
        const before = storageCounters(source);
        for (let index = 0; index < count; index += 1) {
          await source.publish(inputs[index], `document-${index}`);
        }

        return { source: difference(storageCounters(source), before), bodyBytes: count * size };
      });
      await assertDocuments(source, inputs);
      await record(`${setup}status/${count}`, async () => {
        const ledger = await source.snapshot();
        assert.equal(Object.keys(ledger.records).length, count);
        return { records: Object.keys(ledger.records).length };
      });

      if (mode === "managed") continue;

      // Receiver enrollment is setup; only source enrollment is an operation sample.
      const destinationHome = path.join(root, `receiver-${sample}`);
      const destination = new ManagedSyncStore(destinationHome);
      await destination.enroll();
      const ca = await readFile(tls.caPath);
      const key = await readFile(tls.trusted.keyPath);
      const cert = await readFile(tls.trusted.certPath);
      const sourcePeerId = randomUUID();
      const destinationPeerId = randomUUID();
      const token = opaqueToken();
      const credentials = () => ({ token, ca });
      const server = createSyncIngestionServer({ store: destination, peerId: destinationPeerId, key, cert, credentials });
      try {
        const { url } = await server.start();
        const sourceLedger = await source.snapshot();
        const destinationLedger = await destination.snapshot();
        const route = {
          id: randomUUID(), revision: 1, direction: "outbound", peerId: destinationPeerId, peerUrl: url,
          sourceInboxId: sourceLedger.inboxId, destinationInboxId: destinationLedger.inboxId,
          localInboxName: "benchmark", readerAudience: "disposable synthetic fixture",
          allowedOrigins: [{ ...sourceLedger.originKeys[0] }], credentialRef: "synthetic_token",
          tlsTrustRef: "synthetic_ca", state: "active", lastError: null,
        };
        const outbound = await source.configureRoute(route);
        await destination.configureRoute({ ...route, direction: "inbound", peerId: sourcePeerId, peerUrl: "https://127.0.0.1:1" });

        async function reconcile(label, expectedTransfers) {
          const beforeSource = storageCounters(source);
          const beforeDestination = storageCounters(destination);
          const beforeWire = server.status().counters;
          const result = await reconcileSyncRoutes({ store: source, peerId: sourcePeerId, credentials, routeIds: [outbound.id], deadlineMs: 300_000 });
          assert.equal(result.routes.length, 1);
          assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
          assert.equal(result.routes[0].transferred, expectedTransfers, label);
          const afterWire = server.status().counters;

          return {
            transferred: result.routes[0].transferred,
            source: difference(storageCounters(source), beforeSource),
            receiver: difference(storageCounters(destination), beforeDestination),
            wire: difference(afterWire, beforeWire),
          };
        }

        // Receiver state is verified after every pass, outside the timed interval.
        await record(`peer/initial/${count}`, () => reconcile("initial", count));
        await assertReceived(source, destination, route, inputs);
        await record(`peer/noop/${count}`, () => reconcile("no-op", 0));
        const ledger = await assertReceived(source, destination, route, inputs);

        if (count > 0) {
          const recordToRepair = Object.values(ledger.records)[0];
          assert.equal(typeof recordToRepair.bodyFile, "string");
          await rm(path.join(destinationHome, "sync", "bodies", recordToRepair.bodyFile));
          await record(`peer/repair/${count}`, () => reconcile("repair", 1));
          await assertReceived(source, destination, route, inputs);
        }
      } catch (error) {
        // A close failure must not replace the sample's original error.
        await server.close().catch(() => {});
        throw error;
      }
      await server.close();
      assert.equal(server.status().listening, false);
      assert.equal(server.status().sockets, 0);
    }
  } catch (error) {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    throw error;
  }
  for (const cleanup of cleanups.reverse()) await cleanup();
}

module.exports = { runSync };
