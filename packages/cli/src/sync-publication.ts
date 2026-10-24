import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PublishRequest } from "./publish-input";
import { loadPublishInput } from "./publish-input";
import type { ResolvedInboxSelection } from "./inbox-selection";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { ManagedSyncStore } from "./sync-store";
import type { DurableReceipt } from "./sync-ledger";
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
    let ticketSubmitted = false;
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

      delivery = { state: "pending", target: publication.target, reason: "foreground-deadline", receipt: null, cancelled: interrupted,
        retriesEnabled: ledger.worker.enabled && !ledger.worker.retryPaused };
    }
    if (publication.target && delivery.state === "pending" && ledger.worker.enabled && !ledger.worker.retryPaused && !interrupted && Date.now() < finishAt) {
      console.error(`html-inbox: Saved locally. Waiting for intended peer ${publication.target.peerId}, destination ${publication.target.destinationInboxId}.`);
      try {
        await ensureOwnedSyncWorker(selection.home, { deadlineAt: finishAt, signal: viewerController.signal });
        const routes = await matchingRoutes();
        if (routes.length && Date.now() < finishAt) {
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

    if (ticketSubmitted && (interrupted || delivery.state !== "confirmed")) {
      await contactWorker(selection.home, "cancel", ticketId, Math.min(deadlineAt, Date.now() + 150)).catch(() => {});
    }

    if (!interrupted && Date.now() < deadlineAt) {
      delivery = await inspectDelivery(deadlineAt).catch((error) => {
        if (!isForegroundDeadline(error)) {
          throw error;
        }

        return { ...delivery, state: "pending", reason: "foreground-deadline" };
      });
    }

    if (interrupted) {
      delivery = { ...delivery, state: "pending", receipt: null, cancelled: true, reason: "foreground-cancelled-durable-retries-retained" };
    } else if (delivery.state === "pending" && !delivery.reason) {
      delivery.reason = "foreground-deadline";
    }

    await viewerPromise;
    const worker = await getOwnedWorkerStatus(selection.home, Math.min(deadlineAt, Date.now() + 100)).catch(() => ({ enabled: ledger.worker.enabled, running: null,
      processState: "unknown", retryPaused: ledger.worker.retryPaused, ingestion: { state: "unknown", url: null }, bootSupervised: null, setupReasons: ["Worker status could not be verified within the foreground budget."] }));
    const result = { schemaVersion: 1, command: "publish", inbox: { id: publication.origin.originInboxId, name: selection.name ?? null, home: selection.home },
      document: { localId: publication.metadata.id, originInboxId: publication.origin.originInboxId, originDocumentId: publication.origin.originDocumentId,
        historyEpoch: publication.origin.historyEpoch, version: publication.origin.version, fingerprint: publication.fingerprint },
      local: { durable: true, queued: publication.queued }, viewer, delivery, worker, onward: { awaited: false } };
    return { result, exitCode: interrupted ? 130 : delivery.state === "confirmed" || delivery.state === "local-only" ? 0 : delivery.state === "blocked" ? 3 : 2 };

    async function matchingRoutes() {
      const current = await store.snapshot();
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

      const routes = await matchingRoutes();

      if (!routes.length) {
        return { ...base, state: "blocked", reason: "no-authorized-route-to-intended-target" };
      }

      let blockedReason: string | null = null;
      let canRetry = false;
      for (const route of routes) {
        if (Date.now() >= bound) {
          break;
        }

        const status = await store.deliveryStatus(route.id, publication.origin.originInboxId, publication.origin.originDocumentId, Math.min(bound, Date.now() + 200));

        if (status.isCommitted && Date.now() <= bound) {
          return { ...base, state: "confirmed", reason: null, receipt: status.receipt };
        }

        if (status.status === "suppressed" || status.status === "deleted" || status.status === "superseded") {
          blockedReason = `intended-target-${status.status}`;
        } else if (status.status === "blocked" && status.lastError === "Trusted terminal history is required" && !current.routeRetries[route.id]?.blocked && !route.lastError) {
          canRetry = true;
        } else if (status.status === "blocked" || current.routeRetries[route.id]?.blocked) {
          blockedReason = status.lastError ?? current.routeRetries[route.id]?.lastError ?? "delivery-blocked";
        } else {
          canRetry = true;
        }
      }

      return { ...base, state: !canRetry && blockedReason ? "blocked" : "pending", reason: !canRetry && blockedReason ? blockedReason :
        current.worker.retryPaused ? "retries-paused" : !current.worker.enabled ? "worker-disabled" : null };
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
