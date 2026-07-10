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
    const externalUrls = findExternalUrls(value);
    const allowedScriptSource =
      attribute.toLowerCase() === "src" &&
      isInsideScriptOpenTag(html, match.index ?? -1) &&
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

function isInsideScriptOpenTag(html: string, attributeIndex: number): boolean {
  const open = html.lastIndexOf("<", attributeIndex);
  const close = html.lastIndexOf(">", attributeIndex);
  return open > close && /^<script\b/i.test(html.slice(open, attributeIndex));
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
