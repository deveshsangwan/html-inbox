import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { ensurePrivateDirectory, writePrivateFile } from "./private-storage";
import { isRecord } from "./validation";
import { hashManifestFiles, type SnapshotFile } from "./static-export";
import {
  parseStaticSecurityHeaders,
  renderCloudflareHeaders,
} from "./cloudflare-headers";

export const CLOUDFLARE_UPLOAD_FILE_LIMIT = 20_000;
export const CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

export interface CloudflareSnapshotRef {
  outputDir: string;
  capability: string;
  snapshotHash?: string;
}

export async function prepareCloudflareDeployment(
  snapshot: CloudflareSnapshotRef,
): Promise<string> {
  const sourceDir = path.resolve(snapshot.outputDir);
  const sourceStat = await lstat(sourceDir);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Static snapshot is not a regular directory: ${sourceDir}`);
  }

  await Promise.all([
    assertRegularFile(path.join(sourceDir, "__html-inbox", "ownership.json")),
    assertRegularFile(
      path.join(
        sourceDir,
        `i/${snapshot.capability}`,
        "snapshot-manifest.json",
      ),
    ),
    assertRegularFile(
      path.join(sourceDir, `i/${snapshot.capability}`, "security-headers.json"),
    ),
  ]);

  const manifestPath = `i/${snapshot.capability}/snapshot-manifest.json`;
  const manifestBytes = await readSnapshotFile(
    path.join(sourceDir, manifestPath),
  );
  const inventory = parseSnapshotInventory(
    manifestBytes,
    snapshot.snapshotHash,
  );
  if (inventory.has(manifestPath))
    throw new Error("Snapshot manifest must not list itself");

  inventory.set(manifestPath, {
    size: manifestBytes.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  });

  const deployDir = `${sourceDir}.cloudflare-${randomUUID()}`;
  await ensurePrivateDirectory(deployDir);

  try {
    const limits = { files: 0 };
    await copyStaticTree(sourceDir, deployDir, limits, inventory);
    if (inventory.size !== 0)
      throw new Error("Static snapshot is missing manifest files");

    const security = parseStaticSecurityHeaders(
      await readFile(
        path.join(
          deployDir,
          `i/${snapshot.capability}`,
          "security-headers.json",
        ),
        "utf8",
      ),
    );

    await writePrivateFile(
      path.join(deployDir, "_headers"),
      renderCloudflareHeaders(snapshot.capability, security),
    );
    limits.files += 1;
    if (limits.files > CLOUDFLARE_UPLOAD_FILE_LIMIT) {
      throw new Error(
        `Cloudflare Direct Upload allows at most ${CLOUDFLARE_UPLOAD_FILE_LIMIT} files`,
      );
    }

    return deployDir;
  } catch (error) {
    await rm(deployDir, { recursive: true, force: true });
    throw error;
  }
}

async function copyStaticTree(
  sourceDir: string,
  destinationDir: string,
  limits: { files: number },
  inventory: Map<string, { size: number; sha256: string }>,
  relativeDir = "",
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const entryStat = await lstat(sourcePath);

    if (entryStat.isSymbolicLink()) {
      throw new Error(
        `Static snapshot contains a symbolic link: ${sourcePath}`,
      );
    }

    if (entryStat.isDirectory()) {
      await ensurePrivateDirectory(destinationPath);
      await copyStaticTree(
        sourcePath,
        destinationPath,
        limits,
        inventory,
        relativePath,
      );

      continue;
    }

    if (!entryStat.isFile()) {
      throw new Error(
        `Static snapshot contains an unsupported entry: ${sourcePath}`,
      );
    }

    if (entryStat.size > CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT) {
      throw new Error(
        `Cloudflare Direct Upload file exceeds 25 MiB: ${sourcePath}`,
      );
    }

    limits.files += 1;
    if (limits.files > CLOUDFLARE_UPLOAD_FILE_LIMIT) {
      throw new Error(
        `Cloudflare Direct Upload allows at most ${CLOUDFLARE_UPLOAD_FILE_LIMIT} files`,
      );
    }

    const expected = inventory.get(relativePath);
    if (!expected)
      throw new Error(
        `Static snapshot contains an unlisted file: ${relativePath}`,
      );

    const contents = await readSnapshotFile(sourcePath);
    if (
      contents.length !== expected.size ||
      createHash("sha256").update(contents).digest("hex") !== expected.sha256
    )
      throw new Error(
        `Static snapshot file does not match manifest: ${relativePath}`,
      );

    await writePrivateFile(destinationPath, contents);
    inventory.delete(relativePath);
  }
}

function parseSnapshotInventory(contents: Buffer, expectedHash?: string) {
  const value: unknown = JSON.parse(contents.toString("utf8"));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    typeof value.snapshotHash !== "string"
  )
    throw new Error("Static snapshot manifest is invalid");

  const inventory = new Map<string, { size: number; sha256: string }>();
  const files: SnapshotFile[] = [];
  let previousPath = "";

  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      file.path <= previousPath ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error("Static snapshot manifest file is invalid");

    previousPath = file.path;
    inventory.set(file.path, { size: file.size, sha256: file.sha256 });
    files.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }

  const digest = hashManifestFiles(files);
  if (
    digest !== value.snapshotHash ||
    (expectedHash !== undefined && digest !== expectedHash)
  )
    throw new Error("Static snapshot hash does not match remote intent");

  return inventory;
}

async function readSnapshotFile(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");

  try {
    if (!(await file.stat()).isFile()) {
      throw new Error(
        `Static snapshot contains an unsupported entry: ${filePath}`,
      );
    }

    return await readBoundedFile(
      file,
      CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT,
      `Cloudflare Direct Upload file exceeds 25 MiB: ${filePath}`,
    );
  } finally {
    await file.close();
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Static snapshot file is not regular: ${filePath}`);
  }
}
