import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";

async function seed(home: string, count: number) {
  const metadata = [];

  for (let index = 0; index < count; index += 1) {
    const id = `document-${String(index).padStart(3, "0")}`;
    const directory = path.join(home, "documents", id);
    const record = {
      schemaVersion: 1,
      id,
      title: id,
      type: "report",
      sourceFileName: "fixture.html",
      createdAt: index % 2 ? "2026-11-07T00:00:00.000Z" : "2026-11-06T00:00:00.000Z",
    };

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "metadata.json"), JSON.stringify(record));
    await fs.writeFile(path.join(directory, "index.html"), "<html>fixture</html>");

    metadata.push(record);
  }

  return metadata.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

test("ordinary listings share a read limit across instances, preserve ties and release slots after failure", async (t) => {
  const home = await temporaryHome(t);
  const expected = await seed(home, 96);
  const readFile = fs.readFile;
  let activeReads = 0;
  let peakReads = 0;
  let shouldFail = false;
  const failure = Object.assign(new Error("synthetic metadata permission failure"), { code: "EACCES" });

  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (!String(args[0]).endsWith("metadata.json")) {
      return readFile(...args);
    }

    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);

    try {
      await setImmediate();

      if (shouldFail) {
        throw failure;
      }

      return await readFile(...args);
    } finally {
      activeReads -= 1;
    }
  });

  const backends = Array.from({ length: 3 }, () => new LocalDocumentBackend(home));
  const results = await Promise.all(backends.map((backend) => backend.listDocuments()));

  for (const result of results) {
    assert.deepEqual(result, expected);
  }

  assert.ok(peakReads > 1);
  assert.ok(peakReads <= 8, `aggregate active reads: ${peakReads}`);
  assert.equal(activeReads, 0);

  shouldFail = true;
  await assert.rejects(backends[0].listDocuments(), (error) => error === failure);
  assert.equal(activeReads, 0, "failed listing drains active workers before rejecting");

  shouldFail = false;
  assert.deepEqual(await backends[1].listDocuments(), expected);
});

test("ordinary listing retains corruption diagnostics, unsafe-entry handling and permission hardening", async (t) => {
  const home = await temporaryHome(t);
  const expected = await seed(home, 6);
  const directory = (index: number) => path.join(home, "documents", `document-00${index}`);
  await fs.writeFile(path.join(directory(1), "metadata.json"), "{");
  await fs.rm(path.join(directory(2), "index.html"));
  await fs.rm(directory(3), { recursive: true });
  await fs.symlink(directory(0), directory(3));
  await fs.rm(path.join(directory(4), "metadata.json"));
  await fs.symlink(path.join(directory(0), "metadata.json"), path.join(directory(4), "metadata.json"));
  await fs.mkdir(path.join(home, "documents", "unsafe name"));
  await fs.chmod(directory(0), 0o755);
  await fs.chmod(path.join(directory(0), "metadata.json"), 0o644);
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (message) => warnings.push(message));

  assert.deepEqual(await backend.listDocuments(), expected.filter((record) => ["document-000", "document-005"].includes(record.id)));
  assert.equal(warnings.length, 4);

  for (const id of [1, 2, 3, 4]) {
    assert.ok(warnings.some((message) => message.includes(`skipping corrupt document document-00${id}:`)));
  }

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory(0))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(directory(0), "metadata.json"))).mode & 0o777, 0o600);
  }

  await fs.rm(directory(5), { recursive: true });
  assert.equal(await backend.getDocumentMetadata("document-005"), null);
});

test("a failed hardening operation drains its sibling before releasing the listing slot", async (t) => {
  const home = await temporaryHome(t);
  await seed(home, 1);
  const chmod = fs.chmod;
  let releaseHtml = () => {};
  const htmlGate = new Promise<void>((resolve) => { releaseHtml = resolve; });
  let reportFailure = () => {};
  const failureStarted = new Promise<void>((resolve) => { reportFailure = resolve; });
  const failure = Object.assign(new Error("synthetic chmod denial"), { code: "EACCES" });
  let hasSettled = false;

  t.mock.method(fs, "chmod", async (...args: Parameters<typeof fs.chmod>) => {
    if (String(args[0]).endsWith("index.html")) {
      await htmlGate;
    }

    if (String(args[0]).endsWith("metadata.json")) {
      reportFailure();
      throw failure;
    }

    return chmod(...args);
  });

  const listing = new LocalDocumentBackend(home).listDocuments();
  const rejection = assert.rejects(listing, (error) => error === failure).then(() => { hasSettled = true; });

  try {
    await failureStarted;
    await setImmediate();
    assert.equal(hasSettled, false);
  } finally {
    releaseHtml();
    await rejection;
  }
});

test("a record removed after enumeration remains a silent missing record", async (t) => {
  const home = await temporaryHome(t);
  const expected = await seed(home, 2);
  const missingDirectory = path.join(home, "documents", "document-000");
  const lstat = fs.lstat;
  const warnings: string[] = [];

  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === missingDirectory) {
      await fs.rm(missingDirectory, { recursive: true, force: true });
    }

    return lstat(...args);
  });

  assert.deepEqual(await new LocalDocumentBackend(home, (message) => warnings.push(message)).listDocuments(),
    expected.filter((record) => record.id !== "document-000"));
  assert.deepEqual(warnings, []);
});
