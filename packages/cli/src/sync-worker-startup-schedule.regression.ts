import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SyncClient, type SyncRequestOptions } from "./sync-client";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import * as lifecycle from "./sync-lifecycle";
import type { RouteAuthorization, SyncRoute } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { readWorkerRecordOffline } from "./sync-worker-records";
import { opaqueToken } from "./sync-wire";

// Staged for the separately granted red/green diagnosis. Promote to .test.ts
// after execution proves the regression and its causal correction.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const reconcileMs = 6000;

async function caughtUpFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-startup-schedule-")));
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }

    if (failures.length) {
      t.diagnostic(`Startup scheduling fixture retained at ${root}`);
      throw new AggregateError(failures, "Startup scheduling cleanup failed");
    }

    await rm(root, { recursive: true, force: true });
  });
  const tls = await createSyncHttpsCredentials({ after: (close) => {
    if (close) cleanup.push(async () => { await close(t, () => {}); });
  } });
  const home = path.join(root, "source");
  const source = new ManagedSyncStore(home);
  const receiver = new ManagedSyncStore(path.join(root, "receiver"));
  await source.enroll();
  await receiver.enroll();
  const a = await source.snapshot();
  const b = await receiver.snapshot();
  const token = opaqueToken();
  const tokenFile = path.join(root, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const server = createSyncIngestionServer({ store: receiver, peerId: b.inboxId, credentials: () => ({ token }), host: "127.0.0.1",
    key: await readFile(tls.trusted.keyPath), cert: await readFile(tls.trusted.certPath) });
  const { url } = await server.start();
  cleanup.push(async () => { await server.close(); await assertLoopbackClosed(url); });
  const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: url,
    sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: "fixture", readerAudience: "synthetic",
    allowedOrigins: [a.originKeys[0]], credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null };
  await source.configureRoute(route);
  await receiver.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: "https://127.0.0.1:1" });
  const config = defaultRuntimeConfig();
  await source.configureRuntime({ ...config, credentials: { token: tokenFile }, trust: { ca: tls.caPath },
    timings: { ...config.timings, reconcileMs } });
  await source.setWorkerEnabled(true);

  function retain(worker: Awaited<ReturnType<typeof startOwnedSyncWorker>>) {
    cleanup.push(async () => {
      await worker.close();
      await assertLoopbackClosed(worker.record.controlOrigin);
      assert.equal(await readWorkerRecordOffline(home), null);
    });
    return worker;
  }

  // Prepare genuine caught-up route state through one exclusively owned worker.
  const warm = retain(await startOwnedSyncWorker(home));
  const deadline = Date.now() + 10_000;
  while (true) {
    const ledger = await source.snapshot();
    if (ledger.worker.lastRunAt !== null && ledger.routes[route.id].state === "active" &&
        ledger.routeRetries[route.id]?.nextAttemptAt === 0 && ledger.routeRetries[route.id].lastError === null) break;

    assert.ok(Date.now() < deadline, "real caught-up route preparation must complete");
    await delay(10);
  }
  await warm.close();
  const caughtUp = await source.snapshot();
  assert.deepEqual(caughtUp.outbox, {});
  assert.equal(caughtUp.routeRetries[route.id].blocked, false);
  assert.equal((await receiver.snapshot()).routes[route.id].state, "active");

  async function start(mode: "paused" | "disabled-before-admission" | "temporary") {
    const writer = new ManagedSyncStore(home);
    await writer.setRetryPaused(mode !== "disabled-before-admission");
    await writer.setWorkerEnabled(mode !== "temporary");
    const clock = { wall: Date.now(), monotonic: 0 };
    const events: { type: string; at: number }[] = [];
    const admissions: { endpoint: string; at: number }[] = [];
    const reads: number[] = [];
    t.mock.method(Date, "now", () => clock.wall);
    t.mock.timers.enable({ apis: ["setInterval"] });
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === path.join(home, "sync", "ledger.json")) reads.push(clock.monotonic);
      return open(...args);
    });
    const json = SyncClient.prototype.json;
    t.mock.method(SyncClient.prototype, "json", function<T>(this: SyncClient, authorization: RouteAuthorization,
      endpoint: Parameters<SyncClient["json"]>[1], envelope: unknown, parse: (value: unknown) => T, maximum: number, options: SyncRequestOptions = {}) {
      admissions.push({ endpoint, at: clock.monotonic });
      return json.bind(this)(authorization, endpoint, envelope, parse, maximum, options);
    });
    if (mode === "disabled-before-admission") {
      const check = lifecycle.assertManagedLifecycle;
      let checks = 0;
      t.mock.method(lifecycle, "assertManagedLifecycle", async (directory: string) => {
        checks += 1;
        // Persistent disabled entry is forbidden. Disable after that preflight
        // and before the first background admission to reach the same no-pass branch.
        if (checks === 2) await writer.setWorkerEnabled(false);
        return check(directory);
      });
    }

    const worker = retain(await startOwnedSyncWorker(home, { temporary: mode === "temporary", testHooks: {
      wallNow: () => clock.wall, monotonicNow: () => clock.monotonic,
      onEvent: event => { events.push({ type: event.type, at: clock.monotonic }); },
    } }));
    await worker.tick();

    async function advance(milliseconds: number) {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) {
        clock.wall += 250;
        clock.monotonic += 250;
        await worker.tick();
      }
    }

    function observation() {
      return { at: clock.monotonic, passes: events.filter(event => event.type === "pass").length,
        gaps: events.filter(event => event.type === "gap").length, closed: events.some(event => event.type === "closed"),
        admissions: [...admissions], ledgerReads: [...reads] };
    }

    return { worker, writer, advance, observation };
  }

  return { home, source, retain, start };
}

for (const mode of ["paused", "disabled-before-admission"] as const) {
  test(`${mode} startup observes external enablement and periodic deadlines without wakes or clock gaps`, { timeout: 30_000 }, async (t) => {
    const f = await caughtUpFixture(t);
    const runtime = await f.start(mode);
    const before = runtime.observation();
    await runtime.advance(reconcileMs * 2);
    const blocked = runtime.observation();
    assert.equal(blocked.passes, 0);
    assert.deepEqual(blocked.admissions, []);
    assert.equal(blocked.gaps, 0);
    assert.equal(blocked.closed, false);
    assert.ok(blocked.ledgerReads.length - before.ledgerReads.length >= 2, "paused/disabled startup still performs five-second full refreshes");

    if (mode === "paused") await runtime.writer.setRetryPaused(false);
    else await runtime.writer.setWorkerEnabled(true);
    const enabled = await runtime.writer.snapshot();
    assert.equal(enabled.worker.enabled, true);
    assert.equal(enabled.worker.retryPaused, false);
    assert.deepEqual(enabled.outbox, {});
    assert.ok(Object.values(enabled.routeRetries).every(retry => retry.nextAttemptAt === 0 && !retry.blocked));

    const periods = [];
    for (let index = 0; index < 3; index += 1) {
      await runtime.advance(reconcileMs + (index === 0 ? 250 : 0));
      periods.push(runtime.observation());
    }
    t.diagnostic(JSON.stringify({ mode, blocked, periods }));
    assert.equal(periods[2].closed, false, "a fatal fixture shutdown must not be misreported as periodic starvation");
    assert.equal(periods[2].gaps, 0, "a gap wake must not hide periodic starvation");
    assert.ok(periods[0].passes >= 1, "external enablement must arm the first bounded periodic pass");
    assert.ok(periods[2].passes >= 3, "five-second validations must not perpetually reset a six-second deadline");
    assert.ok(periods[2].admissions.length > 0, "a real caught-up route must admit actual protocol requests");
  });
}

test("temporary paused startup remains foreground-only after external unpause and enable", { timeout: 30_000 }, async (t) => {
  const f = await caughtUpFixture(t);
  const runtime = await f.start("temporary");
  await runtime.advance(reconcileMs * 2);
  await runtime.writer.setRetryPaused(false);
  await runtime.writer.setWorkerEnabled(true);
  await runtime.advance(reconcileMs * 3);
  const idle = runtime.observation();
  t.diagnostic(JSON.stringify(idle));
  assert.equal(idle.passes, 0);
  assert.equal(idle.gaps, 0);
  assert.deepEqual(idle.admissions, []);

  runtime.worker.requestRun({ ticketId: randomUUID(), deadlineAt: Date.now() + 10_000, requestMs: 5000 });
  await runtime.worker.tick();
  assert.equal(runtime.observation().passes, 1, "explicit foreground work remains available to temporary workers");
  assert.ok(runtime.observation().admissions.length > 0);
});

test("a persistently disabled worker cannot bypass startup enablement preflight", { timeout: 30_000 }, async (t) => {
  const f = await caughtUpFixture(t);
  await f.source.setWorkerEnabled(false);
  await assert.rejects(startOwnedSyncWorker(f.home), /explicitly enabled/);
  assert.equal(await readWorkerRecordOffline(f.home), null);
});
