import { open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { PublishInput, validateHtml, validatePublishMetadata } from "@html-inbox/shared";

export const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export interface PublishRequest {
  filePath: string;
  title: string;
  type: string;
}

export interface LoadedPublishInput {
  input: PublishInput;
  /** Advisory findings the document CSP already blocks; publishing continues. */
  warnings: string[];
}

export async function loadPublishInput(
  request: PublishRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedPublishInput> {
  const absolutePath = path.resolve(request.filePath);
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension !== ".html" && extension !== ".htm") {
    throw new Error("Published file must use .html or .htm");
  }

  const maximumBytes = getMaxDocumentBytes(env);
  const sourceFileName = path.basename(absolutePath);
  const metadataValidation = validatePublishMetadata({
    title: request.title,
    type: request.type,
    sourceFileName,
  });
  if (!metadataValidation.ok) {
    throw new Error(`Document metadata is invalid: ${metadataValidation.errors.join("; ")}`);
  }

  const file = await open(absolutePath, "r");
  let originalBytes: Buffer;
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error("Published path must be a file");
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - byteLength + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      byteLength += bytesRead;
      if (byteLength > maximumBytes) {
        throw new Error(`Published file exceeds the limit of ${maximumBytes} bytes`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    originalBytes = Buffer.concat(chunks, byteLength);
  } finally {
    await file.close();
  }

  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes);
  } catch {
    throw new Error("Published file must be valid UTF-8");
  }

  const validation = validateHtml(html);
  if (!validation.ok) {
    throw new Error(`HTML validation failed: ${validation.errors.join("; ")}`);
  }

  return {
    input: {
      originalBytes,
      title: request.title,
      type: request.type,
      sourceFileName,
    },
    warnings: validation.warnings,
  };
}

export function getMaxDocumentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.HTML_INBOX_MAX_BYTES;
  if (configured === undefined) {
    return DEFAULT_MAX_DOCUMENT_BYTES;
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("HTML_INBOX_MAX_BYTES must be a positive integer");
  }
  return value;
}
