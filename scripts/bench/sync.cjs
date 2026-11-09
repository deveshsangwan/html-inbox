const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, rm, stat } = require("node:fs/promises");
const path = require("node:path");
const { createSyncHttpsCredentials } = require("../../packages/cli/dist/sync-https-fixtures.js");
const { createSyncIngestionServer } = require("../../packages/cli/dist/sync-http-server.js");
const { SyncClient } = require("../../packages/cli/dist/sync-client.js");
const { reconcileSyncRoutes } = require("../../packages/cli/dist/sync-reconciliation.js");
const { ManagedSyncStore } = require("../../packages/cli/dist/sync-store.js");
const { outboxKey, receiptKey } = require("../../packages/cli/dist/sync-ledger.js");
const { stateFingerprint, canonicalKey } = require("../../packages/cli/dist/sync-model.js");
const { opaqueToken } = require("../../packages/cli/dist/sync-wire.js");

const ledgerWrites = new WeakMap();

function observedStore(home) {
  const writes = { bytes: 0 };
  const store = new ManagedSyncStore(home, { testHooks: { async onEvent(event) {
    if (event === "ledger-renamed") {
      writes.bytes += (await stat(path.join(home, "sync", "ledger.json"))).size;
    }
  } } });
  ledgerWrites.set(store, writes);
  return store;
}

function storageCounters(store) {
  const counters = store.counters;
  return {
    commits: counters.events["ledger-renamed"] ?? 0,
    ledgerReplacementBytes: ledgerWrites.get(store).bytes,
    htmlOpens: counters.htmlOpens,
    htmlBytesRead: counters.htmlBytes,
    hashPasses: counters.hashPasses,
    bodyTransfers: counters.bodyTransfers,
  };
}

function observeClientCalls(trace) {
  const saved = ["json", "putBody"].map(name => [name, Object.getOwnPropertyDescriptor(SyncClient.prototype, name)]);
  let completed = 0;
  let sawFailure = false;
  const observe = (method, failed, error) => {
    completed += 1;
    if (failed && !sawFailure) {
      sawFailure = true;
      trace.emit("client-call", "failure", { method, completed, code: trace.errorCode(error) });
    } else if (completed % 25 === 0) {
      trace.emit("client-call", "completed", { method, completed, failed });
    }
  };
  const restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(SyncClient.prototype, name, descriptor);
    }
  };

  try {
    for (const [name, descriptor] of saved) {
      if (!descriptor || typeof descriptor.value !== "function") continue;

      Object.defineProperty(SyncClient.prototype, name, { ...descriptor, value: function (...args) {
        let result;
        try {
          result = Reflect.apply(descriptor.value, this, args);
        } catch (error) {
          observe(name, true, error);
          throw error;
        }

        // Side observations keep the exact original promise and settlement value/error.
        void result.then(() => observe(name, false), error => observe(name, true, error));
        return result;
      } });
    }
  } catch {
    restore();
    trace.emit("client-observer", "unavailable");
  }

  return restore;
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
async function runSync({ root, count, size = 10240, samples = 3, record, mode = "sync", trace }) {
  const phase = trace ? trace.phase : (_name, operation) => operation();
  let restoreClient;
  const cleanups = [];
  const tls = await phase("tls-create", () => createSyncHttpsCredentials({ after: (cleanup) => cleanups.push(cleanup) }));
  try {
    if (trace) restoreClient = observeClientCalls(trace);

    const ca = await readFile(tls.caPath);
    const key = await readFile(tls.trusted.keyPath);
    const cert = await readFile(tls.trusted.certPath);
    const bytes = htmlBytes(size);
    const input = { originalBytes: bytes, title: "Peer benchmark", type: "report", sourceFileName: "fixture.html" };

    for (let sample = 0; sample < samples; sample += 1) {
      const source = observedStore(path.join(root, `source-${sample}`));
      const destinationHome = path.join(root, `receiver-${sample}`);
      const destination = observedStore(destinationHome);
      await record(`managed/enroll/${count}`, async () => {
        await source.enroll();
        return { source: storageCounters(source) };
      });
      // Receiver enrollment is setup; only source enrollment is an operation sample.
      await phase("receiver-enroll", () => destination.enroll());
      await record(`managed/publish/${count}`, async () => {
        const before = storageCounters(source);
        for (let index = 0; index < count; index += 1) {
          await source.publish(input, `document-${index}`);
        }

        return { source: difference(storageCounters(source), before), bodyBytes: count * size };
      });
      await phase("source-body-assertions", () => assertDocuments(source, count, bytes));
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
        const { url } = await phase("server-start", () => server.start());
        const sourceLedger = await phase("setup-source-snapshot", () => source.snapshot());
        const destinationLedger = await phase("setup-receiver-snapshot", () => destination.snapshot());
        const route = {
          id: randomUUID(), revision: 1, direction: "outbound", peerId: destinationPeerId, peerUrl: url,
          sourceInboxId: sourceLedger.inboxId, destinationInboxId: destinationLedger.inboxId,
          localInboxName: "benchmark", readerAudience: "disposable synthetic fixture",
          allowedOrigins: [{ ...sourceLedger.originKeys[0] }], credentialRef: "synthetic_token",
          tlsTrustRef: "synthetic_ca", state: "active", lastError: null,
        };
        const outbound = await phase("setup-source-route", () => source.configureRoute(route));
        await phase("setup-receiver-route", () => destination.configureRoute({ ...route, direction: "inbound", peerId: sourcePeerId, peerUrl: "https://127.0.0.1:1" }));

        async function reconcile(label, expectedTransfers) {
          const beforeSource = storageCounters(source);
          const beforeDestination = storageCounters(destination);
          const beforeWire = server.status().counters;
          let currentPhase = "reconciliation";
          trace?.emit(currentPhase, "start", { pass: label });
          try {
            const result = await reconcileSyncRoutes({ store: source, peerId: sourcePeerId, credentials, routeIds: [outbound.id], deadlineMs: 300_000 });
            trace?.emit(currentPhase, "return", { pass: label });
            if (trace) {
              trace.emit("reconciliation-result", "observed", { pass: label,
                routes: result.routes.map(route => ({
                  status: ["confirmed", "pending", "blocked", "detached", "aborted"].includes(route.status) ? route.status : "unknown",
                  transferred: trace.number(route.transferred), confirmed: trace.number(route.confirmed),
                  pending: trace.number(route.pending), blocked: trace.number(route.blocked),
                  code: trace.code(route.lastError),
                })),
                counters: { requests: trace.number(result.counters.requests), requestBytes: trace.number(result.counters.requestBytes),
                  responseBytes: trace.number(result.counters.responseBytes) },
              });
            }

            currentPhase = "equivalence-assertions";
            trace?.emit(currentPhase, "start", { pass: label });
            assert.equal(result.routes.length, 1);
            assert.equal(result.routes[0].status, "confirmed", JSON.stringify(result));
            assert.equal(result.routes[0].transferred, expectedTransfers, label);
            const afterWire = server.status().counters;
            const sourceLedger = await source.snapshot();
            const receiverLedger = await destination.snapshot();
            assert.equal(Object.keys(sourceLedger.records).length, count);
            assert.equal(Object.keys(receiverLedger.records).length, count);
            assert.equal(Object.keys(sourceLedger.receipts).length, count);
            const receiverReceipts = new Map(Object.values(receiverLedger.receipts).map(receipt => [receipt.fingerprint, receipt]));
            for (const record of Object.values(sourceLedger.records)) {
              const key = canonicalKey(record.originInboxId, record.originDocumentId);
              const received = receiverLedger.records[key];
              assert.ok(received);
              assert.deepEqual(received.metadata, record.metadata);
              assert.equal(received.signature, record.signature);
              assert.equal(stateFingerprint(received), stateFingerprint(record));
              const receipt = receiverReceipts.get(stateFingerprint(record));
              assert.ok(receipt);
              assert.deepEqual(sourceLedger.receipts[receiptKey(receipt)], receipt);
              const obligation = sourceLedger.outbox[outboxKey(route.id, route.revision, key)];
              assert.ok(obligation);
              assert.equal(obligation.disposition, "confirmed");
              assert.equal(obligation.fingerprint, receipt.fingerprint);
              assert.equal(obligation.receiverStorageIncarnation, receipt.storageIncarnation);
              assert.equal(obligation.receiptDisposition, receipt.disposition);
            }

            trace?.emit(currentPhase, "return", { pass: label });
            return {
              transferred: result.routes[0].transferred,
              source: difference(storageCounters(source), beforeSource),
              receiver: difference(storageCounters(destination), beforeDestination),
              wire: difference(afterWire, beforeWire),
            };
          } catch (error) {
            trace?.emit(currentPhase, "failure", { pass: label, code: trace.errorCode(error) });
            throw error;
          }
        }

        await record(`peer/initial/${count}`, () => reconcile("initial", count));
        await phase("receiver-body-assertions", () => assertDocuments(destination, count, bytes), { pass: "initial" });
        const ledger = await phase("receiver-receipt-assertions", async () => {
          const ledger = await phase("receiver-receipt-snapshot", () => destination.snapshot(), { pass: "initial" });
          assert.equal(Object.keys(ledger.receipts).length, count);
          return ledger;
        }, { pass: "initial" });
        await record(`peer/noop/${count}`, () => reconcile("no-op", 0));

        if (count > 0) {
          const recordToRepair = Object.values(ledger.records)[0];
          assert.equal(typeof recordToRepair.bodyFile, "string");
          await phase("repair-remove-body", () => rm(path.join(destinationHome, "sync", "bodies", recordToRepair.bodyFile)));
          await record(`peer/repair/${count}`, () => reconcile("repair", 1));
          await phase("receiver-body-assertions", () => assertDocuments(destination, count, bytes), { pass: "repair" });
          await phase("receiver-receipt-assertions", async () => {
            const repaired = await phase("receiver-receipt-snapshot", () => destination.snapshot(), { pass: "repair" });
            assert.equal(Object.keys(repaired.receipts).length, count);
          }, { pass: "repair" });
        }
      } finally {
        await phase("server-close", async () => {
          await server.close();
          assert.equal(server.status().listening, false);
          assert.equal(server.status().sockets, 0);
        });
      }
    }
  } finally {
    trace?.emit("tls-cleanup", "start");
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
      trace?.emit("tls-cleanup", "return");
    } catch (error) {
      trace?.emit("tls-cleanup", "failure", { code: trace.errorCode(error) });
      throw error;
    } finally {
      restoreClient?.();
    }
  }
}

module.exports = { runSync };
