import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs, { chmod, link, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { createStorageCounters, DurableFiles } from "./sync-files";
import { readWorkerRecordBytes } from "./sync-worker-record-reader";
import { readWorkerRecordOffline, workerPaths } from "./sync-worker-records";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "worker-record-race-")));
  const target = workerPaths(home).record;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const info = await fs.stat(home);
  const record = { schemaVersion: 1, inboxId: randomUUID(), storageIncarnation: randomUUID(),
    ownerAnchor: { home, dev: info.dev, ino: info.ino }, processId: randomUUID(), pid: process.pid, start: null,
    controlOrigin: "http://127.0.0.1:4242", controlToken: randomBytes(32).toString("base64url"), startedAt: 1, configRevision: 0 };
  const files = new DurableFiles(createStorageCounters(), {}, home);
  await files.replaceLedger(target, record);
  t.after(async () => {
    t.mock.restoreAll();
    await rm(home, { recursive: true, force: true });
  });

  return { home, target, record, files };
}

for (const action of ["replace", "remove"] as const) {
  test(`worker record retries a real unlinked path observation during ${action}`, async (t) => {
    const f = await fixture(t);
    const original = fs.lstat;
    let observations = 0;
    let retained: Awaited<ReturnType<typeof open>> | undefined;
    t.after(async () => { await retained?.close(); });
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === f.target && ++observations === 2) {
        retained = await open(f.target, "r");
        if (action === "replace") {
          await f.files.replaceLedger(f.target, { ...f.record, configRevision: 1 });
        } else {
          await rm(f.target);
        }
      }
      // Deliver the real old inode's post-unlink metadata at two consecutive lookup boundaries.
      // This models the observed CI syscall result; it does not forge a Stats object.
      if (args[0] === f.target && retained && observations <= 3) {
        const stale = await retained.stat({ bigint: args[1]?.bigint });
        assert.equal(Number(stale.nlink), 0);
        return stale;
      }

      return original(...args);
    });

    const result = await readWorkerRecordOffline(f.home);
    assert.equal(result?.configRevision ?? null, action === "replace" ? 1 : null);
  });
}

test("worker record discards bytes unlinked during read", async (t) => {
  const f = await fixture(t);
  const original = fs.open;
  let hits = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args);
    if (args[0] === f.target && hits++ === 0) {
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
        const result = await read(...readArgs);
        if (result.bytesRead > 0) {
          await f.files.replaceLedger(f.target, { ...f.record, configRevision: 1 });
        }
        return result;
      });
    }
    return file;
  });

  assert.equal((await readWorkerRecordOffline(f.home))?.configRevision, 1);
});

for (const unsafe of ["permissions", "hardlink", "oversize", "symlink", "directory"] as const) {
  test(`worker record refuses ${unsafe}`, async (t) => {
    const f = await fixture(t);
    if (unsafe === "permissions") await chmod(f.target, 0o644);
    if (unsafe === "hardlink") await link(f.target, `${f.target}.link`);
    if (unsafe === "oversize") await writeFile(f.target, Buffer.alloc(8193));

    if (unsafe === "symlink") {
      await fs.rename(f.target, `${f.target}.saved`);
      await symlink(`${f.target}.saved`, f.target);
    }
    if (unsafe === "directory") {
      await rm(f.target);
      await mkdir(f.target, { mode: 0o700 });
    }

    await assert.rejects(readWorkerRecordOffline(f.home), /private|bounded|link|unsafe/);
  });
}

for (const change of ["unlink", "mutate", "unsafe-unlink"] as const) {
  test(`worker record handles ${change} at the opened handle without leaking descriptors`, async (t) => {
    const f = await fixture(t);
    const original = fs.open;
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (args[0] === f.target) {
        handles.push(file);
        if (change === "mutate") {
          await writeFile(f.target, "changed", { mode: 0o600 });
        } else {
          if (change === "unsafe-unlink") await chmod(f.target, 0o644);
          await f.files.replaceLedger(f.target, { ...f.record, configRevision: handles.length });
        }
      }

      return file;
    });

    await assert.rejects(readWorkerRecordOffline(f.home), change === "unlink" ? /changed repeatedly/ : /metadata changed|private permissions/);
    assert.equal(handles.length, change === "unlink" ? 4 : 1);
    for (const file of handles) {
      await assert.rejects(file.stat(), { code: "EBADF" });
    }
  });
}

test("worker record refuses a different account's inode", async (t) => {
  const f = await fixture(t);
  if (!process.getuid) return;

  const getuid = process.getuid;
  const uid = getuid();
  process.getuid = () => uid + 1;
  t.after(() => { process.getuid = getuid; });
  await assert.rejects(readWorkerRecordBytes(f.target), /owned|private/);
});

test("worker record retries a different inode opened after the path check", async (t) => {
  const f = await fixture(t);
  const original = fs.open;
  let replacements = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === f.target && replacements++ === 0) {
      await f.files.replaceLedger(f.target, { ...f.record, configRevision: 1 });
    }

    return original(...args);
  });

  assert.equal((await readWorkerRecordOffline(f.home))?.configRevision, 1);
  assert.equal(replacements, 2);
});
