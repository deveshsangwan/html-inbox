import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DocumentBackend, DocumentMetadata } from "@html-inbox/shared";
import {
  ensurePrivateDirectory,
  hardenPrivateDirectory,
  writePrivateFile,
} from "./private-storage";
import {
  documentCsp,
  renderDocumentShell,
  renderIndex,
  shellCsp,
  VIEWER_SCRIPT,
  VIEWER_STYLES,
} from "./viewer";

const SNAPSHOT_SCHEMA_VERSION = 1;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export type SnapshotDocumentSource = Pick<
  DocumentBackend,
  "listDocuments" | "getDocument"
>;

export interface StaticSnapshotOptions {
  outputDir: string;
  capability?: string;
  ownerId?: string;
  generatedAt?: string;
}

export interface SnapshotFile {
  path: string;
  sha256: string;
  size: number;
}

export interface SnapshotManifest {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  documentCount: number;
  snapshotHash: string;
  files: SnapshotFile[];
}

export interface StaticSnapshotResult {
  outputDir: string;
  capability: string;
  inboxPath: string;
  ownerId: string;
  manifest: SnapshotManifest;
}

export interface StaticSecurityHeaders {
  schemaVersion: 1;
  common: Record<string, string>;
  root: Record<string, string>;
  shell: Record<string, string>;
  document: Record<string, string>;
}

export async function exportStaticSnapshot(
  source: SnapshotDocumentSource,
  options: StaticSnapshotOptions,
): Promise<StaticSnapshotResult> {
  const outputDir = path.resolve(options.outputDir);
  if (outputDir === path.parse(outputDir).root) {
    throw new Error("Static export output must not be a filesystem root");
  }

  const capability = options.capability ?? generateInboxCapability();
  assertCapability(capability);
  const ownerId = options.ownerId ?? randomUUID();
  assertOwnerId(ownerId);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Static export generatedAt must be a valid date");
  }

  const documents = await source.listDocuments();
  const inboxPath = `/i/${capability}`;
  const files = new Map<string, Buffer>();
  addTextFile(files, "index.html", renderPrivateRoot());
  addTextFile(
    files,
    "__html-inbox/ownership.json",
    JSON.stringify({ schemaVersion: 1, ownerId }, null, 2),
  );
  addTextFile(files, `${inboxPath.slice(1)}/index.html`, renderIndex(documents, "", {
    basePath: inboxPath,
    clientSearch: true,
  }));
  addTextFile(files, `${inboxPath.slice(1)}/assets/viewer.css`, VIEWER_STYLES);
  addTextFile(files, `${inboxPath.slice(1)}/assets/viewer.js`, VIEWER_SCRIPT);

  for (const metadata of documents) {
    await addDocumentFiles(files, source, metadata, inboxPath);
  }

  addTextFile(
    files,
    `${inboxPath.slice(1)}/security-headers.json`,
    JSON.stringify(buildSecurityHeaders(), null, 2),
  );

  const manifestFiles = Array.from(files.entries())
    .map(([filePath, contents]) => describeFile(filePath, contents))
    .sort((a, b) => a.path.localeCompare(b.path));
  const snapshotHash = hashManifestFiles(manifestFiles);
  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    documentCount: documents.length,
    snapshotHash,
    files: manifestFiles,
  };
  addTextFile(
    files,
    `${inboxPath.slice(1)}/snapshot-manifest.json`,
    JSON.stringify(manifest, null, 2),
  );

  await replaceOutputDirectory(outputDir, files);
  return { outputDir, capability, inboxPath, ownerId, manifest };
}

export function generateInboxCapability(): string {
  return randomBytes(16).toString("base64url");
}

async function addDocumentFiles(
  files: Map<string, Buffer>,
  source: SnapshotDocumentSource,
  metadata: DocumentMetadata,
  inboxPath: string,
): Promise<void> {
  const document = await source.getDocument(metadata.id);
  if (!document) {
    throw new Error(`Document changed while exporting: ${metadata.id}`);
  }
  const documentPath = `${inboxPath.slice(1)}/documents/${metadata.id}`;
  addTextFile(
    files,
    `${documentPath}/index.html`,
    renderDocumentShell(metadata, { basePath: inboxPath }),
  );
  files.set(`${documentPath}/content/index.html`, document.originalBytes);
}

function addTextFile(files: Map<string, Buffer>, filePath: string, contents: string): void {
  files.set(filePath, Buffer.from(contents, "utf8"));
}

function describeFile(filePath: string, contents: Buffer): SnapshotFile {
  return {
    path: filePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    size: contents.byteLength,
  };
}

function hashManifestFiles(files: SnapshotFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildSecurityHeaders(): StaticSecurityHeaders {
  const common = {
    "Cache-Control": "private, no-store",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
  return {
    schemaVersion: 1,
    common,
    root: { "Content-Security-Policy": "default-src 'none'" },
    shell: { "Content-Security-Policy": shellCsp() },
    document: { "Content-Security-Policy": documentCsp() },
  };
}

function renderPrivateRoot(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>HTML Inbox</title>
</head>
<body><main><h1>HTML Inbox</h1><p>This site has no public inbox listing.</p></main></body>
</html>`;
}

async function replaceOutputDirectory(
  outputDir: string,
  files: Map<string, Buffer>,
): Promise<void> {
  const parentDir = path.dirname(outputDir);
  await mkdir(parentDir, { recursive: true });
  const parentStat = await lstat(parentDir);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Static export parent is not a regular directory: ${parentDir}`);
  }

  const suffix = randomUUID();
  const stagingDir = `${outputDir}.staging-${suffix}`;
  const backupDir = `${outputDir}.backup-${suffix}`;
  await ensurePrivateDirectory(stagingDir);
  let movedExisting = false;
  let installedSnapshot = false;

  try {
    for (const [filePath, contents] of Array.from(files.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const destination = path.join(stagingDir, filePath);
      await ensurePrivateDirectory(path.dirname(destination));
      await writePrivateFile(destination, contents);
    }

    try {
      await hardenPrivateDirectory(outputDir);
      await rename(outputDir, backupDir);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await rename(stagingDir, outputDir);
    installedSnapshot = true;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    if (movedExisting && !installedSnapshot) {
      try {
        await rename(backupDir, outputDir);
      } catch {
        // Preserve the original error; the backup path remains available for recovery.
      }
    }
    throw error;
  }

  if (movedExisting) {
    await rm(backupDir, { recursive: true, force: true });
  }
}

function assertCapability(capability: string): void {
  const decoded = Buffer.from(capability, "base64url");
  if (
    !CAPABILITY_PATTERN.test(capability) ||
    decoded.byteLength !== 16 ||
    decoded.toString("base64url") !== capability
  ) {
    throw new Error("Inbox capability must encode exactly 128 bits as 22 base64url characters");
  }
}

function assertOwnerId(ownerId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new Error("Static export ownerId must be a version 4 UUID");
  }
}
