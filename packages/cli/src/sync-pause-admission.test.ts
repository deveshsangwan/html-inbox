import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import platformTest from "node:test";
import { reconcileSyncRoutes, routeAuthorization } from "./sync-reconciliation";
import { ManagedSyncStore } from "./sync-store";
import { assertReceiverCommitted, createCliPair, onlyOriginal, syntheticBytes } from "./sync-worker-fault-fixtures";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

test("persisted pause during nested request admission preserves delivery and remotely initiated attempts", { timeout: 30_000 }, async (t) => {
  const f = await createCliPair(t);
  await f.source.store.publish({ originalBytes: syntheticBytes, title: "Pause admission", type: "report", sourceFileName: "pause.html" }, "paused-publication");
  const { record } = await onlyOriginal(f.source);
  const before = await f.source.store.snapshot();
  const route = before.routes[f.route.id];
  const authorization = routeAuthorization(route);
  const pauseWriter = new ManagedSyncStore(f.source.home);
  const remoteAttempt = await f.source.store.openRouteAttempt(authorization);
  // Fixture resources close before their homes are removed; a later test hook would leave this watcher running.
  f.resources.push(() => remoteAttempt.close());
  const parent = new AbortController();
  let credentialCalls = 0;
  const credentials = { token: (await readFile(f.sourceConfig.credentials.token, "utf8")).trim(), ca: await readFile(f.tls.caPath) };
  const reconcile = () => reconcileSyncRoutes({ store: f.source.store, peerId: f.sourceId, routeIds: [route.id], signal: parent.signal,
    credentials: () => { credentialCalls += 1; return credentials; }, requestMs: 5000, deadlineMs: 15_000 });
  const openAttempt = f.source.store.openRouteAttempt.bind(f.source.store);
  let localAdmissions = 0;
  let outerSignal: AbortSignal | undefined;
  const rejectedAdmissions: Array<{ error: unknown; outerAborted: boolean }> = [];
  const intercepted = t.mock.method(f.source.store, "openRouteAttempt", async (...args: Parameters<typeof openAttempt>) => {
    const attempt = await openAttempt(...args).catch((error: unknown) => {
      rejectedAdmissions.push({ error, outerAborted: outerSignal?.aborted ?? false });
      throw error;
    });
    localAdmissions += 1;
    if (localAdmissions === 1) {
      outerSignal = attempt.signal;
      // A separate store persists pause as another process would, after the outer pass was admitted.
      await pauseWriter.setRetryPaused(true);
    }

    return attempt;
  });

  // Admission must observe pause before the periodic cancellation watcher gets its next turn.
  t.mock.timers.enable({ apis: ["setInterval"] });
  let result: Awaited<ReturnType<typeof reconcile>>;
  try {
    result = await reconcile();
  } finally {
    t.mock.timers.reset();
    intercepted.mock.restore();
  }

  assert.equal(parent.signal.aborted, false);
  assert.equal(remoteAttempt.signal.aborted, false, "pause must preserve remotely initiated communication in the same home");
  assert.equal(localAdmissions, 1, "nested request admission must reject the persisted pause");

  assert.equal(rejectedAdmissions.length, 1);
  const [rejection] = rejectedAdmissions;
  assert.ok(rejection.error instanceof Error);
  assert.equal(rejection.error.message, "Locally initiated sync is persistently paused");
  assert.equal(rejection.outerAborted, true, "pause must cancel the outer attempt before nested admission rejects");

  assert.equal(credentialCalls, 0);
  assert.equal(result.counters.requests, 0);
  assert.equal(result.routes[0].status, "aborted");
  const paused = await f.source.store.snapshot();
  assert.equal(paused.worker.retryPaused, true);
  assert.deepEqual(paused.routes, before.routes);
  assert.deepEqual(paused.routeRetries, before.routeRetries);
  assert.deepEqual(paused.outbox, before.outbox);
  assert.deepEqual(paused.receipts, before.receipts);

  await pauseWriter.setRetryPaused(false);
  const resumed = await reconcile();
  assert.equal(resumed.routes[0].status, "confirmed");
  assert.ok(resumed.counters.requests > 0);
  assert.equal((await f.source.store.deliveryStatus(route.id, f.sourceId, record.originDocumentId)).isCommitted, true);
  await assertReceiverCommitted(f.destination, f.sourceId, record.originDocumentId);
});
