import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PublishRequest } from "./publish-input";
import { loadPublishInput } from "./publish-input";
import type { ResolvedInboxSelection } from "./inbox-selection";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { ManagedSyncStore } from "./sync-store";
import { outboxKey, type DurableReceipt, type SyncLedger } from "./sync-ledger";
import { canonicalKey } from "./sync-model";
import { isBlockedRouteFailure } from "./sync-failure";
import { defaultRuntimeConfig, type SyncTarget } from "./sync-runtime-config";
import { contactWorker, ensureOwnedSyncWorker, getOwnedWorkerStatus } from "./sync-worker-client";
import { ensureViewer } from "./viewer-server";
import { getViewerPort } from "./backend";

interface DeliveryResult {
  state: "confirmed" | "pending" | "blocked" | "local-only";
  target: SyncTarget | null;
  reason: string | null;
  receipt: DurableReceipt | null;
  cancelled: boolean;
  retriesEnabled: boolean;
}

export async function publishManagedDocument(request: PublishRequest, selection: ResolvedInboxSelection) {
  const ledger = await assertManagedLifecycle(selection.home);
  if (!ledger) {
    throw new Error("Managed publication requires an enrolled inbox");
  }

  const { input, warnings } = await loadPublishInput(request);
  for (const warning of warnings) console.error(`html-inbox: ${warning}`);
  const store = new ManagedSyncStore(selection.home);
  let interrupted = false;
  const viewerController = new AbortController();
  const onInterrupt = () => { interrupted = true; viewerController.abort(); };
  process.on("SIGINT", onInterrupt);
  try {
    const publication = await store.publishWithIntent(input, request.target);
    const timings = publication.timings;
    const deadlineAt = publication.committedAt + (request.waitMs ?? timings.foregroundMs);
    const requestMs = request.requestTimeoutMs ?? timings.requestMs;
    const ticketId = randomUUID();
    let ticketSubmissionAttempted = false;
    let ticketSubmitted = false;
    let cancellationAttempted = false;
    let viewer: { url: string | null; state: "running" | "failed"; error: string | null } = { url: null, state: "failed", error: "viewer-not-ready-within-foreground-budget" };
    const viewerTimer = setTimeout(() => viewerController.abort(), Math.max(1, deadlineAt - Date.now() - 150));
    const viewerPromise = ensureViewer(selection.home, process.env.HTML_INBOX_PORT ? getViewerPort() : undefined, selection.name, { deadlineAt, signal: viewerController.signal })
      .then((ready) => { viewer = { url: `${ready.url}/documents/${publication.metadata.id}`, state: "running", error: null }; })
      .catch(() => { viewer = { url: null, state: "failed", error: "viewer-startup-failed-after-durable-save" }; }).finally(() => clearTimeout(viewerTimer));
    const finishAt = Math.max(publication.committedAt, deadlineAt - Math.min(250, Math.floor((deadlineAt - publication.committedAt) / 4)));
    let delivery: DeliveryResult;
    try {
      delivery = await inspectDelivery(finishAt);
    } catch (error) {
      if (!isForegroundDeadline(error) && !interrupted) {
        throw error;
      }

      delivery = { state: "pending", target: publication.target, reason: Date.now() >= deadlineAt ? "foreground-deadline" : "delivery-inspection-unavailable", receipt: null, cancelled: interrupted,
        retriesEnabled: ledger.worker.enabled && !ledger.worker.retryPaused };
    }
    if (publication.target && delivery.state === "pending" && ledger.worker.enabled && !ledger.worker.retryPaused && !interrupted && Date.now() < finishAt) {
      console.error(`html-inbox: Saved locally. Waiting for intended peer ${publication.target.peerId}, destination ${publication.target.destinationInboxId}.`);
      try {
        await ensureOwnedSyncWorker(selection.home, { deadlineAt: finishAt, signal: viewerController.signal });
        const routes = await matchingRoutes();
        if (routes.length && Date.now() < finishAt) {
          ticketSubmissionAttempted = true;
          await contactWorker(selection.home, "run", { ticketId, routeIds: routes.map((route) => route.id), deadlineAt: finishAt, requestMs }, finishAt, viewerController.signal);
          ticketSubmitted = true;
        }

        while (!interrupted && Date.now() < finishAt) {
          try {
            delivery = await inspectDelivery(finishAt);
          } catch (error) {
            if (!isForegroundDeadline(error)) {
              throw error;
            }
          }

          if (delivery.state !== "pending") {
            break;
          }

          await delay(Math.min(40, Math.max(1, finishAt - Date.now())));
        }
      } catch (error) {
        if (!isForegroundDeadline(error) && !interrupted && ticketSubmitted) {
          throw error;
        }

        delivery = { ...delivery, reason: "worker-or-foreground-deadline" };
      }
    }

    if (interrupted && ticketSubmissionAttempted || ticketSubmitted && delivery.state !== "confirmed") {
      await cancelForegroundTicket();
    }

    if (!interrupted && delivery.state !== "confirmed" && Date.now() < deadlineAt) {
      delivery = await inspectDelivery(deadlineAt).catch((error) => {
        if (!isForegroundDeadline(error)) {
          throw error;
        }

        return { ...delivery, state: "pending", reason: Date.now() >= deadlineAt ? "foreground-deadline" : "delivery-inspection-unavailable" };
      });
    }

    await viewerPromise;
    const worker = await getOwnedWorkerStatus(selection.home, Math.min(deadlineAt, Date.now() + 100)).catch(() => ({ enabled: ledger.worker.enabled, running: null,
      processState: "unknown", retryPaused: ledger.worker.retryPaused, ingestion: { state: "unknown", url: null }, bootSupervised: null, setupReasons: ["Worker status could not be verified within the foreground budget."] }));

    if (interrupted && ticketSubmissionAttempted && !cancellationAttempted) {
      await cancelForegroundTicket();
    }

    if (interrupted) {
      delivery = { ...delivery, state: "pending", receipt: null, cancelled: true, reason: "foreground-cancelled-durable-retries-retained" };
    } else if (delivery.state === "pending" && !delivery.reason) {
      delivery.reason = "foreground-deadline";
    }

    const result = { schemaVersion: 1, command: "publish", inbox: { id: publication.origin.originInboxId, name: selection.name ?? null, home: selection.home },
      document: { localId: publication.metadata.id, originInboxId: publication.origin.originInboxId, originDocumentId: publication.origin.originDocumentId,
        historyEpoch: publication.origin.historyEpoch, version: publication.origin.version, fingerprint: publication.fingerprint },
      local: { durable: true, queued: publication.queued }, viewer, delivery, worker, onward: { awaited: false } };
    return { result, exitCode: interrupted ? 130 : delivery.state === "confirmed" || delivery.state === "local-only" ? 0 : delivery.state === "blocked" ? 3 : 2 };

    async function cancelForegroundTicket() {
      cancellationAttempted = true;
      await contactWorker(selection.home, "cancel", ticketId, Math.min(deadlineAt, Date.now() + 150)).catch(() => {});
    }

    async function matchingRoutes(snapshot?: SyncLedger) {
      const current = snapshot ?? await store.snapshot();
      return Object.values(current.routes).filter((route) => route.direction === "outbound" && route.peerId === publication.target?.peerId &&
        route.destinationInboxId === publication.target.destinationInboxId && (route.state === "active" || route.state === "reconnecting") &&
        !!routeOriginGrant(route, publication.origin.originInboxId, publication.origin.historyEpoch));
    }

    async function inspectDelivery(bound: number): Promise<DeliveryResult> {
      const current = await store.snapshot();
      const retriesEnabled = current.worker.enabled && !current.worker.retryPaused;
      const base = { target: publication.target, receipt: null, cancelled: false, retriesEnabled };

      if (!publication.target) {
        return { ...base, state: "local-only", reason: null };
      }

      const routes = await matchingRoutes(current);

      if (!routes.length) {
        return { ...base, state: "blocked", reason: "no-authorized-route-to-intended-target" };
      }

      let blockedReason: string | null = null;
      let canRetry = false;
      let hasUnavailableInspection = false;
      for (const route of routes) {
        const status = Date.now() < bound ? await store.deliveryStatus(route.id, publication.origin.originInboxId, publication.origin.originDocumentId, Math.min(bound, Date.now() + 200))
          .catch((error: unknown) => {
            if (!isForegroundDeadline(error)) throw error;

            return null;
          }) : null;

        hasUnavailableInspection ||= status === null;

        if (status?.isCommitted && Date.now() <= bound) {
          return { ...base, state: "confirmed", reason: null, receipt: status.receipt };
        }

        // Metadata can explain a block or pause when custody is unavailable, but cannot confirm delivery.
        const entry = current.outbox[outboxKey(route.id, route.revision, canonicalKey(publication.origin.originInboxId, publication.origin.originDocumentId))];
        const item = entry?.fingerprint === publication.fingerprint ? entry : undefined;
        const disposition = status?.status ?? (item?.disposition === "confirmed" ? item.receiptDisposition ?? item.disposition : item?.disposition);
        const lastError = status === null ? item?.lastError : status.lastError;

        if (disposition === "suppressed" || disposition === "deleted" || disposition === "superseded") {
          blockedReason = `intended-target-${disposition}`;
        } else if (disposition === "blocked" && lastError === "Trusted terminal history is required" &&
            !current.routeRetries[route.id]?.blocked && !isBlockedRouteFailure(route.lastError)) {
          // A prior transient route error must not end the foreground history wait.
          canRetry = true;
        } else if (disposition === "blocked" || current.routeRetries[route.id]?.blocked || status === null && isBlockedRouteFailure(route.lastError)) {
          blockedReason = lastError ?? current.routeRetries[route.id]?.lastError ?? route.lastError ?? "delivery-blocked";
        } else {
          canRetry = true;
        }
      }

      return { ...base, state: !canRetry && blockedReason ? "blocked" : "pending", reason: !canRetry && blockedReason ? blockedReason :
        current.worker.retryPaused ? "retries-paused" : !current.worker.enabled ? "worker-disabled" : Date.now() >= deadlineAt ? "foreground-deadline" :
        hasUnavailableInspection ? "delivery-inspection-unavailable" : null };
    }
  } finally {
    viewerController.abort();
    process.off("SIGINT", onInterrupt);
  }
}

export function formatManagedPublication(result: Awaited<ReturnType<typeof publishManagedDocument>>["result"]): string {
  const target = result.delivery.target ? `peer ${result.delivery.target.peerId}, destination ${result.delivery.target.destinationInboxId}` : "unconfigured target";
  return [`Saved locally: ${result.document.localId}.`, `Delivery ${result.delivery.state} for ${target}${result.delivery.reason ? ` (${result.delivery.reason})` : ""}.`,
    ...(result.viewer.url ? [result.viewer.url] : [`Viewer unavailable: ${result.viewer.error}.`]), "Onward destinations were not awaited."].join("\n");
}

function isForegroundDeadline(error: unknown): boolean {
  return error instanceof Error && /deadline|abort|cancel/i.test(error.message);
}
import { routeOriginGrant } from "./sync-ledger-policy";
