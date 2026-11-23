import type { SyncLedger } from "./sync-ledger";
import { isHistoryWait } from "./sync-failure";

/** Scheduling hints only. Every pass still reads and validates current authority. */
export function nextWorkerRetryAt(ledger: SyncLedger): number {
  let next = Infinity;
  for (const route of Object.values(ledger.routes)) {
    const retry = ledger.routeRetries[route.id];
    if (route.state !== "active" && route.state !== "reconnecting" || retry?.blocked) {
      continue;
    }

    if (!retry) {
      next = 0;
    } else if (retry.nextAttemptAt) {
      next = Math.min(next, retry.nextAttemptAt);
    }

    for (const entry of Object.values(ledger.outbox)) {
      if (entry.routeId !== route.id || entry.revision !== route.revision || entry.disposition !== "pending") {
        continue;
      }

      // Terminal work can bypass only a history wait, never transport backoff.
      const canBypass = retry && isHistoryWait(retry.lastError) && ledger.records[entry.canonicalKey]?.state === "deleted";
      next = Math.min(next, canBypass ? entry.nextAttemptAt : Math.max(entry.nextAttemptAt, retry?.nextAttemptAt ?? 0));
    }
  }

  return next;
}
