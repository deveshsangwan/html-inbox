import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { createDocumentDeleter, DocumentCleanupError, DocumentIdentityError } from "./document-deletion";
import { parseDocumentDeletionRequest, parseDocumentDeletionResponse, serializeDeletionError } from "./document-deletion-protocol";
import { captureStorageIdentity } from "./document-deletion-worker";
import { temporaryHome } from "./test-fixtures";
import { isRecord } from "./validation";
import { getInboxInstanceId } from "./viewer-records";

test("public deletion uses the fixed internal entry and waits for child close without changing parent cwd", async (t) => {
  const fixture = await workerFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const originalCwd = process.cwd();
  const originalFork = childProcess.fork;
  let isClosed = false;
  let isSettled = false;
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof originalFork>) => {
    assert.equal(args[0], path.join(__dirname, "index.js"));
    assert.deepEqual(args[1], ["__delete-document"]);
    assert.equal(args[2]?.cwd, fixture.home);
    const child = originalFork(...args);
    child.once("message", () => { assert.equal(isSettled, false); });
    child.once("close", () => { isClosed = true; });

    return child;
  });

  const result = await deleter(fixture.metadata.id);
  isSettled = true;
  assert.deepEqual(result?.metadata, fixture.metadata);
  assert.equal(isClosed, true);
  assert.equal(process.cwd(), originalCwd);
  await fs.rename(fixture.home, fixture.movedHome);
});

test("independent public deleters coordinate real child processes", async (t) => {
  const fixture = await workerFixture(t);
  const deleters = await Promise.all(Array.from({ length: 4 }, () => createDocumentDeleter(fixture)));
  const results = await Promise.all(deleters.map((deleter) => deleter(fixture.metadata.id)));

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.filter((result) => result === null).length, 3);
  assert.deepEqual(await fs.readdir(path.join(fixture.home, "documents", ".trash")), []);
});

for (const phase of ["rename", "purge", "unlink"]) {
  test(`cwd binding preserves replacement data when root movement is attempted inside ${phase}`, async (t) => {
    const fixture = await workerFixture(t);
    const deleter = await createDocumentDeleter(fixture);
    const originalCwd = process.cwd();
    let observation: unknown;
    interceptWorker(t, fixture, phase, (value) => { observation = value; });
    const [outcome] = await Promise.allSettled([deleter(fixture.metadata.id)]);

    assert.ok(isRecord(observation));
    assert.equal(observation.usedRelativePaths, true);
    assert.equal(process.cwd(), originalCwd);

    if (observation.moved) {
      assert.equal(outcome.status, "rejected");

      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof DocumentCleanupError);
        assert.deepEqual(outcome.reason.metadata, fixture.metadata);
        assert.ok(outcome.reason.cause instanceof DocumentIdentityError);
      }

      assert.deepEqual(await storageSnapshot(fixture.home), observation.before);
      assert.equal(await exists(path.join(fixture.movedHome, "documents", fixture.metadata.id)), false);
      const originalTrash = await fs.readdir(path.join(fixture.movedHome, "documents", ".trash"));
      const quarantines = originalTrash.filter((name) => !name.startsWith(".delete-"));
      assert.equal(quarantines.length, phase === "rename" ? 1 : 0);
    } else {
      assert.equal(process.platform, "win32", "Only Windows cwd locking should reject this owned root move");
      assert.ok(["EPERM", "EACCES", "EBUSY"].includes(String(observation.moveError)));
      assert.equal(outcome.status, "fulfilled");

      if (outcome.status === "fulfilled") {
        assert.deepEqual(outcome.value?.metadata, fixture.metadata);
      }

      assert.equal(await exists(fixture.movedHome), false);
      assert.equal(await exists(path.join(fixture.home, "documents", fixture.metadata.id)), false);
    }

    // The public promise settles only after cwd locking has ended on Windows.
    await fs.rename(fixture.home, path.join(await temporaryHome(t), "after-close"));
  });
}

test("partial purge errors survive IPC with metadata, cause, and the committed library state", async (t) => {
  const fixture = await workerFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  interceptWorker(t, fixture, "purge-failure");

  await assert.rejects(deleter(fixture.metadata.id), (error: unknown) => {
    assert.ok(error instanceof DocumentCleanupError);
    assert.deepEqual(error.metadata, fixture.metadata);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "injected purge failure");
    assert.equal("code" in error.cause && error.cause.code, "EIO");
    return true;
  });
  const trash = path.join(fixture.home, "documents", ".trash");
  const quarantines = await fs.readdir(trash);
  assert.equal(quarantines.length, 1);
  assert.deepEqual(await fs.readdir(path.join(trash, quarantines[0])), ["metadata.json"]);
  assert.equal(await exists(path.join(fixture.home, "documents", fixture.metadata.id)), false);
});

test("a different cwd cannot pass the captured root identity check", async (t) => {
  const fixture = await workerFixture(t);
  const other = await workerFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const before = await storageSnapshot(fixture.home);
  const otherBefore = await storageSnapshot(other.home);
  const originalFork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof originalFork>) => originalFork(
    args[0], args[1], { ...args[2], cwd: other.home },
  ));

  await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
  assert.deepEqual(await storageSnapshot(fixture.home), before);
  assert.deepEqual(await storageSnapshot(other.home), otherBefore);
});

test("canonical aliases are rejected before worker startup on every platform", async (t) => {
  const fixture = await workerFixture(t);
  const alias = path.join(await temporaryHome(t), "alias");
  await fs.symlink(fixture.home, alias, process.platform === "win32" ? "junction" : "dir");
  const before = await storageSnapshot(fixture.home);

  await assert.rejects(createDocumentDeleter({ ...fixture, home: alias }), DocumentIdentityError);
  assert.deepEqual(await storageSnapshot(fixture.home), before);
});

test("the hidden command without IPC cannot delete documents", async (t) => {
  const fixture = await workerFixture(t);
  const before = await storageSnapshot(fixture.home);
  const child = childProcess.spawn(process.execPath, [path.join(__dirname, "index.js"), "__delete-document"], {
    cwd: fixture.home, stdio: "ignore",
  });
  const [code] = await once(child, "close");

  assert.notEqual(code, 0);
  assert.deepEqual(await storageSnapshot(fixture.home), before);
});

test("worker boundaries reject malformed requests, oversized responses, and mismatched metadata", async (t) => {
  const fixture = await workerFixture(t);
  const { directory, ...storage } = await captureStorageIdentity(fixture.home, fixture.instanceId);
  const request = { protocolVersion: 1, id: fixture.metadata.id, storage };

  for (const invalid of [null, { ...request, id: "../escape" }, { ...request, storage: { ...storage, root: { dev: -1, ino: 1 } } },
    { ...request, storage: { ...storage, home: "relative" } }, { ...request, extra: "x".repeat(64 * 1024) }]) {
    assert.throws(() => parseDocumentDeletionRequest(invalid));
  }

  assert.deepEqual(parseDocumentDeletionRequest(request), request);
  assert.throws(() => parseDocumentDeletionResponse({ protocolVersion: 1, ok: true, result: {
    metadata: { ...fixture.metadata, id: "other" }, reclaimedBytes: 1,
  } }, fixture.metadata.id), /identity/);
  assert.throws(() => parseDocumentDeletionResponse({ protocolVersion: 1, ok: true, result: null, extra: "x".repeat(64 * 1024) }, fixture.metadata.id), /byte limit/);
  const response = parseDocumentDeletionResponse({ protocolVersion: 1, ok: false,
    error: serializeDeletionError(new DocumentCleanupError(fixture.metadata, new DocumentIdentityError("root drift"))),
  }, fixture.metadata.id);
  assert.equal(response.ok, false);

  if (!response.ok) {
    assert.ok(response.error instanceof DocumentCleanupError);
    assert.ok(response.error.cause instanceof DocumentIdentityError);
  }
});

function interceptWorker(t: TestContext, fixture: Awaited<ReturnType<typeof workerFixture>>, phase: string, observe: (value: unknown) => void = () => undefined) {
  const script = `
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const { runDocumentDeletionWorker } = require(process.argv[1]);
    const config = JSON.parse(process.argv[2]);
    const originalRename = fs.rename;
    const originalRm = fs.rm;
    const originalUnlink = fs.unlink;
    const originalOpen = fs.open;
    const originalSend = process.send.bind(process);
    let observation = { usedRelativePaths: true };
    const snapshot = async root => {
      const names = ["", ...await fs.readdir(root, { recursive: true })].sort();
      return Promise.all(names.map(async name => {
        const info = await fs.lstat(path.join(root, name));
        return { name, mode: info.mode, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
          ...(info.isFile() ? { bytes: (await fs.readFile(path.join(root, name))).toString("base64") } : {}) };
      }));
    };
    const checkRelative = file => {
      if (path.isAbsolute(String(file))) {
        observation.usedRelativePaths = false;
        throw new Error("worker mutation used an absolute path");
      }
    };
    const moveRoot = async () => {
      try { await originalRename(config.home, config.movedHome); }
      catch (error) { observation.moved = false; observation.moveError = error.code; return; }
      await fs.cp(config.movedHome, config.home, { recursive: true });
      observation.moved = true;
      observation.before = await snapshot(config.home);
    };
    fs.open = async (...args) => {
      if (args[1] === "wx") checkRelative(args[0]);
      return originalOpen(...args);
    };
    fs.rename = async (...args) => {
      checkRelative(args[0]); checkRelative(args[1]);
      if (config.phase === "rename") await moveRoot();
      return originalRename(...args);
    };
    fs.rm = async (...args) => {
      checkRelative(args[0]);
      if (config.phase === "purge") await moveRoot();
      if (config.phase === "purge-failure") {
        await originalRm(path.join(String(args[0]), "index.html"));
        throw Object.assign(new Error("injected purge failure"), { code: "EIO" });
      }
      return originalRm(...args);
    };
    fs.unlink = async (...args) => {
      checkRelative(args[0]);
      if (config.phase === "unlink") await moveRoot();
      return originalUnlink(...args);
    };
    process.send = (message, callback) => originalSend({ ...message, fixture: observation }, callback);
    runDocumentDeletionWorker().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const originalFork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof originalFork>) => {
    const child = originalFork("-e", [script, path.join(__dirname, "document-deletion-worker.js"), JSON.stringify({
      home: fixture.home, movedHome: fixture.movedHome, phase,
    })], args[2]);
    child.on("message", (value: unknown) => {
      if (isRecord(value)) {
        observe(value.fixture);
      }
    });

    return child;
  });
}

async function workerFixture(t: TestContext) {
  const home = await fs.realpath(await temporaryHome(t));
  const instanceId = await getInboxInstanceId(home);
  const metadata = await new LocalDocumentBackend(home).publish({
    originalBytes: Buffer.from("<!doctype html><title>Worker</title>"),
    title: "Worker report", type: "report", sourceFileName: "worker.html",
  });
  const movedHome = path.join(await temporaryHome(t), "moved");

  return { home, instanceId, metadata, movedHome };
}

async function storageSnapshot(root: string) {
  const names = ["", ...await fs.readdir(root, { recursive: true })].sort();

  return Promise.all(names.map(async (name) => {
    const info = await fs.lstat(path.join(root, name));

    return { name, mode: info.mode, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
      ...(info.isFile() ? { bytes: (await fs.readFile(path.join(root, name))).toString("base64") } : {}) };
  }));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
