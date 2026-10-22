import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { LocalDocumentSource } from "./local-document-source";
import { temporaryHome } from "./test-fixtures";
import { getInboxInstanceId } from "./viewer-records";

test("source reads original metadata and bytes without changing files, directories, or permissions", async (t) => {
  const fixture = await sourceFixture(t);
  const directories = [fixture.home, path.join(fixture.home, "documents"), fixture.documentDirectory];
  const files = [path.join(fixture.home, "instance-id"), path.join(fixture.documentDirectory, "metadata.json"), path.join(fixture.documentDirectory, "index.html")];
  const source = new LocalDocumentSource(fixture);

  try {
    if (process.platform !== "win32") {
      for (const directory of directories) {
        await chmod(directory, 0o500);
      }

      for (const file of files) {
        await chmod(file, 0o400);
      }
    }

    const before = await storageSnapshot(fixture.home);
    assert.deepEqual(await source.listDocuments(), [fixture.metadata]);
    assert.deepEqual(await source.getDocumentMetadata(fixture.metadata.id), fixture.metadata);
    assert.deepEqual(await source.getDocument(fixture.metadata.id), {
      metadata: fixture.metadata,
      originalBytes: fixture.originalBytes,
    });
    assert.deepEqual(await storageSnapshot(fixture.home), before);
    assert.equal("publish" in source, false);
    assert.equal("deleteDocument" in source, false);
  } finally {
    if (process.platform !== "win32") {
      for (const directory of directories) {
        await chmod(directory, 0o700);
      }
    }
  }
});

test("missing sources and identities remain absent", async (t) => {
  const parent = await realpath(await temporaryHome(t));
  const home = path.join(parent, "absent");
  const source = new LocalDocumentSource({ home, instanceId: randomUUID() });
  await assert.rejects(source.listDocuments(), { code: "ENOENT" });
  await assert.rejects(source.getDocument("safe-id"), { code: "ENOENT" });
  assert.deepEqual(await readdir(parent), []);

  await mkdir(home);
  await assert.rejects(source.listDocuments(), { code: "ENOENT" });
  assert.deepEqual(await readdir(home), []);
});

test("a valid identity-only inbox is empty without creating storage", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const instanceId = await getInboxInstanceId(home);
  const source = new LocalDocumentSource({ home, instanceId });
  const before = await storageSnapshot(home);
  assert.deepEqual(await source.listDocuments(), []);
  assert.equal(await source.getDocumentMetadata("missing"), null);
  assert.equal(await source.getDocument("missing"), null);
  assert.deepEqual(await storageSnapshot(home), before);

  const documents = path.join(home, "documents");
  await mkdir(documents);
  assert.deepEqual(await source.listDocuments(), []);
  await rm(documents, { recursive: true });
  await assert.rejects(source.listDocuments(), { code: "ENOENT" });
});

test("source treats uppercase UUID files and configured UUIDs as the same identity", async (t) => {
  const fixture = await sourceFixture(t);
  await writeFile(path.join(fixture.home, "instance-id"), fixture.instanceId.toUpperCase());
  for (const instanceId of [fixture.instanceId, fixture.instanceId.toUpperCase()]) {
    const source = new LocalDocumentSource({ home: fixture.home, instanceId });
    assert.deepEqual(await source.getDocument(fixture.metadata.id), { metadata: fixture.metadata, originalBytes: fixture.originalBytes });
  }
});

test("source pins both canonical root and UUID and refuses root replacement", async (t) => {
  const fixture = await sourceFixture(t);
  assert.throws(() => new LocalDocumentSource({ home: "relative", instanceId: fixture.instanceId }), /canonical/);
  assert.throws(() => new LocalDocumentSource({ home: `${fixture.home}/../other`, instanceId: fixture.instanceId }), /canonical/);
  assert.throws(() => new LocalDocumentSource({ home: fixture.home, instanceId: "unsupported" }), /UUID/);
  const wrongIdentity = new LocalDocumentSource({ home: fixture.home, instanceId: randomUUID() });
  await assert.rejects(wrongIdentity.listDocuments(), /identity/);

  const source = new LocalDocumentSource(fixture);
  await source.listDocuments();
  const originalHome = `${fixture.home}-original`;
  await rename(fixture.home, originalHome);
  t.after(() => rm(originalHome, { recursive: true, force: true }));
  await mkdir(fixture.home);
  await writeFile(path.join(fixture.home, "instance-id"), fixture.instanceId);
  await assert.rejects(source.listDocuments(), /root was replaced/);
  await assert.rejects(source.getDocument(fixture.metadata.id), /root was replaced/);
});

test("source validates metadata versions, directory IDs, complete files, and bounded reads", async (t) => {
  const fixture = await sourceFixture(t);
  const source = new LocalDocumentSource(fixture);
  const metadataPath = path.join(fixture.documentDirectory, "metadata.json");
  const invalidRecords = [
    "{",
    JSON.stringify({ ...fixture.metadata, schemaVersion: 2 }),
    JSON.stringify({ ...fixture.metadata, id: "different-id" }),
    JSON.stringify({ ...fixture.metadata, title: "" }),
    " ".repeat(64 * 1024 + 1),
  ];

  for (const invalid of invalidRecords) {
    await writeFile(metadataPath, invalid);
    await assert.rejects(source.listDocuments());
    await assert.rejects(source.getDocument(fixture.metadata.id));
  }

  const { schemaVersion, ...legacyMetadata } = fixture.metadata;
  await writeFile(metadataPath, JSON.stringify(legacyMetadata));
  assert.deepEqual(await source.getDocumentMetadata(fixture.metadata.id), fixture.metadata);
  await assert.rejects(new LocalDocumentSource(fixture, 1).getDocument(fixture.metadata.id), /byte limit/);

  await rm(path.join(fixture.documentDirectory, "index.html"));
  await assert.rejects(source.listDocuments(), { code: "ENOENT" });
  await assert.rejects(source.getDocument(fixture.metadata.id), { code: "ENOENT" });
});

test("source rejects traversal IDs before filesystem access", async (t) => {
  const home = path.join(await temporaryHome(t), "absent");
  const source = new LocalDocumentSource({ home, instanceId: randomUUID() });
  for (const id of ["../secret", "..", ".staging", "/absolute", "safe/id", "safe\\id", "%2e%2e", "safe\0id"]) {
    assert.equal(await source.getDocumentMetadata(id), null);
    assert.equal(await source.getDocument(id), null);
  }
});

for (const managedPath of ["root", "documents", "record", "metadata.json", "index.html", "instance-id"]) {
  test(`source rejects ${managedPath} symlinks without reading their target`, { skip: process.platform === "win32" }, async (t) => {
    const fixture = await sourceFixture(t);
    const parent = await temporaryHome(t);
    const linkPath = managedPath === "root" ? fixture.home
      : managedPath === "documents" || managedPath === "instance-id" ? path.join(fixture.home, managedPath)
        : managedPath === "record" ? fixture.documentDirectory : path.join(fixture.documentDirectory, managedPath);
    const destination = path.join(parent, "target");
    const source = new LocalDocumentSource(fixture);
    await rename(linkPath, destination);
    const targetBefore = await lstat(destination);
    await symlink(destination, linkPath);

    await assert.rejects(source.listDocuments());
    await assert.rejects(source.getDocument(fixture.metadata.id));
    const targetAfter = await lstat(destination);
    assert.equal(targetAfter.mode, targetBefore.mode);
    assert.equal(targetAfter.ctimeMs, targetBefore.ctimeMs);
  });
}

test("source rejects hardlinked files and unexpected managed path types", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await sourceFixture(t);
  const source = new LocalDocumentSource(fixture);
  const metadataPath = path.join(fixture.documentDirectory, "metadata.json");
  await link(metadataPath, path.join(fixture.home, "metadata-link"));
  await assert.rejects(source.listDocuments(), /regular file/);

  await rm(metadataPath);
  await mkdir(metadataPath);
  await assert.rejects(source.getDocument(fixture.metadata.id), /regular file/);
});

async function sourceFixture(t: TestContext) {
  const home = await realpath(await temporaryHome(t));
  const instanceId = await getInboxInstanceId(home);
  const originalBytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("<!doctype html>\r\n<html><body>Original π</body></html>\r\n"), 0]);
  const metadata = await new LocalDocumentBackend(home).publish({
    originalBytes,
    title: "Original title",
    type: "report",
    sourceFileName: "original.html",
  });

  return { home, instanceId, originalBytes, metadata, documentDirectory: path.join(home, "documents", metadata.id) };
}

async function storageSnapshot(home: string) {
  const names = ["", ...await readdir(home, { recursive: true })].sort();
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(home, name);
    const info = await lstat(filePath);
    return {
      name,
      mode: info.mode,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      bytes: info.isFile() ? await readFile(filePath) : undefined,
    };
  }));
}
