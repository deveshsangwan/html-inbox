export type DocumentType = "report" | "note" | "dashboard" | "other" | (string & {});

export const DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_DOCUMENT_TITLE_LENGTH = 200;
export const MAX_DOCUMENT_TYPE_LENGTH = 64;
export const MAX_SOURCE_FILE_NAME_LENGTH = 255;

export interface DocumentMetadata {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  id: string;
  title: string;
  type: DocumentType;
  createdAt: string;
  sourceFileName: string;
}

export interface PublishInput {
  originalBytes: Buffer;
  title: string;
  type: DocumentType;
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
  html: string;
  originalBytes: Buffer;
}

export interface DocumentBackend {
  publish(input: PublishInput): Promise<PublishResult>;
  listDocuments(): Promise<DocumentMetadata[]>;
  getDocument(id: string): Promise<StoredDocument | null>;
  deleteDocument(id: string): Promise<DeleteResult | null>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export const DOCUMENT_SCRIPT_CSP_SOURCES = [
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/",
] as const;

const externalAttributePattern =
  /\b(src|href|poster|action|formaction|srcset|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
const scriptBodyPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const externalUrlPattern = /(?:https?:)?\/\/[^\s"'`<>)]+/gi;
const allowedExternalScriptUrls = [
  /^https:\/\/cdn\.tailwindcss\.com\/?(?:\?plugins=(?:forms|typography|aspect-ratio|line-clamp)(?:,(?:forms|typography|aspect-ratio|line-clamp))*)?$/,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@4$/,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\/dist\/mermaid\.esm\.min\.mjs$/,
];

export function validateHtml(html: string): ValidationResult {
  const errors: string[] = [];
  const lower = html.toLowerCase();

  if (!lower.includes("<html") && !lower.includes("<!doctype html")) {
    errors.push("HTML must contain <html or <!doctype html");
  }

  if (/\son[a-z][a-z0-9_-]*\s*=/i.test(html)) {
    errors.push("HTML must not contain inline event handlers");
  }

  for (const match of html.matchAll(externalAttributePattern)) {
    const attribute = match[1] ?? "";
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (
      attribute.toLowerCase() === "href" &&
      isInsideOpenTag(html, match.index ?? -1, "a")
    ) {
      if (!isAllowedAnchorHref(value)) {
        errors.push("HTML links must use HTTPS, relative, or fragment URLs");
        break;
      }
      continue;
    }
    const externalUrls = findExternalUrls(value);
    const allowedScriptSource =
      attribute.toLowerCase() === "src" &&
      isInsideOpenTag(html, match.index ?? -1, "script") &&
      externalUrls.length === 1 &&
      externalUrls[0] === value.trim() &&
      isAllowedExternalScriptUrl(externalUrls[0]);
    if (externalUrls.length > 0 && !allowedScriptSource) {
      errors.push("HTML must not reference non-allowlisted external asset URLs");
      break;
    }
  }

  for (const match of html.matchAll(scriptBodyPattern)) {
    if (containsDisallowedExternalUrl(match[1] ?? "")) {
      errors.push("HTML scripts must not reference non-allowlisted external URLs");
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

function containsDisallowedExternalUrl(value: string): boolean {
  return findExternalUrls(value).some((url) => !isAllowedExternalScriptUrl(url));
}

function findExternalUrls(value: string): string[] {
  return Array.from(value.matchAll(externalUrlPattern), ([url]) => url);
}

function isAllowedExternalScriptUrl(url: string): boolean {
  return allowedExternalScriptUrls.some((pattern) => pattern.test(url));
}

function isAllowedAnchorHref(value: string): boolean {
  const href = value.trim();
  if (href.startsWith("//")) {
    return false;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return true;
  }
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

function isInsideOpenTag(html: string, attributeIndex: number, tagName: string): boolean {
  const open = html.lastIndexOf("<", attributeIndex);
  const close = html.lastIndexOf(">", attributeIndex);
  return open > close && new RegExp(`^<${tagName}\\b`, "i").test(html.slice(open, attributeIndex));
}

export function assertDocumentMetadata(value: unknown): asserts value is DocumentMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("metadata must be an object");
  }

  const metadata = value as Record<string, unknown>;
  if (metadata.schemaVersion === undefined) {
    metadata.schemaVersion = DOCUMENT_SCHEMA_VERSION;
  }
  if (metadata.schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    throw new Error(`unsupported metadata schema version: ${String(metadata.schemaVersion)}`);
  }
  for (const key of ["id", "title", "type", "createdAt", "sourceFileName"]) {
    if (typeof metadata[key] !== "string" || metadata[key] === "") {
      throw new Error(`metadata.${key} must be a non-empty string`);
    }
  }

  if (!isSafeDocumentId(metadata.id as string)) {
    throw new Error("metadata.id contains unsupported characters");
  }
  assertMetadataLength("title", metadata.title as string, MAX_DOCUMENT_TITLE_LENGTH);
  assertMetadataLength("type", metadata.type as string, MAX_DOCUMENT_TYPE_LENGTH);
  assertMetadataLength(
    "sourceFileName",
    metadata.sourceFileName as string,
    MAX_SOURCE_FILE_NAME_LENGTH,
  );
  if (Number.isNaN(Date.parse(metadata.createdAt as string))) {
    throw new Error("metadata.createdAt must be a valid date");
  }
}

export function validatePublishMetadata(input: {
  title: string;
  type: string;
  sourceFileName: string;
}): ValidationResult {
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
