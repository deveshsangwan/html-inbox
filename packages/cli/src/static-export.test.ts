import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import { formatStaticExportResult } from "./index";
import { exportStaticSnapshot } from "./static-export";
import { DOCUMENT_CSP } from "./viewer-assets";
import { temporaryHome } from "./test-fixtures";

test("static export preserves bytes, metadata and atomic replacement", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const published = await backend.publish({
    originalBytes: Buffer.from(html),
    title: "Report",
    type: "report",
    sourceFileName: "report.html",
  });
  const hostileTitle = 'Title </h1><script>alert("title")</script>';
  const hostileType = "report\"><svg/onload=alert('type')>";
  const hostileSource = "source.html\" autofocus onfocus=\"alert('source')";
  await backend.publish({
    originalBytes: Buffer.from(html),
    title: hostileTitle,
    type: hostileType,
    sourceFileName: hostileSource,
  });

  const snapshotDirectory = path.join(home, "snapshot");
  const capability = "AAAAAAAAAAAAAAAAAAAAAA";
  const ownerId = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(
    exportStaticSnapshot(
      {
        async listDocuments() {
          return [{ ...published.metadata, id: "../../../../escaped" }];
        },
        async getDocument() {
          return null;
        },
      },
      {
        outputDir: path.join(home, "escaping-snapshot"),
        capability,
        ownerId,
      },
    ),
    /metadata\.id/,
  );
  const publishedDocument = await backend.getDocument(published.metadata.id);
  assert(publishedDocument);
  await assert.rejects(
    exportStaticSnapshot(
      {
        async listDocuments() {
          return [published.metadata];
        },
        async getDocument() {
          return {
            ...publishedDocument,
            metadata: {
              ...publishedDocument.metadata,
              title: "Changed during export",
            },
          };
        },
      },
      {
        outputDir: path.join(home, "changed-snapshot"),
        capability,
        ownerId,
      },
    ),
    /Document changed while exporting/,
  );
  const firstSnapshot = await exportStaticSnapshot(backend, {
    outputDir: snapshotDirectory,
    capability,
    ownerId,
    generatedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(firstSnapshot.inboxPath, `/i/${capability}`);
  assert.equal(firstSnapshot.manifest.documentCount, 2);
  assert.match(
    formatStaticExportResult(firstSnapshot, false),
    /Exported 2 documents/,
  );
  assert.equal(
    JSON.parse(formatStaticExportResult(firstSnapshot, true)).capability,
    capability,
  );

  const snapshotRoot = await readFile(
    path.join(snapshotDirectory, "index.html"),
    "utf8",
  );
  assert.equal(snapshotRoot.includes(capability), false);
  assert.equal(snapshotRoot.includes("no public inbox listing"), true);
  const snapshotIndex = await readFile(
    path.join(snapshotDirectory, "i", capability, "index.html"),
    "utf8",
  );
  assert.equal(
    snapshotIndex.includes(`src="/i/${capability}/assets/viewer.js"`),
    true,
  );
  assert.equal(snapshotIndex.includes("data-client-search"), true);
  assert.equal(
    snapshotIndex.includes(
      `/i/${capability}/documents/${published.metadata.id}/`,
    ),
    true,
  );
  const snapshotShell = await readFile(
    path.join(
      snapshotDirectory,
      "i",
      capability,
      "documents",
      published.metadata.id,
      "index.html",
    ),
    "utf8",
  );
  assert.equal(
    snapshotShell.includes(
      `/i/${capability}/documents/${published.metadata.id}/content/`,
    ),
    true,
  );
  assert.deepEqual(
    await readFile(
      path.join(
        snapshotDirectory,
        "i",
        capability,
        "documents",
        published.metadata.id,
        "content",
        "index.html",
      ),
    ),
    Buffer.from(html),
  );

  const ownerMarker = JSON.parse(
    await readFile(
      path.join(snapshotDirectory, "__html-inbox", "ownership.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.deepEqual(ownerMarker, { schemaVersion: 1, ownerId });
  const securityHeaders = JSON.parse(
    await readFile(
      path.join(snapshotDirectory, "i", capability, "security-headers.json"),
      "utf8",
    ),
  ) as {
    common: Record<string, string>;
    document: Record<string, string>;
  };
  assert.equal(
    securityHeaders.document["Content-Security-Policy"],
    DOCUMENT_CSP,
  );
  assert.equal(
    securityHeaders.common["X-Robots-Tag"],
    "noindex, nofollow, noarchive",
  );
  assert.deepEqual(
    firstSnapshot.manifest.files.map((file) => file.path),
    firstSnapshot.manifest.files.map((file) => file.path).sort(),
  );
  const manifestText = await readFile(
    path.join(snapshotDirectory, "i", capability, "snapshot-manifest.json"),
    "utf8",
  );
  assert.equal(manifestText.includes(home), false);

  const secondSnapshot = await exportStaticSnapshot(backend, {
    outputDir: snapshotDirectory,
    capability,
    generatedAt: "2026-07-16T01:00:00.000Z",
  });
  assert.equal(
    secondSnapshot.manifest.snapshotHash,
    firstSnapshot.manifest.snapshotHash,
  );
  const reversedSnapshot = await exportStaticSnapshot(
    {
      async listDocuments() {
        return (await backend.listDocuments()).reverse();
      },
      getDocument: (id) => backend.getDocument(id),
    },
    {
      outputDir: path.join(home, "reversed-snapshot"),
      capability,
      ownerId,
      generatedAt: "2026-07-16T02:00:00.000Z",
    },
  );
  assert.equal(
    reversedSnapshot.manifest.snapshotHash,
    firstSnapshot.manifest.snapshotHash,
  );
  const unrelatedDirectory = path.join(home, "unrelated-output");
  await mkdir(unrelatedDirectory);
  await writeFile(path.join(unrelatedDirectory, "keep.txt"), "keep");
  await assert.rejects(
    exportStaticSnapshot(backend, {
      outputDir: unrelatedDirectory,
      capability,
    }),
    /Refusing to replace/,
  );
  assert.equal(
    await readFile(path.join(unrelatedDirectory, "keep.txt"), "utf8"),
    "keep",
  );

  await assert.rejects(
    exportStaticSnapshot(backend, {
      outputDir: path.join(home, "invalid-snapshot"),
      capability: "too-short",
    }),
    /exactly 128 bits/,
  );
  await assert.rejects(
    exportStaticSnapshot(backend, {
      outputDir: path.join(home, "noncanonical-snapshot"),
      capability: "BBBBBBBBBBBBBBBBBBBBBB",
    }),
    /exactly 128 bits/,
  );

  if (process.platform !== "win32") {
    assert.equal((await stat(snapshotDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(snapshotDirectory, "index.html"))).mode & 0o777,
      0o600,
    );
  }
});
