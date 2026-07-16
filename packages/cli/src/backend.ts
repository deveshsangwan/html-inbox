import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertDocumentMetadata,
  DOCUMENT_SCHEMA_VERSION,
  DocumentBackend,
  DocumentMetadata,
  isSafeDocumentId,
  PublishInput,
  PublishResult,
  StoredDocument,
} from "@html-inbox/shared";
import {
  ensurePrivateDirectory,
  hardenPrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
} from "./private-storage";

export const DEFAULT_PORT = 3217;

export function getInboxHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HTML_INBOX_HOME
    ? path.resolve(env.HTML_INBOX_HOME)
    : path.join(homedir(), ".html-inbox");
}

export function getViewerPort(env: NodeJS.ProcessEnv = process.env): number {
  if (!env.HTML_INBOX_PORT) {
    return DEFAULT_PORT;
  }

  const port = Number(env.HTML_INBOX_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HTML_INBOX_PORT must be an integer from 1 to 65535");
  }

  return port;
}

export class LocalDocumentBackend implements DocumentBackend {
  constructor(
    private readonly home: string = getInboxHome(),
    private readonly onWarning: (message: string) => void = (message) =>
      console.warn(`html-inbox: ${message}`),
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    await this.prepareStorage();
    const metadata: DocumentMetadata = {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      id: randomUUID(),
      title: input.title,
      type: input.type,
      createdAt: new Date().toISOString(),
      sourceFileName: input.sourceFileName,
    };
    const documentDir = this.documentDir(metadata.id);
    const stagingDir = path.join(this.stagingDir(), metadata.id);

    await ensurePrivateDirectory(stagingDir);
    try {
      await writePrivateFile(path.join(stagingDir, "index.html"), input.originalBytes);
      await writePrivateFile(
        path.join(stagingDir, "metadata.json"),
        JSON.stringify(metadata, null, 2),
      );
      await this.validateStagedDocument(stagingDir, metadata.id, input.originalBytes);
      await rename(stagingDir, documentDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }

    return { metadata };
  }

  async listDocuments(): Promise<DocumentMetadata[]> {
    await this.prepareStorage();
    const documentsDir = path.join(this.home, "documents");
    let entries: string[];

    try {
      entries = await readdir(documentsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const documents = await Promise.all(entries.map((id) => this.readMetadata(id)));
    return documents
      .filter((metadata): metadata is DocumentMetadata => metadata !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDocument(id: string): Promise<StoredDocument | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    await this.prepareStorage();

    let metadataBytes: string;
    let html: string;
    try {
      await this.hardenDocument(id);
      [metadataBytes, html] = await Promise.all([
        readFile(path.join(this.documentDir(id), "metadata.json"), "utf8"),
        readFile(path.join(this.documentDir(id), "index.html"), "utf8"),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if (error instanceof Error && error.message.startsWith("Managed ")) {
        this.warnCorrupt(id, error);
        return null;
      }
      throw error;
    }

    const metadata = this.parseMetadata(id, metadataBytes);
    return metadata ? { metadata, html } : null;
  }

  private async readMetadata(id: string): Promise<DocumentMetadata | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    let metadataBytes: string;
    try {
      await this.hardenDocument(id);
      metadataBytes = await readFile(path.join(this.documentDir(id), "metadata.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.warnCorrupt(id, new Error("document files are incomplete"));
        return null;
      }
      if (error instanceof Error && error.message.startsWith("Managed ")) {
        this.warnCorrupt(id, error);
        return null;
      }
      throw error;
    }

    return this.parseMetadata(id, metadataBytes);
  }

  private parseMetadata(id: string, metadataBytes: string): DocumentMetadata | null {
    try {
      const metadata = JSON.parse(metadataBytes) as unknown;
      assertDocumentMetadata(metadata);
      if (metadata.id !== id) {
        throw new Error(`metadata ID ${metadata.id} does not match its directory`);
      }
      return metadata;
    } catch (error) {
      this.warnCorrupt(id, error);
      return null;
    }
  }

  private documentDir(id: string): string {
    return path.join(this.home, "documents", id);
  }

  private async prepareStorage(): Promise<void> {
    const documentsDir = path.join(this.home, "documents");
    await ensurePrivateDirectory(this.home);
    await ensurePrivateDirectory(documentsDir);
    await ensurePrivateDirectory(this.stagingDir());
  }

  private async hardenDocument(id: string): Promise<void> {
    if (!isSafeDocumentId(id)) {
      return;
    }

    const documentDir = this.documentDir(id);
    try {
      await hardenPrivateDirectory(documentDir);
      await Promise.all([
        hardenPrivateFile(path.join(documentDir, "index.html")),
        hardenPrivateFile(path.join(documentDir, "metadata.json")),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private stagingDir(): string {
    return path.join(this.home, "documents", ".staging");
  }

  private async validateStagedDocument(
    stagingDir: string,
    expectedId: string,
    expectedBytes: Uint8Array,
  ): Promise<void> {
    const [metadataBytes, storedBytes] = await Promise.all([
      readFile(path.join(stagingDir, "metadata.json"), "utf8"),
      readFile(path.join(stagingDir, "index.html")),
    ]);
    const metadata = JSON.parse(metadataBytes) as unknown;
    assertDocumentMetadata(metadata);
    if (metadata.id !== expectedId) {
      throw new Error("Staged metadata does not match the generated document ID");
    }
    if (!storedBytes.equals(Buffer.from(expectedBytes))) {
      throw new Error("Staged HTML does not match the published bytes");
    }
  }

  private warnCorrupt(id: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.onWarning(`skipping corrupt document ${id}: ${detail}`);
  }
}
