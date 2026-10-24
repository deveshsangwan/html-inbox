import { parseRuntimeConfig, parseSyncTarget, type SyncRuntimeConfig, type SyncTarget } from "./sync-runtime-config";
import { type OriginState, type OriginGrant, type SyncRoute, type CompleteInventory, SYNC_LIMITS, parseOriginState, parseOriginGrant, parseRoute, parseCompleteInventory, canonicalKey, stateFingerprint,
  parseObject, assertExactKeys, parseArray, parseUuid, parseSafeId, parseString, parseInteger, parseBoolean, parseChoice, parseNullableString, parseReference } from "./sync-model";

export interface Contribution {
  routeId: string;
  revision: number;
  state: "attached" | "detached";
}

export interface ManagedRecord extends OriginState {
  localId: string;
  bodyFile: string | null;
  contributions: Contribution[];
  suppressed: boolean;
  provenance: { peerId: string; routeId: string; receivedAt: string }[];
}

export interface OwnerAnchor {
  home: string;
  dev: number;
  ino: number;
}

export interface OutboxEntry {
  routeId: string;
  revision: number;
  canonicalKey: string;
  fingerprint: string;
  receiverStorageIncarnation: string | null;
  receiptDisposition?: DurableReceipt["disposition"] | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  disposition: "pending" | "confirmed" | "blocked" | "retired";
}

export interface DurableReceipt {
  schemaVersion: 1;
  receiverInboxId: string;
  storageIncarnation: string;
  destinationInboxId: string;
  routeId: string;
  revision: number;
  originState: OriginState;
  fingerprint: string;
  disposition: "committed" | "deleted" | "suppressed" | "superseded";
}

export interface RouteRetryState {
  revision: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  blocked: boolean;
}

export interface SyncLedger {
  routeRetries: Record<string, RouteRetryState>;
  schemaVersion: 1;
  runtime: { revision: number; config: SyncRuntimeConfig } | null;
  publicationIntents: Record<string, SyncTarget | null>;
  inboxId: string;
  historyEpoch: string;
  storageIncarnation: string;
  ownerAnchor: OwnerAnchor;
  generation: number;
  nextOriginVersion: number;
  originKeys: OriginGrant[];
  records: Record<string, ManagedRecord>;
  routes: Record<string, SyncRoute>;
  outbox: Record<string, OutboxEntry>;
  receipts: Record<string, DurableReceipt>;
  checkpoints: Record<string, CompleteInventory>;
  historyCheckpoints: Record<string, CompleteInventory>;
  migration: { phase: "intent" | "barrier" | "enrolling" | "forking" | "complete"; enrolledIds: string[] };
  worker: { enabled: boolean; retryPaused: boolean; ownerQuarantined: boolean; bootSupervised: boolean; lastRunAt: number | null; lastError: string | null };
}

export function outboxKey(routeId: string, revision: number, key: string): string {
  return JSON.stringify([routeId, revision, key]);
}

export function receiptKey(receipt: DurableReceipt): string {
  return JSON.stringify([receipt.routeId, receipt.revision, canonicalKey(receipt.originState.originInboxId, receipt.originState.originDocumentId), receipt.fingerprint, receipt.storageIncarnation, receipt.disposition]);
}

export function parseReceipt(value: unknown): DurableReceipt {
  const record = parseObject(value, "receipt");
  assertExactKeys(record, ["schemaVersion", "receiverInboxId", "storageIncarnation", "destinationInboxId", "routeId", "revision", "originState", "fingerprint", "disposition"]);
  if (record.schemaVersion !== 1) {
    throw new Error("Unsupported receipt schema");
  }

  const originState = parseOriginState(record.originState);
  const fingerprint = parseString(record.fingerprint, "state fingerprint", 64);
  if (fingerprint !== stateFingerprint(originState)) {
    throw new Error("Receipt state fingerprint conflict");
  }

  const disposition = parseChoice(record.disposition, ["committed", "deleted", "suppressed", "superseded"]);
  if (originState.state === "live" && disposition === "deleted" || originState.state === "deleted" && (disposition === "committed" || disposition === "suppressed")) {
    throw new Error("Receipt disposition conflicts with signed origin state");
  }

  return { schemaVersion: 1, receiverInboxId: parseUuid(record.receiverInboxId), storageIncarnation: parseUuid(record.storageIncarnation), destinationInboxId: parseUuid(record.destinationInboxId),
    routeId: parseUuid(record.routeId), revision: parseInteger(record.revision, 1), originState, fingerprint,
    disposition };
}

export function parseLedger(value: unknown): SyncLedger {
  const record = parseObject(value, "ledger");
  if (!Object.hasOwn(record, "historyCheckpoints")) {
    record.historyCheckpoints = record.checkpoints;
    record.checkpoints = {};
  }

  if (!Object.hasOwn(record, "runtime")) {
    record.runtime = null;
    record.publicationIntents = {};
  }

  if (!Object.hasOwn(record, "routeRetries")) {
    record.routeRetries = {};
  }

  const runtime = record.runtime === null ? null : parseObject(record.runtime, "runtime configuration");
  if (runtime) {
    assertExactKeys(runtime, ["revision", "config"]);
  }

  assertExactKeys(record, ["routeRetries", "runtime", "publicationIntents", "schemaVersion", "inboxId", "historyEpoch", "storageIncarnation", "ownerAnchor", "generation", "nextOriginVersion", "originKeys", "records", "routes", "outbox", "receipts", "checkpoints", "historyCheckpoints", "migration", "worker"]);
  if (record.schemaVersion !== 1) {
    throw new Error("Unsupported managed store schema version");
  }

  const anchor = parseObject(record.ownerAnchor, "owner anchor");
  assertExactKeys(anchor, ["home", "dev", "ino"]);
  const migration = parseObject(record.migration, "migration");
  assertExactKeys(migration, ["phase", "enrolledIds"]);
  const worker = parseObject(record.worker, "worker");
  assertExactKeys(worker, ["enabled", "retryPaused", "ownerQuarantined", "bootSupervised", "lastRunAt", "lastError"]);
  const ledger: SyncLedger = { schemaVersion: 1, routeRetries: dictionary(record.routeRetries, parseRouteRetry, 128), runtime: runtime ? { revision: parseInteger(runtime.revision, 1), config: parseRuntimeConfig(runtime.config) } : null,
    publicationIntents: dictionary(record.publicationIntents, (value) => value === null ? null : parseSyncTarget(value), SYNC_LIMITS.records), inboxId: parseUuid(record.inboxId), historyEpoch: parseUuid(record.historyEpoch), storageIncarnation: parseUuid(record.storageIncarnation),
    ownerAnchor: { home: parseString(anchor.home, "canonical home"), dev: parseInteger(anchor.dev), ino: parseInteger(anchor.ino) },
    generation: parseInteger(record.generation), nextOriginVersion: parseInteger(record.nextOriginVersion, 1), originKeys: parseArray(record.originKeys, parseOriginGrant),
    records: dictionary(record.records, parseManagedRecord, SYNC_LIMITS.records), routes: dictionary(record.routes, parseRoute, SYNC_LIMITS.records),
    outbox: dictionary(record.outbox, parseOutbox), receipts: dictionary(record.receipts, parseReceipt), checkpoints: dictionary(record.checkpoints, parseCompleteInventory), historyCheckpoints: dictionary(record.historyCheckpoints, parseCompleteInventory),
    migration: { phase: parseChoice(migration.phase, ["intent", "barrier", "enrolling", "forking", "complete"]), enrolledIds: parseArray(migration.enrolledIds, parseSafeId) },
    worker: { enabled: parseBoolean(worker.enabled), retryPaused: parseBoolean(worker.retryPaused), ownerQuarantined: parseBoolean(worker.ownerQuarantined),
      bootSupervised: parseBoolean(worker.bootSupervised), lastRunAt: worker.lastRunAt === null ? null : parseInteger(worker.lastRunAt), lastError: parseNullableString(worker.lastError) } };

  const localIds = new Set<string>();
  if (new Set(ledger.originKeys.map((grant) => grant.inboxId)).size !== ledger.originKeys.length) {
    throw new Error("Ledger has duplicate origin key bindings");
  }

  for (const [key, state] of Object.entries(ledger.records)) {
    if (key !== canonicalKey(state.originInboxId, state.originDocumentId) || localIds.has(state.localId)) {
      throw new Error("Ledger canonical or local identity collision");
    }

    localIds.add(state.localId);
    if (state.originInboxId === ledger.inboxId && state.historyEpoch !== ledger.historyEpoch) {
      throw new Error("Owner history epoch conflict");
    }

    if (state.originInboxId === ledger.inboxId && state.version >= ledger.nextOriginVersion && !ledger.worker.ownerQuarantined) {
      throw new Error("Owner version counter would reuse history");
    }

    for (const contribution of state.contributions) {
      const route = ledger.routes[contribution.routeId];
      if (!route || contribution.revision > route.revision || (contribution.state === "attached" &&
          (contribution.revision !== route.revision || route.state !== "active"))) {
        throw new Error("Ledger contribution refers to invalid route revision");
      }
    }
  }

  for (const key of Object.keys(ledger.publicationIntents)) {
    if (!ledger.records[key]) {
      throw new Error("Publication intent refers to missing canonical state");
    }
  }

  for (const [id, retry] of Object.entries(ledger.routeRetries)) {
    if (!ledger.routes[id] || ledger.routes[id].revision !== retry.revision) {
      throw new Error("Route retry state has an invalid revision binding");
    }
  }

  for (const [key, route] of Object.entries(ledger.routes)) {
    if (key !== route.id || (route.direction === "inbound" ? route.destinationInboxId : route.sourceInboxId) !== ledger.inboxId) {
      throw new Error("Ledger route inbox binding conflict");
    }
  }

  for (const [key, entry] of Object.entries(ledger.outbox)) {
    const route = ledger.routes[entry.routeId];
    const state = ledger.records[entry.canonicalKey];
    if (key !== outboxKey(entry.routeId, entry.revision, entry.canonicalKey) || !route || !state || entry.revision > route.revision ||
        (entry.disposition !== "retired" && (entry.revision !== route.revision || entry.fingerprint !== stateFingerprint(state)))) {
      throw new Error("Ledger outbox binding conflict");
    }
  }

  for (const [key, receipt] of Object.entries(ledger.receipts)) {
    if (key !== receiptKey(receipt) || !ledger.routes[receipt.routeId]) {
      throw new Error("Ledger receipt binding conflict");
    }
  }

  for (const [key, checkpoint] of Object.entries({ ...ledger.historyCheckpoints, ...ledger.checkpoints })) {
    if (key !== outboxKey(checkpoint.routeId, checkpoint.revision, "inventory") || !ledger.routes[checkpoint.routeId]) {
      throw new Error("Ledger checkpoint binding conflict");
    }
  }

  return ledger;
}

function parseManagedRecord(value: unknown): ManagedRecord {
  const record = parseObject(value, "managed record");
  assertExactKeys(record, ["originInboxId", "originDocumentId", "historyEpoch", "version", "state", "metadata", "sha256", "byteLength", "metadataSha256", "signature", "localId", "bodyFile", "contributions", "suppressed", "provenance"]);
  const state = parseOriginState({ originInboxId: record.originInboxId, originDocumentId: record.originDocumentId, historyEpoch: record.historyEpoch,
    version: record.version, state: record.state, metadata: record.metadata, sha256: record.sha256, byteLength: record.byteLength, metadataSha256: record.metadataSha256, signature: record.signature });
  const bodyFile = record.bodyFile === null ? null : parseString(record.bodyFile, "immutable body filename", 64);
  if (bodyFile !== null && !/^[a-f0-9-]{36}\.html$/.test(bodyFile)) {
    throw new Error("Invalid private body filename");
  }

  const contributions = parseArray(record.contributions, (value) => {
    const contribution = parseObject(value, "contribution");
    assertExactKeys(contribution, ["routeId", "revision", "state"]);
    return { routeId: parseUuid(contribution.routeId), revision: parseInteger(contribution.revision, 1), state: parseChoice(contribution.state, ["attached", "detached"]) };
  });
  if (new Set(contributions.map((item) => item.routeId)).size !== contributions.length) {
    throw new Error("Duplicate mapping contribution");
  }

  return { ...state, localId: parseSafeId(record.localId), bodyFile, contributions, suppressed: parseBoolean(record.suppressed),
    provenance: parseArray(record.provenance, (value) => {
      const provenance = parseObject(value, "provenance");
      assertExactKeys(provenance, ["peerId", "routeId", "receivedAt"]);
      const receivedAt = parseString(provenance.receivedAt);
      if (Number.isNaN(Date.parse(receivedAt))) {
        throw new Error("Invalid provenance date");
      }

      return { peerId: parseUuid(provenance.peerId), routeId: parseUuid(provenance.routeId), receivedAt };
    }) };
}

function parseRouteRetry(value: unknown): RouteRetryState {
  const record = parseObject(value, "route retry state");
  assertExactKeys(record, ["revision", "attempts", "nextAttemptAt", "lastError", "blocked"]);
  return { revision: parseInteger(record.revision, 1), attempts: parseInteger(record.attempts), nextAttemptAt: parseInteger(record.nextAttemptAt),
    lastError: parseNullableString(record.lastError), blocked: parseBoolean(record.blocked) };
}

function parseOutbox(value: unknown): OutboxEntry {
  const record = parseObject(value, "outbox entry");
  const keys = ["routeId", "revision", "canonicalKey", "fingerprint", "receiverStorageIncarnation", "attempts", "nextAttemptAt", "lastError", "disposition"];
  const receiptDisposition = Object.hasOwn(record, "receiptDisposition") ? { receiptDisposition: record.receiptDisposition === null ? null :
    parseChoice(record.receiptDisposition, ["committed", "deleted", "suppressed", "superseded"]) } : {};
  assertExactKeys(record, Object.hasOwn(record, "receiptDisposition") ? [...keys, "receiptDisposition"] : keys);
  return { ...receiptDisposition, routeId: parseUuid(record.routeId), revision: parseInteger(record.revision, 1), canonicalKey: parseString(record.canonicalKey, "canonical pair", 512),
    fingerprint: parseReference(record.fingerprint), receiverStorageIncarnation: record.receiverStorageIncarnation === null ? null : parseUuid(record.receiverStorageIncarnation),
    attempts: parseInteger(record.attempts), nextAttemptAt: parseInteger(record.nextAttemptAt), lastError: parseNullableString(record.lastError),
    disposition: parseChoice(record.disposition, ["pending", "confirmed", "blocked", "retired"]) };
}

function dictionary<T>(value: unknown, parse: (item: unknown) => T, maximum = 1_000_000): Record<string, T> {
  const record = parseObject(value, "dictionary");
  if (Object.keys(record).length > maximum) {
    throw new Error("Managed store capacity exceeded");
  }

  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, parse(item)]));
}
