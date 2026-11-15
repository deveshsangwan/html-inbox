const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const { createSyncHttpsCredentials } = require("../../packages/cli/dist/sync-https-fixtures.js");
const { createSyncIngestionServer } = require("../../packages/cli/dist/sync-http-server.js");
const { reconcileSyncRoutes } = require("../../packages/cli/dist/sync-reconciliation.js");
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

function htmlBytes(size) {
  const head = "<!doctype html><html><head><title>Peer benchmark</title></head><body>";
  const tail = "</body></html>";
  assert.ok(size >= head.length + tail.length, "Peer fixture size is too small");

  return Buffer.from(head + "x".repeat(size - head.length - tail.length) + tail);
}

async function assertDocuments(store, count, bytes) {
  const documents = await store.listDocuments();
  assert.equal(documents.length, count);
  for (const metadata of documents) {
    const document = await store.getDocument(metadata.id);
    assert.ok(document);
    assert.deepEqual(document.originalBytes, bytes);
  }
}

// Both peers run in this process, so caller CPU measurements include sender and receiver.
async function runSync({ root, count, size = 10240, samples = 3, record, mode = "sync" }) {
  const cleanups = [];
  const tls = await createSyncHttpsCredentials({ after: (cleanup) => cleanups.push(cleanup) });
  try {
    const ca = await readFile(tls.caPath);
    const key = await readFile(tls.trusted.keyPath);
    const cert = await readFile(tls.trusted.certPath);
    const bytes = htmlBytes(size);
    const input = { originalBytes: bytes, title: "Peer benchmark", type: "report", sourceFileName: "fixture.html" };

    for (let sample = 0; sample < samples; sample += 1) {
      const source = new ManagedSyncStore(path.join(root, `source-${sample}`));
      const destinationHome = path.join(root, `receiver-${sample}`);
      const destination = new ManagedSyncStore(destinationHome);
      await record(`managed/enroll/${count}`, async () => {
        await source.enroll();
        return { source: storageCounters(source) };
      });
      // Receiver enrollment is setup; only source enrollment is an operation sample.
      await destination.enroll();
      await record(`managed/publish/${count}`, async () => {
        const before = storageCounters(source);
        for (let index = 0; index < count; index += 1) {
          await source.publish(input, `document-${index}`);
        }

        return { source: difference(storageCounters(source), before), bodyBytes: count * size };
      });
      await assertDocuments(source, count, bytes);
      await record(`managed/status/${count}`, async () => {
        const ledger = await source.snapshot();
        assert.equal(Object.keys(ledger.records).length, count);
        return { records: Object.keys(ledger.records).length };
      });

      if (mode === "managed") continue;

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

        await record(`peer/initial/${count}`, () => reconcile("initial", count));
        await assertDocuments(destination, count, bytes);
        const ledger = await destination.snapshot();
        assert.equal(Object.keys(ledger.receipts).length, count);
        await record(`peer/noop/${count}`, () => reconcile("no-op", 0));

        if (count > 0) {
          const recordToRepair = Object.values(ledger.records)[0];
          assert.equal(typeof recordToRepair.bodyFile, "string");
          await rm(path.join(destinationHome, "sync", "bodies", recordToRepair.bodyFile));
          await record(`peer/repair/${count}`, () => reconcile("repair", 1));
          await assertDocuments(destination, count, bytes);
          assert.equal(Object.keys((await destination.snapshot()).receipts).length, count);
        }
      } finally {
        await server.close();
        assert.equal(server.status().listening, false);
        assert.equal(server.status().sockets, 0);
      }
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}

module.exports = { runSync };
