import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertDocumentMetadata,
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
  constructor(private readonly home: string = getInboxHome()) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    await this.prepareStorage();
    const metadata: DocumentMetadata = {
      id: randomUUID(),
      title: input.title,
      type: input.type,
      createdAt: new Date().toISOString(),
      sourceFileName: input.sourceFileName,
    };
    const documentDir = this.documentDir(metadata.id);

    await ensurePrivateDirectory(documentDir);
    await writePrivateFile(path.join(documentDir, "index.html"), input.originalBytes);
    await writePrivateFile(
      path.join(documentDir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );

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

    const documents = await Promise.all(
      entries.map(async (id) => {
        await this.hardenDocument(id);
        return this.readMetadata(id);
      }),
    );
    return documents
      .filter((metadata): metadata is DocumentMetadata => metadata !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDocument(id: string): Promise<StoredDocument | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    await this.prepareStorage();
    await this.hardenDocument(id);

    try {
      const [metadataBytes, html] = await Promise.all([
        readFile(path.join(this.documentDir(id), "metadata.json"), "utf8"),
        readFile(path.join(this.documentDir(id), "index.html"), "utf8"),
      ]);
      const metadata = JSON.parse(metadataBytes) as unknown;
      assertDocumentMetadata(metadata);
      return { metadata, html };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readMetadata(id: string): Promise<DocumentMetadata | null> {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    try {
      const metadata = JSON.parse(
        await readFile(path.join(this.documentDir(id), "metadata.json"), "utf8"),
      ) as unknown;
      assertDocumentMetadata(metadata);
      return metadata;
    } catch {
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
}
