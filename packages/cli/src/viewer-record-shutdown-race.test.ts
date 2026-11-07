import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";
import * as records from "./viewer-records";
import { startViewer, stopViewer } from "./viewer-server";

const skip = process.platform === "win32" ? "The fixture replaces open records during POSIX shutdown" : false;

test("viewer stop continues its cleanup poll after one exhausted snapshot read", { skip, timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const recordPath = path.join(home, "viewer.json");
  t.mock.method(console, "error", () => {});
  const server = await startViewer(new LocalDocumentBackend(home), home, 0);
  const record = await records.readViewerRecord(home);
  assert(record);
  const remove = records.removeViewerRecord;
  let releaseCleanup = () => {};
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let cleanupStarted = false;
  let cleanup: Promise<void> | undefined;
  t.mock.method(records, "removeViewerRecord", (...args: Parameters<typeof remove>) => {
    cleanupStarted = true;
    cleanup = cleanupGate.then(() => remove(...args));
    return cleanup;
  });
  const open = fs.open;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (args[0] === recordPath && cleanupStarted && handles.length < 4) {
      handles.push(file);
      // Four actual atomic replacements exercise the reader's exhaustion contract.
      // This does not claim a single native unlink causes four zero-link observations.
      await records.writeViewerRecord(home, record);
      assert.equal((await file.stat()).nlink, 0);
      if (handles.length === 4) releaseCleanup();
    }

    return file;
  });

  try {
    assert.equal((await stopViewer(home)).state, "stopped");
    assert.equal(handles.length, 4);
    await cleanup;
    assert.equal(await records.readViewerRecord(home), null);
    for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
  } finally {
    releaseCleanup();
    server.close();
    await cleanup;
  }
});

for (const failure of ["permanent churn", "unsafe record"] as const) {
  test(`viewer cleanup polling preserves ${failure === "permanent churn" ? "its deadline" : "storage errors"}`, { skip, timeout: 10_000 }, async (t) => {
    const home = await temporaryHome(t);
    t.mock.method(console, "error", () => {});
    const server = await startViewer(new LocalDocumentBackend(home), home, 0);
    const remove = records.removeViewerRecord;
    let releaseCleanup = () => {};
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupStarted = false;
    let cleanup: Promise<void> | undefined;
    t.mock.method(records, "removeViewerRecord", (...args: Parameters<typeof remove>) => {
      cleanupStarted = true;
      cleanup = cleanupGate.then(() => remove(...args));
      return cleanup;
    });
    const originalRead = records.readViewerRecord;
    const now = Date.now;
    let offset = 0;
    let failures = 0;
    const alias = path.join(home, "viewer-hardlink.json");
    t.mock.method(Date, "now", () => now() + offset);
    const read = t.mock.method(records, "readViewerRecord", async (...args: Parameters<typeof originalRead>) => {
      if (cleanupStarted) {
        failures += 1;
        if (failure === "unsafe record") {
          await fs.link(path.join(home, "viewer.json"), alias);
          return originalRead(...args);
        }

        // Advance only the observer clock after a second failed poll; production
        // keeps its existing five-second bound rather than extending it on churn.
        if (failures === 2) offset = 10_000;
        throw new records.ViewerRecordChangedError("synthetic snapshot churn");
      }

      return originalRead(...args);
    });

    try {
      await assert.rejects(stopViewer(home), failure === "permanent churn" ? /cleanup did not finish/ : /regular private file/);
      assert.equal(failures, failure === "permanent churn" ? 2 : 1);
    } finally {
      read.mock.restore();
      await fs.rm(alias, { force: true });
      releaseCleanup();
      server.close();
      await cleanup;
    }
  });
}
