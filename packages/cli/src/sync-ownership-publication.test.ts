import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { mock, type TestContext } from "node:test";
import { promisify } from "node:util";
import { acquireSyncOwnership, isDeadOwner, openPrivateFile, processStart, readSyncOwnership, withStoreLock } from "./sync-files";
import { assertExactKeys, parseInteger, parseObject, parseString } from "./sync-model";

const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const runFile = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-ownership-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await assert.rejects(lstat(root), { code: "ENOENT" }); });
  return { root, lockPath: path.join(root, "mutation.lock") };
}

async function launch(t: TestContext, lockPath: string, stage: string, action = "cut", errorCode = "EIO") {
  const child = spawn(process.execPath, [path.join(__dirname, "sync-ownership-fault-child.js"), lockPath, stage, action, errorCode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    if (child.pid) assert.throws(() => process.kill(child.pid ?? 0, 0), { code: "ESRCH" });
  });
  const [message] = await Promise.race([once(child, "message"), closed.then(() => { throw new Error(`Child missed ${stage}: ${stderr}`); })]);
  const receipt = parseObject(message, "cut receipt");
  assert.equal(receipt.hits, 1, JSON.stringify(receipt));
  assert.equal(receipt.candidateOpens, 1, "exactly one candidate open per invocation");
  assert.equal(receipt.type, action === "cut" ? "cut" : "result", JSON.stringify(receipt));

  return { child, closed, receipt, async kill() {
    child.kill("SIGKILL");
    assert.deepEqual(await closed, [null, "SIGKILL"]);
    clearTimeout(timer);
    assert.throws(() => process.kill(parseInteger(receipt.pid, 1), 0), { code: "ESRCH" });
  } };
}

const preinstallCuts = ["created", "partial", "written", "writable-sync-before", "writable-sync-after", "close-before", "close-after", "read-open",
  "directory-1-sync-before", "directory-1-sync-after", "link-before"];
const pairCuts = ["linked", "readonly-1-sync-before", "readonly-1-sync-after", "directory-2-sync-before", "directory-2-sync-after", "candidate-unlink-before"];
const installedCuts = ["candidate-unlinked", "readonly-2-sync-before", "readonly-2-sync-after", "directory-3-sync-before", "directory-3-sync-after", "held", "public-unlink-before"];

for (const stage of [...preinstallCuts, ...pairCuts, ...installedCuts, "public-unlinked", "directory-4-sync-before", "directory-4-sync-after"]) {
  test(`QA003 process cut ${stage} preserves exact publication authority and recovers after reap`, { timeout: 10_000 }, async (t) => {
    const { root, lockPath } = await fixture(t);
    const owned = await launch(t, lockPath, stage);
    const names = (await readdir(root)).sort();
    const candidates = names.filter((name) => name.startsWith(".mutation.lock.owner-"));
    const hasPublic = pairCuts.includes(stage) || installedCuts.includes(stage);
    assert.equal(names.includes("mutation.lock"), hasPublic, JSON.stringify(owned.receipt));
    assert.equal(candidates.length, preinstallCuts.includes(stage) || pairCuts.includes(stage) ? 1 : 0);
    if (stage === "created") {
      assert.equal(owned.receipt.bytes, 0);
      assert.notEqual(owned.receipt.name, lockPath, "must hit the NEW candidate, never the old canonical create");
    }

    for (const name of names) {
      const info = await lstat(path.join(root, name));
      assert.equal(info.nlink, pairCuts.includes(stage) ? 2 : 1);
      assert.equal(info.mode & 0o777, 0o600);
    }
    if (hasPublic) {
      const owner = await readSyncOwnership(lockPath);
      assert.equal(owner?.pid, owned.child.pid, JSON.stringify(owned.receipt));
      if (pairCuts.includes(stage)) await assert.rejects(openPrivateFile(lockPath, 4096), /bounded regular file/);
      await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
      await assert.rejects(lstat(`${lockPath}.reap`), { code: "ENOENT" });
    }

    if (stage === "held") {
      const trace = owned.receipt.trace;
      assert.ok(Array.isArray(trace));
      const expected = ["writable-sync-after", "close-after", "directory-1-sync-after", "linked", "readonly-1-sync-after", "directory-2-sync-after",
        "candidate-unlinked", "readonly-2-sync-after", "directory-3-sync-after", "held"];
      const indices = expected.map((event) => trace.indexOf(event));
      assert.ok(indices.every((index, position) => index >= 0 && (position === 0 || index > indices[position - 1])), JSON.stringify(trace));
    }

    await owned.kill();
    t.diagnostic(JSON.stringify(owned.receipt));
    const ownership = await acquireSyncOwnership(lockPath, Date.now() + 1000);
    assert.deepEqual(await readSyncOwnership(lockPath), ownership.owner);
    await ownership.release();
    const remnants = await readdir(root);
    assert.deepEqual(remnants.sort(), preinstallCuts.includes(stage) ? candidates : []);
  });
}

const acquisitionFaults = ["created", "write-before", "partial", "written", "writable-sync-before", "writable-sync-after", "close-before", "close-after", "read-open",
  "directory-1-sync-before", "directory-1-sync-after", "link-before", "linked", "readonly-1-sync-before", "readonly-1-sync-after", "directory-2-sync-before", "directory-2-sync-after",
  "candidate-unlink-before", "candidate-unlinked", "readonly-2-sync-before", "readonly-2-sync-after", "directory-3-sync-before", "directory-3-sync-after"];
for (const code of ["EIO", "ENOSPC"]) {
  for (const stage of acquisitionFaults) {
    test(`${code} at ${stage} rejects acquisition and cleans only known own names`, { timeout: 10_000 }, async (t) => {
      const { root, lockPath } = await fixture(t);
      const owned = await launch(t, lockPath, stage, "error", code);
      assert.equal(owned.receipt.acquired, false, JSON.stringify(owned.receipt));
      assert.equal(owned.receipt.callback, false);
      assert.match(parseString(owned.receipt.error), /Injected|uncertainty/);
      assert.deepEqual(await owned.closed, [0, null]);
      const remnants = await readdir(root);
      if (stage === "created") {
        assert.equal(remnants.length, 1, "open-performed-then-rejected retains a non-authoritative candidate without an owned handle");
        assert.match(remnants[0], /^\.mutation\.lock\.owner-/);
        await assert.rejects(lstat(lockPath), { code: "ENOENT" });
      } else {
        assert.deepEqual(remnants, [], JSON.stringify(owned.receipt));
      }
      const next = await acquireSyncOwnership(lockPath, Date.now() + 1000);
      await next.release();
    });
  }
}

for (const action of ["abort", "deadline"]) {
  for (const stage of ["directory-1-sync-after", "directory-3-sync-after"]) {
    test(`${action} at ${stage} prevents protected work and removes its known installation`, async (t) => {
      const { root, lockPath } = await fixture(t);
      const owned = await launch(t, lockPath, stage, action);
      assert.equal(owned.receipt.acquired, false);
      assert.equal(owned.receipt.callback, false);
      assert.deepEqual(await owned.closed, [0, null]);
      assert.deepEqual(await readdir(root), []);
    });
  }
}

for (const stage of ["public-unlink-before", "public-unlinked", "directory-4-sync-before", "directory-4-sync-after"]) {
  test(`release error ${stage} reports failure after protected work without rollback`, async (t) => {
    const { lockPath } = await fixture(t);
    const owned = await launch(t, lockPath, stage, "error");
    assert.equal(owned.receipt.acquired, false);
    assert.equal(owned.receipt.callback, true);
    assert.deepEqual(await owned.closed, [0, null]);
    const ownership = await acquireSyncOwnership(lockPath, Date.now() + 1000);
    await ownership.release();
  });
}

async function deadRecord() {
  return { token: randomUUID(), pid: 2147483647, start: null };
}

for (const invalid of ["", "{", "{}", "[]", "null", "unknown", "extra", "version", "pid", "token", "start", "oversize", "utf8"]) {
  test(`unknown canonical ${invalid || "empty"} remains blocked with no reaper guard`, async (t) => {
    const { root, lockPath } = await fixture(t);
    const valid = await deadRecord();
    const variants: Record<string, unknown> = { unknown: { ...valid, schemaVersion: 3 }, extra: { ...valid, extra: true }, version: { ...valid, schemaVersion: 1 },
      pid: { ...valid, pid: 2147483648 }, token: { ...valid, token: "../../other", schemaVersion: 2 }, start: { ...valid, start: "" } };
    const bytes = invalid === "oversize" ? Buffer.alloc(4097, 32) : invalid === "utf8" ? Buffer.from([0xff]) : Buffer.from(invalid in variants ? JSON.stringify(variants[invalid]) : invalid);
    await writeFile(lockPath, bytes, { mode: 0o600 });
    assert.equal(await readSyncOwnership(lockPath), null);
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
    assert.deepEqual(await readFile(lockPath), bytes);
    assert.deepEqual(await readdir(root), ["mutation.lock"]);
  });
}

test("legacy one-link record is readable and recoverable; old schema reader rejects new records", async (t) => {
  const { lockPath } = await fixture(t);
  const owner = await deadRecord();
  await writeFile(lockPath, JSON.stringify(owner), { mode: 0o600 });
  assert.deepEqual(await readSyncOwnership(lockPath), owner);
  const current = await acquireSyncOwnership(lockPath, Date.now() + 1000);
  const disk = parseObject(JSON.parse(await readFile(lockPath, "utf8")), "new lock");
  assert.equal(disk.schemaVersion, 2);
  assert.throws(() => assertExactKeys(disk, ["token", "pid", "start"]), /schema/);
  await current.release();
});

for (const kind of ["symlink", "fifo", "directory", "insecure", "unreadable", "legacy-hardlink", "third-link", "wrong-candidate", "missing-candidate"]) {
  test(`${kind} never grants authority or causes foreign unlink`, async (t) => {
    const { root, lockPath } = await fixture(t);
    const owner = await deadRecord();
    const foreign = path.join(root, "foreign");
    const candidate = path.join(root, `.mutation.lock.owner-${owner.token}`);
    await writeFile(foreign, "foreign", { mode: 0o600 });
    if (kind === "symlink") await symlink(foreign, lockPath);
    else if (kind === "fifo") await runFile("mkfifo", ["-m", "600", lockPath]);
    else if (kind === "directory") await fs.mkdir(lockPath, { mode: 0o700 });
    else {
      await writeFile(lockPath, JSON.stringify(kind === "legacy-hardlink" ? owner : { schemaVersion: 2, ...owner }), { mode: 0o600 });
      if (kind === "insecure") await chmod(lockPath, 0o644);
      if (kind === "unreadable") await chmod(lockPath, 0o000);
      if (["legacy-hardlink", "third-link", "missing-candidate", "wrong-candidate"].includes(kind)) await link(lockPath, path.join(root, "outside"));
      if (kind === "third-link") await link(lockPath, candidate);
      if (kind === "wrong-candidate") await writeFile(candidate, JSON.stringify({ schemaVersion: 2, ...owner }), { mode: 0o600 });
    }
    const before = (await readdir(root)).sort();
    assert.equal(await readSyncOwnership(lockPath), null);
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
    assert.deepEqual((await readdir(root)).sort(), before);
    assert.equal(await readFile(foreign, "utf8"), "foreign");
  });
}

test("live, null-start and EPERM identity are conservative; Linux start mismatch proves old identity gone", async (t) => {
  const { root, lockPath } = await fixture(t);
  const live = { token: randomUUID(), pid: process.pid, start: await processStart(process.pid) };
  for (const start of [live.start, null]) {
    await writeFile(lockPath, JSON.stringify({ ...live, start }), { mode: 0o600 });
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
    assert.equal(await isDeadOwner({ ...live, start }), false);
    assert.deepEqual(await readdir(root), ["mutation.lock"]);
  }
  const kill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
    assert.equal(await isDeadOwner({ ...live, start: "different" }), false);
  } finally { process.kill = kill; }
  if (process.platform === "linux") {
    const originalRead = fs.readFile;
    const probe = mock.method(fs, "readFile", async (...args: Parameters<typeof originalRead>) => {
      if (String(args[0]) === `/proc/${process.pid}/stat`) throw Object.assign(new Error("identity unavailable"), { code: "EPERM" });
      return originalRead(...args);
    });
    try { assert.equal(await isDeadOwner({ ...live, start: "unavailable" }), false); } finally { probe.mock.restore(); }
    assert.equal(await isDeadOwner({ ...live, start: "different-boot:start" }), true);
    await writeFile(lockPath, JSON.stringify({ ...live, start: "different-boot:start" }), { mode: 0o600 });
    const ownership = await acquireSyncOwnership(lockPath, Date.now() + 1000);
    await ownership.release();
  }
});

test("wrong account and insecure parent are rejected without chmod or deletion", async (t) => {
  const { root, lockPath } = await fixture(t);
  const getuid = process.getuid;
  assert.ok(getuid);
  const uid = getuid();
  await writeFile(lockPath, JSON.stringify(await deadRecord()), { mode: 0o600 });
  try {
    process.getuid = () => uid + 1;
    assert.equal(await readSyncOwnership(lockPath), null);
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 100), /account/);
  } finally { process.getuid = getuid; }
  await unlink(lockPath);
  await chmod(root, 0o755);
  await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 100), /0700/);
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
});

test("release refuses a substituted inode or changed bytes despite matching token", async (t) => {
  const { root, lockPath } = await fixture(t);
  for (const replacement of ["inode", "identity"]) {
    const ownership = await acquireSyncOwnership(lockPath, Date.now() + 1000);
    const bytes = await readFile(lockPath);
    if (replacement === "inode") {
      await rename(lockPath, path.join(root, "saved"));
      await writeFile(lockPath, bytes, { mode: 0o600 });
    } else {
      await writeFile(lockPath, JSON.stringify({ schemaVersion: 2, ...ownership.owner, start: "foreign" }));
    }
    await assert.rejects(ownership.release(), /inode|identity/);
    assert.ok(await lstat(lockPath));
    await unlink(lockPath);
  }
});

test("ordinary catalog mode avoids directory fsync and managed platform gate", async (t) => {
  const { lockPath } = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const open = fs.open;
  let directories = 0;
  fs.open = async (name, flags, mode) => {
    const file = await open(name, flags, mode);
    if ((await file.stat()).isDirectory()) { directories += 1; await file.close(); throw new Error("unsupported directory fsync"); }
    return file;
  };
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 100), /POSIX/);
    const portable = await acquireSyncOwnership(lockPath, Date.now() + 1000, undefined, { mode: "portable" });
    const record = parseObject(JSON.parse(await readFile(lockPath, "utf8")), "portable");
    assertExactKeys(record, ["token", "pid", "start"]);
    await portable.release();
    assert.equal(directories, 0);
  } finally {
    fs.open = open;
    if (platform) Object.defineProperty(process, "platform", platform);
  }
});

test("local promise contenders serialize protected mutations without normal remnants", async (t) => {
  const { root } = await fixture(t);
  let active = 0;
  let count = 0;
  await Promise.all(Array.from({ length: 12 }, () => withStoreLock(root, 3000, async () => {
    assert.equal(++active, 1);
    const previous = count;
    await new Promise((resolve) => setTimeout(resolve, 2));
    count = previous + 1;
    active -= 1;
  })));
  assert.equal(count, 12);
  assert.deepEqual(await readdir(root), []);
});

test("reader retries the legitimate pair-to-single transition while general hardlink checks stay strict", async (t) => {
  const { root, lockPath } = await fixture(t);
  const owner = await deadRecord();
  const candidate = path.join(root, `.mutation.lock.owner-${owner.token}`);
  await writeFile(lockPath, JSON.stringify({ schemaVersion: 2, ...owner }), { mode: 0o600 });
  await link(lockPath, candidate);
  await assert.rejects(openPrivateFile(lockPath, 4096), /bounded regular file/);
  const open = fs.open;
  let hits = 0;
  fs.open = async (name, flags, mode) => {
    const file = await open(name, flags, mode);
    if (String(name) === candidate && hits++ === 0) await unlink(candidate);
    return file;
  };
  try {
    assert.deepEqual(await readSyncOwnership(lockPath), owner);
    assert.equal(hits, 1);
  } finally { fs.open = open; }
});

test("reader rejects pathname substitution after opening the original inode", async (t) => {
  const { root, lockPath } = await fixture(t);
  const bytes = JSON.stringify({ schemaVersion: 2, ...await deadRecord() });
  await writeFile(lockPath, bytes, { mode: 0o600 });
  const open = fs.open;
  let hits = 0;
  fs.open = async (name, flags, mode) => {
    const file = await open(name, flags, mode);
    if (String(name) === lockPath && hits++ === 0) {
      await rename(lockPath, path.join(root, "original"));
      await writeFile(lockPath, bytes, { mode: 0o600 });
    }
    return file;
  };
  try { assert.equal(await readSyncOwnership(lockPath), null); } finally { fs.open = open; }
  assert.equal(await readFile(lockPath, "utf8"), bytes);
});

test("performed link plus failed cleanup retains inspectable uncertainty and never enters protected work", async (t) => {
  const { root, lockPath } = await fixture(t);
  const originalLink = fs.link;
  const originalUnlink = fs.unlink;
  let callback = 0;
  fs.link = async (source, target) => { await originalLink(source, target); throw Object.assign(new Error("link outcome uncertain"), { code: "EIO" }); };
  fs.unlink = async () => { throw Object.assign(new Error("cleanup unavailable"), { code: "ENOSPC" }); };
  try {
    await assert.rejects(withStoreLock(root, 1000, async () => { callback += 1; }), /uncertainty retained/);
  } finally { fs.link = originalLink; fs.unlink = originalUnlink; }
  assert.equal(callback, 0);
  const names = await readdir(root);
  assert.equal(names.length, 2);
  assert.equal((await lstat(lockPath)).nlink, 2);
  const record = await readSyncOwnership(lockPath);
  assert.equal(record?.pid, process.pid);
  await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
  assert.deepEqual((await readdir(root)).sort(), names.sort());
});

test("candidate substitution is retained without chmod or foreign unlink", async (t) => {
  const { root, lockPath } = await fixture(t);
  const originalLink = fs.link;
  let foreign: string | undefined;
  fs.link = async (source, target) => {
    foreign = String(source);
    await rename(source, path.join(root, "original"));
    await writeFile(source, "foreign candidate", { mode: 0o644 });
    await originalLink(source, target);
  };
  try { await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 1000), /uncertainty retained/); } finally { fs.link = originalLink; }
  assert.ok(foreign);
  assert.equal(await readFile(foreign, "utf8"), "foreign candidate");
  assert.equal((await lstat(foreign)).mode & 0o777, 0o644);
  assert.equal(await readFile(lockPath, "utf8"), "foreign candidate");
});

for (const stage of ["guard-created", "candidate-unlink-before", "candidate-unlinked", "readonly-1-sync-before", "readonly-1-sync-after",
  "directory-2-sync-before", "directory-2-sync-after", "public-unlink-before", "public-unlinked", "directory-3-sync-before", "directory-3-sync-after", "guard-unlink-before", "guard-unlinked"]) {
  test(`dead pair reaper process cut ${stage} respects retained guard and public authority`, async (t) => {
    const { root, lockPath } = await fixture(t);
    const owner = await deadRecord();
    const candidate = path.join(root, `.mutation.lock.owner-${owner.token}`);
    await writeFile(lockPath, JSON.stringify({ schemaVersion: 2, ...owner }), { mode: 0o600 });
    await link(lockPath, candidate);
    const owned = await launch(t, lockPath, stage);
    await owned.kill();
    t.diagnostic(JSON.stringify(owned.receipt));
    const publicExists = await lstat(lockPath).then(() => true, () => false);
    const guardExists = await lstat(`${lockPath}.reap`).then(() => true, () => false);
    if (publicExists && guardExists) {
      await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
      assert.ok(await lstat(lockPath));
      assert.ok(await lstat(`${lockPath}.reap`));
    } else {
      const next = await acquireSyncOwnership(lockPath, Date.now() + 1000);
      await next.release();
      assert.equal(await lstat(`${lockPath}.reap`).then(() => true, () => false), guardExists);
    }
  });
}

test("reaper never touches public L after removal even when a successor installs before finally", async (t) => {
  const { lockPath } = await fixture(t);
  await writeFile(lockPath, JSON.stringify(await deadRecord()), { mode: 0o600 });
  const originalUnlink = fs.unlink;
  let successor: Awaited<ReturnType<typeof acquireSyncOwnership>> | undefined;
  let hits = 0;
  fs.unlink = async (name) => {
    await originalUnlink(name);
    if (String(name) === lockPath && hits++ === 0) successor = await acquireSyncOwnership(lockPath, Date.now() + 1000);
  };
  try {
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 100), /deadline/);
    assert.equal(hits, 1);
    assert.ok(successor);
    assert.deepEqual(await readSyncOwnership(lockPath), successor.owner);
  } finally { fs.unlink = originalUnlink; await successor?.release(); }
});

test("reaper guard substitution survives cleanup and is never recursively recovered", async (t) => {
  const { root, lockPath } = await fixture(t);
  await writeFile(lockPath, JSON.stringify(await deadRecord()), { mode: 0o600 });
  const originalUnlink = fs.unlink;
  let hits = 0;
  fs.unlink = async (name) => {
    await originalUnlink(name);
    if (String(name) === lockPath && hits++ === 0) {
      await rename(`${lockPath}.reap`, path.join(root, "old-guard"));
      await writeFile(`${lockPath}.reap`, "foreign guard", { mode: 0o600 });
    }
  };
  try { await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 1000), /inode/); } finally { fs.unlink = originalUnlink; }
  assert.equal(hits, 1);
  assert.equal(await readFile(`${lockPath}.reap`, "utf8"), "foreign guard");
  const ownership = await acquireSyncOwnership(lockPath, Date.now() + 1000);
  await ownership.release();
  assert.equal(await readFile(`${lockPath}.reap`, "utf8"), "foreign guard");
});

test("independent process contenders preserve every protected increment and one holder", async (t) => {
  const { root } = await fixture(t);
  const counter = path.join(root, "counter");
  await writeFile(counter, "0", { mode: 0o600 });
  const script = `
    const fs = require('node:fs/promises');
    const {withStoreLock} = require(process.argv[1]);
    const root = process.argv[2];
    (async () => { for (let index=0; index<6; index++) await withStoreLock(root, 5000, async () => {
      const file = await fs.open(root+'/active', 'wx', 0o600);
      try { const n=Number(await fs.readFile(root+'/counter','utf8')); await fs.writeFile(root+'/counter', String(n+1)); }
      finally { await file.close(); await fs.unlink(root+'/active'); }
    }); })().catch(error=>{ console.error(error);process.exitCode=1; });`;
  const results = await Promise.all(Array.from({ length: 5 }, () => runFile(process.execPath,
    ["-e", script, path.join(__dirname, "sync-files.js"), root], { timeout: 10_000 })));
  assert.equal(results.length, 5);
  assert.equal(await readFile(counter, "utf8"), "30");
  assert.deepEqual(await readdir(root), ["counter"]);
});

test("a missed fault hook with successful acquisition is explicitly rejected by the cut verifier", async (t) => {
  const { lockPath } = await fixture(t);
  await assert.rejects(launch(t, lockPath, "nonexistent-cut", "error"), /0 !== 1/);
});

for (const stage of ["candidate-unlink-before", "candidate-unlinked", "readonly-1-sync-before", "readonly-1-sync-after", "directory-2-sync-before", "directory-2-sync-after",
  "public-unlink-before", "public-unlinked", "directory-3-sync-before", "directory-3-sync-after", "guard-unlink-before", "guard-unlinked"]) {
  for (const code of ["EIO", "ENOSPC"]) {
    test(`dead pair reaper ${code} at ${stage} preserves uncertainty without protected work`, async (t) => {
      const { root, lockPath } = await fixture(t);
      const owner = await deadRecord();
      await writeFile(lockPath, JSON.stringify({ schemaVersion: 2, ...owner }), { mode: 0o600 });
      await link(lockPath, path.join(root, `.mutation.lock.owner-${owner.token}`));
      const owned = await launch(t, lockPath, stage, "error", code);
      assert.equal(owned.receipt.acquired, false);
      assert.equal(owned.receipt.callback, false);
      assert.deepEqual(await owned.closed, [0, null]);
      const guard = await lstat(`${lockPath}.reap`).then(() => true, () => false);
      const canonical = await lstat(lockPath).then(() => true, () => false);
      if (guard && canonical) {
        await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 35), /deadline/);
      } else {
        const next = await acquireSyncOwnership(lockPath, Date.now() + 1000);
        await next.release();
      }
    });
  }
}

test("catalog registration remains portable under simulated Windows with unavailable directory fsync", async (t) => {
  const { root } = await fixture(t);
  const script = `
    const fs = require('node:fs/promises');
    const original = fs.open;
    let directoryOpens=0;
    fs.open = async (...args) => {
      const file=await original(...args);
      if((await file.stat()).isDirectory()) {directoryOpens++;await file.close();throw new Error('directory fsync unsupported');}
      return file;
    };
    Object.defineProperty(process,'platform',{value:'win32'});
    const {createInbox,readInboxCatalog}=require(process.argv[1]);
    (async()=>{
      for(let index=0;index<3;index++) await createInbox('inbox'+index,process.argv[2]+'/inbox'+index,process.argv[2]+'/catalog');
      const catalog=await readInboxCatalog(process.argv[2]+'/catalog');
      process.stdout.write(JSON.stringify({count:catalog.inboxes.length,directoryOpens}));
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const result = await runFile(process.execPath, ["-e", script, path.join(__dirname, "inbox-catalog.js"), root], { timeout: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout), { count: 3, directoryOpens: 0 });
});

test("reaper rejects an inode substitution under its guard even with identical dead owner bytes", { timeout: 5000 }, async (t) => {
  const { root, lockPath } = await fixture(t);
  const bytes = JSON.stringify(await deadRecord());
  await writeFile(lockPath, bytes, { mode: 0o600 });
  const originalOpen = fs.open;
  const originalNow = Date.now;
  let clock = originalNow();
  const deadline = clock + 60;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Fixture did not reach the guarded inode substitution")), 1000);
  // Candidate durability can consume the real deadline before this fault is armed.
  // Expire the same logical deadline only after the guarded substitution occurs.
  Date.now = () => clock;
  let hits = 0;
  fs.open = async (name, flags, mode) => {
    const file = await originalOpen(name, flags, mode);
    if (String(name) === `${lockPath}.reap`) {
      hits += 1;
      await rename(lockPath, path.join(root, `old-${hits}`));
      await writeFile(lockPath, bytes, { mode: 0o600 });
      clock = deadline;
    }
    return file;
  };
  try {
    await assert.rejects(acquireSyncOwnership(lockPath, deadline, controller.signal), /deadline/);
  } finally {
    clearTimeout(timer);
    Date.now = originalNow;
    fs.open = originalOpen;
  }
  assert.equal(hits, 1);
  assert.equal(await readFile(lockPath, "utf8"), bytes);
  await assert.rejects(lstat(`${lockPath}.reap`), { code: "ENOENT" });
});

test("EEXIST reported after performing the link is detected as own installation and cleaned", async (t) => {
  const { root, lockPath } = await fixture(t);
  const owned = await launch(t, lockPath, "linked", "error", "EEXIST");
  assert.equal(owned.receipt.acquired, false);
  assert.equal(owned.receipt.callback, false);
  assert.deepEqual(await owned.closed, [0, null]);
  assert.deepEqual(await readdir(root), []);
});

test("EEXIST contention reuses one candidate for the invocation and removes it on timeout", async (t) => {
  const { root, lockPath } = await fixture(t);
  const holder = await acquireSyncOwnership(lockPath, Date.now() + 1000);
  const originalOpen = fs.open;
  const candidates: string[] = [];
  fs.open = async (name, flags, mode) => {
    if (String(name).includes(".mutation.lock.owner-") && typeof flags === "number" && (flags & constants.O_EXCL) !== 0) candidates.push(String(name));
    return originalOpen(name, flags, mode);
  };
  try {
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 90), /deadline/);
    assert.equal(candidates.length, 1);
    assert.deepEqual(await readSyncOwnership(lockPath), holder.owner);
    assert.deepEqual(await readdir(root), ["mutation.lock"]);
  } finally { fs.open = originalOpen; await holder.release(); }
});

test("candidate collision is never replaced or chmodded", async (t) => {
  const { root, lockPath } = await fixture(t);
  const crypto: typeof import("node:crypto") = require("node:crypto");
  const originalUuid = crypto.randomUUID;
  const token = randomUUID();
  const candidate = path.join(root, `.mutation.lock.owner-${token}`);
  await writeFile(candidate, "foreign collision", { mode: 0o644 });
  crypto.randomUUID = () => token;
  try { await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 1000), { code: "EEXIST" }); } finally { crypto.randomUUID = originalUuid; }
  assert.equal(await readFile(candidate, "utf8"), "foreign collision");
  assert.equal((await lstat(candidate)).mode & 0o777, 0o644);
  assert.deepEqual(await readdir(root), [path.basename(candidate)]);
});

test("release rejection after public unlink preserves the actual committed ledger and exact report bytes", async (t) => {
  const { ManagedSyncStore } = await import("./sync-store.js");
  const { root } = await fixture(t);
  const home = path.join(root, "inbox");
  let armed = false;
  let flushed = false;
  const store = new ManagedSyncStore(home, { testHooks: { onEvent(event) {
    if (armed && event === "ledger-dir-fsynced") flushed = true;
  } } });
  await store.enroll();
  const bytes = Buffer.from("<!doctype html><html><body>committed before release failure</body></html>");
  const originalUnlink = fs.unlink;
  let hits = 0;
  fs.unlink = async (name) => {
    await originalUnlink(name);
    if (String(name) === path.join(home, "sync", "mutation.lock") && flushed && hits++ === 0) {
      throw Object.assign(new Error("release unlink performed then rejected"), { code: "EIO" });
    }
  };
  armed = true;
  try {
    await assert.rejects(store.publish({ originalBytes: bytes, title: "Release failure", type: "report", sourceFileName: "release.html" }, "release-failure"), /release unlink/);
  } finally { fs.unlink = originalUnlink; }
  assert.equal(hits, 1);
  const ledger = await store.snapshot();
  assert.ok(Object.values(ledger.records).find((record) => record.originDocumentId === "release-failure"));
  assert.deepEqual((await store.getDocument("release-failure"))?.originalBytes, bytes);
  await assert.rejects(lstat(path.join(home, "sync", "mutation.lock")), { code: "ENOENT" });
});

test("a further handle-close rejection never hides retained namespace uncertainty", async (t) => {
  const { root, lockPath } = await fixture(t);
  const originalOpen = fs.open;
  const originalLink = fs.link;
  const originalUnlink = fs.unlink;
  let intercepted = false;
  fs.open = async (name, flags, mode) => {
    const file = await originalOpen(name, flags, mode);
    if (!intercepted && String(name).includes(".owner-") && typeof flags === "number" && (flags & constants.O_EXCL) === 0) {
      intercepted = true;
      const close = file.close.bind(file);
      file.close = async () => { await close(); throw new Error("held close performed then rejected"); };
    }
    return file;
  };
  fs.link = async (source, target) => { await originalLink(source, target); throw Object.assign(new Error("link performed then rejected"), { code: "EIO" }); };
  fs.unlink = async () => { throw Object.assign(new Error("cleanup unlink denied"), { code: "ENOSPC" }); };
  try {
    await assert.rejects(acquireSyncOwnership(lockPath, Date.now() + 1000), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /namespace uncertainty retained/);
      assert.equal(error.errors.length, 3);
      assert.match(String(error.errors[0]), /link performed/);
      assert.match(String(error.errors[1]), /cleanup unlink/);
      assert.match(String(error.errors[2]), /close/);
      return true;
    });
  } finally { fs.open = originalOpen; fs.link = originalLink; fs.unlink = originalUnlink; }
  assert.equal(intercepted, true);
  assert.equal((await lstat(lockPath)).nlink, 2);
  assert.equal((await readdir(root)).length, 2);
});

test("reaper guard unlink and close errors retain both causes and the exact guard", async (t) => {
  const { root, lockPath } = await fixture(t);
  await writeFile(lockPath, JSON.stringify(await deadRecord()), { mode: 0o600 });
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  fs.open = async (name, flags, mode) => {
    const file = await originalOpen(name, flags, mode);
    if (String(name) === `${lockPath}.reap`) {
      const close = file.close.bind(file);
      file.close = async () => { await close(); throw new Error("reaper guard close rejected"); };
    }
    return file;
  };
  fs.unlink = async (name) => {
    if (String(name) === `${lockPath}.reap`) throw Object.assign(new Error("reaper guard unlink denied"), { code: "ENOSPC" });
    await originalUnlink(name);
  };
  try {
    await assert.rejects(withStoreLock(root, 1000, async () => { assert.fail("failed reaper must prevent protected work"); }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /namespace uncertainty retained/);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /guard unlink/);
      assert.match(String(error.errors[1]), /close/);
      return true;
    });
  } finally { fs.open = originalOpen; fs.unlink = originalUnlink; }
  assert.ok(await lstat(`${lockPath}.reap`));
  assert.deepEqual(await readdir(root), ["mutation.lock.reap"]);
  const next = await acquireSyncOwnership(lockPath, Date.now() + 1000);
  await next.release();
  assert.deepEqual(await readdir(root), ["mutation.lock.reap"]);
});

function errorCauses(error: unknown): unknown[] {
  if (!(error instanceof Error)) return [error];

  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(errorCauses) : []),
    ...("cause" in error ? errorCauses(error.cause) : [])];
}

for (const stage of ["candidate-write", "candidate-sync", "candidate-validation", "candidate-close-only", "directory-validation",
  "pair-read", "pair-close-only", "snapshot-recovery", "held-validation"]) {
  test(`nested ownership ${stage} preserves operation and close failures with actual handle cleanup`, async (t) => {
    const { root, lockPath } = await fixture(t);
    const foreign = path.join(root, "foreign");
    await writeFile(foreign, "unrelated evidence", { mode: 0o644 });
    const operationError = Object.assign(new Error(`${stage} operation EIO`), { code: "EIO" });
    const recoveryError = Object.assign(new Error("snapshot recovery stat ENOSPC"), { code: "ENOSPC" });
    const closeError = new Error(`${stage} first close rejected`);
    const originalOpen = fs.open;
    const handles: { file: Awaited<ReturnType<typeof fs.open>>; close: () => Promise<void> }[] = [];
    let operationHits = 0;
    let recoveryHits = 0;
    let closeHits = 0;
    let writes = 0;
    let candidateReads = 0;
    let publicOpens = 0;
    let callbacks = 0;
    let armedHeld = false;
    let selected = false;
    const failOperation = () => { operationHits += 1; throw operationError; };

    fs.open = async (name, flags, mode) => {
      const file = await originalOpen(name, flags, mode);
      const close = file.close.bind(file);
      handles.push({ file, close });
      const candidate = String(name).startsWith(path.join(root, ".mutation.lock.owner-"));
      const writable = candidate && typeof flags === "number" && (flags & constants.O_EXCL) !== 0;
      if (writable) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (...args) => { writes += 1; if (stage === "candidate-write") failOperation(); return write(...args); };
      }
      if (candidate && !writable) candidateReads += 1;
      if (String(name) === lockPath) publicOpens += 1;

      if (stage === "held-validation" && candidate && !writable && candidateReads === 1) {
        const stat = file.stat.bind(file);
        t.mock.method(file, "stat", async () => { if (armedHeld && operationHits === 0) failOperation(); return stat(); });
      }

      const target = !selected && (stage.startsWith("candidate-") && writable ||
        stage === "directory-validation" && String(name) === root ||
        stage.startsWith("pair-") && candidate && !writable && candidateReads === 2 ||
        ["snapshot-recovery", "held-validation"].includes(stage) && String(name) === lockPath && publicOpens === 1);
      if (target) {
        selected = true;
        file.close = async () => { closeHits += 1; if (closeHits === 1) throw closeError; await close(); };
        if (stage === "candidate-sync") file.sync = async () => failOperation();
        if (["candidate-validation", "directory-validation", "snapshot-recovery"].includes(stage)) {
          const stat = file.stat.bind(file);
          let stats = 0;
          t.mock.method(file, "stat", async () => {
            stats += 1;
            if (stage === "directory-validation" || stage === "candidate-validation" && stats === 2) failOperation();
            if (stage === "snapshot-recovery" && stats === 2) { recoveryHits += 1; throw recoveryError; }
            return stat();
          });
        }
        if (["pair-read", "snapshot-recovery"].includes(stage)) file.read = async () => failOperation();
        if (stage === "held-validation") armedHeld = true;
      }

      return file;
    };

    try {
      let failure: unknown;
      try { await withStoreLock(root, 1000, async () => { callbacks += 1; }); } catch (error) { failure = error; }
      const causes = errorCauses(failure);
      t.diagnostic(JSON.stringify({ stage, writes, operationHits, recoveryHits, closeHits, callbacks,
        causes: causes.map(String), handles: handles.map(({ file }) => file.fd), names: await readdir(root) }));
      assert.equal(callbacks, 0, "failed acquisition must never enter protected work");
      assert.equal(selected, true, "the actual nested handle must be reached");
      assert.equal(writes, stage === "directory-validation" ? 0 : 1);
      assert.equal(closeHits, 2, "the second close must actually release the descriptor");
      assert.ok(causes.includes(closeError));
      assert.equal(operationHits, stage.endsWith("close-only") ? 0 : 1);
      if (!stage.endsWith("close-only")) { assert.ok(causes.includes(operationError)); assert.equal(operationError.code, "EIO"); }
      if (stage === "snapshot-recovery") { assert.equal(recoveryHits, 1); assert.ok(causes.includes(recoveryError)); }
      assert.ok(handles.every(({ file }) => file.fd === -1), "all owned handles must be closed before emergency fixture cleanup");
      assert.deepEqual(await readdir(root), ["foreign"]);
      assert.equal(await readFile(foreign, "utf8"), "unrelated evidence");
      assert.equal((await lstat(foreign)).mode & 0o777, 0o644);
    } finally {
      fs.open = originalOpen;
      for (const { close } of handles) await close();
    }
  });
}

test("protected operation and release failures both survive while the unremoved lock remains authoritative", async (t) => {
  const { root, lockPath } = await fixture(t);
  const operationError = new Error("protected operation rejected");
  const releaseError = Object.assign(new Error("release public unlink denied"), { code: "ENOSPC" });
  const originalUnlink = fs.unlink;
  let callbacks = 0;
  let unlinkHits = 0;
  fs.unlink = async (name) => {
    if (String(name) === lockPath) { unlinkHits += 1; throw releaseError; }
    await originalUnlink(name);
  };

  try {
    await assert.rejects(withStoreLock(root, 1000, async () => { callbacks += 1; throw operationError; }), (error: unknown) => {
      const causes = errorCauses(error);
      assert.ok(causes.includes(operationError));
      assert.ok(causes.includes(releaseError));
      return true;
    });
  } finally { fs.unlink = originalUnlink; }

  assert.equal(callbacks, 1);
  assert.equal(unlinkHits, 1);
  assert.equal((await readSyncOwnership(lockPath))?.pid, process.pid);
  assert.deepEqual(await readdir(root), ["mutation.lock"]);
});

test("candidate write, close and denied cleanup retain every cause and the exact uncertain candidate", async (t) => {
  const { root, lockPath } = await fixture(t);
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  const writeError = Object.assign(new Error("candidate write denied"), { code: "EIO" });
  const closeError = new Error("candidate close rejected");
  const unlinkError = Object.assign(new Error("candidate unlink denied"), { code: "ENOSPC" });
  let writable: Awaited<ReturnType<typeof fs.open>> | undefined;
  let candidate: string | undefined;
  let writeHits = 0;
  let closeHits = 0;
  let unlinkHits = 0;
  let callbacks = 0;
  fs.open = async (name, flags, mode) => {
    const file = await originalOpen(name, flags, mode);
    if (String(name).startsWith(path.join(root, ".mutation.lock.owner-"))) {
      writable = file;
      candidate = String(name);
      const close = file.close.bind(file);
      file.writeFile = async () => { writeHits += 1; throw writeError; };
      file.close = async () => { closeHits += 1; if (closeHits === 1) throw closeError; await close(); };
    }
    return file;
  };
  fs.unlink = async (name) => {
    assert.equal(String(name), candidate, "only the checked own candidate may be targeted");
    unlinkHits += 1;
    throw unlinkError;
  };

  try {
    await assert.rejects(withStoreLock(root, 1000, async () => { callbacks += 1; }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /namespace uncertainty retained/);
      const causes = errorCauses(error);
      assert.ok(causes.includes(writeError));
      assert.ok(causes.includes(closeError));
      assert.ok(causes.includes(unlinkError));
      return true;
    });
  } finally { fs.open = originalOpen; fs.unlink = originalUnlink; }

  assert.equal(callbacks, 0);
  assert.equal(writeHits, 1);
  assert.equal(closeHits, 2);
  assert.equal(unlinkHits, 1);
  assert.equal(writable?.fd, -1);
  assert.ok(candidate);
  assert.equal((await lstat(candidate)).size, 0);
  assert.equal((await lstat(candidate)).nlink, 1);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), [path.basename(candidate)]);
});

test("readSyncOwnership still returns unknown after pair read and close failures without removing evidence", async (t) => {
  const { root, lockPath } = await fixture(t);
  const owner = await deadRecord();
  const candidate = path.join(root, `.mutation.lock.owner-${owner.token}`);
  const bytes = JSON.stringify({ schemaVersion: 2, ...owner });
  await writeFile(lockPath, bytes, { mode: 0o600 });
  await link(lockPath, candidate);
  const originalOpen = fs.open;
  let pair: Awaited<ReturnType<typeof fs.open>> | undefined;
  let reads = 0;
  let closes = 0;
  fs.open = async (name, flags, mode) => {
    const file = await originalOpen(name, flags, mode);
    if (String(name) === candidate) {
      pair = file;
      const close = file.close.bind(file);
      file.read = async () => { reads += 1; throw new Error("pair read EIO"); };
      file.close = async () => { closes += 1; if (closes === 1) throw new Error("pair close rejected"); await close(); };
    }
    return file;
  };

  try { assert.equal(await readSyncOwnership(lockPath), null); } finally { fs.open = originalOpen; }

  assert.equal(reads, 1);
  assert.equal(closes, 2);
  assert.equal(pair?.fd, -1);
  assert.equal(await readFile(lockPath, "utf8"), bytes);
  assert.equal(await readFile(candidate, "utf8"), bytes);
  assert.equal((await lstat(lockPath)).nlink, 2);
  assert.deepEqual((await readdir(root)).sort(), [path.basename(candidate), "mutation.lock"].sort());
});
