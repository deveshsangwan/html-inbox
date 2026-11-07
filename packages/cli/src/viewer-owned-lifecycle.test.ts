import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";
import * as records from "./viewer-records";
import { startViewerLifecycle } from "./viewer-server";

for (const hasSuccessor of [false, true]) {
  test(`owned close is memoized and preserves successor record ${hasSuccessor}`, async (t) => {
    const home = await temporaryHome(t);
    const viewer = await startViewerLifecycle(new LocalDocumentBackend(home), home, 0);
    const record = await records.readViewerRecord(home);
    assert(record);
    const remove = records.removeViewerRecord;
    let release = () => {};
    let enter = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const removal = t.mock.method(records, "removeViewerRecord", async (...args: Parameters<typeof remove>) => {
      enter();
      await gate;
      return remove(...args);
    });
    const closing = viewer.close();
    assert.equal(viewer.close(), closing);

    try {
      await entered;
      assert.equal(viewer.server.listening, false);
      await rebind(record.config.port);
      await rebind(Number(new URL(record.controlUrl).port));
      assert.equal((await records.readViewerRecord(home))?.processId, record.processId);
      const successor = { ...record, processId: randomUUID() };
      if (hasSuccessor) {
        await records.writeViewerRecord(home, successor);
      }

      release();
      await closing;
      assert.equal(await viewer.close(), undefined);
      assert.equal(removal.mock.callCount(), 1);
      assert.equal((await records.readViewerRecord(home))?.processId, hasSuccessor ? successor.processId : undefined);
    } finally {
      release();
      await closing;
    }
  });
}

test("owned close memoizes rejection and completes failure journaling once", async (t) => {
  const home = await temporaryHome(t);
  const viewer = await startViewerLifecycle(new LocalDocumentBackend(home), home, 0);
  const record = await records.readViewerRecord(home);
  assert(record);
  const cleanupError = new Error("owned record removal failed");
  const previousExitCode = process.exitCode;
  const removal = t.mock.method(records, "removeViewerRecord", async () => { throw cleanupError; });
  const closing = viewer.close();

  try {
    assert.equal(viewer.close(), closing);
    await assert.rejects(closing, (error) => error === cleanupError);
    assert.equal(viewer.close(), closing);
    await assert.rejects(viewer.close(), (error) => error === cleanupError);
    assert.equal(removal.mock.callCount(), 1);
    assert.equal((await records.readViewerRecord(home))?.shutdownError, cleanupError.message);
    await rebind(record.config.port);
    await rebind(Number(new URL(record.controlUrl).port));
  } finally {
    await closing.catch(() => undefined);
    process.exitCode = previousExitCode;
  }
});

async function rebind(port: number) {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
