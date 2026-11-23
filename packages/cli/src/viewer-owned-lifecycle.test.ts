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
  const listeners = signalListenerCounts();

  const failure = await startViewerLifecycle(new LocalDocumentBackend(home), home, 0).then(() => undefined, (error: unknown) => error);
  assert(written, "startup must reach readiness before the lock is released");
  assert.equal(await records.readViewerRecord(home), null, "live viewer record survived a start-lock release failure");
  assert(failure instanceof Error, "startup must reject when its start lock cannot be released");
  assert.equal(failure.cause, releaseError);
  assert.match(failure.message, /rolling the viewer back/);
  assert.deepEqual(signalListenerCounts(), listeners);
  await rebind(written.config.port);
  await rebind(Number(new URL(written.controlUrl).port));
});

test("startup failure keeps both its cause and a start-lock release failure", async (t) => {
  const home = await temporaryHome(t);
  const startupError = new Error("viewer configuration failed");
  const releaseError = new Error("viewer start lock release failed");
  failLockRelease(t, releaseError);
  t.mock.method(records, "saveViewerConfiguration", async () => { throw startupError; });
  const listeners = signalListenerCounts();

  await assert.rejects(startViewerLifecycle(new LocalDocumentBackend(home), home, 0), (error) => {
    assert(error instanceof AggregateError, "start-lock release failure replaced the startup cause");
    assert.deepEqual(error.errors, [startupError, releaseError]);
    return true;
  });
  assert.equal(await records.readViewerRecord(home), null);
  assert.deepEqual(signalListenerCounts(), listeners);
});

test("release failure after readiness with a failed rollback keeps both causes and journals it", async (t) => {
  const home = await temporaryHome(t);
  const releaseError = new Error("viewer start lock release failed");
  const cleanupError = new Error("owned record removal failed");
  const previousExitCode = process.exitCode;
  t.mock.method(console, "error", () => {});
  failLockRelease(t, releaseError);
  t.mock.method(records, "removeViewerRecord", async () => { throw cleanupError; });
  const listeners = signalListenerCounts();

  try {
    await assert.rejects(startViewerLifecycle(new LocalDocumentBackend(home), home, 0), (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /rollback failed/);
      assert.equal(error.errors.length, 2);
      assert(error.errors[0] instanceof Error);
      assert.equal(error.errors[0].cause, releaseError);
      assert.equal(error.errors[1], cleanupError);
      return true;
    });
    const record = await records.readViewerRecord(home);
    assert(record);
    assert.equal(record.shutdownError, cleanupError.message);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(signalListenerCounts(), listeners);
    await rebind(record.config.port);
    await rebind(Number(new URL(record.controlUrl).port));
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("a signal during start-lock release rejects startup after its shared shutdown", async (t) => {
  const home = await temporaryHome(t);
  t.mock.method(console, "error", () => {});
  const write = records.writeViewerRecord;
  let written: Parameters<typeof write>[1] | undefined;
  t.mock.method(records, "writeViewerRecord", async (...args: Parameters<typeof write>) => {
    written = args[1];
    return write(...args);
  });
  const acquire = startLock.acquireViewerStartLock;
  t.mock.method(startLock, "acquireViewerStartLock", async (...args: Parameters<typeof acquire>) => {
    const lock = await acquire(...args);
    return {
      ...lock,
      release: async () => {
        process.emit("SIGTERM");
        await lock.release();
      },
    };
  });

  const listeners = signalListenerCounts();

  await assert.rejects(startViewerLifecycle(new LocalDocumentBackend(home), home, 0), /startup interrupted before readiness/,
    "startup returned a lifecycle after its shutdown had started");
  assert(written, "startup must reach readiness before the lock is released");
  assert.equal(await records.readViewerRecord(home), null);
  assert.deepEqual(signalListenerCounts(), listeners);
  await rebind(written.config.port);
  await rebind(Number(new URL(written.controlUrl).port));
});

function signalListenerCounts() {
  return { SIGTERM: process.listenerCount("SIGTERM"), SIGINT: process.listenerCount("SIGINT") };
}

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
