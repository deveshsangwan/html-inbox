import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocumentMetadata } from "./documents";
import { validateHtml } from "./html-validation";
import { LocalDocumentBackend } from "./backend";
import { readBoundedFile } from "./bounded-file";
import { exportStaticSnapshot, hashManifestFiles } from "./static-export";

const input = { title: "Report", type: "report", sourceFileName: "report.html",
  originalBytes: Buffer.from("\ufeff<html><body>Original bytes</body></html>") };

async function temporaryDirectory(context: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "html-inbox-storage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("metadata parsing normalizes legacy records without mutating frozen input", () => {
  const legacy = Object.freeze({ id: "legacy", title: "Report", type: "report",
    sourceFileName: "report.html", createdAt: "2026-09-05T00:00:00.000Z" });
  assert.deepEqual(parseDocumentMetadata(legacy), { schemaVersion: 1, ...legacy });
  assert.equal("schemaVersion" in legacy, false);
  for (const invalid of [null, [], { ...legacy, title: 1 }, { ...legacy, createdAt: "bad" },
    { ...legacy, schemaVersion: 2 }, { ...legacy, id: "../escape" }]) {
    assert.throws(() => parseDocumentMetadata(invalid));
  }
});

test("HTML parsing follows raw-text closing tags and decodes attributes once", () => {
  assert.equal(validateHtml('<html><script>const s = "</script-x><a href=javascript:bad>"</script>').ok, true);
  assert.equal(validateHtml('<html><a href="java&Tab;script:bad">').ok, false);
  assert.equal(validateHtml('<html><a href="java&amp;Tab;script:bad">').ok, true);
  assert.equal(validateHtml('<html><template><a href="javascript:bad"></template>').ok, false);
  assert.equal(validateHtml('<html><a href="https://example.org" href="javascript:bad">').ok, true);
});

test("publish validates metadata before writing and metadata reads preserve original bytes", async (context) => {
  const directory = await temporaryDirectory(context);
  const backend = new LocalDocumentBackend(directory);
  await assert.rejects(backend.publish({ ...input, title: "" }), /metadata.title/);
  assert.deepEqual(await backend.listDocuments(), []);

  const metadata = await backend.publish(input);
  assert.deepEqual(await backend.getDocumentMetadata(metadata.id), metadata);
  assert.deepEqual((await backend.getDocument(metadata.id))?.originalBytes, input.originalBytes);
  const deleted = await backend.deleteDocument(metadata.id);
  assert.deepEqual(deleted?.metadata, metadata);
  assert.ok(deleted && deleted.reclaimedBytes > input.originalBytes.length);
  assert.equal(await backend.getDocumentMetadata(metadata.id), null);
});

test("corrupt managed files are skipped with the same warning for listing and reading", async (context) => {
  const directory = await temporaryDirectory(context);
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(directory, (warning) => warnings.push(warning));
  const metadata = await backend.publish(input);
  const htmlPath = path.join(directory, "documents", metadata.id, "index.html");
  const externalPath = path.join(directory, "external.html");
  await writeFile(externalPath, "external");
  await rm(htmlPath);
  await symlink(externalPath, htmlPath);

  assert.deepEqual(await backend.listDocuments(), []);
  assert.equal(await backend.getDocument(metadata.id), null);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => warning.includes("Managed file is not a regular file")));
});

test("bounded reads accept exactly the limit and reject one extra byte", async (context) => {
  const directory = await temporaryDirectory(context);
  const filePath = path.join(directory, "input");
  for (const length of [0, 65536, 65537]) {
    await writeFile(filePath, Buffer.alloc(length, 1));
    const file = await open(filePath, "r");
    try {
      if (length > 65536) {
        await assert.rejects(readBoundedFile(file, 65536, "too big"), /too big/);
      } else {
        assert.equal((await readBoundedFile(file, 65536, "too big")).length, length);
      }
    } finally {
      await file.close();
    }
  }
});

test("incremental snapshots preserve manifests and roll back when a document changes", async (context) => {
  const directory = await temporaryDirectory(context);
  const backend = new LocalDocumentBackend(path.join(directory, "home"));
  const metadata = await backend.publish(input);
  const outputDir = path.join(directory, "snapshot");
  await backend.publish({ ...input, title: "Second report" });
  let previousDocumentId: string | undefined;
  const first = await exportStaticSnapshot({
    listDocuments: () => backend.listDocuments(),
    getDocument: async (id) => {
      if (previousDocumentId) {
        const stagingName = (await readdir(directory)).find((entry) => entry.startsWith("snapshot.staging-"));
        assert.ok(stagingName);
        const stagingDir = path.join(directory, stagingName);
        const [capability] = await readdir(path.join(stagingDir, "i"));
        const previousBytes = await readFile(path.join(stagingDir, "i", capability,
          "documents", previousDocumentId, "content", "index.html"));
        assert.deepEqual(previousBytes, input.originalBytes);
      }
      previousDocumentId = id;
      return backend.getDocument(id);
    },
  }, { outputDir });
  const manifestPath = path.join(outputDir, first.inboxPath, "snapshot-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  assert.equal(first.manifest.snapshotHash, hashManifestFiles(first.manifest.files));
  for (const file of first.manifest.files) {
    const bytes = await readFile(path.join(outputDir, file.path));
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  }

  await assert.rejects(exportStaticSnapshot({
    listDocuments: async () => [metadata],
    getDocument: async () => null,
  }, { outputDir }), /Document changed/);
  assert.deepEqual(await readFile(manifestPath), manifestBytes);
  assert.ok((await readdir(directory)).every((entry) => !entry.includes(".staging-")));
});
