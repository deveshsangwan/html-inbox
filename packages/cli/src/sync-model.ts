import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { isSafeDocumentId, parseDocumentMetadata, type OriginalDocumentMetadata } from "./documents";
import { assertUuidV4, isRecord } from "./validation";

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_LIMITS = Object.freeze({ records: 10_000, ledgerBytes: 64 * 1024 * 1024, htmlBytes: 10 * 1024 * 1024, descriptorBytes: 64 * 1024, manifestPage: 128, manifestLeaseMs: 60_000 });
export const SYNC_DEFAULTS = Object.freeze({ lockDeadlineMs: 10_000, foregroundMs: 30_000, attemptMs: 5_000, reconcileMs: 30_000, retryMinMs: 1_000, retryMaxMs: 300_000, maxAttempts: 20 });
export const SYNC_HISTORY_UNAVAILABLE = "trusted-history-unavailable";

export class IncompleteSyncHistoryError extends Error {
  readonly code = SYNC_HISTORY_UNAVAILABLE;
}

export const STATE_DOMAIN = "html-inbox/sync/v1/origin-state";
export const MANIFEST_DOMAIN = "html-inbox/sync/v1/complete-manifest";

export interface OriginState {
  originInboxId: string;
  originDocumentId: string;
  historyEpoch: string;
  version: number;
  state: "live" | "deleted";
  metadata: OriginalDocumentMetadata;
  sha256: string;
  byteLength: number;
  metadataSha256: string;
  signature: string;
}

export interface OriginGrant {
  inboxId: string;
  historyEpoch: string;
  publicKey: string;
  completeHistory: boolean;
  redistribute: boolean;
}

export interface SyncRoute {
  id: string;
  revision: number;
  direction: "inbound" | "outbound";
  peerId: string;
  peerUrl: string;
  sourceInboxId: string;
  destinationInboxId: string;
  localInboxName: string;
  readerAudience: string;
  allowedOrigins: OriginGrant[];
  credentialRef: string;
  tlsTrustRef: string;
  state: "active" | "reconnecting" | "detached" | "blocked";
  lastError: string | null;
}

export interface RouteAuthorization {
  routeId: string;
  revision: number;
  peerId: string;
  sourceInboxId: string;
  destinationInboxId: string;
}

export interface CompleteInventory {
  protocolVersion: 1;
  domain: typeof MANIFEST_DOMAIN;
  peerId: string;
  routeId: string;
  revision: number;
  scope: { inboxId: string; historyEpoch: string }[];
  generation: number;
  count: number;
  descriptorDigest: string;
  nonce: string;
}

export function canonicalKey(inboxId: string, documentId: string): string {
  return JSON.stringify([inboxId, documentId]);
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function metadataProjection(metadata: OriginalDocumentMetadata): OriginalDocumentMetadata {
  return { schemaVersion: 1, id: metadata.id, title: metadata.title, type: metadata.type, createdAt: metadata.createdAt, sourceFileName: metadata.sourceFileName };
}

export function metadataEncoding(metadata: OriginalDocumentMetadata): string {
  return JSON.stringify([metadata.schemaVersion, metadata.id, metadata.title, metadata.type, metadata.createdAt, metadata.sourceFileName]);
}

export function stateEncoding(state: Omit<OriginState, "signature">): Buffer {
  return Buffer.from(JSON.stringify([STATE_DOMAIN, SYNC_PROTOCOL_VERSION, state.originInboxId, state.originDocumentId, state.historyEpoch, state.version, state.state,
    [state.metadata.schemaVersion, state.metadata.id, state.metadata.title, state.metadata.type, state.metadata.createdAt, state.metadata.sourceFileName],
    state.sha256, state.byteLength, state.metadataSha256]), "utf8");
}

export function signOriginState(state: Omit<OriginState, "signature">, privateKey: string): OriginState {
  return { ...state, signature: sign(null, stateEncoding(state), privateKey).toString("base64url") };
}

export function verifyOriginState(state: OriginState, publicKey: string): void {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, stateEncoding(state), key, Buffer.from(state.signature, "base64url"))) {
    throw new Error("Origin signature verification failed");
  }
}

export function stateFingerprint(state: OriginState): string {
  return sha256(stateEncoding(state));
}

export function sameImmutableDescriptor(left: OriginState, right: OriginState): boolean {
  return left.historyEpoch === right.historyEpoch && left.sha256 === right.sha256 && left.byteLength === right.byteLength &&
    left.metadataSha256 === right.metadataSha256 && metadataEncoding(left.metadata) === metadataEncoding(right.metadata);
}

export function parseOriginState(value: unknown): OriginState {
  const record = parseObject(value, "origin state");
  assertExactKeys(record, ["originInboxId", "originDocumentId", "historyEpoch", "version", "state", "metadata", "sha256", "byteLength", "metadataSha256", "signature"]);
  if (Buffer.byteLength(JSON.stringify(record)) > SYNC_LIMITS.descriptorBytes) {
    throw new Error("Origin descriptor exceeds 64 KiB");
  }

  const metadata = parseOriginalMetadata(record.metadata);
  const originDocumentId = parseSafeId(record.originDocumentId);
  const metadataSha256 = parseDigest(record.metadataSha256);
  if (metadata.id !== originDocumentId || sha256(metadataEncoding(metadata)) !== metadataSha256) {
    throw new Error("Origin metadata identity or fingerprint conflict");
  }

  const signature = parseString(record.signature, "signature", 86);
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, "base64url").toString("base64url") !== signature) {
    throw new Error("Invalid Ed25519 signature encoding");
  }

  return { originInboxId: parseUuid(record.originInboxId), originDocumentId, historyEpoch: parseUuid(record.historyEpoch), version: parseInteger(record.version, 1),
    state: parseChoice(record.state, ["live", "deleted"]), metadata, sha256: parseDigest(record.sha256), byteLength: parseInteger(record.byteLength, 0, SYNC_LIMITS.htmlBytes), metadataSha256, signature };
}

export function parseOriginalMetadata(value: unknown): OriginalDocumentMetadata {
  const record = parseObject(value, "original metadata");
  assertExactKeys(record, ["schemaVersion", "id", "title", "type", "createdAt", "sourceFileName"]);
  if (record.schemaVersion !== 1) {
    throw new Error("Original metadata requires schemaVersion 1");
  }

  return metadataProjection(parseDocumentMetadata(record));
}

export function parseOriginGrant(value: unknown): OriginGrant {
  const record = parseObject(value, "origin grant");
  assertExactKeys(record, ["inboxId", "historyEpoch", "publicKey", "completeHistory", "redistribute"]);
  const publicKey = parseString(record.publicKey, "origin public key", 1024);
  if (createPublicKey(publicKey).asymmetricKeyType !== "ed25519") {
    throw new Error("Origin key must be Ed25519");
  }

  return { inboxId: parseUuid(record.inboxId), historyEpoch: parseUuid(record.historyEpoch), publicKey,
    completeHistory: parseBoolean(record.completeHistory), redistribute: parseBoolean(record.redistribute) };
}

export function parseRoute(value: unknown): SyncRoute {
  const record = parseObject(value, "route");
  assertExactKeys(record, ["id", "revision", "direction", "peerId", "peerUrl", "sourceInboxId", "destinationInboxId", "localInboxName", "readerAudience", "allowedOrigins", "credentialRef", "tlsTrustRef", "state", "lastError"]);
  const peerUrl = parseString(record.peerUrl, "peer HTTPS URL", 2048);
  const url = new URL(peerUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Route peer must be an HTTPS origin without credentials or paths");
  }

  const allowedOrigins = parseArray(record.allowedOrigins, parseOriginGrant, SYNC_LIMITS.records);
  if (new Set(allowedOrigins.map((grant) => grant.inboxId)).size !== allowedOrigins.length) {
    throw new Error("Duplicate allowed origin");
  }

  const localInboxName = parseString(record.localInboxName, "local inbox name", 63);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(localInboxName)) {
    throw new Error("Route needs a trusted local named inbox binding");
  }

  return { id: parseUuid(record.id), revision: parseInteger(record.revision, 1), direction: parseChoice(record.direction, ["inbound", "outbound"]), peerId: parseUuid(record.peerId), peerUrl,
    sourceInboxId: parseUuid(record.sourceInboxId), destinationInboxId: parseUuid(record.destinationInboxId), localInboxName,
    readerAudience: parseString(record.readerAudience, "reader audience", 1024), allowedOrigins, credentialRef: parseReference(record.credentialRef), tlsTrustRef: parseReference(record.tlsTrustRef),
    state: parseChoice(record.state, ["active", "reconnecting", "detached", "blocked"]), lastError: parseNullableString(record.lastError) };
}

export function parseAuthorization(value: unknown): RouteAuthorization {
  const record = parseObject(value, "route authorization");
  assertExactKeys(record, ["routeId", "revision", "peerId", "sourceInboxId", "destinationInboxId"]);
  return { routeId: parseUuid(record.routeId), revision: parseInteger(record.revision, 1), peerId: parseUuid(record.peerId),
    sourceInboxId: parseUuid(record.sourceInboxId), destinationInboxId: parseUuid(record.destinationInboxId) };
}

export function parseCompleteInventory(value: unknown): CompleteInventory {
  const record = parseObject(value, "complete inventory evidence");
  assertExactKeys(record, ["protocolVersion", "domain", "peerId", "routeId", "revision", "scope", "generation", "count", "descriptorDigest", "nonce"]);
  if (record.protocolVersion !== SYNC_PROTOCOL_VERSION || record.domain !== MANIFEST_DOMAIN) {
    throw new Error("Unsupported complete inventory protocol/domain");
  }

  const scope = parseArray(record.scope, (item) => {
    const origin = parseObject(item, "inventory origin");
    assertExactKeys(origin, ["inboxId", "historyEpoch"]);
    return { inboxId: parseUuid(origin.inboxId), historyEpoch: parseUuid(origin.historyEpoch) };
  }, SYNC_LIMITS.records);
  if (new Set(scope.map((origin) => origin.inboxId)).size !== scope.length) {
    throw new Error("Duplicate inventory scope");
  }

  return { protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: parseUuid(record.peerId), routeId: parseUuid(record.routeId), revision: parseInteger(record.revision, 1), scope,
    generation: parseInteger(record.generation, 0), count: parseInteger(record.count, 0, SYNC_LIMITS.records), descriptorDigest: parseDigest(record.descriptorDigest), nonce: parseReference(record.nonce) };
}

export function inventoryDigest(states: OriginState[]): string {
  return sha256(JSON.stringify([...states].sort((a, b) => compareCanonicalKeys(canonicalKey(a.originInboxId, a.originDocumentId), canonicalKey(b.originInboxId, b.originDocumentId)))
    .map((state) => [canonicalKey(state.originInboxId, state.originDocumentId), stateFingerprint(state)])));
}

export function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}`);
  }

  return value;
}

export function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Unsupported or missing schema fields");
  }
}

export function parseString(value: unknown, label = "string", maximum = 4096): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }

  return value;
}

export function parseUuid(value: unknown): string {
  const result = parseString(value, "UUID", 36);
  assertUuidV4(result, "Sync identity");
  if (result !== result.toLowerCase()) {
    throw new Error("Sync UUIDs must use canonical lowercase encoding");
  }

  return result;
}

export function parseSafeId(value: unknown): string {
  const result = parseString(value, "document ID", 255);
  if (!isSafeDocumentId(result)) {
    throw new Error("Invalid origin document ID");
  }

  return result;
}

export function parseDigest(value: unknown): string {
  const result = parseString(value, "SHA256", 64);
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new Error("Invalid SHA256 encoding");
  }

  return result;
}

export function parseReference(value: unknown): string {
  const result = parseString(value, "opaque reference", 255);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) {
    throw new Error("Invalid opaque reference");
  }

  return result;
}

export function parseInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("Invalid bounded integer");
  }

  return value;
}

export function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid boolean");
  }

  return value;
}

export function parseNullableString(value: unknown): string | null {
  return value === null ? null : parseString(value, "error text", 2048);
}

export function parseChoice<T extends string>(value: unknown, values: readonly T[]): T {
  for (const allowed of values) {
    if (value === allowed) {
      return allowed;
    }
  }

  throw new Error("Unsupported enum value");
}

export function parseArray<T>(value: unknown, parse: (item: unknown) => T, maximum: number = SYNC_LIMITS.records): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("Invalid bounded array");
  }

  return value.map((item: unknown) => parse(item));
}

function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
