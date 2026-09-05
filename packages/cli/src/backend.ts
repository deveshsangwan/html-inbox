import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocumentMetadata, DOCUMENT_SCHEMA_VERSION, DeleteResult, DocumentBackend, DocumentMetadata, isSafeDocumentId, PublishInput, StoredDocument } from "./documents";
import {
  ensurePrivateDirectory,
  ManagedStorageError,
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
    private readonly createDocumentId: () => string = randomUUID,
  ) {}

  async publish(input: PublishInput): Promise<DocumentMetadata> {
    await this.prepareStorage();
    const metadata = parseDocumentMetadata({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      id: this.createDocumentId(),
      title: input.title,
      type: input.type,
      createdAt: new Date().toISOString(),
      sourceFileName: input.sourceFileName,
    });
    const documentDir = this.documentDir(metadata.id);
    const stagingDir = path.join(this.stagingDir(), metadata.id);

    await ensurePrivateDirectory(stagingDir);
    try {
      await writePrivateFile(path.join(stagingDir, "index.html"), input.originalBytes);
      await writePrivateFile(
        path.join(stagingDir, "metadata.json"),
        JSON.stringify(metadata, null, 2),
      );
      await rename(stagingDir, documentDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }

    return metadata;
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
    const metadata = await this.getDocumentMetadata(id);
    if (!metadata) {
      return null;
    }

    try {
      const originalBytes = await readFile(path.join(this.documentDir(id), "index.html"));
      return { metadata, originalBytes };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await this.warnIfIncomplete(id);
        return null;
      }
      throw error;
    }
  }

  async getDocumentMetadata(id: string): Promise<DocumentMetadata | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    await this.prepareStorage();
    return this.readMetadata(id);
  }

  async deleteDocument(id: string): Promise<DeleteResult | null> {
    const metadata = await this.getDocumentMetadata(id);
    if (!metadata) {
      return null;
    }

    const documentDir = this.documentDir(id);
    const [htmlStat, metadataStat] = await Promise.all([
      stat(path.join(documentDir, "index.html")),
      stat(path.join(documentDir, "metadata.json")),
    ]);
    const trashDir = path.join(this.trashDir(), `${id}-${randomUUID()}`);
    await rename(documentDir, trashDir);
    await rm(trashDir, { recursive: true, force: true });

    return {
      metadata,
      reclaimedBytes: htmlStat.size + metadataStat.size,
    };
  }

  private async readMetadata(id: string): Promise<DocumentMetadata | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    let metadataBytes: string;
    try {
      const state = await this.hardenDocument(id);
      if (state === "missing") {
        return null;
      }
      if (state === "incomplete") {
        this.warnCorrupt(id, new Error("document files are incomplete"));
        return null;
      }
      metadataBytes = await readFile(path.join(this.documentDir(id), "metadata.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.warnCorrupt(id, new Error("document files are incomplete"));
        return null;
      }
      if (error instanceof ManagedStorageError) {
        this.warnCorrupt(id, error);
        return null;
      }
      throw error;
    }

    return this.parseMetadata(id, metadataBytes);
  }

  private parseMetadata(id: string, metadataBytes: string): DocumentMetadata | null {
    try {
      const metadata = parseDocumentMetadata(JSON.parse(metadataBytes));
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
    await ensurePrivateDirectory(this.trashDir());
  }

  private async hardenDocument(id: string): Promise<"complete" | "incomplete" | "missing"> {
    if (!isSafeDocumentId(id)) {
      return "missing";
    }

    const documentDir = this.documentDir(id);
    try {
      await hardenPrivateDirectory(documentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "missing";
      }
      throw error;
    }

    try {
      await Promise.all([
        hardenPrivateFile(path.join(documentDir, "index.html")),
        hardenPrivateFile(path.join(documentDir, "metadata.json")),
      ]);
      return "complete";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "incomplete";
      }
      throw error;
    }
  }

  private stagingDir(): string {
    return path.join(this.home, "documents", ".staging");
  }

  private trashDir(): string {
    return path.join(this.home, "documents", ".trash");
  }

  private warnCorrupt(id: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.onWarning(`skipping corrupt document ${id}: ${detail}`);
  }

  private async warnIfIncomplete(id: string): Promise<void> {
    try {
      await lstat(this.documentDir(id));
      this.warnCorrupt(id, new Error("document files are incomplete"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
