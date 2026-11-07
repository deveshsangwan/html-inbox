import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readInboxIdentity } from "./inbox-home";
import { ManagedSyncStore } from "./sync-store";
import { temporaryHome } from "./test-fixtures";
import { getInboxInstanceId } from "./viewer-records";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pauseIdentityWrite(t: TestContext, home: string, failure?: Error) {
  const opened = deferred();
  const resumed = deferred();
  const writeFile = fs.writeFile;
  let intercepted = false;

  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    const [filename, contents, options] = args;
    const isIdentity = typeof filename === "string" && path.dirname(filename) === home &&
      (path.basename(filename) === "instance-id" || path.basename(filename).startsWith("instance-id.tmp-"));
    if (intercepted || !isIdentity) {
      return writeFile(...args);
    }

    intercepted = true;
    assert.ok(options && typeof options === "object" && options.flag === "wx");
    const file = await fs.open(filename, "wx", options.mode);
    try {
      opened.resolve();
      await resumed.promise;
      if (failure) {
        throw failure;
      }

      assert.ok(typeof contents === "string");
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
  });

  return { opened: opened.promise, release: resumed.resolve };
}

test("initial identity stays absent until complete while concurrent creators converge", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const paused = pauseIdentityWrite(t, home);
  const writer = getInboxInstanceId(home);
  const writerResult = Promise.allSettled([writer]);
  let contenders: Promise<string[]> | undefined;

  try {
    await paused.opened;
    assert.equal(await readInboxIdentity(home), undefined);
    await assert.rejects(fs.lstat(path.join(home, "instance-id")), { code: "ENOENT" });

    contenders = Promise.all(Array.from({ length: 3 }, () => getInboxInstanceId(home)));
    void contenders.catch(() => {});
    paused.release();
    const identity = await writer;
    assert.deepEqual(await contenders, [identity, identity, identity]);
    assert.equal(await readInboxIdentity(home), identity);
    assert.deepEqual(await fs.readdir(home), ["instance-id"]);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(path.join(home, "instance-id"))).mode & 0o777, 0o600);
    }
  } finally {
    paused.release();
    await writerResult;
    await contenders?.catch(() => {});
  }
});

test("failed initial identity write leaves no published identity or temporary ownership files", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const failure = new Error("Injected identity write failure");
  const paused = pauseIdentityWrite(t, home, failure);
  const writer = getInboxInstanceId(home);
  const rejected = assert.rejects(writer, failure);

  try {
    await paused.opened;
    paused.release();
    await rejected;
    assert.equal(await readInboxIdentity(home), undefined);
    assert.deepEqual(await fs.readdir(home), []);
  } finally {
    paused.release();
    await rejected;
  }
});

test("failed identity rename cleans up and permits a fresh creation", async (t) => {
  const home = await temporaryHome(t);
  const identityPath = path.join(home, "instance-id");
  const failure = new Error("Injected identity rename failure");
  const rename = fs.rename;
  let rejectedRename = false;

  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!rejectedRename && args[1] === identityPath) {
      rejectedRename = true;
      throw failure;
    }

    return rename(...args);
  });

  await assert.rejects(getInboxInstanceId(home), failure);
  assert.equal(rejectedRename, true);
  assert.equal(await readInboxIdentity(home), undefined);
  assert.deepEqual(await fs.readdir(home), []);

  const identity = await getInboxInstanceId(home);
  assert.equal(await readInboxIdentity(home), identity);
  assert.deepEqual(await fs.readdir(home), ["instance-id"]);
});

test("identity initialization preserves an existing UUID and rejects malformed contents", async (t) => {
  const home = await temporaryHome(t);
  const identityPath = path.join(home, "instance-id");
  const identity = randomUUID();
  await fs.writeFile(identityPath, identity, { mode: 0o600 });
  assert.equal(await getInboxInstanceId(home), identity);
  assert.equal(await fs.readFile(identityPath, "utf8"), identity);

  for (const malformed of ["", "not-a-uuid"]) {
    await fs.writeFile(identityPath, malformed);
    await assert.rejects(getInboxInstanceId(home), /must be a version 4 UUID/);
    assert.equal(await fs.readFile(identityPath, "utf8"), malformed);
  }
});

test("identity inspection retains symbolic-link and hard-link rejection", { skip: process.platform === "win32" }, async (t) => {
  const home = await temporaryHome(t);
  const target = path.join(home, "target");
  const identityPath = path.join(home, "instance-id");
  const identity = randomUUID();
  await fs.writeFile(target, identity, { mode: 0o600 });
  await fs.symlink(target, identityPath);
  await assert.rejects(readInboxIdentity(home), /regular private file/);
  await assert.rejects(getInboxInstanceId(home), /regular.*file/);
  assert.equal(await fs.readFile(target, "utf8"), identity);

  await fs.unlink(identityPath);
  await fs.link(target, identityPath);
  await assert.rejects(readInboxIdentity(home), /regular private file/);
  assert.equal(await fs.readFile(target, "utf8"), identity);
});

test("managed enrollment and viewer identity creation converge during initial publication", {
  skip: process.platform === "win32", timeout: 10_000,
}, async (t) => {
  const home = await temporaryHome(t);
  const paused = pauseIdentityWrite(t, home);
  const writer = getInboxInstanceId(home);
  const writerResult = Promise.allSettled([writer]);
  const store = new ManagedSyncStore(home);
  let enrollment: Promise<unknown> | undefined;

  try {
    await paused.opened;
    const attemptedOwnership = deferred();
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      try {
        return await open(...args);
      } catch (error) {
        if (args[0] === path.join(home, "instance-id.creation.lock") && args[1] === "wx" &&
            error instanceof Error && "code" in error && error.code === "EEXIST") {
          attemptedOwnership.resolve();
        }

        throw error;
      }
    });

    enrollment = store.enroll();
    void enrollment.catch(() => {});
    await Promise.race([
      attemptedOwnership.promise,
      enrollment.then(() => { throw new Error("Enrollment completed before the identity creator released ownership"); }),
    ]);
    paused.release();
    const identity = await writer;
    await enrollment;
    assert.equal((await store.snapshot()).inboxId, identity);
    assert.equal(await readInboxIdentity(home), identity);
  } finally {
    paused.release();
    await writerResult;
    await enrollment?.catch(() => {});
  }
});
