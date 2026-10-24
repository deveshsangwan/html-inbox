import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { assertLoopbackClosed } from "./sync-protocol-fixture";

export function errorCauses(error: unknown): unknown[] {
  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(errorCauses) : []),
    ...(error instanceof Error && error.cause !== undefined ? errorCauses(error.cause) : [])];
}

export async function shutdownFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-shutdown-"));
  const cleanup: (() => Promise<unknown>)[] = [];
  const ports: string[] = [];
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const handlePaths = new Map<Awaited<ReturnType<typeof fs.open>>, string>();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(async () => {
    t.mock.restoreAll();
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }

    for (const port of ports) {
      try { await assertLoopbackClosed(port); } catch (error) { failures.push(error); }
    }

    // A red must clean up its own intercepted descriptors after recording them.
    for (const file of handles) if (file.fd !== -1) await file.close();
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, []);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(fs.lstat(root), { code: "ENOENT" });
    t.diagnostic(`${ports.length} exact ports rebound; intercepted handles disposed; synthetic root removed`);
    if (failures.length) throw new AggregateError(failures, "Shutdown fixture cleanup failed");
  });

  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).startsWith(`${root}/`)) {
      handles.push(file);
      handlePaths.set(file, String(args[0]));
    }
    return file;
  });
  const home = path.join(root, "inbox");
  const store = new ManagedSyncStore(home);
  await store.enroll();
  await store.setWorkerEnabled(true);

  async function worker(options: Parameters<typeof startOwnedSyncWorker>[1] = { temporary: true }) {
    const runtime = await startOwnedSyncWorker(home, options);
    ports.push(runtime.record.controlOrigin);
    cleanup.push(() => runtime.close().catch(() => {}));
    return runtime;
  }

  async function directory(name: string) {
    const selected = path.join(root, name);
    await mkdir(selected, { mode: 0o700 });
    return selected;
  }

  async function assertHandlesClosed() {
    assert.equal(handles.filter((file) => file.fd !== -1).length, 0, "all actual retained descriptors are closed");
    for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
  }

  return { root, home, store, worker, directory, cleanup, ports, handles, handlePaths, assertHandlesClosed, readFile };
}
