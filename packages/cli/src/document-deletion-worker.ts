import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedFile } from "./bounded-file";
import { type DeleteResult, type DocumentMetadata, isSafeDocumentId, parseDocumentMetadata } from "./documents";
import { DocumentCleanupError, DocumentIdentityError, parseDocumentDeletionRequest, serializeDeletionError } from "./document-deletion-protocol";
import { type LocalDocumentLocation, parseLocalDocumentLocation } from "./local-document-source";
import { checkCanonicalDirectory as checkDirectory, checkRegularFile as checkFile, isOwnedDirectory, isOwnedRegularFile } from "./local-storage-checks";
import { assertUuidV4, isRecord } from "./validation";

export type DocumentDeleter = (id: string) => Promise<DeleteResult | null>;

export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface StorageIdentity {
  home: string;
  instanceId?: string;
  root: FileIdentity;
  documents: FileIdentity | null;
  trash: FileIdentity | null;
  directory: string;
}

interface DocumentEntry {
  name: string;
  info: Stats;
}

export async function runDocumentDeletionWorker(): Promise<void> {
  const value: unknown = await new Promise((resolve) => {
    process.once("message", resolve);
    process.once("disconnect", () => resolve(undefined));
  });
  let response: unknown;

  try {
    const request = parseDocumentDeletionRequest(value);
    // Only the child uses this root. Its cwd was selected by the parent before startup.
    const storage = { ...request.storage, directory: "." };
    await checkStorageIdentity(storage);
    const result = await deleteDocument(storage, request.id);
    response = { protocolVersion: 1, ok: true, result };
  } catch (error) {
    response = { protocolVersion: 1, ok: false, error: serializeDeletionError(error) };
  }

  if (process.connected && process.send) {
    await new Promise<void>((resolve, reject) => {
      process.send?.(response, (error: Error | null) => error ? reject(error) : resolve());
    });
    process.disconnect();
  }
}

export async function createInProcessDocumentDeleter(location: LocalDocumentLocation): Promise<DocumentDeleter> {
  const { home, instanceId } = parseLocalDocumentLocation(location);
  const storage = await captureStorageIdentity(home, instanceId);

  return (id) => deleteDocument(storage, id);
}

export async function captureStorageIdentity(home: string, instanceId?: string): Promise<StorageIdentity> {
  return withIdentityError(async () => {
    const root = await checkDirectory(home);
    const documents = await optionalDirectory(path.join(home, "documents"));
    const trash = await optionalDirectory(path.join(home, "documents", ".trash"));
    const storage = {
      home, instanceId, directory: home,
      root: { dev: root.dev, ino: root.ino },
      documents: documents ? { dev: documents.dev, ino: documents.ino } : null,
      trash: trash ? { dev: trash.dev, ino: trash.ino } : null,
    };
    await checkStorageIdentity(storage, false);

    return storage;
  });
}

export async function checkStorageIdentity(storage: StorageIdentity, requireDirectories = true): Promise<void> {
  await withIdentityError(async () => {
    assertSameIdentity(await checkDirectory(storage.directory), storage.root, "Deletion working directory does not match the captured root");
    assertSameIdentity(await checkDirectory(storage.home), storage.root, "Inbox root was replaced");

    if (storage.instanceId !== undefined) {
      const identityPath = path.join(storage.directory, "instance-id");
      const checked = await checkFile(identityPath);
      const bytes = await readCheckedFile(identityPath, checked, 128);
      const instanceId = bytes.toString("utf8").trim().toLowerCase();
      assertUuidV4(instanceId, "Inbox instance identity");

      if (instanceId !== storage.instanceId) {
        throw new DocumentIdentityError("Inbox instance identity does not match the selected inbox");
      }
    }

    for (const key of ["documents", "trash"] as const) {
      const directory = key === "documents" ? path.join(storage.directory, "documents") : path.join(storage.directory, "documents", ".trash");
      const current = requireDirectories ? await checkDirectory(directory) : await optionalDirectory(directory);
      const previous = storage[key];

      if (previous && !current) {
        throw new DocumentIdentityError(`Inbox ${key} directory is unavailable`);
      }

      if (previous && current) {
        assertSameIdentity(current, previous, `Inbox ${key} directory was replaced`);
      }

      storage[key] ??= current ? { dev: current.dev, ino: current.ino } : null;
    }

    assertSameIdentity(await checkDirectory(storage.home), storage.root, "Inbox root changed during deletion");
    assertSameIdentity(await checkDirectory(storage.directory), storage.root, "Deletion working directory changed");
  });
}

export async function deleteDocument(storage: StorageIdentity, id: string): Promise<DeleteResult | null> {
  if (!isSafeDocumentId(id)) {
    return null;
  }

  const documentDirectory = path.join(storage.directory, "documents", id);
  let metadata: DocumentMetadata;
  let reclaimedBytes: number;
  let entries: DocumentEntry[];
  let quarantineDirectory: string;
  let releaseLock: (() => Promise<void>) | null = null;

  try {
    await checkStorageIdentity(storage);
    entries = await inspectDocumentTree(documentDirectory);
    const html = entries.find((entry) => entry.name === "index.html" && entry.info.isFile());
    const record = entries.find((entry) => entry.name === "metadata.json" && entry.info.isFile());

    if (!html || !record) {
      throw new Error("Document files are incomplete");
    }

    const bytes = await readCheckedFile(path.join(documentDirectory, record.name), record.info, 64 * 1024);
    metadata = parseDocumentMetadata(JSON.parse(bytes.toString("utf8")));

    if (metadata.id !== id) {
      throw new Error("Document metadata identity does not match its directory");
    }

    reclaimedBytes = html.info.size + record.info.size;
    // The operation UUID keeps legacy IDs near the filesystem's filename limit deletable.
    quarantineDirectory = path.join(storage.directory, "documents", ".trash", randomUUID());
    await checkDocumentSnapshot(documentDirectory, entries);

    if (process.platform !== "win32") {
      for (const [directory, identity] of [
        [path.join(storage.directory, "documents"), storage.documents],
        [path.join(storage.directory, "documents", ".trash"), storage.trash],
        [documentDirectory, entries[0].info],
      ] as const) {
        if (!identity) {
          throw new DocumentIdentityError("Required deletion directory is unavailable");
        }

        await checkStorageIdentity(storage);
        await makeDirectoryWritable(directory, identity);
      }
    }

    releaseLock = await acquireDocumentLock(storage, id);

    if (!releaseLock) {
      return null;
    }

    await checkDocumentSnapshot(documentDirectory, entries);
    await checkStorageIdentity(storage);
    await rename(documentDirectory, quarantineDirectory);
  } catch (error) {
    await releaseLock?.();
    await checkStorageIdentity(storage);

    if (await isMissingDocument(documentDirectory)) {
      return null;
    }

    throw error;
  }

  try {
    await checkStorageIdentity(storage);
    await checkDocumentSnapshot(quarantineDirectory, entries);

    for (const entry of entries) {
      if (entry.info.isDirectory() && process.platform !== "win32") {
        await checkStorageIdentity(storage);
        await makeDirectoryWritable(path.join(quarantineDirectory, entry.name), entry.info);
      }
    }

    await checkDocumentSnapshot(quarantineDirectory, entries);
    await checkStorageIdentity(storage);
    await rm(quarantineDirectory, { recursive: true, force: true });
    await checkStorageIdentity(storage);
  } catch (cause) {
    await releaseLock().catch(() => undefined);
    throw new DocumentCleanupError(metadata, cause);
  }

  try {
    await releaseLock();
    await checkStorageIdentity(storage);
  } catch (cause) {
    throw new DocumentCleanupError(metadata, cause);
  }

  return { metadata, reclaimedBytes };
}

async function acquireDocumentLock(storage: StorageIdentity, id: string): Promise<(() => Promise<void>) | null> {
  const digest = createHash("sha256").update(id).digest("hex");
  const lockPath = path.join(storage.directory, "documents", ".trash", `.delete-${digest}.lock`);
  const displayLockPath = path.isAbsolute(lockPath) ? lockPath : path.join(storage.home, lockPath);
  const documentDirectory = path.join(storage.directory, "documents", id);
  const deadline = Date.now() + 5000;

  while (true) {
    await checkStorageIdentity(storage);

    if (await isMissingDocument(documentDirectory)) {
      return null;
    }

    try {
      return await createDocumentLock(storage, lockPath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }

    await checkDocumentLockOwner(lockPath, displayLockPath);

    if (Date.now() >= deadline) {
      throw new Error(`Document deletion is busy; retry after the current operation finishes: ${displayLockPath}`);
    }

    await delay(10);
  }
}

async function createDocumentLock(storage: StorageIdentity, lockPath: string): Promise<() => Promise<void>> {
  const file = await open(lockPath, "wx", 0o600);
  let identity: FileIdentity | undefined;

  try {
    try {
      const info = await file.stat();

      if (!isOwnedRegularFile(info)) {
        throw new Error("Deletion lock must be a regular private file");
      }

      identity = info;
      await checkStorageIdentity(storage);
      await file.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`);

      return () => releaseDocumentLock(storage, lockPath, info);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (identity) {
      await releaseDocumentLock(storage, lockPath, identity);
    }

    throw error;
  }
}

async function releaseDocumentLock(storage: StorageIdentity, lockPath: string, identity: FileIdentity): Promise<void> {
  try {
    await checkStorageIdentity(storage);
  } catch (error) {
    if (error instanceof DocumentIdentityError) {
      return;
    }

    throw error;
  }

  try {
    const current = await checkFile(lockPath);
    assertSameIdentity(current, identity, "Document deletion lock was replaced");
    await unlink(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function checkDocumentLockOwner(lockPath: string, displayLockPath: string): Promise<void> {
  let checked: Stats | undefined;

  try {
    checked = await checkFile(lockPath);
    const bytes = await readCheckedFile(lockPath, checked, 1024);
    const owner: unknown = JSON.parse(bytes.toString("utf8"));

    if (!isRecord(owner) || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1 || owner.pid > 2_147_483_647 || typeof owner.token !== "string") {
      throw new Error("Invalid deletion lock owner");
    }

    assertUuidV4(owner.token, "Deletion lock token");

    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) {
        throw new Error("Document deletion lock belongs to an exited process");
      }
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }

    // A creator may still be writing its record. Age never proves a live owner stopped.
    if (checked && Date.now() - checked.mtimeMs < 1000) {
      return;
    }

    throw new Error(`Cannot verify document deletion lock at ${displayLockPath}. Stop HTML Inbox viewers, hubs, and CLI deletion commands; confirm no deletion is running, then remove only this lock file and retry.`, { cause: error });
  }
}

async function inspectDocumentTree(directory: string, name = ""): Promise<DocumentEntry[]> {
  const info = await checkDirectory(directory);
  const entries: DocumentEntry[] = [{ name, info }];

  for (const child of (await readdir(directory)).sort()) {
    const childPath = path.join(directory, child);
    const childName = path.join(name, child);
    const current = await lstat(childPath);

    if (current.isDirectory()) {
      entries.push(...await inspectDocumentTree(childPath, childName));
    } else {
      entries.push({ name: childName, info: await checkFile(childPath) });
    }
  }

  assertSameIdentity(await checkDirectory(directory), info, "Document directory changed during deletion");
  return entries;
}

async function checkDocumentSnapshot(directory: string, expected: DocumentEntry[]): Promise<void> {
  const current = await inspectDocumentTree(directory);

  if (current.length !== expected.length) {
    throw new Error("Document files changed during deletion");
  }

  for (let index = 0; index < expected.length; index += 1) {
    const before = expected[index];
    const after = current[index];

    if (before.name !== after.name || before.info.isDirectory() !== after.info.isDirectory() ||
        before.info.size !== after.info.size || before.info.mtimeMs !== after.info.mtimeMs ||
        (before.info.isFile() && before.info.ctimeMs !== after.info.ctimeMs)) {
      throw new Error("Document files changed during deletion");
    }

    assertSameIdentity(after.info, before.info, "Document files changed during deletion");
  }
}

async function optionalDirectory(directory: string) {
  try {
    return await checkDirectory(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

async function readCheckedFile(filePath: string, checked: Stats, maximumBytes: number): Promise<Buffer> {
  if (checked.size > maximumBytes) {
    throw new Error("Deletion record exceeds its byte limit");
  }

  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    const info = await file.stat();

    if (!isOwnedRegularFile(info)) {
      throw new Error("Deletion record must be a regular file owned by the current account without hardlinks");
    }

    assertSameIdentity(info, checked, "Deletion record changed during read");
    const bytes = await readBoundedFile(file, maximumBytes, "Deletion record exceeds its byte limit");
    const current = await checkFile(filePath);
    assertSameIdentity(current, checked, "Deletion record changed during read");

    if (current.size !== checked.size || current.mtimeMs !== checked.mtimeMs || current.ctimeMs !== checked.ctimeMs) {
      throw new Error("Deletion record changed during read");
    }

    return bytes;
  } finally {
    await file.close();
  }
}

async function makeDirectoryWritable(directory: string, expected: FileIdentity): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));

  try {
    const info = await file.stat();

    if (!isOwnedDirectory(info)) {
      throw new Error("Deletion directory must be owned by the current account");
    }

    assertSameIdentity(info, expected, "Document directory changed before cleanup");

    if ((info.mode & 0o700) !== 0o700) {
      await file.chmod(0o700);
    }
  } finally {
    await file.close();
  }
}

async function isMissingDocument(directory: string): Promise<boolean> {
  try {
    await lstat(directory);
    return false;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }

    throw error;
  }
}

async function withIdentityError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof DocumentIdentityError) {
      throw cause;
    }

    throw new DocumentIdentityError("Inbox root, identity, or required storage directories are unavailable or unsafe", { cause });
  }
}

function assertSameIdentity(current: FileIdentity, expected: FileIdentity, message: string): void {
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(message);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
