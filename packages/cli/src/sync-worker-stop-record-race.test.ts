import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { createStorageCounters, DurableFiles } from "./sync-files";
import { ManagedSyncStore } from "./sync-store";
import { temporaryHome } from "./test-fixtures";
import { startOwnedSyncWorker } from "./sync-worker";
import { stopOwnedSyncWorker } from "./sync-worker-client";
import { WorkerRecordChangedError } from "./sync-worker-record-reader";
import * as records from "./sync-worker-records";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

async function fixture(t: TestContext) {
  const home = await fs.realpath(await temporaryHome(t));
  const store = new ManagedSyncStore(home);
  await store.enroll();
  await store.setWorkerEnabled(true);
  const worker = await startOwnedSyncWorker(home);
  const target = records.workerPaths(home).record;
  const files = new DurableFiles(createStorageCounters(), {}, home);
  const rm = fs.rm;
  let releaseRemoval = () => {};
  const gate = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  let removing = false;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof rm>) => {
    if (args[0] === target) {
      removing = true;
      await gate;
    }

    return rm(...args);
  });
  t.after(async () => {
    t.mock.restoreAll();
    releaseRemoval();
    await worker.close();
  });

  return { home, target, files, worker, releaseRemoval, isRemoving: () => removing };
}

test("actual worker stop polls again after four safe runtime snapshot replacements", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const open = fs.open;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (args[0] === f.target && f.isRemoving() && handles.length < 4) {
      handles.push(file);
      // Exercise real snapshot exhaustion during the actual stop poll. This does
      // not assert that one native unlink caused the four observations seen in CI.
      await f.files.replaceLedger(f.target, f.worker.record);
      assert.equal((await file.stat()).nlink, 0);
      if (handles.length === 4) f.releaseRemoval();
    }

    return file;
  });

  try {
    assert.deepEqual(await stopOwnedSyncWorker(f.home), { stopped: true, alreadyStopped: false });
    assert.equal(handles.length, 4);
    await f.worker.close();
    assert.equal(await records.readWorkerRecordOffline(f.home), null);
    for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
  } finally {
    f.releaseRemoval();
    await f.worker.close();
  }
});

for (const mode of ["permanent churn", "hardlink", "foreign owner"] as const) {
  test(`actual worker stop retains its ${mode === "permanent churn" ? "deadline" : `${mode} guard`}`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t);
    const read = records.readWorkerRecordOffline;
    const now = Date.now;
    const alias = path.join(f.home, "runtime-hardlink.json");
    let offset = 0;
    let failures = 0;
    t.mock.method(Date, "now", () => now() + offset);
    const observed = t.mock.method(records, "readWorkerRecordOffline", async (...args: Parameters<typeof read>) => {
      if (f.isRemoving()) {
        failures += 1;
        if (mode === "permanent churn") {
          // Two failed polls exhaust the unchanged ten-second observer deadline.
          if (failures === 2) offset = 20_000;
          throw new WorkerRecordChangedError("synthetic snapshot churn");
        }

        if (mode === "hardlink") {
          await fs.link(f.target, alias);
        } else {
          await f.files.replaceLedger(f.target, { ...f.worker.record, processId: randomUUID() });
        }
      }

      return read(...args);
    });

    try {
      await assert.rejects(stopOwnedSyncWorker(f.home), mode === "permanent churn" ? /shutdown deadline exceeded/
        : mode === "hardlink" ? /at most one link/ : /ownership changed during stop/);
      assert.equal(failures, mode === "permanent churn" ? 2 : 1);
      assert(await fs.lstat(f.target), "a failed stop must not infer that the runtime record is absent");
    } finally {
      observed.mock.restore();
      await fs.rm(alias, { force: true });
      f.releaseRemoval();
      await f.worker.close();
    }
  });
}
