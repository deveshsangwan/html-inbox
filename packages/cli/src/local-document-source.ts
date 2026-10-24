import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { type DocumentMetadata, type DocumentSource, type StoredDocument, isSafeDocumentId, parseDocumentMetadata } from "./documents";
import { assertUuidV4 } from "./validation";
import { ManagedSyncStore } from "./sync-store";

export interface LocalDocumentLocation {
  home: string;
  instanceId: string;
}

export function parseLocalDocumentLocation(value: LocalDocumentLocation): LocalDocumentLocation {
  if (typeof value.home !== "string" || value.home.includes("\0") || value.home.length > 4096 ||
      !path.isAbsolute(value.home) || path.resolve(value.home) !== value.home) {
    throw new Error("Source home must be an absolute canonical path");
  }

  if (typeof value.instanceId !== "string") {
    throw new Error("Source instance identity must be a version 4 UUID");
  }

  assertUuidV4(value.instanceId, "Source instance identity");
  return { home: value.home, instanceId: value.instanceId.toLowerCase() };
}

// These reads deliberately never use the backend's storage preparation or hardening.
export class LocalDocumentSource implements DocumentSource {
  private readonly location: LocalDocumentLocation;
  private rootIdentity?: { dev: number; ino: number };
  private hasSeenDocumentsDirectory = false;

  constructor(location: LocalDocumentLocation, private readonly maximumDocumentBytes = 10 * 1024 * 1024) {
    this.location = parseLocalDocumentLocation(location);
    if (!Number.isSafeInteger(maximumDocumentBytes) || maximumDocumentBytes < 1) {
      throw new Error("Source document byte limit must be a positive safe integer");
    }
  }

  async listDocuments(): Promise<DocumentMetadata[]> {
    await this.checkIdentity();
    if (await ManagedSyncStore.isEnrolled(this.location.home)) {
      const documents = await new ManagedSyncStore(this.location.home).listDocuments(this.maximumDocumentBytes);
      await this.checkIdentity();
      return documents;
    }

    const directory = path.join(this.location.home, "documents");
    if (!await this.hasDocumentDirectory()) {
      await this.checkIdentity();
      return [];
    }

    const documents: DocumentMetadata[] = [];
    for (const id of await readdir(directory)) {
      if (!isSafeDocumentId(id)) {
        continue;
      }

      const metadata = await this.readMetadata(id);
      if (metadata) {
        documents.push(metadata);
      }
    }

    await this.checkIdentity();
    return documents.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  async getDocumentMetadata(id: string): Promise<DocumentMetadata | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    await this.checkIdentity();
    if (await ManagedSyncStore.isEnrolled(this.location.home)) {
      const metadata = await new ManagedSyncStore(this.location.home).getDocumentMetadata(id, this.maximumDocumentBytes);
      await this.checkIdentity();
      return metadata;
    }

    const metadata = await this.readMetadata(id);
    await this.checkIdentity();

    return metadata;
  }

  async getDocument(id: string): Promise<StoredDocument | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    await this.checkIdentity();
    if (await ManagedSyncStore.isEnrolled(this.location.home)) {
      const document = await new ManagedSyncStore(this.location.home).getDocument(id, this.maximumDocumentBytes);
      await this.checkIdentity();
      return document;
    }

    const metadata = await this.readMetadata(id);
    if (!metadata) {
      await this.checkIdentity();
      return null;
    }

    const originalBytes = await readSourceFile(path.join(this.documentDirectory(id), "index.html"), this.maximumDocumentBytes);
    await this.checkIdentity();

    return { metadata, originalBytes };
  }

  private async checkIdentity(): Promise<void> {
    const root = await checkDirectory(this.location.home);
    if (this.rootIdentity && (root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino)) {
      throw new Error("Source root was replaced");
    }

    const bytes = await readSourceFile(path.join(this.location.home, "instance-id"), 128);
    const instanceId = bytes.toString("utf8").trim().toLowerCase();
    assertUuidV4(instanceId, "Source instance identity");
    if (instanceId !== this.location.instanceId) {
      throw new Error("Source instance identity does not match the selected inbox");
    }

    const current = await checkDirectory(this.location.home);
    if (current.dev !== root.dev || current.ino !== root.ino ||
        (this.rootIdentity && (current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino))) {
      throw new Error("Source root changed during read");
    }

    this.rootIdentity ??= { dev: root.dev, ino: root.ino };
  }

  private async readMetadata(id: string): Promise<DocumentMetadata | null> {
    if (!await this.hasDocumentDirectory()) {
      return null;
    }

    try {
      await checkDirectory(this.documentDirectory(id));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    await checkFile(path.join(this.documentDirectory(id), "index.html"), this.maximumDocumentBytes);
    const bytes = await readSourceFile(path.join(this.documentDirectory(id), "metadata.json"), 64 * 1024);
    const metadata = parseDocumentMetadata(JSON.parse(bytes.toString("utf8")));
    if (metadata.id !== id) {
      throw new Error("Source metadata identity does not match its directory");
    }

    return metadata;
  }

  private documentDirectory(id: string): string {
    return path.join(this.location.home, "documents", id);
  }

  private async hasDocumentDirectory(): Promise<boolean> {
    try {
      await checkDirectory(path.join(this.location.home, "documents"));
      this.hasSeenDocumentsDirectory = true;
      return true;
    } catch (error) {
      // A viewer can create its identity before the first document is published.
      if (!this.hasSeenDocumentsDirectory && error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }
}

async function checkDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !isSameAccount(info.uid) || await realpath(directory) !== directory) {
    throw new Error("Source directory must be canonical and owned by the current account");
  }

  return info;
}

async function checkFile(filePath: string, maximumBytes: number) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !isSameAccount(info.uid)) {
    throw new Error("Source file must be a regular file owned by the current account");
  }

  if (info.size > maximumBytes) {
    throw new Error("Source file exceeds its byte limit");
  }

  return info;
}

async function readSourceFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const checked = await checkFile(filePath, maximumBytes);
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !isSameAccount(info.uid) || info.dev !== checked.dev || info.ino !== checked.ino) {
      throw new Error("Source file changed during read");
    }

    const bytes = await readBoundedFile(file, maximumBytes, "Source file exceeds its byte limit");
    const current = await checkFile(filePath, maximumBytes);
    if (current.dev !== info.dev || current.ino !== info.ino) {
      throw new Error("Source file changed during read");
    }

    return bytes;
  } finally {
    await file.close();
  }
}

function isSameAccount(uid: number): boolean {
  return !process.getuid || uid === process.getuid();
}
