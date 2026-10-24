import { assertExactKeys, IncompleteSyncHistoryError, parseObject, SYNC_HISTORY_UNAVAILABLE } from "./sync-model";
import { SyncProtocolError } from "./sync-wire";

export type SyncFailureKind = "history" | "retry" | "blocked";
export interface SyncFailure { kind: SyncFailureKind; code: string }

const blockedRouteCodes = new Set(["tls-verification-failed", "unauthorized", "peer-identity-conflict", "origin-scope-conflict", "local-validation-or-storage-failed"]);

// Only these authenticated wire failures carry scheduling meaning. Status is part
// of the code's meaning; an authorization failure can never claim a history wait.
const remoteFailures = new Map([
  [SYNC_HISTORY_UNAVAILABLE, 409], ["unauthorized", 403], ["session-expired", 410], ["transfer-expired", 410],
  ["session-capacity", 503], ["request-capacity", 503], ["transfer-capacity", 503], ["storage-unavailable", 503], ["body-unavailable", 503],
  ["session-quota", 413], ["transfer-quota", 413], ["inventory-limit", 413], ["resource-limit", 413], ["envelope-limit", 413],
  ["state-or-envelope-conflict", 409], ["invalid-envelope", 409], ["invalid-bytes", 409], ["content-length-required", 409],
  ["truncated-envelope", 409], ["compression-or-transfer-encoding-rejected", 409], ["invalid-cursor", 409], ["challenge-conflict", 409],
  ["invalid-history-transition", 409], ["body-length-conflict", 409], ["incomplete-history", 409], ["unordered-history", 409],
]);

export function parseRemoteFailure(value: unknown, status: number): SyncProtocolError {
  const record = parseObject(value, "protocol error");
  assertExactKeys(record, ["error"]);
  if (typeof record.error !== "string" || remoteFailures.get(record.error) !== status) {
    throw new Error("Unrecognized protocol error or status binding");
  }

  return new SyncProtocolError(status, record.error);
}

export function classifySyncFailure(error: unknown): SyncFailure {
  if (error instanceof IncompleteSyncHistoryError || error instanceof SyncProtocolError && error.status === 409 && error.code === SYNC_HISTORY_UNAVAILABLE) {
    return { kind: "history", code: SYNC_HISTORY_UNAVAILABLE };
  }

  if (!(error instanceof SyncProtocolError)) {
    return { kind: "blocked", code: "local-validation-or-storage-failed" };
  }

  return { kind: [400, 401, 403, 404, 409, 413, 426].includes(error.status) ? "blocked" : "retry", code: error.code };
}

export function isHistoryWait(code: string | null): boolean {
  return code === SYNC_HISTORY_UNAVAILABLE;
}

export function isBlockedRouteFailure(code: string | null): boolean {
  return code !== null && blockedRouteCodes.has(code);
}
