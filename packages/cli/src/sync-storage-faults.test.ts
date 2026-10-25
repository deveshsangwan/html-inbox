import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { cp, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock, test as platformTest, type TestContext } from "node:test";
import { ensurePrivateDirectory, writePrivateFile } from "./private-storage";
import { createOneShotStorageFault, type StorageEvent } from "./sync-files";
import { outboxKey, parseLedger, type DurableReceipt } from "./sync-ledger";
import { canonicalKey, inventoryDigest, MANIFEST_DOMAIN, parseObject, parseAuthorization, parseOriginState, sha256, stateFingerprint,
  type CompleteInventory, type OriginGrant, type OriginState, type RouteAuthorization, type SyncRoute } from "./sync-model";
import { MANAGED_FORMAT_BARRIER, ManagedSyncStore, toOriginState } from "./sync-store";
import { temporaryHome } from "./test-fixtures";

// Managed durability requires POSIX directory fsync; Windows opt-in rejection has its own active regression.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const body = Buffer.from("<!doctype html><html><head><title>Fault fixture</title></head><body>Synthetic storage fixture</body></html>");
const input = { originalBytes: body, title: "Fault fixture", type: "report", sourceFileName: "fixture.html" };
const commitEvents: StorageEvent[] = ["ledger-temp-written", "ledger-temp-fsynced", "ledger-renamed", "ledger-dir-fsynced"];
const bodyEvents: StorageEvent[] = ["body-staged", "body-flushed", "body-installed", "body-directory-flushed"];
const childOperations = ["enroll", "publish", "delete", "apply", "acknowledge", "metadata", "recover", "legacy-prepared", "legacy-staged"];

interface ChildConfiguration {
  home: string;
  operation: string;
  event?: StorageEvent;
  occurrence?: number;
  authorization?: RouteAuthorization;
  descriptor?: OriginState;
  receipt?: DurableReceipt;
}

if (process.argv[2] === "--storage-fault-child") {
  void runStorageChild().catch(async (error: unknown) => {
    await sendChildMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    process.disconnect?.();
  });
} else {
  registerStorageFaultTests();
}

function registerStorageFaultTests() {
  test("enrollment flushes a canonical parent owned by another account without treating it as managed storage", { timeout: 10_000 }, async (t) => {
    const home = await temporaryHome(t);
    const store = new ManagedSyncStore(home);
    await store.enroll();
    await store.publish(input, "Owned-Inbox-Shared-Parent");
    await new ManagedSyncStore(home).recover();
    assert.deepEqual((await store.getDocument("Owned-Inbox-Shared-Parent"))?.originalBytes, body);
    await assertNoLock(home);
  });

  test("migration survives killed intent, evacuation, barrier, enumeration, and persisted enrollment batches", { timeout: 40_000 }, async (t) => {
    const cuts: { event: StorageEvent; occurrence?: number }[] = [
      { event: "migration-intent" }, { event: "migration-evacuated" }, { event: "migration-barrier" },
      { event: "migration-enumeration" }, { event: "ledger-renamed", occurrence: 3 },
    ];

    for (const cut of cuts) {
      await t.test(`${cut.event} occurrence ${cut.occurrence ?? 1}`, async (t) => {
        const home = await storageHome(t);
        const ids = Array.from({ length: 35 }, (_, index) => `Legacy-ID-${String(index).padStart(2, "0")}`);
        for (const id of ids) {
          await seedLegacyDocument(home, id);
        }

        const child = storageChild(t, { home, operation: "enroll", ...cut });
        await child.killAtFault(cut.event);
        const store = new ManagedSyncStore(home);
        await store.recover();
        const first = await store.snapshot();
        await new ManagedSyncStore(home).recover();
        await store.enroll();
        const recovered = await store.snapshot();

        assert.deepEqual(recovered, first, "repeated recovery must preserve versions, identities, and enrollment progress");
        assert.equal(recovered.migration.phase, "complete");
        assert.deepEqual([...recovered.migration.enrolledIds].sort(), ids);
        assert.equal(Object.keys(recovered.records).length, ids.length);
        assert.equal(await readFile(path.join(home, "documents"), "utf8"), MANAGED_FORMAT_BARRIER);
        for (const id of ids) {
          const record = recovered.records[canonicalKey(recovered.inboxId, id)];
          assert(record);
          assert.equal(record.state, "live");
          assert.equal(record.metadata.id, id);
          assert.equal(record.version, ids.indexOf(id) + 1);
          assert.deepEqual((await store.getDocument(id))?.originalBytes, body);
        }

        await assertNoLock(home);
      });
    }
  });

  test("phase1 publishers past preparation fail against the barrier before changing managed originals", { timeout: 20_000 }, async (t) => {
    for (const operation of ["legacy-prepared", "legacy-staged"]) {
      await t.test(operation, async (t) => {
        const home = await storageHome(t);
        await seedLegacyDocument(home, "Preserved-Legacy");
        const child = storageChild(t, { home, operation });
        await child.waitFor("legacy-ready");
        const store = new ManagedSyncStore(home);
        await store.enroll();
        const before = await store.snapshot();
        child.resume();
        const result = await child.waitFor("legacy-blocked");
        assert.equal(result.writesAfterPause, 0);
        assert.match(String(result.message), /ENOTDIR|not a regular directory|EEXIST/);
        await child.expectExit(0);

        assert.deepEqual(await store.snapshot(), before);
        assert.deepEqual((await store.getDocument("Preserved-Legacy"))?.originalBytes, body);
        assert.equal(await readFile(path.join(home, "documents"), "utf8"), MANAGED_FORMAT_BARRIER);
        assert.equal((await store.listDocuments()).length, 1);
      });
    }

    await t.test("a phase1 rename completed before evacuation is enrolled", async (t) => {
      const home = await storageHome(t);
      const child = storageChild(t, { home, operation: "legacy-staged" });
      await child.waitFor("legacy-ready");
      child.resume();
      await child.waitFor("legacy-published");
      await child.expectExit(0);
      const store = new ManagedSyncStore(home);
      await store.enroll();
      assert.deepEqual((await store.getDocument("Legacy-Late"))?.originalBytes, body);
    });
  });

  test("a recreated documents directory blocks migration instead of merging or inferring deletes", { timeout: 10_000 }, async (t) => {
    const home = await storageHome(t);
    await seedLegacyDocument(home, "Evacuated-Legacy");
    const child = storageChild(t, { home, operation: "enroll", event: "migration-evacuated" });
    await child.killAtFault("migration-evacuated");
    await seedLegacyDocument(home, "Racing-Legacy");
    const before = await rawLedger(home);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(new ManagedSyncStore(home).recover(), /recreated documents/);
      assert.deepEqual(await rawLedger(home), before);
      assert.deepEqual(await readFile(path.join(home, "documents", "Racing-Legacy", "index.html")), body);
      assert.deepEqual(await readFile(path.join(home, "sync", "legacy-documents", "Evacuated-Legacy", "index.html")), body);
    }

    assert.equal(Object.values(before.records).filter((record) => record.state === "deleted").length, 0);
    await assertNoLock(home);
  });

  test("actual corrupt and incomplete legacy directory entries block complete enrollment", { timeout: 20_000 }, async (t) => {
    for (const corruption of ["missing-body", "missing-metadata", "invalid-json", "unknown-metadata", "wrong-case", "symlink", "stray-file"]) {
      await t.test(corruption, async (t) => {
        const home = await storageHome(t);
        await seedLegacyDocument(home, "A-Valid");
        await seedLegacyDocument(home, "Z-Corrupt");
        const candidate = path.join(home, "documents", "Z-Corrupt");
        if (corruption === "missing-body") await rm(path.join(candidate, "index.html"));
        if (corruption === "missing-metadata") await rm(path.join(candidate, "metadata.json"));
        if (corruption === "invalid-json") await writeFile(path.join(candidate, "metadata.json"), "{");
        if (corruption === "unknown-metadata") await writeFile(path.join(candidate, "metadata.json"), JSON.stringify({ ...legacyMetadata("Z-Corrupt"), unsupported: true }));
        if (corruption === "wrong-case") await writeFile(path.join(candidate, "metadata.json"), JSON.stringify(legacyMetadata("z-corrupt")));
        if (corruption === "symlink") {
          await rm(path.join(candidate, "index.html"));
          await symlink(path.join(home, "documents", "A-Valid", "index.html"), path.join(candidate, "index.html"));
        }
        if (corruption === "stray-file") await writeFile(path.join(home, "documents", "Unexpected"), "not a directory");

        await assert.rejects(new ManagedSyncStore(home).enroll());
        const before = await rawLedger(home);
        assert.notEqual(before.migration.phase, "complete");
        assert.equal(Object.values(before.records).filter((record) => record.state === "deleted").length, 0);
        await assert.rejects(new ManagedSyncStore(home).recover());
        assert.notEqual((await rawLedger(home)).migration.phase, "complete");
        await assert.rejects(new ManagedSyncStore(home).listDocuments(), /incomplete/);
        assert((await lstat(path.join(home, "sync", "legacy-documents", "Z-Corrupt"))).isDirectory());
        assert.equal(await readFile(path.join(home, "documents"), "utf8"), MANAGED_FORMAT_BARRIER);
        await assertNoLock(home);
      });
    }
  });

  test("SIGKILL publication cuts recover the descriptor and outbox in the same ledger snapshot", { timeout: 40_000 }, async (t) => {
    for (const event of [...bodyEvents, ...commitEvents]) {
      await t.test(event, async (t) => {
        const { home, store } = await enrolledStore(t);
        const before = await store.snapshot();
        const route = outboundRoute(before.inboxId, ownerGrant(before));
        await configureReadyRoute(store, route);
        const child = storageChild(t, { home, operation: "publish", event });
        await child.killAtFault(event);
        const recovered = new ManagedSyncStore(home);
        await recovered.recover();
        const ledger = await recovered.snapshot();
        const key = canonicalKey(ledger.inboxId, "Crash-Original");
        const record = ledger.records[key];
        const isCommitted = event === "ledger-renamed" || event === "ledger-dir-fsynced";

        assert.equal(!!record, isCommitted);
        assert.equal(Object.keys(ledger.receipts).length, 0);
        assert.equal(Object.keys(ledger.outbox).length, isCommitted ? 1 : 0);
        if (record) {
          assert.equal(record.sha256, sha256(body));
          assert.equal(record.byteLength, body.length);
          assert.equal(record.state, "live");
          assert.deepEqual((await recovered.getDocument(record.localId))?.originalBytes, body);
          assertPending(ledger, route, record);
        }

        const stable = await recovered.snapshot();
        await recovered.recover();
        assert.deepEqual(await recovered.snapshot(), stable);
        await assertNoLock(home);
      });
    }
  });

  test("SIGKILL receiver cuts never return a receipt early and recover onward obligations with installation", { timeout: 50_000 }, async (t) => {
    for (const event of [...bodyEvents, ...commitEvents, "committed-before-receipt"] satisfies StorageEvent[]) {
      await t.test(event, async (t) => {
        const fixture = await relayFixture(t);
        const { home, store, inbound, onward, state } = fixture;
        const child = storageChild(t, { home, operation: "apply", event, authorization: authorization(inbound), descriptor: state });
        await child.killAtFault(event);
        const recovered = new ManagedSyncStore(home);
        await recovered.recover();
        const ledger = await recovered.snapshot();
        const record = ledger.records[canonicalKey(state.originInboxId, state.originDocumentId)];
        const isCommitted = ["ledger-renamed", "ledger-dir-fsynced", "committed-before-receipt"].includes(event);

        assert.equal(!!record, isCommitted);
        assert.equal(Object.keys(ledger.receipts).length, isCommitted ? 1 : 0);
        assert.equal(Object.keys(ledger.outbox).length, isCommitted ? 1 : 0);
        assert.deepEqual((await store.getDocument("Destination-Original"))?.originalBytes, body);
        if (record) {
          assert.deepEqual(toOriginState(record), state);
          assert.deepEqual(record.contributions, [{ routeId: inbound.id, revision: 1, state: "attached" }]);
          assert.deepEqual((await recovered.getDocument(record.localId))?.originalBytes, body);
          assertPending(ledger, onward, state);
          const receipt = Object.values(ledger.receipts)[0];
          assert(receipt);
          assert.equal(receipt.disposition, "committed");
          assert.equal(receipt.storageIncarnation, ledger.storageIncarnation);
        }

        const result = await recovered.apply(authorization(inbound), state, isCommitted ? undefined : body);
        assert.equal(result.status, "committed");
        assert.equal(Object.keys((await recovered.snapshot()).outbox).length, 1);
        assert.equal((await recovered.listDocuments()).length, 2);
        await assertNoLock(home);
      });
    }
  });

  test("owner delete cuts atomically supersede pending live work and retain terminal evidence", { timeout: 25_000 }, async (t) => {
    for (const event of commitEvents) {
      await t.test(event, async (t) => {
        const { home, store } = await enrolledStore(t);
        await store.publish(input, "Crash-Original");
        const before = await store.snapshot();
        const route = outboundRoute(before.inboxId, ownerGrant(before));
        await configureReadyRoute(store, route);
        const key = canonicalKey(before.inboxId, "Crash-Original");
        const previous = before.records[key];
        assert(previous);
        const child = storageChild(t, { home, operation: "delete", event });
        await child.killAtFault(event);
        const recovered = new ManagedSyncStore(home);
        await recovered.recover();
        const ledger = await recovered.snapshot();
        const record = ledger.records[key];
        assert(record);
        const isCommitted = event === "ledger-renamed" || event === "ledger-dir-fsynced";

        assert.equal(record.state, isCommitted ? "deleted" : "live");
        assert.equal(record.version, previous.version + Number(isCommitted));
        assert.equal(record.sha256, previous.sha256);
        assert.equal(record.bodyFile, previous.bodyFile);
        assertPending(ledger, route, record);
        assert.equal((await recovered.listDocuments()).length, isCommitted ? 0 : 1);
        assert.deepEqual(await readFile(path.join(home, "sync", "bodies", String(record.bodyFile))), body);
        await recovered.recover();
        assert.deepEqual(await recovered.snapshot(), ledger);
      });
    }
  });

  test("killed relay tombstones dominate stale live retries and keep onward deletion pending", { timeout: 15_000 }, async (t) => {
    for (const event of ["ledger-renamed", "committed-before-receipt"] satisfies StorageEvent[]) {
      await t.test(event, async (t) => {
        const fixture = await relayFixture(t);
        await fixture.store.apply(authorization(fixture.inbound), fixture.state, body);
        await fixture.origin.deleteDocument(fixture.state.originDocumentId);
        const originLedger = await fixture.origin.snapshot();
        const deleted = originLedger.records[canonicalKey(fixture.state.originInboxId, fixture.state.originDocumentId)];
        assert(deleted);
        const child = storageChild(t, { home: fixture.home, operation: "apply", event,
          authorization: authorization(fixture.inbound), descriptor: toOriginState(deleted) });
        await child.killAtFault(event);
        const recovered = new ManagedSyncStore(fixture.home);
        await recovered.recover();
        const stale = await recovered.apply(authorization(fixture.inbound), fixture.state);
        assert.equal(stale.status, "superseded");
        assert("receipt" in stale);
        assert.equal(stale.receipt.originState.state, "deleted");
        const ledger = await recovered.snapshot();
        const record = ledger.records[canonicalKey(deleted.originInboxId, deleted.originDocumentId)];
        assert(record);
        assert.deepEqual(toOriginState(record), toOriginState(deleted));
        assertPending(ledger, fixture.onward, deleted);
        assert.equal((await recovered.listDocuments()).length, 1);
        assert.equal((await recovered.listDocuments())[0]?.id, "Destination-Original");
      });
    }
  });

  test("receipt persistence interrupted before retirement stays recoverable without claiming onward success", { timeout: 10_000 }, async (t) => {
    const fixture = await relayFixture(t);
    const sourceLedger = await fixture.origin.snapshot();
    const outbound = outboundRoute(sourceLedger.inboxId, ownerGrant(sourceLedger), fixture.inbound.destinationInboxId, fixture.inbound.id);
    await configureReadyRoute(fixture.origin, outbound);
    const applied = await fixture.store.apply(authorization(fixture.inbound), fixture.state, body);
    assert("receipt" in applied);
    const child = storageChild(t, { home: fixture.originHome, operation: "acknowledge", event: "receipt-before-retirement",
      authorization: authorization(outbound), receipt: applied.receipt });
    await child.killAtFault("receipt-before-retirement");
    const recovered = new ManagedSyncStore(fixture.originHome);
    await recovered.recover();
    const ledger = await recovered.snapshot();
    assert.equal(Object.keys(ledger.receipts).length, 1);
    assertPending(ledger, outbound, fixture.state);
    await recovered.acknowledge(authorization(outbound), applied.receipt);
    const final = await recovered.snapshot();
    assert.equal(Object.keys(final.receipts).length, 1);
    assert.equal(final.outbox[outboxKey(outbound.id, 1, canonicalKey(fixture.state.originInboxId, fixture.state.originDocumentId))]?.disposition, "confirmed");
    assertPending(await fixture.store.snapshot(), fixture.onward, fixture.state);
  });

  test("one-shot EIO and ENOSPC faults fail exactly once and fence uncertain mutations until recovery", { timeout: 30_000 }, async (t) => {
    for (const code of ["EIO", "ENOSPC"]) {
      for (const event of [...bodyEvents, ...commitEvents]) {
        await t.test(`${code} at ${event}`, async (t) => {
          const { home, store } = await enrolledStore(t);
          const initial = await store.snapshot();
          const route = outboundRoute(initial.inboxId, ownerGrant(initial));
          await configureReadyRoute(store, route);
          const injected = Object.assign(new Error(`Synthetic ${code} at ${event}`), { code });
          const fault = createOneShotStorageFault(event, () => { throw injected; });
          const writer = new ManagedSyncStore(home, { testHooks: fault.hooks });
          await writer.recover();
          await assert.rejects(writer.publish(input, "Fault-Original"), (error: unknown) => error === injected);
          assert.deepEqual(fault.proof(), { event, armed: false, hits: 1 });

          if (["body-installed", "body-directory-flushed", "ledger-renamed", "ledger-dir-fsynced"].includes(event)) {
            const before = await rawLedger(home);
            await assert.rejects(writer.publish(input, "Forbidden-While-Uncertain"), /uncertain|recovery required/);
            assert.deepEqual(await rawLedger(home), before);
          }

          await writer.recover();
          const recovered = await writer.snapshot();
          const record = recovered.records[canonicalKey(recovered.inboxId, "Fault-Original")];
          assert.equal(!!record, event === "ledger-renamed" || event === "ledger-dir-fsynced");
          assert.equal(Object.keys(recovered.receipts).length, 0);
          if (record) assertPending(recovered, route, record);
          await writer.publish(input, "After-Recovery");
          assert.equal((await writer.getDocument("After-Recovery"))?.originalBytes.length, body.length);
          assert.deepEqual(fault.proof(), { event, armed: false, hits: 1 });
          await assertNoLock(home);
        });
      }
    }
  });

  test("receiver durability errors return no custody receipt and recover the complete onward mutation", { timeout: 25_000 }, async (t) => {
    for (const code of ["EIO", "ENOSPC"]) {
      for (const event of [...commitEvents, "committed-before-receipt"] satisfies StorageEvent[]) {
        await t.test(`${code} at ${event}`, async (t) => {
          const fixture = await relayFixture(t);
          const injected = Object.assign(new Error(`Synthetic receiver ${code}`), { code });
          const fault = createOneShotStorageFault(event, () => { throw injected; });
          const receiver = new ManagedSyncStore(fixture.home, { testHooks: fault.hooks });
          await receiver.recover();
          const auth = authorization(fixture.inbound);
          await assert.rejects(receiver.apply(auth, fixture.state, body), (error: unknown) => error === injected);
          assert.deepEqual(fault.proof(), { event, armed: false, hits: 1 });
          if (event === "ledger-renamed" || event === "ledger-dir-fsynced") {
            await assert.rejects(receiver.apply(auth, fixture.state), /uncertain/);
          }

          await receiver.recover();
          const ledger = await receiver.snapshot();
          const isCommitted = ["ledger-renamed", "ledger-dir-fsynced", "committed-before-receipt"].includes(event);
          assert.equal(Object.keys(ledger.receipts).length, isCommitted ? 1 : 0);
          assert.equal(Object.keys(ledger.outbox).length, isCommitted ? 1 : 0);
          if (isCommitted) assertPending(ledger, fixture.onward, fixture.state);
          const retried = await receiver.apply(auth, fixture.state, isCommitted ? undefined : body);
          assert.equal(retried.status, "committed");
          assert.equal(Object.keys((await receiver.snapshot()).receipts).length, 1);
          assertPending(await receiver.snapshot(), fixture.onward, fixture.state);
          assert.equal(fault.proof().hits, 1);
          await assertNoLock(fixture.home);
        });
      }
    }
  });

  test("armed durability hooks inject one real file or directory sync rejection before recovery", { timeout: 20_000 }, async (t) => {
    const phases: { name: string; event: StorageEvent; uncertain: boolean; committed: boolean; matches: (file: string, home: string) => boolean }[] = [
      { name: "body file", event: "body-staged", uncertain: false, committed: false, matches: (file) => file.endsWith(".stage") },
      { name: "ledger file", event: "ledger-temp-written", uncertain: false, committed: false, matches: (file) => path.basename(file).startsWith("ledger.json.tmp-") },
      { name: "body directory", event: "body-installed", uncertain: true, committed: false, matches: (file, home) => file === path.join(home, "sync", "bodies") },
      { name: "ledger directory", event: "ledger-renamed", uncertain: true, committed: true, matches: (file, home) => file === path.join(home, "sync") },
    ];
    for (const code of ["EIO", "ENOSPC"]) {
      for (const phase of phases) {
        await t.test(`${code} from ${phase.name} sync`, async (t) => {
          const { home, store } = await enrolledStore(t);
          const initial = await store.snapshot();
          const route = outboundRoute(initial.inboxId, ownerGrant(initial));
          await configureReadyRoute(store, route);
          let isSyncArmed = false;
          let syncHits = 0;
          const injected = Object.assign(new Error(`Synthetic ${code} from ${phase.name} sync`), { code });
          const fault = createOneShotStorageFault(phase.event, () => { isSyncArmed = true; });
          const originalOpen = fs.open;
          t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
            const handle = await originalOpen(...args);
            if (phase.matches(String(args[0]), home)) {
              const originalSync = handle.sync;
              t.mock.method(handle, "sync", async () => {
                if (isSyncArmed) {
                  isSyncArmed = false;
                  syncHits += 1;
                  throw injected;
                }

                return originalSync.call(handle);
              });
            }

            return handle;
          });

          const writer = new ManagedSyncStore(home, { testHooks: fault.hooks });
          await writer.recover();
          await assert.rejects(writer.publish(input, "Sync-Failed"), (error: unknown) => error === injected);
          assert.equal(syncHits, 1);
          assert.equal(isSyncArmed, false);
          assert.deepEqual(fault.proof(), { event: phase.event, armed: false, hits: 1 });
          if (phase.uncertain) await assert.rejects(writer.publish(input, "Blocked-Sync"), /uncertain/);

          await writer.recover();
          const ledger = await writer.snapshot();
          const record = ledger.records[canonicalKey(ledger.inboxId, "Sync-Failed")];
          assert.equal(!!record, phase.committed);
          assert.equal(Object.keys(ledger.receipts).length, 0);
          assert.equal(Object.keys(ledger.outbox).length, Number(phase.committed));
          if (record) assertPending(ledger, route, record);
          await writer.publish(input, "After-Sync-Recovery");
          assert.equal(syncHits, 1);
          assert.equal((await writer.listDocuments()).length, phase.committed ? 2 : 1);
          await assertNoLock(home);
        });
      }
    }
  });

  test("a live child lock cannot be stolen and a killed owner is reaped on repeated recovery", { timeout: 12_000 }, async (t) => {
    const { home, store } = await enrolledStore(t);
    const child = storageChild(t, { home, operation: "publish", event: "body-staged" });
    await child.waitFor("fault");
    const lockPath = path.join(home, "sync", "mutation.lock");
    const locked = await readFile(lockPath, "utf8");
    const contender = new ManagedSyncStore(home, { lockDeadlineMs: 100 });

    await assert.rejects(contender.recover(), /lock deadline/);
    await assert.rejects(contender.publish(input, "Cannot-Steal"), /lock deadline/);
    assert.equal(await readFile(lockPath, "utf8"), locked);
    assert.deepEqual(await store.snapshot(), await rawLedger(home));
    await child.killAtFault("body-staged");
    await contender.recover();
    await contender.recover();
    await contender.publish(input, "After-Dead-Owner");
    assert.equal((await contender.listDocuments()).length, 1);
    await assertNoLock(home);
  });

  test("unknown, live, PID-reused, and abandoned reaper records obey conclusive ownership checks", { timeout: 12_000 }, async (t) => {
    const { home, store } = await enrolledStore(t);
    const lockPath = path.join(home, "sync", "mutation.lock");
    const refusalStore = new ManagedSyncStore(home, { lockDeadlineMs: 60 });
    for (const contents of ["", "{", "{}", JSON.stringify({ token: randomUUID(), pid: process.pid, start: null })]) {
      await writeFile(lockPath, contents, { mode: 0o600 });
      await assert.rejects(refusalStore.recover(), /lock deadline/);
      assert.equal(await readFile(lockPath, "utf8"), contents);
      await assert.rejects(lstat(`${lockPath}.reap`), { code: "ENOENT" });
    }

    await rm(lockPath);
    const dead = JSON.stringify({ token: randomUUID(), pid: 2_147_483_647, start: null });
    await writeFile(lockPath, dead, { mode: 0o600 });
    await writeFile(`${lockPath}.reap`, "interrupted-reaper", { mode: 0o600 });
    await assert.rejects(refusalStore.recover(), /lock deadline/);
    assert.equal(await readFile(lockPath, "utf8"), dead);
    assert.equal(await readFile(`${lockPath}.reap`, "utf8"), "interrupted-reaper");
    await rm(`${lockPath}.reap`);
    await store.recover();
    await assertNoLock(home);

    if (process.platform === "linux") {
      const reused = JSON.stringify({ token: randomUUID(), pid: process.pid, start: "different-boot:0" });
      await writeFile(lockPath, reused, { mode: 0o600 });
      await store.recover();
      process.kill(process.pid, 0);
      await assertNoLock(home);
    }

    await writeFile(lockPath, JSON.stringify({ token: randomUUID(), pid: process.pid, start: null }), { mode: 0o600 });
    const originalKill = process.kill;
    const probe = t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === process.pid && signal === 0) throw Object.assign(new Error("Synthetic inconclusive process probe"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    await assert.rejects(refusalStore.recover(), /lock deadline/);
    probe.mock.restore();
    assert.equal(parseObject(JSON.parse(await readFile(lockPath, "utf8")), "lock owner").pid, process.pid);
    await rm(lockPath);
  });

  test("a restarted store and metadata mutations open zero HTML files at the filesystem boundary", { timeout: 10_000 }, async (t) => {
    const { home, store } = await enrolledStore(t);
    for (let index = 0; index < 4; index += 1) await store.publish(input, `Metadata-${index}`);
    const ledger = await store.snapshot();
    const route = outboundRoute(ledger.inboxId, ownerGrant(ledger));
    await configureReadyRoute(store, route);
    const child = storageChild(t, { home, operation: "metadata", authorization: authorization(route) });
    const result = await child.waitFor("done");
    await child.expectExit(0);

    assert.equal(result.startupBodyOpens, 0, "recovery must not reopen bodies for fsync");
    assert.equal(result.metadataBodyOpens, 0, "metadata-only methods must not open bodies");
    assert.equal(result.metadataCounterOpens, 0);
    assert.equal(result.metadataCounterBytes, 0);
    assert.equal(result.metadataHashPasses, 0);
    assert.equal(result.calibrationBodyOpens, 1, "the boundary probe must observe a real getDocument body open");
    assert.equal(result.calibrationCounterOpens, 1);
    assert.equal(result.calibrationCounterBytes, body.length);
  });

  test("restarted receiver holdings, repeat offers, and complete inventory retries open zero HTML bodies", { timeout: 10_000 }, async (t) => {
    const fixture = await relayFixture(t);
    await fixture.store.apply(authorization(fixture.inbound), fixture.state, body);
    const child = storageChild(t, { home: fixture.home, operation: "metadata", authorization: authorization(fixture.inbound), descriptor: fixture.state });
    const result = await child.waitFor("done");
    await child.expectExit(0);
    assert.equal(result.startupBodyOpens, 0);
    assert.equal(result.metadataBodyOpens, 0);
    assert.equal(result.metadataCounterOpens, 0);
    assert.equal(result.metadataCounterBytes, 0);
    assert.equal(result.metadataHashPasses, 0);
    assert.equal(result.calibrationBodyOpens, 1);
    assert.equal(result.calibrationCounterOpens, 1);
    assert.equal(result.calibrationCounterBytes, body.length);
    assert.equal(Object.keys((await fixture.store.snapshot()).receipts).length, 1);
  });

  test("clone and move anchors block; restore rotates custody and fork preserves detached terminal history", { timeout: 20_000 }, async (t) => {
    const fixture = await relayFixture(t);
    await fixture.store.apply(authorization(fixture.inbound), fixture.state, body);
    await fixture.store.publish(input, "Inherited-Deleted");
    await fixture.store.deleteDocument("Inherited-Deleted");
    await fixture.store.setWorkerState({ enabled: true, retryPaused: false, bootSupervised: true, lastRunAt: 1, lastError: null });
    const before = await fixture.store.snapshot();
    assert.equal(Object.keys(before.receipts).length, 1);
    assert.equal(Object.keys(before.historyCheckpoints).length, 1);
    const copyParent = await storageHome(t);
    const copyHome = path.join(copyParent, "copy");
    await cp(fixture.home, copyHome, { recursive: true });
    const clone = new ManagedSyncStore(copyHome);
    await assert.rejects(clone.snapshot(), /Copied or moved/);
    await assert.rejects(clone.recover(), /Copied or moved/);
    await assert.rejects(clone.publish(input, "Cannot-Clone-Owner"), /Copied or moved/);
    assert.deepEqual(await rawLedger(copyHome), before);
    await assert.rejects(clone.fork(), /quarantine/);
    await clone.quarantineRestore();
    const quarantined = await clone.snapshot();

    assert.notEqual(quarantined.storageIncarnation, before.storageIncarnation);
    assert.equal(quarantined.inboxId, before.inboxId);
    assert.deepEqual(quarantined.receipts, {});
    assert.deepEqual(quarantined.checkpoints, {});
    assert.equal(quarantined.worker.enabled, false);
    assert.equal(quarantined.worker.ownerQuarantined, true);
    assert(Object.values(quarantined.routes).every((route) => route.state === "blocked" && route.revision === 2));
    assert(Object.values(quarantined.outbox).every((entry) => entry.disposition === "retired"));
    assert(Object.values(quarantined.records).every((record) => record.contributions.every((item) => item.state === "detached")));
    await assert.rejects(lstat(path.join(copyHome, "sync", `owner-${before.inboxId}.pem`)), { code: "ENOENT" });
    await clone.recover();
    await assert.rejects(clone.publish(input, "Cannot-Resume-Owner"), /quarantine/);
    await assert.rejects(clone.deleteDocument("Destination-Original"), /quarantine/);
    await assert.rejects(clone.configureRoute({ ...fixture.onward, revision: 3 }), /quarantine/);
    await assert.rejects(clone.inventory(authorization(fixture.onward)), /quarantine/);

    const fork = await clone.fork();
    const forked = await clone.snapshot();
    assert.notEqual(fork.inboxId, before.inboxId);
    assert.notEqual(fork.historyEpoch, before.historyEpoch);
    assert.equal(await readFile(path.join(copyHome, "instance-id"), "utf8"), `${fork.inboxId}\n`);
    assert.deepEqual(forked.routes, {});
    assert.deepEqual(forked.outbox, {});
    assert.equal(forked.worker.enabled, false);
    for (const [key, record] of Object.entries(before.records)) {
      const inherited = forked.records[key];
      assert(inherited);
      assert.deepEqual(toOriginState(inherited), toOriginState(record));
      assert.deepEqual(inherited.contributions, []);
    }

    assert((await clone.listDocuments()).every((metadata) => metadata.origin?.detached === true));
    assert.equal((await clone.listDocuments()).length, 2);
    await clone.publish(input, "Future-Original");
    const future = (await clone.snapshot()).records[canonicalKey(fork.inboxId, "Future-Original")];
    assert(future);
    assert.equal(future.version, 1);
    assert.equal(future.historyEpoch, fork.historyEpoch);
    await clone.recover();
    assert.equal((await clone.snapshot()).records[canonicalKey(before.inboxId, "Inherited-Deleted")]?.state, "deleted");
    assert.deepEqual(await fixture.store.snapshot(), before, "restore/fork must leave the original checkout's fixture untouched");

    const movedHome = path.join(copyParent, "moved");
    await rename(copyHome, movedHome);
    await assert.rejects(new ManagedSyncStore(movedHome).recover(), /Copied or moved/);
    await assert.rejects(new ManagedSyncStore(movedHome).snapshot(), /Copied or moved/);
  });

  test("missing or untrusted terminal history keeps reconnected copies detached and live forwarding blocked", { timeout: 10_000 }, async (t) => {
    const fixture = await relayFixture(t);
    await fixture.store.apply(authorization(fixture.inbound), fixture.state, body);
    await fixture.store.revokeRoute(fixture.inbound.id, 1);
    const relayInbound = { ...fixture.inbound, revision: 3, sourceInboxId: fixture.state.originInboxId,
      allowedOrigins: fixture.inbound.allowedOrigins.map((grant) => ({ ...grant, completeHistory: false })) };
    await fixture.store.configureRoute(relayInbound);
    const auth = authorization(relayInbound);
    const before = await fixture.store.snapshot();
    await assert.rejects(fixture.store.apply(auth, fixture.state), /terminal inventory/);
    const complete = inventoryEvidence(relayInbound, [fixture.state]);
    await assert.rejects(fixture.store.completeInventory(auth, { ...complete, count: 2 }, [fixture.state], complete.nonce), /Incomplete/);
    await assert.rejects(fixture.store.completeInventory(auth, complete, [fixture.state], "wrong-nonce"), /Incomplete/);
    assert.deepEqual(await fixture.store.snapshot(), before);
    assert.equal((await fixture.store.listDocuments()).find((metadata) => metadata.origin)?.origin?.detached, true);
    await assert.rejects(fixture.store.inventory(authorization(fixture.onward)), /lacks trusted origin history/);

    const { store: untrusted } = await enrolledStore(t);
    const local = await untrusted.snapshot();
    const untrustedRoute = { ...fixture.inbound, id: randomUUID(), peerId: randomUUID(), sourceInboxId: randomUUID(), destinationInboxId: local.inboxId,
      allowedOrigins: fixture.inbound.allowedOrigins.map((grant) => ({ ...grant, completeHistory: false, redistribute: true })) };
    await untrusted.configureRoute(untrustedRoute);
    await untrusted.revokeRoute(untrustedRoute.id, 1);
    const reconnect = { ...untrustedRoute, revision: 3 };
    await untrusted.configureRoute(reconnect);
    const evidence = inventoryEvidence(reconnect, []);
    await assert.rejects(untrusted.completeInventory(authorization(reconnect), evidence, [], evidence.nonce), /complete-history delegation/);
    await assert.rejects(untrusted.apply(authorization(reconnect), fixture.state, body), /terminal inventory/);
    assert.equal((await untrusted.snapshot()).routes[reconnect.id]?.state, "reconnecting");
    assert.deepEqual((await untrusted.snapshot()).checkpoints, {});
  });
}

async function storageHome(t: TestContext) {
  const root = await temporaryHome(t);
  const home = path.join(root, "inbox");
  await mkdir(home, { mode: 0o700 });
  return home;
}

async function enrolledStore(t: TestContext) {
  const home = await storageHome(t);
  const store = new ManagedSyncStore(home);
  await store.enroll();
  return { home, store };
}

async function relayFixture(t: TestContext) {
  const { home: originHome, store: origin } = await enrolledStore(t);
  await origin.publish(input, "Origin-Case-ID");
  const source = await origin.snapshot();
  const record = source.records[canonicalKey(source.inboxId, "Origin-Case-ID")];
  assert(record);
  const grant = ownerGrant(source);
  const { home, store } = await enrolledStore(t);
  await store.publish(input, "Destination-Original");
  const receiver = await store.snapshot();
  const inbound: SyncRoute = { ...outboundRoute(source.inboxId, grant, receiver.inboxId), direction: "inbound", peerId: source.inboxId };
  await store.configureRoute(inbound);
  const complete = inventoryEvidence(inbound, []);
  await store.completeInventory(authorization(inbound), complete, [], complete.nonce);
  const onward = outboundRoute(receiver.inboxId, grant);
  await configureReadyRoute(store, onward);
  return { home, store, originHome, origin, inbound, onward, state: toOriginState(record) };
}

function ownerGrant(ledger: Awaited<ReturnType<ManagedSyncStore["snapshot"]>>) {
  const grant = ledger.originKeys.find((item) => item.inboxId === ledger.inboxId);
  assert(grant);
  return grant;
}

function outboundRoute(sourceInboxId: string, grant: OriginGrant, destinationInboxId: string = randomUUID(), id: string = randomUUID()): SyncRoute {
  return { id, revision: 1, direction: "outbound", peerId: destinationInboxId, peerUrl: "https://synthetic.invalid", sourceInboxId, destinationInboxId,
    localInboxName: "default", readerAudience: "Synthetic fixture only", allowedOrigins: [{ ...grant, completeHistory: true, redistribute: true }],
    credentialRef: "synthetic-no-secret", tlsTrustRef: "synthetic-no-tls", state: "active", lastError: null };
}

function authorization(route: SyncRoute): RouteAuthorization {
  return { routeId: route.id, revision: route.revision, peerId: route.peerId, sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId };
}

function inventoryEvidence(route: SyncRoute, states: OriginState[]): CompleteInventory {
  return { protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: route.peerId, routeId: route.id, revision: route.revision,
    scope: route.allowedOrigins.map(({ inboxId, historyEpoch }) => ({ inboxId, historyEpoch })), generation: 1, count: states.length,
    descriptorDigest: inventoryDigest(states), nonce: randomUUID() };
}

function assertPending(ledger: Awaited<ReturnType<ManagedSyncStore["snapshot"]>>, route: SyncRoute, state: OriginState) {
  const entry = ledger.outbox[outboxKey(route.id, route.revision, canonicalKey(state.originInboxId, state.originDocumentId))];
  assert(entry, "the committed state must have a recoverable onward obligation");
  assert.equal(entry.fingerprint, stateFingerprint(state));
  assert.equal(entry.disposition, "pending");
}

function legacyMetadata(id: string) {
  return { schemaVersion: 1, id, title: "Legacy fixture", type: "report", createdAt: "2025-01-02T03:04:05.000Z", sourceFileName: "legacy.html" };
}

async function seedLegacyDocument(home: string, id: string) {
  const directory = path.join(home, "documents", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify(legacyMetadata(id)), { mode: 0o600 });
  await writeFile(path.join(directory, "index.html"), body, { mode: 0o600 });
}

async function rawLedger(home: string) {
  return parseLedger(JSON.parse(await readFile(path.join(home, "sync", "ledger.json"), "utf8")));
}

async function assertNoLock(home: string) {
  for (const name of ["mutation.lock", "mutation.lock.reap"]) {
    await assert.rejects(lstat(path.join(home, "sync", name)), { code: "ENOENT" });
  }
}

function storageChild(t: TestContext, configuration: ChildConfiguration) {
  const child = spawn(process.execPath, [__filename, "--storage-fault-child", JSON.stringify(configuration)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages: Record<string, unknown>[] = [];
  let diagnostics = "";
  let spawnError: Error | undefined;
  assert(child.stdout && child.stderr);
  child.stdout.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const onMessage = (message: unknown) => { messages.push(parseObject(message, "child IPC message")); };
  child.on("message", onMessage);
  child.once("error", (error) => { spawnError = error; });
  let hasClosed = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      hasClosed = true;
      resolve({ code, signal });
    });
  });

  async function waitFor(type: string) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Child IPC timeout at ${type}: ${diagnostics}`));
      }, 7_000);
      const onUpdate = () => { inspect(); };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onUpdate);
        child.off("close", onUpdate);
      };

      function inspect() {
        const message = messages.find((message) => message.type === type);
        const error = messages.find((message) => message.type === "error");
        if (message) {
          cleanup();
          resolve(message);
          return;
        }

        if (error || hasClosed || spawnError) {
          cleanup();
          reject(new Error(`Child did not reach ${type}: ${JSON.stringify(error ?? messages)} ${diagnostics} ${spawnError?.message ?? ""}`));
        }
      }

      child.on("message", onUpdate);
      child.once("close", onUpdate);
      inspect();
    });
  }

  t.after(async () => {
    if (!hasClosed) child.kill("SIGKILL");
    await bounded(closed, 5_000, "child reap");
    assert.equal(child.listenerCount("message"), 1, "IPC waiters must remove their own listeners");
    child.off("message", onMessage);
    assert.equal(child.listenerCount("message"), 0);
    assert.equal(child.connected, false);
    const pid = child.pid;
    if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });

  return {
    waitFor,
    resume() { assert(child.send({ type: "resume" })); },
    async expectExit(code: number) {
      const result = await bounded(closed, 8_000, "child exit");
      assert.equal(result.code, code, `${JSON.stringify(messages)} ${diagnostics}`);
      assert.equal(result.signal, null);
    },
    async killAtFault(event: StorageEvent) {
      const hit = await waitFor("fault");
      assert.equal(hit.event, event);
      assert.equal(hit.hits, 1);
      assert.equal(hit.armed, false);
      assert.equal(messages.filter((message) => message.type === "fault").length, 1);
      assert.equal(messages.some((message) => message.type === "done" || message.type === "error"), false);
      assert(child.kill("SIGKILL"));
      const result = await bounded(closed, 5_000, "SIGKILL reap");
      assert.equal(result.code, null);
      assert.equal(result.signal, "SIGKILL");
      assert.equal(messages.some((message) => message.type === "done"), false, "a killed operation must not report a receipt or success");
    },
  };
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendChildMessage(message: Record<string, unknown>) {
  const send = process.send;
  assert(send, "storage child requires an IPC channel");
  await new Promise<void>((resolve, reject) => send.call(process, message, (error: Error | null) => error ? reject(error) : resolve()));
}

async function pauseStorageChild(message: Record<string, unknown>) {
  const resumed = new Promise<void>((resolve) => {
    process.once("message", (value: unknown) => {
      assert.equal(parseObject(value, "resume IPC message").type, "resume");
      resolve();
    });
  });
  await sendChildMessage(message);
  await resumed;
}

async function runStorageChild() {
  const argument = process.argv[3];
  assert(argument);
  const configuration = parseObject(JSON.parse(argument), "storage child configuration");
  assert(typeof configuration.home === "string");
  assert(typeof configuration.operation === "string");
  assert(childOperations.includes(configuration.operation));
  const home = configuration.home;
  const operation = configuration.operation;
  let boundaryBodyOpens = 0;
  const originalOpen = fs.open;
  const probe = mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const filePath = String(args[0]);
    if (filePath.endsWith(".html")) boundaryBodyOpens += 1;
    return originalOpen(...args);
  });

  if (operation.startsWith("legacy-")) {
    await runLegacyPublisher(home, operation);
    probe.mock.restore();
    process.disconnect?.();
    return;
  }

  let isArmed = operation === "enroll";
  let occurrences = 0;
  const event = configuration.event;
  const occurrence = configuration.occurrence ?? 1;
  assert.equal(typeof occurrence, "number");
  const fault = typeof event === "string" ? createOneShotStorageFault(parseStorageEvent(event), async () => {
    await pauseStorageChild({ type: "fault", ...faultProof() });
  }) : undefined;
  const faultProof = () => fault?.proof() ?? { hits: 0, armed: false, event: null };
  const store = new ManagedSyncStore(home, { lockDeadlineMs: 500, testHooks: { async onEvent(current) {
    if (!isArmed || current !== event) return;

    occurrences += 1;
    if (occurrences === occurrence) await fault?.hooks.onEvent(current);
  } } });
  if (operation !== "enroll") await store.recover();
  isArmed = true;
  const startupBodyOpens = boundaryBodyOpens;

  if (operation === "enroll") await store.enroll();
  if (operation === "recover") await store.recover();
  if (operation === "publish") await store.publish(input, "Crash-Original");
  if (operation === "delete") await store.deleteDocument("Crash-Original");
  if (operation === "apply") {
    const state = parseOriginState(configuration.descriptor);
    await store.apply(parseAuthorization(configuration.authorization), state, state.state === "live" ? body : undefined);
  }
  if (operation === "acknowledge") await store.acknowledge(configuration.authorization, configuration.receipt);
  if (operation === "metadata") {
    const auth = parseAuthorization(configuration.authorization);
    const ledger = await store.snapshot();
    const route = ledger.routes[auth.routeId];
    assert(route);
    for (let pass = 0; pass < 3; pass += 1) {
      await store.listDocuments();
      for (const record of Object.values(ledger.records)) await store.getDocumentMetadata(record.localId);
      if (route.direction === "outbound") {
        await store.inventory(auth);
        await store.retry(auth);
        await store.updateAttempt(auth, Object.keys(ledger.records)[0] ?? "missing", { nextAttemptAt: 1, lastError: "synthetic retry", blocked: false });
      } else {
        const state = parseOriginState(configuration.descriptor);
        const holding = (await store.holdings(auth, [state]))[0];
        assert(holding?.available);
        assert.equal(holding.receipts.length, 1);
        assert.equal((await store.apply(auth, state)).status, "committed");
        const complete = { ...inventoryEvidence(route, [state]), generation: pass + 2 };
        await store.completeInventory(auth, complete, [state], complete.nonce);
      }

      await store.setWorkerState({ enabled: false, retryPaused: false, bootSupervised: false, lastRunAt: null, lastError: null });
    }

    const metadataBodyOpens = boundaryBodyOpens - startupBodyOpens;
    const metadataCounterOpens = store.counters.htmlOpens;
    const metadataCounterBytes = store.counters.htmlBytes;
    const metadataHashPasses = store.counters.hashPasses;
    const first = Object.values(ledger.records)[0];
    assert(first);
    assert.deepEqual((await store.getDocument(first.localId))?.originalBytes, body);
    await sendChildMessage({ type: "done", startupBodyOpens, metadataBodyOpens, metadataCounterOpens, metadataCounterBytes, metadataHashPasses,
      calibrationBodyOpens: boundaryBodyOpens - metadataBodyOpens - startupBodyOpens,
      calibrationCounterOpens: store.counters.htmlOpens - metadataCounterOpens, calibrationCounterBytes: store.counters.htmlBytes - metadataCounterBytes });
  } else {
    await sendChildMessage({ type: "done", ...faultProof() });
  }

  probe.mock.restore();
  process.disconnect?.();
}

function parseStorageEvent(value: string): StorageEvent {
  const events: StorageEvent[] = [...bodyEvents, ...commitEvents, "migration-intent", "migration-evacuated", "migration-barrier", "migration-enumeration",
    "committed-before-receipt", "receipt-before-retirement"];
  const event = events.find((event) => event === value);
  assert(event, "unknown storage event");
  return event;
}

async function runLegacyPublisher(home: string, operation: string) {
  // Keep the phase1 preparation/stage/rename sequence frozen at b843e126.
  const documents = path.join(home, "documents");
  for (const directory of [home, documents, path.join(documents, ".staging"), path.join(documents, ".trash")]) {
    await ensurePrivateDirectory(directory);
  }

  const staged = path.join(documents, ".staging", "Legacy-Late");
  if (operation === "legacy-staged") {
    await ensurePrivateDirectory(staged);
    await writePrivateFile(path.join(staged, "index.html"), body);
    await writePrivateFile(path.join(staged, "metadata.json"), JSON.stringify(legacyMetadata("Legacy-Late")));
  }

  await pauseStorageChild({ type: "legacy-ready" });
  let writesAfterPause = 0;
  try {
    if (operation === "legacy-prepared") {
      await ensurePrivateDirectory(staged);
      await writePrivateFile(path.join(staged, "index.html"), body);
      writesAfterPause += 1;
      await writePrivateFile(path.join(staged, "metadata.json"), JSON.stringify(legacyMetadata("Legacy-Late")));
      writesAfterPause += 1;
    }

    await rename(staged, path.join(documents, "Legacy-Late"));
    await sendChildMessage({ type: "legacy-published" });
  } catch (error) {
    await sendChildMessage({ type: "legacy-blocked", writesAfterPause, message: error instanceof Error ? error.message : String(error) });
  }
}

async function configureReadyRoute(store: ManagedSyncStore, route: SyncRoute) {
  await store.configureRoute(route);
  if (route.direction !== "outbound") return;
  const cut = await store.inventory(authorization(route));
  const evidence = { ...inventoryEvidence(route, cut.states), generation: cut.generation };
  await store.activateOutbound(authorization(route), { kind: "terminal-inventory-ready", evidence, ackNonce: "local_pending_nonce",
    receiverPeerId: route.peerId, destinationInboxId: route.destinationInboxId, storageIncarnation: randomUUID() }, evidence, "local_pending_nonce", route.peerId);
}
