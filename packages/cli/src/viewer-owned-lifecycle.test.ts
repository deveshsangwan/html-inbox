import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { test, type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";
import * as records from "./viewer-records";
import { startViewerLifecycle } from "./viewer-server";
import * as startLock from "./viewer-start-lock";

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

test("start-lock release failure after readiness rolls back the live viewer", async (t) => {
  const home = await temporaryHome(t);
  const releaseError = new Error("viewer start lock release failed");
  failLockRelease(t, releaseError);
  const write = records.writeViewerRecord;
  let written: Parameters<typeof write>[1] | undefined;
  t.mock.method(records, "writeViewerRecord", async (...args: Parameters<typeof write>) => {
    written = args[1];
    return write(...args);
  });

  await assert.rejects(startViewerLifecycle(new LocalDocumentBackend(home), home, 0), (error) => error === releaseError);
  assert(written, "startup must reach readiness before the lock is released");
  assert.equal(await records.readViewerRecord(home), null, "live viewer record survived a start-lock release failure");
  await rebind(written.config.port);
  await rebind(Number(new URL(written.controlUrl).port));
});

test("startup failure keeps both its cause and a start-lock release failure", async (t) => {
  const home = await temporaryHome(t);
  const startupError = new Error("viewer configuration failed");
  const releaseError = new Error("viewer start lock release failed");
  failLockRelease(t, releaseError);
  t.mock.method(records, "saveViewerConfiguration", async () => { throw startupError; });

  await assert.rejects(startViewerLifecycle(new LocalDocumentBackend(home), home, 0), (error) => {
    assert(error instanceof AggregateError, "start-lock release failure replaced the startup cause");
    assert.deepEqual(error.errors, [startupError, releaseError]);
    return true;
  });
  assert.equal(await records.readViewerRecord(home), null);
});

function failLockRelease(t: TestContext, releaseError: Error) {
  const acquire = startLock.acquireViewerStartLock;
  t.mock.method(startLock, "acquireViewerStartLock", async (...args: Parameters<typeof acquire>) => {
    const lock = await acquire(...args);
    return {
      ...lock,
      release: async () => {
        await lock.release();
        throw releaseError;
      },
    };
  });
}

async function rebind(port: number) {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
