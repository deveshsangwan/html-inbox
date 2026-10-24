import { createHash } from "node:crypto";

export const DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_DOCUMENT_TITLE_LENGTH = 200;
export const MAX_DOCUMENT_TYPE_LENGTH = 64;
export const MAX_SOURCE_FILE_NAME_LENGTH = 255;

export interface OriginalDocumentMetadata {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  id: string;
  title: string;
  type: string;
  createdAt: string;
  sourceFileName: string;
}

export interface DocumentOrigin {
  schemaVersion: 1;
  inboxId: string;
  documentId: string;
  historyEpoch: string;
  version: number;
  sha256: string;
  byteLength: number;
  metadataSha256: string;
  signature: string;
  detached: boolean;
  originalMetadata: OriginalDocumentMetadata;
}

export interface DocumentMetadata extends OriginalDocumentMetadata {
  origin?: DocumentOrigin;
}

export interface PublishInput {
  originalBytes: Buffer;
  title: string;
  type: string;
  sourceFileName: string;
}

export interface DeleteResult {
  metadata: DocumentMetadata;
  reclaimedBytes: number;
}

export interface StoredDocument {
  metadata: DocumentMetadata;
  originalBytes: Buffer;
}

export interface DocumentBackend {
  publish(input: PublishInput): Promise<DocumentMetadata>;
  listDocuments(): Promise<DocumentMetadata[]>;
  getDocumentMetadata(id: string): Promise<DocumentMetadata | null>;
  getDocument(id: string): Promise<StoredDocument | null>;
  deleteDocument(id: string): Promise<DeleteResult | null>;
}

export type DocumentSource = Pick<
  DocumentBackend,
  "listDocuments" | "getDocumentMetadata" | "getDocument"
>;

export function parseDocumentMetadata(value: unknown): DocumentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }

  const schemaVersion = "schemaVersion" in value ? value.schemaVersion : DOCUMENT_SCHEMA_VERSION;
  if (schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new Error(`unsupported metadata schema version: ${String(schemaVersion)}`);
  }
  if (!("id" in value) || typeof value.id !== "string" || !isSafeDocumentId(value.id)) {
    throw new Error("metadata.id contains unsupported characters");
  }
  if (!("title" in value) || typeof value.title !== "string") {
    throw new Error("metadata.title must be a non-empty string");
  }
  if (!("type" in value) || typeof value.type !== "string") {
    throw new Error("metadata.type must be a non-empty string");
  }
  if (!("sourceFileName" in value) || typeof value.sourceFileName !== "string") {
    throw new Error("metadata.sourceFileName must be a non-empty string");
  }
  if (!("createdAt" in value) || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("metadata.createdAt must be a valid date");
  }

  assertMetadataLength("title", value.title, MAX_DOCUMENT_TITLE_LENGTH);
  assertMetadataLength("type", value.type, MAX_DOCUMENT_TYPE_LENGTH);
  assertMetadataLength("sourceFileName", value.sourceFileName, MAX_SOURCE_FILE_NAME_LENGTH);

  const origin = "origin" in value ? parseDocumentOrigin(value.origin) : undefined;
  if (origin && (value.title !== origin.originalMetadata.title || value.type !== origin.originalMetadata.type ||
      value.createdAt !== origin.originalMetadata.createdAt || value.sourceFileName !== origin.originalMetadata.sourceFileName)) {
    throw new Error("metadata display fields conflict with its original projection");
  }

  return {
    schemaVersion,
    id: value.id,
    title: value.title,
    type: value.type,
    createdAt: value.createdAt,
    sourceFileName: value.sourceFileName,
    ...(origin ? { origin } : {}),
  };
}

function parseDocumentOrigin(value: unknown): DocumentOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("inboxId" in value) || typeof value.inboxId !== "string" ||
      !("historyEpoch" in value) || typeof value.historyEpoch !== "string" ||
      !("documentId" in value) || typeof value.documentId !== "string" || !isSafeDocumentId(value.documentId) ||
      !("version" in value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1 ||
      !("sha256" in value) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !("metadataSha256" in value) || typeof value.metadataSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.metadataSha256) ||
      !("byteLength" in value) || typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > 10 * 1024 * 1024 ||
      !("signature" in value) || typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value.signature) ||
      !("detached" in value) || typeof value.detached !== "boolean" ||
      !("originalMetadata" in value)) {
    throw new Error("metadata.origin is invalid");
  }

  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const fields = new Set(["schemaVersion", "inboxId", "documentId", "historyEpoch", "version", "sha256", "byteLength", "metadataSha256", "signature", "detached", "originalMetadata"]);
  if (!uuid.test(value.inboxId) || !uuid.test(value.historyEpoch) || Object.keys(value).some((key) => !fields.has(key))) {
    throw new Error("metadata.origin identity or fields are invalid");
  }

  if (!value.originalMetadata || typeof value.originalMetadata !== "object" || "origin" in value.originalMetadata) {
    throw new Error("metadata.origin.originalMetadata must be an original projection");
  }

  const originalFields = ["schemaVersion", "id", "title", "type", "createdAt", "sourceFileName"];
  const originalValue = value.originalMetadata;
  if (Object.keys(originalValue).length !== originalFields.length || originalFields.some((key) => !Object.hasOwn(originalValue, key))) {
    throw new Error("metadata.origin.originalMetadata has unsupported or missing fields");
  }

  const originalMetadata = parseDocumentMetadata(value.originalMetadata);
  if (originalMetadata.id !== value.documentId) {
    throw new Error("metadata.origin document identity conflicts with original metadata");
  }

  const metadataHash = createHash("sha256").update(JSON.stringify([1, originalMetadata.id, originalMetadata.title, originalMetadata.type,
    originalMetadata.createdAt, originalMetadata.sourceFileName])).digest("hex");
  if (metadataHash !== value.metadataSha256) {
    throw new Error("metadata.origin original metadata fingerprint conflict");
  }

  return { schemaVersion: 1, inboxId: value.inboxId, documentId: value.documentId, historyEpoch: value.historyEpoch,
    version: value.version, sha256: value.sha256, byteLength: value.byteLength, metadataSha256: value.metadataSha256,
    signature: value.signature, detached: value.detached, originalMetadata };
}

export function validatePublishMetadata(input: {
  title: string;
  type: string;
  sourceFileName: string;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  validateMetadataField(errors, "title", input.title, MAX_DOCUMENT_TITLE_LENGTH);
  validateMetadataField(errors, "type", input.type, MAX_DOCUMENT_TYPE_LENGTH);
  validateMetadataField(
    errors,
    "source file name",
    input.sourceFileName,
    MAX_SOURCE_FILE_NAME_LENGTH,
  );
  return { ok: errors.length === 0, errors };
}

function validateMetadataField(
  errors: string[],
  label: string,
  value: string,
  maximumLength: number,
): void {
  if (value.trim().length === 0) {
    errors.push(`${label} must not be empty`);
  } else if (value.length > maximumLength) {
    errors.push(`${label} must be at most ${maximumLength} characters`);
  }
}

function assertMetadataLength(label: string, value: string, maximumLength: number): void {
  if (value.trim().length === 0 || value.length > maximumLength) {
    throw new Error(`metadata.${label} must contain 1-${maximumLength} characters`);
  }
}

export function isSafeDocumentId(id: string): boolean {
  return id.length <= 255 && /^[a-zA-Z0-9_-]+$/.test(id);
}
