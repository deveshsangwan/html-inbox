import { readFile, stat } from "node:fs/promises";
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

  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Published path must be a file");
  }

  const maximumBytes = getMaxDocumentBytes(env);
  if (fileStat.size > maximumBytes) {
    throw new Error(
      `Published file is ${fileStat.size} bytes; the limit is ${maximumBytes} bytes`,
    );
  }

  const sourceFileName = path.basename(absolutePath);
  const metadataValidation = validatePublishMetadata({
    title: request.title,
    type: request.type,
    sourceFileName,
  });
  if (!metadataValidation.ok) {
    throw new Error(`Document metadata is invalid: ${metadataValidation.errors.join("; ")}`);
  }

  const originalBytes = await readFile(absolutePath);
  if (originalBytes.byteLength > maximumBytes) {
    throw new Error(
      `Published file grew to ${originalBytes.byteLength} bytes; the limit is ${maximumBytes} bytes`,
    );
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
