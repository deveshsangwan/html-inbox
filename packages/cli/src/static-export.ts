import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertDocumentMetadata,
  DocumentBackend,
  DocumentMetadata,
} from "@html-inbox/shared";
import {
  ensurePrivateDirectory,
  hardenPrivateDirectory,
  writePrivateFile,
} from "./private-storage";
import { assertInboxCapability, assertUuidV4 } from "./validation";
import {
  documentCsp,
  renderDocumentShell,
  renderIndex,
  shellCsp,
  VIEWER_SCRIPT,
  VIEWER_STYLES,
} from "./viewer";

const SNAPSHOT_SCHEMA_VERSION = 1;
const OWNERSHIP_MARKER_PATH = "__html-inbox/ownership.json";

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

  const existingOwnerId = await readExistingOwnerId(outputDir);
  const capability = options.capability ?? generateInboxCapability();
  assertInboxCapability(capability);
  const ownerId = options.ownerId ?? existingOwnerId ?? randomUUID();
  assertUuidV4(ownerId, "Static export ownerId");
  if (existingOwnerId && ownerId !== existingOwnerId) {
    throw new Error("Static export ownerId does not match the existing output");
  }
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Static export generatedAt must be a valid date");
  }

  const documents = [...(await source.listDocuments())];
  documents.forEach(assertDocumentMetadata);
  documents.sort(compareDocuments);
  const inboxPath = `/i/${capability}`;
  const files = new Map<string, Buffer>();
  addTextFile(files, "index.html", renderPrivateRoot());
  addTextFile(
    files,
    OWNERSHIP_MARKER_PATH,
    JSON.stringify({ schemaVersion: 1, ownerId }, null, 2),
  );
  addTextFile(files, `${inboxPath.slice(1)}/index.html`, renderIndex(documents, "", {
    basePath: inboxPath,
    clientSearch: true,
    timeZone: "UTC",
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
    .sort((a, b) => compareText(a.path, b.path));
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
  assertDocumentMetadata(document.metadata);
  if (!sameMetadata(document.metadata, metadata) || !Buffer.isBuffer(document.originalBytes)) {
    throw new Error(`Document changed while exporting: ${metadata.id}`);
  }
  const documentPath = `${inboxPath.slice(1)}/documents/${metadata.id}`;
  addTextFile(
    files,
    `${documentPath}/index.html`,
    renderDocumentShell(metadata, { basePath: inboxPath, timeZone: "UTC" }),
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

function compareDocuments(a: DocumentMetadata, b: DocumentMetadata): number {
  return compareText(b.createdAt, a.createdAt) || compareText(a.id, b.id);
}

function sameMetadata(a: DocumentMetadata, b: DocumentMetadata): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.id === b.id &&
    a.title === b.title &&
    a.type === b.type &&
    a.createdAt === b.createdAt &&
    a.sourceFileName === b.sourceFileName
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
      compareText(a, b),
    )) {
      const destination = path.join(stagingDir, filePath);
      await ensurePrivateDirectory(path.dirname(destination));
      await writePrivateFile(destination, contents);
    }
    await validateStagedFiles(stagingDir, files);

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
async function validateStagedFiles(
  stagingDir: string,
  files: Map<string, Buffer>,
): Promise<void> {
  for (const [filePath, expected] of files) {
    const actual = await readFile(path.join(stagingDir, filePath));
    if (!actual.equals(expected)) {
      throw new Error(`Static export verification failed for ${filePath}`);
    }
  }
}

async function readExistingOwnerId(outputDir: string): Promise<string | null> {
  try {
    const outputStat = await lstat(outputDir);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
      throw new Error(`Static export output is not a regular directory: ${outputDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let marker: unknown;
  try {
    const markerPath = path.join(outputDir, OWNERSHIP_MARKER_PATH);
    const markerDirectoryStat = await lstat(path.dirname(markerPath));
    const markerStat = await lstat(markerPath);
    if (
      !markerDirectoryStat.isDirectory() ||
      markerDirectoryStat.isSymbolicLink() ||
      !markerStat.isFile() ||
      markerStat.isSymbolicLink()
    ) {
      throw new Error("invalid ownership marker");
    }
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error(
      `Refusing to replace a directory without a valid ${OWNERSHIP_MARKER_PATH}`,
    );
  }
  if (
    typeof marker !== "object" ||
    marker === null ||
    !("schemaVersion" in marker) ||
    marker.schemaVersion !== 1 ||
    !("ownerId" in marker) ||
    typeof marker.ownerId !== "string"
  ) {
    throw new Error(`Refusing to replace a directory without a valid ${OWNERSHIP_MARKER_PATH}`);
  }
  assertUuidV4(marker.ownerId, "Static export ownerId");
  return marker.ownerId;
}
