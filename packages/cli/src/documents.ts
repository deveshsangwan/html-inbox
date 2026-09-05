export const DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_DOCUMENT_TITLE_LENGTH = 200;
export const MAX_DOCUMENT_TYPE_LENGTH = 64;
export const MAX_SOURCE_FILE_NAME_LENGTH = 255;

export interface DocumentMetadata {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  id: string;
  title: string;
  type: string;
  createdAt: string;
  sourceFileName: string;
}

export interface PublishInput {
  originalBytes: Buffer;
  title: string;
  type: string;
  sourceFileName: string;
}

export interface PublishResult {
  metadata: DocumentMetadata;
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
  publish(input: PublishInput): Promise<PublishResult>;
  listDocuments(): Promise<DocumentMetadata[]>;
  getDocumentMetadata(id: string): Promise<DocumentMetadata | null>;
  getDocument(id: string): Promise<StoredDocument | null>;
  deleteDocument(id: string): Promise<DeleteResult | null>;
}

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

  return {
    schemaVersion,
    id: value.id,
    title: value.title,
    type: value.type,
    createdAt: value.createdAt,
    sourceFileName: value.sourceFileName,
  };
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
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
