export type DocumentType = "report" | "note" | "dashboard" | "other" | (string & {});

export interface DocumentMetadata {
  id: string;
  title: string;
  type: DocumentType;
  createdAt: string;
  sourceFileName: string;
}

export interface PublishInput {
  html: string;
  originalBytes: Buffer;
  title: string;
  type: DocumentType;
  sourceFileName: string;
}

export interface PublishResult {
  metadata: DocumentMetadata;
}

export interface StoredDocument {
  metadata: DocumentMetadata;
  html: string;
}

export interface DocumentBackend {
  publish(input: PublishInput): Promise<PublishResult>;
  listDocuments(): Promise<DocumentMetadata[]>;
  getDocument(id: string): Promise<StoredDocument | null>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const externalAttributePattern =
  /\b(?:src|href|poster|action|formaction|srcset|xlink:href)\s*=\s*(?:"[^"]*(?:https?:|\/\/)|'[^']*(?:https?:|\/\/)|[^\s>]*(?:https?:|\/\/))/i;

export function validateHtml(html: string): ValidationResult {
  const errors: string[] = [];
  const lower = html.toLowerCase();

  if (!lower.includes("<html") && !lower.includes("<!doctype html")) {
    errors.push("HTML must contain <html or <!doctype html");
  }

  if (/<script\b/i.test(html)) {
    errors.push("HTML must not contain <script> tags");
  }

  if (/\son[a-z][a-z0-9_-]*\s*=/i.test(html)) {
    errors.push("HTML must not contain inline event handlers");
  }

  if (externalAttributePattern.test(html)) {
    errors.push("HTML must not reference external asset URLs");
  }

  return { ok: errors.length === 0, errors };
}

export function assertDocumentMetadata(value: unknown): asserts value is DocumentMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("metadata must be an object");
  }

  const metadata = value as Record<string, unknown>;
  for (const key of ["id", "title", "type", "createdAt", "sourceFileName"]) {
    if (typeof metadata[key] !== "string" || metadata[key] === "") {
      throw new Error(`metadata.${key} must be a non-empty string`);
    }
  }
}

export function isSafeDocumentId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
