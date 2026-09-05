import { parse, type DefaultTreeAdapterMap } from "parse5";

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
  originalBytes: Buffer;
}

export interface DocumentBackend {
  publish(input: PublishInput): Promise<PublishResult>;
  listDocuments(): Promise<DocumentMetadata[]>;
  getDocumentMetadata(id: string): Promise<DocumentMetadata | null>;
  getDocument(id: string): Promise<StoredDocument | null>;
  deleteDocument(id: string): Promise<DeleteResult | null>;
}

/**
 * Two-tier validation result.
 *
 * `errors` block literal markup that the sandboxed frame and document CSP do
 * not contain. Allowed scripts can still recreate equivalent behavior.
 *
 * `warnings` are advisory lint: conditions the runtime already fails closed.
 * They are reported so the author can fix a document that will silently not
 * work, but they never block publishing. See docs/threat-model.md.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const DOCUMENT_SCRIPT_CSP_SOURCES = [
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/",
] as const;

const externalUrlPattern = /(?:https?:)?\/\/[^\s"'`<>)]+/gi;
const allowedExternalScriptUrls = [
  /^https:\/\/cdn\.tailwindcss\.com\/?(?:\?plugins=(?:forms|typography|aspect-ratio|line-clamp)(?:,(?:forms|typography|aspect-ratio|line-clamp))*)?$/,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@4$/,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\/dist\/mermaid\.esm\.min\.mjs$/,
];

/** Attributes whose value the browser may resolve as a URL. */
const URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "poster",
  "action",
  "formaction",
  "srcset",
  "xlink:href",
  "ping",
  "data",
]);

/** Attributes that start a navigation rather than load a subresource. */
const NAVIGATION_ATTRIBUTES = new Set(["href", "action", "formaction"]);

/**
 * Schemes that execute script or hand the user a document the author controls.
 * `script-src 'unsafe-inline'` permits `javascript:` and the sandbox does not
 * stop it, so these block publishing rather than becoming lint.
 */
const EXECUTABLE_SCHEMES = new Set(["javascript", "vbscript"]);

export function validateHtml(html: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const add = (list: string[], message: string) => {
    if (!list.includes(message)) {
      list.push(message);
    }
  };
  const lower = html.toLowerCase();

  if (!lower.includes("<html") && !lower.includes("<!doctype html")) {
    add(errors, "HTML must contain <html or <!doctype html");
  }

  for (const element of elements(parse(html))) {
    const tag = {
      name: element.tagName.toLowerCase(),
      attributes: element.attrs.map((attribute) => ({
        name: attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name,
        value: attribute.value,
      })),
    };

    if (tag.name === "script" && element.childNodes.some((node) =>
      "value" in node && containsDisallowedExternalUrl(node.value),
    )) {
      add(warnings, "HTML scripts reference non-allowlisted external URLs; the document CSP blocks fetches to them");
    }
    for (const attribute of tag.attributes) {
      if (attribute.name.startsWith("on")) {
        // Blocked at runtime by `script-src-attr 'none'`.
        add(warnings, "HTML inline event handlers are blocked by the document CSP and will not run");
        continue;
      }
      if (!URL_ATTRIBUTES.has(attribute.name)) {
        continue;
      }
      checkUrlAttribute(tag, attribute, errors, warnings, add);
    }

    if (tag.name === "meta") {
      checkMetaRefresh(tag, errors, add);
    }
    if (tag.name === "base") {
      // Blocked at runtime by `base-uri 'none'`.
      add(warnings, "HTML <base> is blocked by the document CSP and will be ignored");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function checkUrlAttribute(
  tag: HtmlTag,
  attribute: HtmlAttribute,
  errors: string[],
  warnings: string[],
  add: (list: string[], message: string) => void,
): void {
  const scheme = urlScheme(attribute.value);
  const value = attribute.value;

  if (scheme && EXECUTABLE_SCHEMES.has(scheme)) {
    add(errors, `HTML must not use ${scheme}: URLs in ${attribute.name}`);
    return;
  }

  const navigable = NAVIGATION_ATTRIBUTES.has(attribute.name) || tag.name === "iframe";
  if (scheme === "data" && navigable) {
    add(errors, `HTML must not navigate to data: URLs in ${attribute.name}`);
    return;
  }

  if ((tag.name === "a" || tag.name === "area") && attribute.name === "href") {
    checkAnchorHref(attribute, scheme, errors, add);
    return;
  }

  const cspAllowsData =
    scheme === "data" &&
    ((attribute.name === "src" && ["audio", "img", "input", "source", "video"].includes(tag.name)) ||
      (attribute.name === "srcset" && ["img", "source"].includes(tag.name)) ||
      (attribute.name === "poster" && tag.name === "video") ||
      (["href", "xlink:href"].includes(attribute.name) && tag.name === "image"));
  if (cspAllowsData) {
    return;
  }
  if (scheme === "data" || scheme === "blob") {
    add(warnings, `HTML references a ${scheme}: URL that the document CSP will block`);
    return;
  }

  // Special HTTP(S) URLs treat reverse solidus as solidus.
  const externalValue = value.replaceAll("\\", "/");
  const externalUrls = findExternalUrls(externalValue);
  if (externalUrls.length === 0) {
    return;
  }

  const allowedScriptSource =
    tag.name === "script" &&
    attribute.name === "src" &&
    externalUrls.length === 1 &&
    externalUrls[0] === externalValue.trim() &&
    isAllowedExternalScriptUrl(externalUrls[0]);
  if (allowedScriptSource) {
    return;
  }

  if (tag.name === "script" && attribute.name === "src") {
    // A non-allowlisted script source is refused by `script-src`, but a blocked
    // script is a broken document rather than a compromised one.
    add(
      warnings,
      "HTML references a non-allowlisted external script URL; the document CSP will block it",
    );
    return;
  }

  // Blocked at runtime by `default-src 'none'` plus the data:-only media
  // directives, so the reference fails closed.
  add(
    warnings,
    "HTML references non-allowlisted external asset URLs; the document CSP will block them",
  );
}

function checkAnchorHref(
  attribute: HtmlAttribute,
  scheme: string | null,
  errors: string[],
  add: (list: string[], message: string) => void,
): void {
  if (attribute.name !== "href") {
    return;
  }
  const href = stripUrlNoise(attribute.value);

  if (/^[\\/]{2}/.test(href)) {
    add(errors, "HTML links must use an explicit https: scheme rather than //");
    return;
  }
  if (!scheme || scheme === "https") {
    return;
  }
  add(errors, `HTML links must use https: rather than ${scheme}:`);
}

function checkMetaRefresh(
  tag: HtmlTag,
  errors: string[],
  add: (list: string[], message: string) => void,
): void {
  const httpEquiv = tag.attributes.find((attribute) => attribute.name === "http-equiv");
  if (!httpEquiv || httpEquiv.value.trim().toLowerCase() !== "refresh") {
    return;
  }
  // The refresh grammar allows a bare URL after the delay, and entity decoding
  // happens before this pragma is interpreted. Reject the feature rather than
  // trying to duplicate the browser's URL extraction algorithm.
  add(errors, "HTML must not use <meta http-equiv=\"refresh\">");
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

/**
 * Returns the lowercased scheme of a URL attribute value, or null when the
 * value is relative. Attribute entities have already been decoded by parse5.
 * Strip embedded URL whitespace before matching the scheme so
 * `&#106;avascript:` and `java\tscript:` both reach the browser as
 * `javascript:`.
 */
function urlScheme(value: string): string | null {
  return /^([a-z][a-z0-9+.-]*):/.exec(stripUrlNoise(value).toLowerCase())?.[1] ?? null;
}

function stripUrlNoise(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]/g, "");
}

interface HtmlAttribute {
  /** Lowercased attribute name. */
  name: string;
  value: string;
}

interface HtmlTag {
  /** Lowercased tag name. */
  name: string;
  attributes: HtmlAttribute[];
}

function* elements(root: DefaultTreeAdapterMap["node"]): Generator<DefaultTreeAdapterMap["element"]> {
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }

    if ("tagName" in node) {
      yield node;
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        pending.push(node.childNodes[index]);
      }
    }
    if ("content" in node) {
      pending.push(node.content);
    }
  }
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
  return { ok: errors.length === 0, errors, warnings: [] };
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
