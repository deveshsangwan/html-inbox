import { type ManagedRecord, type OutboxEntry, type RouteRetryState, type SyncLedger, outboxKey } from "./sync-ledger";
import { type OriginState, type SyncRoute, stateFingerprint, SYNC_DEFAULTS } from "./sync-model";
import { isHistoryWait } from "./sync-failure";

export function routeOriginGrant(route: SyncRoute, inboxId: string, historyEpoch?: string) {
  return route.allowedOrigins.find((grant) => grant.inboxId === inboxId && (historyEpoch === undefined || grant.historyEpoch === historyEpoch) &&
    (inboxId === route.sourceInboxId || grant.redistribute));
}

export function pinnedOriginGrant(ledger: SyncLedger, route: SyncRoute, inboxId: string, historyEpoch?: string) {
  const grant = routeOriginGrant(route, inboxId, historyEpoch);
  const pinned = ledger.originKeys.find((key) => key.inboxId === inboxId);
  return grant && pinned?.historyEpoch === grant.historyEpoch && pinned.publicKey === grant.publicKey ? grant : undefined;
}

export function pinnedStateGrant(ledger: SyncLedger, route: SyncRoute, state: OriginState) {
  return pinnedOriginGrant(ledger, route, state.originInboxId, state.historyEpoch);
}

export function currentCustodyReceipt(ledger: SyncLedger, route: SyncRoute, record: ManagedRecord, entry?: OutboxEntry) {
  return Object.values(ledger.receipts).find((receipt) => receipt.routeId === route.id && receipt.revision === route.revision &&
    receipt.originState.originInboxId === record.originInboxId && receipt.originState.originDocumentId === record.originDocumentId &&
    receipt.fingerprint === stateFingerprint(record) && (entry
      ? entry.disposition === "confirmed" && receipt.storageIncarnation === entry.receiverStorageIncarnation && receipt.disposition === entry.receiptDisposition
      : receipt.receiverInboxId === ledger.inboxId && receipt.storageIncarnation === ledger.storageIncarnation));
}

export function hasTrustedOriginHistory(ledger: SyncLedger, inboxId: string, historyEpoch: string): boolean {
  return Object.values(ledger.routes).some((source) => source.direction === "inbound" && source.state === "active" &&
    ledger.historyCheckpoints[outboxKey(source.id, source.revision, "inventory")]?.scope.some((scope) => scope.inboxId === inboxId && scope.historyEpoch === historyEpoch));
}

export function canForwardRecord(ledger: SyncLedger, route: SyncRoute, record: ManagedRecord, complete = false): boolean {
  if (!pinnedStateGrant(ledger, route, record) || (route.state !== "active" && !(route.state === "reconnecting" && (complete || record.state === "deleted"))) ||
      route.direction !== "outbound") {
    return false;
  }

  if (record.originInboxId === ledger.inboxId) {
    return true;
  }

  if (record.state === "deleted") {
    return !complete || hasTrustedOriginHistory(ledger, record.originInboxId, record.historyEpoch);
  }

  if (!hasTrustedOriginHistory(ledger, record.originInboxId, record.historyEpoch)) {
    return false;
  }

  return record.contributions.some((contribution) => {
    const source = ledger.routes[contribution.routeId];
    const checkpoint = source ? ledger.historyCheckpoints[outboxKey(source.id, source.revision, "inventory")] : undefined;
    return contribution.state === "attached" && source?.state === "active" && !!checkpoint?.scope.some((scope) => scope.inboxId === record.originInboxId && scope.historyEpoch === record.historyEpoch);
  });
}

export function detachLedgerRoute(ledger: SyncLedger, routeId: string): void {
  for (const record of Object.values(ledger.records)) {
    for (const contribution of record.contributions) {
      if (contribution.routeId === routeId) {
        contribution.state = "detached";
      }
    }
  }

  for (const entry of Object.values(ledger.outbox)) {
    if (entry.routeId === routeId) {
      entry.disposition = "retired";
    }
  }
}

/** All dependent authorization is retired in the same ledger transition. */
export function fenceLedgerRoute(ledger: SyncLedger, route: SyncRoute, state: "blocked" | "detached", error: string | null): void {
  detachLedgerRoute(ledger, route.id);
  route.revision += 1;
  route.state = state;
  route.lastError = error;
  delete ledger.routeRetries[route.id];
}

export function nextRouteRetry(route: SyncRoute, previous: RouteRetryState | undefined, error: string | null, blocked: boolean,
  now: number, intervalMs: number, random: number): RouteRetryState {
  if (isHistoryWait(error)) {
    return { revision: route.revision, attempts: 0, nextAttemptAt: now + intervalMs, lastError: error, blocked: false };
  }

  const attempts = error === null ? 0 : (previous?.attempts ?? 0) + 1;
  return { revision: route.revision, attempts, nextAttemptAt: error === null ? 0 : now + Math.round(Math.min(SYNC_DEFAULTS.retryMaxMs,
    SYNC_DEFAULTS.retryMinMs * 2 ** Math.min(attempts - 1, 30)) * (0.5 + random * 0.5)), lastError: error,
    blocked: error !== null && (blocked || attempts >= SYNC_DEFAULTS.maxAttempts) };
}

export function isRouteDue(ledger: SyncLedger, route: SyncRoute, now: number): boolean {
  const retry = ledger.routeRetries[route.id];
  if (retry?.blocked) {
    return false;
  }

  if (!retry || retry.nextAttemptAt <= now) {
    return true;
  }

  if (!isHistoryWait(retry.lastError)) {
    return false;
  }

  return Object.values(ledger.outbox).some((entry) => entry.routeId === route.id && entry.revision === route.revision && entry.disposition === "pending" &&
    entry.nextAttemptAt <= now && ledger.records[entry.canonicalKey]?.state === "deleted");
}

export function queueLedgerState(ledger: SyncLedger, key: string, routeId?: string, force = false): void {
  const record = ledger.records[key];
  for (const route of Object.values(ledger.routes)) {
    if (routeId && route.id !== routeId) {
      continue;
    }

    const entryKey = outboxKey(route.id, route.revision, key);
    const existing = ledger.outbox[entryKey];
    const allowed = route.direction === "outbound" && (route.state === "active" || route.state === "reconnecting") && !!pinnedStateGrant(ledger, route, record);
    if (!allowed) {
      if (existing) {
        existing.disposition = "retired";
      }

      continue;
    }

    const fingerprint = stateFingerprint(record);
    const canForward = canForwardRecord(ledger, route, record);
    const waitingForHistory = existing?.lastError === "Trusted terminal history is required";
    if (existing?.fingerprint === fingerprint && !(waitingForHistory && canForward)) {
      if (force && existing.disposition === "confirmed") {
        existing.disposition = canForward ? "pending" : "blocked";
      }

      if (!canForward && existing.disposition !== "confirmed") {
        existing.disposition = "blocked";
        existing.lastError = "Trusted terminal history is required";
      }

      continue;
    }

    ledger.outbox[entryKey] = { routeId: route.id, revision: route.revision, canonicalKey: key, fingerprint,
      receiverStorageIncarnation: existing?.receiverStorageIncarnation ?? null, receiptDisposition: null, attempts: 0, nextAttemptAt: 0,
      lastError: canForward ? null : "Trusted terminal history is required", disposition: canForward ? "pending" : "blocked" };
  }
}
