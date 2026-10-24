import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { acquireSyncOwnership, readSyncOwnership } from "./sync-files";
import { createInbox, readNamedInbox } from "./inbox-catalog";
import { errorCauses } from "./sync-shutdown-fixtures";

async function portableFixture(t: TestContext, catalog = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "html-inbox-portable-acquisition-"));
  await fs.chmod(root, 0o700);
  const directory = path.join(root, "catalog");
  await fs.mkdir(directory, { mode: 0o700 });
  const lock = path.join(directory, catalog ? "registration.lock" : "catalog.lock");
  const sentinel = path.join(root, "sentinel");
  await fs.writeFile(sentinel, "untouched synthetic sentinel", { mode: 0o600 });
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (String(args[0]).startsWith(`${root}${path.sep}`)) handles.push(file);
    return file;
  });
  t.after(async () => {
    t.mock.restoreAll();
    // Red probes dispose only their own demonstrated leaks after product assertions.
    for (const file of handles) if (file.fd !== -1) await file.close();
    for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
    assert.equal(await fs.readFile(sentinel, "utf8"), "untouched synthetic sentinel");
    await fs.rm(root, { recursive: true });
    await assert.rejects(fs.lstat(root), { code: "ENOENT" });
    t.diagnostic(`${handles.length} actual handles disposed; sentinel unchanged; synthetic catalog/credential-free root removed`);
  });

  async function assertClosed() {
    for (const file of handles) await assert.rejects(file.stat(), { code: "EBADF" });
  }

  return { root, directory, lock, handles, assertClosed };
}

for (const catalog of [false, true]) {
  test(`${catalog ? "ordinary createInbox registration" : "portable ownership"} initial stat failure closes its actual new descriptor and retains unknown name`, async (t) => {
    const f = await portableFixture(t, catalog);
    const fault = Object.assign(new Error("Controlled initial owner stat failure"), { code: "EIO" });
    const open = fs.open;
    let hits = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (args[0] === f.lock && args[1] === "wx") {
        const stat = file.stat.bind(file);
        t.mock.method(file, "stat", async (...values: Parameters<typeof stat>) => {
          if (hits++ === 0) throw fault;
          return stat(...values);
        });
      }
      return file;
    });
    let acquired = false;
    const operation = catalog ? createInbox("synthetic", path.join(f.root, "inbox"), f.directory) :
      acquireSyncOwnership(f.lock, Date.now() + 1000, undefined, { mode: "portable" });
    await assert.rejects(operation.then(() => { acquired = true; }), (error: unknown) => errorCauses(error).includes(fault));
    assert.equal(hits, 1);
    assert.equal(acquired, false);
    t.mock.restoreAll();
    assert.equal(f.handles.length, 1);
    t.diagnostic(JSON.stringify({ actualFd: f.handles[0].fd, hits, acquired }));
    await f.assertClosed();
    assert.equal((await fs.lstat(f.lock)).size, 0);
    assert.equal(await readSyncOwnership(f.lock), null);
    await assert.rejects(acquireSyncOwnership(f.lock, Date.now() + 60, undefined, { mode: "portable" }), /deadline/);
    assert.equal((await fs.lstat(f.lock)).size, 0);
    if (catalog) {
      assert.equal(await readNamedInbox("synthetic", f.directory), null);
      await assert.rejects(fs.lstat(path.join(f.root, "inbox")), { code: "ENOENT" });
    }
  });
}

for (const mode of ["write", "sync", "write-close", "sync-close", "inspection-close", "unlink-close", "permanent-close", "foreign"] as const) {
  test(`portable failed acquisition ${mode} preserves causes, authority and actual descriptor disposal`, async (t) => {
    const f = await portableFixture(t);
    const primary = Object.assign(new Error("Controlled portable write/sync failure"), { code: "EIO" });
    const inspection = Object.assign(new Error("Controlled cleanup inspection failure"), { code: "EIO" });
    const removal = Object.assign(new Error("Controlled cleanup unlink failure"), { code: "EACCES" });
    const closeFirst = new Error("Controlled first close failure");
    const closeSecond = new Error("Controlled second close failure");
    let primaryHits = 0;
    let inspectionHits = 0;
    let unlinkHits = 0;
    let closeHits = 0;
    let foreignInode: number | undefined;
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (args[0] !== f.lock || args[1] !== "wx") return file;

      const failPrimary = async () => {
        primaryHits += 1;
        if (mode === "foreign") {
          await fs.rename(f.lock, `${f.lock}.original`);
          await fs.writeFile(f.lock, "foreign namespace sentinel", { mode: 0o600 });
          foreignInode = (await fs.lstat(f.lock)).ino;
        }
        throw primary;
      };
      if (mode === "sync" || mode === "sync-close") t.mock.method(file, "sync", failPrimary);
      else t.mock.method(file, "writeFile", failPrimary);
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        closeHits += 1;
        if (mode.includes("close") && closeHits === 1) throw closeFirst;
        if (mode === "permanent-close" && closeHits === 2) throw closeSecond;
        await close();
      });
      return file;
    });
    const lstat = fs.lstat;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof lstat>) => {
      if (mode === "inspection-close" && args[0] === f.lock && primaryHits) {
        inspectionHits += 1;
        throw inspection;
      }
      return lstat(...args);
    });
    const unlink = fs.unlink;
    t.mock.method(fs, "unlink", async (...args: Parameters<typeof unlink>) => {
      if (args[0] === f.lock) {
        unlinkHits += 1;
        if (mode === "unlink-close") throw removal;
      }
      return unlink(...args);
    });
    let acquired = false;
    let observed: unknown;
    try {
      const ownership = await acquireSyncOwnership(f.lock, Date.now() + 1000, undefined, { mode: "portable" });
      acquired = true;
      await ownership.closeHandles();
    } catch (error) {
      observed = error;
    }
    const causes = errorCauses(observed);
    assert.equal(acquired, false);
    assert.equal(primaryHits, 1);
    assert.ok(causes.includes(primary), "retain the original acquisition failure");
    if (mode.includes("close")) {
      assert.ok(causes.includes(closeFirst));
      assert.equal(closeHits, 2, "reuse exactly one bounded safe-close retry");
    } else assert.equal(closeHits, 1);
    if (mode === "inspection-close") {
      assert.equal(inspectionHits, 1);
      assert.ok(causes.includes(inspection));
    }
    if (mode === "unlink-close") assert.ok(causes.includes(removal));
    if (mode === "permanent-close") assert.ok(causes.includes(closeSecond));
    assert.equal(unlinkHits, mode === "inspection-close" || mode === "foreign" ? 0 : 1);
    t.mock.restoreAll();
    if (mode === "permanent-close") {
      assert.notEqual(f.handles[0].fd, -1, "permanent OS close failure remains explicit uncertainty");
      await f.handles[0].stat();
    } else await f.assertClosed();
    if (mode === "foreign") {
      assert.equal((await fs.lstat(f.lock)).ino, foreignInode);
      assert.equal(await fs.readFile(f.lock, "utf8"), "foreign namespace sentinel");
    } else if (mode === "inspection-close" || mode === "unlink-close") {
      assert.ok((await fs.lstat(f.lock)).isFile());
    } else await assert.rejects(fs.lstat(f.lock), { code: "ENOENT" });
    t.diagnostic(JSON.stringify({ mode, acquired, primaryHits, inspectionHits, unlinkHits, closeHits, actualFd: f.handles[0].fd }));
  });
}

test("ordinary portable acquisition transfers its retained handle and coordinates repeated release/disposal without directory fsync", async (t) => {
  const f = await portableFixture(t);
  const open = fs.open;
  let directoryFlushes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if ((await file.stat()).isDirectory()) t.mock.method(file, "sync", async () => {
      directoryFlushes += 1;
      throw Object.assign(new Error("Directory fsync unavailable"), { code: "EINVAL" });
    });
    return file;
  });
  const ownership = await acquireSyncOwnership(f.lock, Date.now() + 1000, undefined, { mode: "portable" });
  assert.equal(f.handles.length, 1);
  await f.handles[0].stat();
  assert.equal((await readSyncOwnership(f.lock))?.token, ownership.owner.token);
  const released = ownership.release();
  assert.equal(ownership.release(), released);
  await Promise.all([released, ownership.closeHandles()]);
  await ownership.release();
  await ownership.closeHandles();
  t.mock.restoreAll();
  await f.assertClosed();
  await assert.rejects(fs.lstat(f.lock), { code: "ENOENT" });
  assert.equal(directoryFlushes, 0);
});

test("ordinary catalog creation remains portable when directory fsync is unavailable", async (t) => {
  const f = await portableFixture(t, true);
  const open = fs.open;
  let directoryFlushes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if ((await file.stat()).isDirectory()) t.mock.method(file, "sync", async () => {
      directoryFlushes += 1;
      throw Object.assign(new Error("Directory fsync unavailable"), { code: "EINVAL" });
    });
    return file;
  });
  const created = await createInbox("synthetic", path.join(f.root, "inbox"), f.directory);
  assert.equal((await readNamedInbox("synthetic", f.directory))?.instanceId, created.instanceId);
  t.mock.restoreAll();
  await f.assertClosed();
  await assert.rejects(fs.lstat(f.lock), { code: "ENOENT" });
  assert.equal(directoryFlushes, 0);
});
