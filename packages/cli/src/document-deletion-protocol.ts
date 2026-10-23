import path from "node:path";
import { type DeleteResult, type DocumentMetadata, isSafeDocumentId, parseDocumentMetadata } from "./documents";
import { type FileIdentity, type StorageIdentity } from "./document-deletion-worker";
import { assertUuidV4, isRecord } from "./validation";

export class DocumentIdentityError extends Error {}

export class DocumentCleanupError extends Error {
  constructor(readonly metadata: DocumentMetadata, cause: unknown) {
    super("Document was removed from the library, but permanent cleanup failed", { cause });
  }
}

export interface DocumentDeletionRequest {
  protocolVersion: 1;
  id: string;
  storage: Omit<StorageIdentity, "directory">;
}

interface SerializedError {
  kind: "identity" | "cleanup" | "error";
  message: string;
  name: string;
  code?: string;
  metadata?: DocumentMetadata;
  cause?: SerializedError;
}

export function parseDocumentDeletionRequest(value: unknown): DocumentDeletionRequest {
  assertBoundedMessage(value);

  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.id !== "string" ||
      !isSafeDocumentId(value.id) || value.id.length > 4096 || !isRecord(value.storage)) {
    throw new Error("Invalid document deletion worker request");
  }

  const storage = value.storage;

  if (typeof storage.home !== "string" || storage.home.includes("\0") || storage.home.length > 4096 ||
      !path.isAbsolute(storage.home) || path.resolve(storage.home) !== storage.home ||
      (storage.instanceId !== undefined && typeof storage.instanceId !== "string")) {
    throw new Error("Invalid document deletion worker location");
  }

  if (typeof storage.instanceId === "string") {
    assertUuidV4(storage.instanceId, "Deletion worker instance identity");
  }

  return {
    protocolVersion: 1,
    id: value.id,
    storage: {
      home: storage.home,
      ...(typeof storage.instanceId === "string" ? { instanceId: storage.instanceId.toLowerCase() } : {}),
      root: parseFileIdentity(storage.root),
      documents: storage.documents === null ? null : parseFileIdentity(storage.documents),
      trash: storage.trash === null ? null : parseFileIdentity(storage.trash),
    },
  };
}

export function serializeDeletionError(error: unknown, depth = 0): SerializedError {
  const value = error instanceof Error ? error : new Error(String(error));
  const kind = value instanceof DocumentCleanupError ? "cleanup" : value instanceof DocumentIdentityError ? "identity" : "error";

  return {
    kind,
    message: value.message.slice(0, 2048),
    name: value.name.slice(0, 64),
    ...("code" in value && typeof value.code === "string" ? { code: value.code.slice(0, 64) } : {}),
    ...(value instanceof DocumentCleanupError ? { metadata: value.metadata } : {}),
    ...(value.cause !== undefined && depth < 2 ? { cause: serializeDeletionError(value.cause, depth + 1) } : {}),
  };
}

export function parseDocumentDeletionResponse(value: unknown, id: string): { ok: true; result: DeleteResult | null } | { ok: false; error: Error } {
  assertBoundedMessage(value);

  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.ok !== "boolean") {
    throw new Error("Invalid document deletion worker response");
  }

  if (!value.ok) {
    return { ok: false, error: parseDeletionError(value.error, id) };
  }

  if (value.result === null) {
    return { ok: true, result: null };
  }

  if (!isRecord(value.result) || typeof value.result.reclaimedBytes !== "number" ||
      !Number.isSafeInteger(value.result.reclaimedBytes) || value.result.reclaimedBytes < 0) {
    throw new Error("Invalid document deletion worker result");
  }

  const metadata = parseDocumentMetadata(value.result.metadata);
  assertMatchingId(metadata, id);

  return { ok: true, result: { metadata, reclaimedBytes: value.result.reclaimedBytes } };
}

function parseDeletionError(value: unknown, id: string, depth = 0): Error {
  if (depth > 2 || !isRecord(value) || typeof value.message !== "string" || value.message.length > 2048 ||
      typeof value.name !== "string" || value.name.length > 64 ||
      (value.code !== undefined && (typeof value.code !== "string" || value.code.length > 64))) {
    throw new Error("Invalid document deletion worker error");
  }

  const cause = value.cause === undefined ? undefined : parseDeletionError(value.cause, id, depth + 1);

  if (value.kind === "cleanup") {
    const metadata = parseDocumentMetadata(value.metadata);
    assertMatchingId(metadata, id);

    return new DocumentCleanupError(metadata, cause);
  }

  if (value.kind !== "identity" && value.kind !== "error") {
    throw new Error("Invalid document deletion worker error kind");
  }

  const error = value.kind === "identity" ? new DocumentIdentityError(value.message, { cause })
    : value.name === "SyntaxError" ? new SyntaxError(value.message, { cause }) : new Error(value.message, { cause });

  return typeof value.code === "string" ? Object.assign(error, { code: value.code }) : error;
}

function parseFileIdentity(value: unknown): FileIdentity {
  if (!isRecord(value) || typeof value.dev !== "number" || !Number.isInteger(value.dev) || value.dev < 0 ||
      typeof value.ino !== "number" || !Number.isInteger(value.ino) || value.ino < 0) {
    throw new Error("Invalid document deletion filesystem identity");
  }

  return { dev: value.dev, ino: value.ino };
}

function assertMatchingId(metadata: DocumentMetadata, id: string): void {
  if (metadata.id !== id) {
    throw new Error("Document deletion worker metadata identity does not match its request");
  }
}

function assertBoundedMessage(value: unknown): void {
  const serialized = JSON.stringify(value);

  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 64 * 1024) {
    throw new Error("Document deletion worker message exceeds its byte limit");
  }
}
