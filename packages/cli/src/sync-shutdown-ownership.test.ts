import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import platformTest from "node:test";
import { acquireSyncOwnership, readSyncOwnership, withStoreLock } from "./sync-files";
import { errorCauses, shutdownFixture } from "./sync-shutdown-fixtures";
import { startOwnedSyncWorker } from "./sync-worker";
import * as records from "./sync-worker-records";
import { waitUntil } from "./sync-worker-fault-fixtures";
import { parseObject } from "./sync-model";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

for (const mode of ["managed", "portable"] as const) {
  test(`${mode} ownership disposes real handles without releasing names, and blocks later release`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const lock = path.join(await f.directory(mode), "owner.lock");
    const ownership = await acquireSyncOwnership(lock, Date.now() + 1000, undefined, { mode });
    const bytes = await readFile(lock);
    const closing = ownership.closeHandles();
    assert.equal(ownership.closeHandles(), closing);
    await closing;
    await f.assertHandlesClosed();
    assert.deepEqual(await readFile(lock), bytes);
    assert.deepEqual(await readSyncOwnership(lock), ownership.owner);
    const releasing = ownership.release();
    assert.equal(ownership.release(), releasing);
    await assert.rejects(releasing, /disposed/);
    await assert.rejects(acquireSyncOwnership(lock, Date.now() + 100, undefined, { mode }), /deadline/);
    assert.deepEqual(await readFile(lock), bytes, "a live owner remains conservative after handle disposal");
  });

  test(`${mode} concurrent release and handle disposal share stable successful results`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const lock = path.join(await f.directory(mode), "owner.lock");
    const ownership = await acquireSyncOwnership(lock, Date.now() + 1000, undefined, { mode });
    const releasing = ownership.release();
    const closing = ownership.closeHandles();
    assert.equal(ownership.release(), releasing);
    assert.equal(ownership.closeHandles(), closing);
    await Promise.all([releasing, closing]);
    await ownership.release();
    await f.assertHandlesClosed();
    await assert.rejects(fs.lstat(lock), { code: "ENOENT" });
  });

  test(`${mode} failed namespace release preserves its cause and disposes retained handles`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const lock = path.join(await f.directory(mode), "owner.lock");
    const ownership = await acquireSyncOwnership(lock, Date.now() + 1000, undefined, { mode });
    const bytes = await readFile(lock);
    const unlink = fs.unlink;
    const failure = new Error("synthetic namespace unlink EIO");
    let hits = 0;
    t.mock.method(fs, "unlink", async (name: Parameters<typeof fs.unlink>[0]) => {
      if (name === lock) { hits += 1; throw failure; }
      return unlink(name);
    });
    const releasing = ownership.release();
    await assert.rejects(releasing, (error: unknown) => error === failure);
    await assert.rejects(ownership.release(), (error: unknown) => error === failure);
    await ownership.closeHandles();
    assert.equal(hits, 1);
    await f.assertHandlesClosed();
    assert.deepEqual(await readFile(lock), bytes);
  });
}

test("managed disposal attempts both descriptors and preserves both actual close failures", { timeout: 5000 }, async (t) => {
  const f = await shutdownFixture(t);
  const lock = path.join(await f.directory("managed"), "owner.lock");
  const ownership = await acquireSyncOwnership(lock, Date.now() + 1000);
  const bytes = await readFile(lock);
  const retained = f.handles.filter((file) => file.fd !== -1);
  assert.equal(retained.length, 2);
  const failures = [new Error("synthetic parent close rejection"), new Error("synthetic owner close rejection")];
  const hits = [0, 0];
  for (const [index, file] of retained.entries()) {
    const close = file.close.bind(file);
    t.mock.method(file, "close", async () => {
      hits[index] += 1;
      if (hits[index] === 1) throw failures[index];
      await close();
    });
  }

  const closing = ownership.closeHandles();
  await assert.rejects(closing, (error: unknown) => failures.every((failure) => errorCauses(error).includes(failure)));
  assert.equal(ownership.closeHandles(), closing);
  assert.deepEqual(hits, [2, 2]);
  await f.assertHandlesClosed();
  await assert.rejects(ownership.release(), /disposed/);
  assert.deepEqual(await readFile(lock), bytes);
});

test("failed worker record cleanup retains authority while closing every actual ownership descriptor", { timeout: 5000 }, async (t) => {
  const f = await shutdownFixture(t);
  let notifications = 0;
  const worker = await f.worker({ temporary: true, onFatalStop: () => { notifications += 1; } });
  const paths = records.workerPaths(f.home);
  const bytes = await readFile(paths.lifetime);
  const failure = new Error("synthetic runtime record inspection EIO");
  t.mock.method(records, "readWorkerRecordOffline", async () => { throw failure; });
  await assert.rejects(worker.close(), (error: unknown) => error === failure);
  await f.assertHandlesClosed();
  assert.equal(notifications, 1);
  assert.deepEqual(await readFile(paths.lifetime), bytes);
  assert.equal((await readSyncOwnership(paths.lifetime))?.token, worker.record.processId);
  await assert.rejects(acquireSyncOwnership(paths.lifetime, Date.now() + 100), /deadline/);
  assert.ok(await fs.lstat(paths.record));
});

for (const observer of ["normal", "throw", "reject"] as const) {
  test(`early malformed record plus release failure retains both causes with ${observer} observer`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const paths = records.workerPaths(f.home);
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.record, "{malformed", { mode: 0o600 });
    const acquire = records.acquireWorkerExclusion;
    const cleanupError = new Error("synthetic startup cleanup failure");
    let releases = 0;
    t.mock.method(records, "acquireWorkerExclusion", async (...args: Parameters<typeof acquire>) => {
      const ownership = await acquire(...args);
      return { ...ownership, async release() { releases += 1; await ownership.release(); throw cleanupError; } };
    });
    let notified = 0;
    const exitBefore = process.exitCode;
    await assert.rejects(startOwnedSyncWorker(f.home, { temporary: true, onFatalStop: () => {
      notified += 1;
      if (observer === "throw") throw new Error("synthetic observer throw");
      if (observer === "reject") return Promise.reject(new Error("synthetic observer rejection"));
    } }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(errorCauses(error).some((cause) => cause instanceof SyntaxError));
      assert.ok(errorCauses(error).includes(cleanupError));
      return true;
    });
    assert.equal(notified, 1);
    assert.equal(releases, 1);
    assert.equal(process.exitCode, exitBefore);
    await f.assertHandlesClosed();
    await assert.rejects(fs.lstat(paths.startup), { code: "ENOENT" });
  });
}

test("ordinary early preflight failure with successful cleanup is not fatal", { timeout: 5000 }, async (t) => {
  const f = await shutdownFixture(t);
  const paths = records.workerPaths(f.home);
  await mkdir(paths.directory, { mode: 0o700 });
  await writeFile(paths.record, "{malformed", { mode: 0o600 });
  let notified = 0;
  await assert.rejects(startOwnedSyncWorker(f.home, { temporary: true, onFatalStop: () => { notified += 1; } }), SyntaxError);
  assert.equal(notified, 0);
  await f.assertHandlesClosed();
});

test("actual lifetime write and startup directory-sync failures retain both causes before readiness", { timeout: 5000 }, async (t) => {
  const f = await shutdownFixture(t);
  const paths = records.workerPaths(f.home);
  const writeError = Object.assign(new Error("synthetic lifetime write EIO"), { code: "EIO" });
  const syncError = Object.assign(new Error("synthetic startup directory sync EIO"), { code: "EIO" });
  const open = fs.open;
  const unlink = fs.unlink;
  let writes = 0;
  let syncs = 0;
  let unlinked = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (path.basename(String(args[0])).startsWith(".lifetime.lock.owner-")) {
      t.mock.method(file, "writeFile", async () => { writes += 1; throw writeError; });
    }

    if (args[0] === paths.directory) {
      const sync = file.sync.bind(file);
      t.mock.method(file, "sync", async () => {
        if (unlinked && syncs === 0) { syncs += 1; throw syncError; }
        await sync();
      });
    }

    return file;
  });
  t.mock.method(fs, "unlink", async (name: Parameters<typeof fs.unlink>[0]) => { await unlink(name); if (name === paths.startup) unlinked = true; });
  let notified = 0;
  await assert.rejects(startOwnedSyncWorker(f.home, { onFatalStop: () => { notified += 1; } }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(errorCauses(error).includes(writeError));
    assert.ok(errorCauses(error).includes(syncError));
    return true;
  });
  assert.equal(writes, 1);
  assert.equal(syncs, 1);
  assert.equal(notified, 1);
  await f.assertHandlesClosed();
  assert.deepEqual(await readdir(paths.directory), []);
});

test("known owner-unreadable metadata blocks without opening the ownership record", { timeout: 5000 }, async (t) => {
  const f = await shutdownFixture(t);
  const directory = await f.directory("unreadable");
  const lock = path.join(directory, "mutation.lock");
  await writeFile(lock, JSON.stringify({ schemaVersion: 2, token: randomUUID(), pid: 2147483647, start: null }), { mode: 0o000 });
  const before = await fs.lstat(lock);
  const open = fs.open;
  let opens = 0;
  let calls = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === lock) opens += 1;
    return open(...args);
  });

  await assert.rejects(withStoreLock(directory, 100, async () => { calls += 1; }), /deadline/);
  assert.equal(opens, 0);
  assert.equal(calls, 0);
  const after = await fs.lstat(lock);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal(after.size, before.size);
  assert.deepEqual(await readdir(directory), ["mutation.lock"]);
});

for (const phase of [1, 2]) {
  test(`reaper boundary ${phase} preserves open EACCES after valid metadata`, { timeout: 5000 }, async (t) => {
    const f = await shutdownFixture(t);
    const directory = await f.directory("open-failure");
    const lock = path.join(directory, "mutation.lock");
    const bytes = JSON.stringify({ schemaVersion: 2, token: randomUUID(), pid: 2147483647, start: null });
    await writeFile(lock, bytes, { mode: 0o600 });
    const failure = Object.assign(new Error("synthetic permission change after metadata check"), { code: "EACCES" });
    const open = fs.open;
    let opens = 0;
    let hits = 0;
    let calls = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === lock && ++opens === phase) { hits += 1; throw failure; }
      return open(...args);
    });

    await assert.rejects(withStoreLock(directory, 1000, async () => { calls += 1; }), (error: unknown) => errorCauses(error).includes(failure));
    assert.equal(hits, 1);
    assert.equal(calls, 0);
    assert.equal(await readFile(lock, "utf8"), bytes);
    assert.deepEqual(await readdir(directory), ["mutation.lock"]);
    await f.assertHandlesClosed();
  });

  for (const invalid of [false, true]) {
    test(`reaper boundary ${phase} preserves ${invalid ? "invalid-record" : "read EIO"} plus close failure and never enters protected work`, { timeout: 5000 }, async (t) => {
      const f = await shutdownFixture(t);
      const directory = await f.directory("reaper");
      const lock = path.join(directory, "mutation.lock");
      const bytes = invalid ? "{malformed" : JSON.stringify({ schemaVersion: 2, token: randomUUID(), pid: 2147483647, start: null });
      // A malformed first precheck cannot reach the second boundary. It becomes
      // malformed only on the selected held handle's read.
      const valid = JSON.stringify({ schemaVersion: 2, token: randomUUID(), pid: 2147483647, start: null });
      await writeFile(lock, invalid ? valid : bytes, { mode: 0o600 });
      const original = await readFile(lock);
      const readError = Object.assign(new Error("synthetic existing-owner read EIO"), { code: "EIO" });
      const closeError = new Error("synthetic existing-owner close rejection");
      const open = fs.open;
      let opens = 0;
      let reads = 0;
      let closes = 0;
      let calls = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args);
        if (args[0] === lock && ++opens === phase) {
          t.mock.method(file, "read", async (buffer: Buffer) => {
            reads += 1;
            if (!invalid) throw readError;
            if (reads > 1) return { bytesRead: 0, buffer };
            buffer.write("{malformed");
            return { bytesRead: 10, buffer };
          });
          const close = file.close.bind(file);
          t.mock.method(file, "close", async () => { closes += 1; if (closes === 1) throw closeError; await close(); });
        }

        return file;
      });
      await assert.rejects(withStoreLock(directory, 1000, async () => { calls += 1; }), (error: unknown) => {
        const causes = errorCauses(error);
        assert.ok(causes.includes(closeError));
        assert.ok(invalid ? causes.some((cause) => cause instanceof SyntaxError) : causes.includes(readError));
        return true;
      });
      assert.equal(calls, 0);
      assert.equal(reads, invalid ? 2 : 1);
      assert.equal(closes, 2);
      assert.deepEqual(await readFile(lock), original);
      assert.deepEqual(await readdir(directory), ["mutation.lock"]);
      await f.assertHandlesClosed();
      await withStoreLock(directory, 1000, async () => { calls += 1; });
      assert.equal(calls, 1, "a separate explicit acquisition can recover after the first failure is reported");
      assert.deepEqual(await readdir(directory), []);
    });
  }
}

test("actual foreground CLI sanitizes fatal cleanup before readiness", { timeout: 7000 }, async (t) => {
  const f = await shutdownFixture(t);
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "sync-worker-fatal-child.js"), path.join(__dirname, "index.js"),
    "sync", "worker", "start", "--foreground", "--home", f.home, "--json"], {
    cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, XDG_CONFIG_HOME: f.root, XDG_STATE_HOME: f.root, XDG_DATA_HOME: f.root,
      XDG_CACHE_HOME: f.root, HTML_INBOX_CATALOG_HOME: path.join(f.root, "catalog"), TMPDIR: f.root, TMP: f.root, TEMP: f.root, ZDOTDIR: f.root,
      HTML_INBOX_FATAL_FIXTURE: "early-startup-cleanup" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  assert.ok(child.stdout && child.stderr);
  let stdout = "";
  let stderr = "";
  const events: unknown[] = [];
  child.stdout.on("data", (value: Buffer) => { stdout += value.toString(); });
  child.stderr.on("data", (value: Buffer) => { stderr += value.toString(); });
  child.on("message", (value: unknown) => events.push(value));
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await completion; clearTimeout(timer); });
  assert.deepEqual(await completion, { code: 1, signal: null });
  clearTimeout(timer);
  assert.equal(stderr, "html-inbox: Sync worker stopped after an unrecoverable state or cleanup failure; inspect the inbox before restarting.\n");
  assert.equal(parseObject(JSON.parse(stdout), "CLI startup result").ready, false);
  assert.equal(events.filter((event) => parseObject(event, "fixture event").type === "candidate-write-fault").length, 1);
  assert.equal(events.filter((event) => parseObject(event, "fixture event").type === "startup-sync-fault").length, 1);
  assert.equal(events.some((event) => parseObject(event, "fixture event").type === "sync-worker-ready"), false);
  assert.ok(child.pid);
  await waitUntil("CLI child is reaped", async () => { try { process.kill(child.pid ?? 0, 0); return false; } catch { return true; } }, Boolean);
});
