import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { type DeleteResult, type DocumentMetadata, isSafeDocumentId, parseDocumentMetadata } from "./documents";
import { type LocalDocumentLocation, parseLocalDocumentLocation } from "./local-document-source";
import { assertUuidV4 } from "./validation";

export type DocumentDeleter = (id: string) => Promise<DeleteResult | null>;

export class DocumentIdentityError extends Error {}

export class DocumentCleanupError extends Error {
  constructor(readonly metadata: DocumentMetadata, cause: unknown) {
    super("Document was removed from the library, but permanent cleanup failed", { cause });
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface StorageIdentity {
  home: string;
  instanceId?: string;
  root: FileIdentity;
  documents: FileIdentity | null;
  trash: FileIdentity | null;
}

interface DocumentEntry {
  name: string;
  info: Stats;
}

export async function createDocumentDeleter(location: LocalDocumentLocation): Promise<DocumentDeleter> {
  const { home, instanceId } = parseLocalDocumentLocation(location);
  const storage = await captureStorageIdentity(home, instanceId);

  return (id) => deleteDocument(storage, id);
}

// CLI storage preparation predates inbox identities. Both callers use the same deletion algorithm.
export async function deleteStoredDocument(home: string, id: string): Promise<DeleteResult | null> {
  if (!isSafeDocumentId(id)) {
    return null;
  }

  const storage = await captureStorageIdentity(home);
  return deleteDocument(storage, id);
}

async function captureStorageIdentity(home: string, instanceId?: string): Promise<StorageIdentity> {
  return withIdentityError(async () => {
    const root = await checkDirectory(home);
    const documents = await optionalDirectory(path.join(home, "documents"));
    const trash = await optionalDirectory(path.join(home, "documents", ".trash"));
    const storage = { home, instanceId, root, documents, trash };
    await checkStorageIdentity(storage, false);

    return storage;
  });
}

async function checkStorageIdentity(storage: StorageIdentity, requireDirectories = true): Promise<void> {
  await withIdentityError(async () => {
    assertSameIdentity(await checkDirectory(storage.home), storage.root, "Inbox root was replaced");
    if (storage.instanceId !== undefined) {
      const identityPath = path.join(storage.home, "instance-id");
      const checked = await checkFile(identityPath);
      const bytes = await readCheckedFile(identityPath, checked, 128);
      const instanceId = bytes.toString("utf8").trim().toLowerCase();
      assertUuidV4(instanceId, "Inbox instance identity");
      if (instanceId !== storage.instanceId) {
        throw new DocumentIdentityError("Inbox instance identity does not match the selected inbox");
      }
    }

    for (const key of ["documents", "trash"] as const) {
      const directory = key === "documents" ? path.join(storage.home, "documents") : path.join(storage.home, "documents", ".trash");
      const current = requireDirectories ? await checkDirectory(directory) : await optionalDirectory(directory);
      const previous = storage[key];
      if (previous && !current) {
        throw new DocumentIdentityError(`Inbox ${key} directory is unavailable`);
      }

      if (previous && current) {
        assertSameIdentity(current, previous, `Inbox ${key} directory was replaced`);
      }

      storage[key] ??= current;
    }

    assertSameIdentity(await checkDirectory(storage.home), storage.root, "Inbox root changed during deletion");
  });
}

async function deleteDocument(storage: StorageIdentity, id: string): Promise<DeleteResult | null> {
  if (!isSafeDocumentId(id)) {
    return null;
  }

  const documentDirectory = path.join(storage.home, "documents", id);
  let metadata: DocumentMetadata;
  let reclaimedBytes: number;
  let entries: DocumentEntry[];
  let quarantineDirectory: string;

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
    quarantineDirectory = path.join(storage.home, "documents", ".trash", randomUUID());
    await checkDocumentSnapshot(documentDirectory, entries);
    if (process.platform !== "win32") {
      for (const [directory, identity] of [
        [path.join(storage.home, "documents"), storage.documents],
        [path.join(storage.home, "documents", ".trash"), storage.trash],
        [documentDirectory, entries[0].info],
      ] as const) {
        if (!identity) {
          throw new DocumentIdentityError("Required deletion directory is unavailable");
        }

        await checkStorageIdentity(storage);
        await makeDirectoryWritable(directory, identity);
      }
    }

    await checkDocumentSnapshot(documentDirectory, entries);
    await checkStorageIdentity(storage);
    await rename(documentDirectory, quarantineDirectory);
  } catch (error) {
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
  } catch (cause) {
    throw new DocumentCleanupError(metadata, cause);
  }

  return { metadata, reclaimedBytes };
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

async function checkDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !isSameAccount(info.uid) || await realpath(directory) !== directory) {
    throw new Error("Deletion directory must be canonical and owned by the current account");
  }

  return info;
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

async function checkFile(filePath: string) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !isSameAccount(info.uid)) {
    throw new Error("Deletion file must be a regular file owned by the current account without hardlinks");
  }

  return info;
}

async function readCheckedFile(filePath: string, checked: Stats, maximumBytes: number): Promise<Buffer> {
  if (checked.size > maximumBytes) {
    throw new Error("Deletion record exceeds its byte limit");
  }

  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !isSameAccount(info.uid)) {
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
    if (!info.isDirectory() || !isSameAccount(info.uid)) {
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

function isSameAccount(uid: number): boolean {
  return !process.getuid || uid === process.getuid();
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
