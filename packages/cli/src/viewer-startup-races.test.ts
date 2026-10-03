import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";
import * as viewerRecords from "./viewer-records";
import { startViewer, stopViewer } from "./viewer-server";

test("shutdown waits for an in-flight readiness commit and removes its completed record", async (t) => {
  const home = await temporaryHome(t);
  const writeRecord = viewerRecords.writeViewerRecord;
  const remove = t.mock.method(viewerRecords, "removeViewerRecord");
  t.mock.method(
    viewerRecords,
    "writeViewerRecord",
    async (recordHome: string, record: viewerRecords.ViewerRecord) => {
      process.emit("SIGTERM");
      await delay(50);
      assert.equal(
        remove.mock.callCount(),
        0,
        "shutdown must wait for the pending readiness write",
      );

      await writeRecord(recordHome, record);
    },
  );

  await assert.rejects(
    startViewer(new LocalDocumentBackend(home), home, 0),
    /startup interrupted before readiness/,
  );
  assert.equal(await viewerRecords.readViewerRecord(home), null);
  assert.equal(remove.mock.callCount(), 1);
});

test(
  "loopback stop waits for the worker's completed record cleanup",
  {
    skip:
      process.platform === "win32"
        ? "Windows process signals cannot exercise an in-process graceful POSIX stop."
        : false,
  },
  async (t) => {
    const home = await temporaryHome(t);
    const server = await startViewer(new LocalDocumentBackend(home), home, 0);
    const removeRecord = viewerRecords.removeViewerRecord;
    const remove = t.mock.method(
      viewerRecords,
      "removeViewerRecord",
      async (recordHome: string, processId: string) => {
        await delay(150);
        await removeRecord(recordHome, processId);
      },
    );

    try {
      assert.equal((await stopViewer(home)).state, "stopped");
      assert.equal(await viewerRecords.readViewerRecord(home), null);
      assert.equal(
        remove.mock.callCount(),
        1,
        "the worker must finish cleanup before stop reports success",
      );
    } finally {
      server.close();
    }
  },
);
