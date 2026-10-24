import { randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import { parseReceipt } from "./sync-ledger";
import { assertExactKeys, canonicalKey, inventoryDigest, MANIFEST_DOMAIN, parseArray, parseBoolean, parseChoice, parseCompleteInventory, parseDigest, parseInteger,
  parseObject, parseOriginState, parseSafeId, parseString, parseUuid, sha256, SYNC_LIMITS, type CompleteInventory, type OriginState, type SyncRoute } from "./sync-model";
import { type ApplyResult, type Holding, type InventoryReadiness } from "./sync-store";

export const WIRE_LIMITS = Object.freeze({ headers: 16 * 1024, url: 2048, identity: 4096, offer: 66 * 1024, readiness: 2 * 1024 * 1024,
  page: 16 * 1024 * 1024, holdings: 32 * 1024 * 1024, sessions: 8, cachedBytes: 128 * 1024 * 1024, transfers: 16, concurrent: 16, bodyTransfers: 4 });
export const BINDING_HEADER = "x-html-inbox-sync";

export interface RequestBinding {
  protocolVersion: 1;
  routeId: string;
  revision: number;
  callerPeerId: string;
  targetPeerId: string;
  sourceInboxId: string;
  destinationInboxId: string;
  callerStorageIncarnation: string;
}

export interface IdentityResponse {
  sessionId: string;
  requestNonce: string;
  challengeNonce: string;
  peerId: string;
  inboxId: string;
  storageIncarnation: string;
  scopeDigest: string;
  expiresAt: number;
}

export interface ManifestPage {
  evidence: CompleteInventory;
  pageNumber: number;
  descriptors: OriginState[];
  nextCursor: string | null;
}

export type OfferResponse = Exclude<ApplyResult, { status: "needs-body" }> | { status: "needs-body"; transferId: string; expiresAt: number };
export type ManifestRequest = { op: "pull"; sessionId: string; cursor: string | null } | { op: "push"; sessionId: string; page: ManifestPage } |
  { op: "ready"; sessionId: string; ready: InventoryReadiness } | { op: "complete"; sessionId: string };

export class SyncProtocolError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "SyncProtocolError";
  }
}

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseToken(value: unknown): string {
  const token = parseString(value, "opaque token", 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token) {
    throw new SyncProtocolError(403, "unauthorized");
  }

  return token;
}

export function credentialsMatch(received: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(received), "hex"), Buffer.from(sha256(expected), "hex"));
}

export function parseBinding(encoded: unknown): RequestBinding {
  const text = parseString(encoded, "request binding", 2048);
  const record = parseObject(decodeJson(Buffer.from(text, "base64url")), "request binding");
  assertExactKeys(record, ["protocolVersion", "routeId", "revision", "callerPeerId", "targetPeerId", "sourceInboxId", "destinationInboxId", "callerStorageIncarnation"]);
  if (record.protocolVersion !== 1) {
    throw new SyncProtocolError(403, "unauthorized");
  }

  return { protocolVersion: 1, routeId: parseUuid(record.routeId), revision: parseInteger(record.revision, 1), callerPeerId: parseUuid(record.callerPeerId),
    targetPeerId: parseUuid(record.targetPeerId), sourceInboxId: parseUuid(record.sourceInboxId), destinationInboxId: parseUuid(record.destinationInboxId),
    callerStorageIncarnation: parseUuid(record.callerStorageIncarnation) };
}

export function scopeDigest(route: SyncRoute): string {
  return sha256(JSON.stringify(route.allowedOrigins.map((grant) => [grant.inboxId, grant.historyEpoch, grant.publicKey, grant.completeHistory, grant.redistribute])
    .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1)));
}

export function createEvidence(route: SyncRoute, peerId: string, nonce: string, cut: { generation: number; states: OriginState[] }): CompleteInventory {
  return { protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId, routeId: route.id, revision: route.revision,
    scope: route.allowedOrigins.map((grant) => ({ inboxId: grant.inboxId, historyEpoch: grant.historyEpoch })),
    generation: cut.generation, count: cut.states.length, descriptorDigest: inventoryDigest(cut.states), nonce };
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function parseIdentityRequest(value: unknown): { nonce: string } {
  const record = parseObject(value, "identity challenge");
  assertExactKeys(record, ["nonce"]);
  return { nonce: parseToken(record.nonce) };
}

export function parseIdentityResponse(value: unknown): IdentityResponse {
  const record = parseObject(value, "identity response");
  assertExactKeys(record, ["sessionId", "requestNonce", "challengeNonce", "peerId", "inboxId", "storageIncarnation", "scopeDigest", "expiresAt"]);
  return { sessionId: parseToken(record.sessionId), requestNonce: parseToken(record.requestNonce), challengeNonce: parseToken(record.challengeNonce), peerId: parseUuid(record.peerId),
    inboxId: parseUuid(record.inboxId), storageIncarnation: parseUuid(record.storageIncarnation), scopeDigest: parseDigest(record.scopeDigest), expiresAt: parseInteger(record.expiresAt) };
}

export function parseReadiness(value: unknown): InventoryReadiness {
  const record = parseObject(value, "terminal readiness");
  assertExactKeys(record, ["kind", "evidence", "ackNonce", "receiverPeerId", "destinationInboxId", "storageIncarnation"]);
  return { kind: parseChoice(record.kind, ["terminal-inventory-ready"]), evidence: parseCompleteInventory(record.evidence), ackNonce: parseToken(record.ackNonce),
    receiverPeerId: parseUuid(record.receiverPeerId), destinationInboxId: parseUuid(record.destinationInboxId), storageIncarnation: parseUuid(record.storageIncarnation) };
}

export function parseManifestPage(value: unknown): ManifestPage {
  const record = parseObject(value, "manifest page");
  assertExactKeys(record, ["evidence", "pageNumber", "descriptors", "nextCursor"]);
  return { evidence: parseCompleteInventory(record.evidence), pageNumber: parseInteger(record.pageNumber, 0, Math.ceil(SYNC_LIMITS.records / SYNC_LIMITS.manifestPage)),
    descriptors: parseArray(record.descriptors, parseOriginState, SYNC_LIMITS.manifestPage), nextCursor: record.nextCursor === null ? null : parseToken(record.nextCursor) };
}

export function parseManifestRequest(value: unknown): ManifestRequest {
  const record = parseObject(value, "manifest request");
  const sessionId = parseToken(record.sessionId);
  if (record.op === "complete") {
    assertExactKeys(record, ["op", "sessionId"]);
    return { op: "complete", sessionId };
  }

  if (record.op === "pull") {
    assertExactKeys(record, ["op", "sessionId", "cursor"]);
    return { op: "pull", sessionId, cursor: record.cursor === null ? null : parseToken(record.cursor) };
  }

  if (record.op === "push") {
    assertExactKeys(record, ["op", "sessionId", "page"]);
    return { op: "push", sessionId, page: parseManifestPage(record.page) };
  }

  assertExactKeys(record, ["op", "sessionId", "ready"]);
  return { op: parseChoice(record.op, ["ready"]), sessionId, ready: parseReadiness(record.ready) };
}

export function parseIdentities(value: unknown) {
  const record = parseObject(value, "holdings request");
  assertExactKeys(record, ["identities"]);
  const identities = parseArray(record.identities, (value) => {
    const identity = parseObject(value, "canonical identity");
    assertExactKeys(identity, ["originInboxId", "originDocumentId"]);
    return { originInboxId: parseUuid(identity.originInboxId), originDocumentId: parseSafeId(identity.originDocumentId) };
  }, SYNC_LIMITS.manifestPage);
  if (new Set(identities.map((item) => canonicalKey(item.originInboxId, item.originDocumentId))).size !== identities.length) {
    throw new Error("Duplicate holdings identities");
  }

  return identities;
}

export function parseHoldingsResponse(value: unknown): { storageIncarnation: string; holdings: Holding[] } {
  const record = parseObject(value, "holdings response");
  assertExactKeys(record, ["storageIncarnation", "holdings"]);
  return { storageIncarnation: parseUuid(record.storageIncarnation), holdings: parseArray(record.holdings, (value) => {
    const holding = parseObject(value, "holding");
    assertExactKeys(holding, ["state", "available", "suppressed", "receipts"]);
    return { state: holding.state === null ? null : parseOriginState(holding.state), available: parseBoolean(holding.available), suppressed: parseBoolean(holding.suppressed),
      receipts: parseArray(holding.receipts, parseReceipt, 1) };
  }, SYNC_LIMITS.manifestPage) };
}

export function parseOffer(value: unknown): OriginState {
  const record = parseObject(value, "offer");
  assertExactKeys(record, ["descriptor"]);
  return parseOriginState(record.descriptor);
}

export function parseOfferResponse(value: unknown): OfferResponse {
  const record = parseObject(value, "offer response");
  if (record.status === "needs-body") {
    assertExactKeys(record, ["status", "transferId", "expiresAt"]);
    return { status: "needs-body", transferId: parseToken(record.transferId), expiresAt: parseInteger(record.expiresAt) };
  }

  assertExactKeys(record, ["status", "receipt"]);
  const receipt = parseReceipt(record.receipt);
  const status = parseChoice(record.status, ["committed", "deleted", "suppressed", "superseded"]);
  if (receipt.disposition !== status) {
    throw new Error("Receipt disposition conflict");
  }

  return { status, receipt };
}

export function validatePageProgress(page: ManifestPage, previous: OriginState[], expectedPage: number, evidence?: CompleteInventory): void {
  if (page.pageNumber !== expectedPage || evidence && JSON.stringify(evidence) !== JSON.stringify(page.evidence) ||
      previous.length + page.descriptors.length > SYNC_LIMITS.records || page.nextCursor !== null && page.descriptors.length !== SYNC_LIMITS.manifestPage) {
    throw new SyncProtocolError(409, "incomplete-history");
  }

  let last = previous.at(-1);
  for (const state of page.descriptors) {
    if (last && canonicalKey(last.originInboxId, last.originDocumentId) >= canonicalKey(state.originInboxId, state.originDocumentId)) {
      throw new SyncProtocolError(409, "unordered-history");
    }

    last = state;
  }
}
