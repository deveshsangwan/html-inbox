import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as reconciliation from "./sync-reconciliation";
import { parseObject, parseUuid } from "./sync-model";
import * as worker from "./sync-worker";
import * as workerClient from "./sync-worker-client";

function reportStartupFailure(stage: "start" | "ensure", error: unknown) {
  try {
    const names = ["Error", "AggregateError", "TypeError", "RangeError", "AbortError"];
    const codes = ["EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOENT", "EIO", "ENOSPC", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ABORT_ERR"];
    const name = error instanceof Error && names.includes(error.name) ? error.name : "Error";
    const code = error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code) ? error.code : null;
    const messageSHA256 = createHash("sha256").update(error instanceof Error ? error.message : typeof error).digest("hex");
    process.stderr.write(`${JSON.stringify({ type: "credential-startup-failure", stage, pid: process.pid, name, code, messageSHA256 })}\n`);
  } catch {
    // Observation must preserve the original startup failure.
  }
}

// This preload holds a real reconciliation call, before either implementation
// starts the later route. Credential resolution itself is never replaced.
const catalog = process.env.HTML_INBOX_CATALOG_HOME;
if (catalog) {
  const root = path.dirname(catalog);
  const start = worker.startOwnedSyncWorker;
  mock.method(worker, "startOwnedSyncWorker", async (...args: Parameters<typeof start>) => {
    try {
      return await start(...args);
    } catch (error) {
      reportStartupFailure("start", error);
      throw error;
    }
  });

  const ensure = workerClient.ensureOwnedSyncWorker;
  mock.method(workerClient, "ensureOwnedSyncWorker", async (...args: Parameters<typeof ensure>) => {
    try {
      return await ensure(...args);
    } catch (error) {
      reportStartupFailure("ensure", error);
      throw error;
    }
  });

  const reconcile = reconciliation.reconcileSyncRoutes;
  mock.method(reconciliation, "reconcileSyncRoutes", async (options: Parameters<typeof reconcile>[0]) => {
    let pin: { firstRouteId: string; targetRouteId: string; sourceId: string } | undefined;
    try {
      const request = parseObject(JSON.parse(await readFile(path.join(root, "credential-hold.json"), "utf8")), "credential fixture hold");
      pin = { firstRouteId: parseUuid(request.firstRouteId), targetRouteId: parseUuid(request.targetRouteId), sourceId: parseUuid(request.sourceId) };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    if (pin && options.routeIds[0] === pin.firstRouteId) {
      const ledger = await options.store.snapshot();
      if (ledger.inboxId === pin.sourceId && ledger.routeRetries[pin.targetRouteId]?.blocked) {
        let held = false;
        try {
          await writeFile(path.join(root, "credential-held.json"), JSON.stringify({ pid: process.pid, routeId: pin.firstRouteId }), { mode: 0o600, flag: "wx" });
          held = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }

        if (held) {
          const deadline = Date.now() + 8000;
          for (;;) {
            try { await readFile(path.join(root, "credential-release")); break; } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }

            if (Date.now() >= deadline) throw new Error("Credential fixture release deadline exceeded");
            await delay(10);
          }

          await appendFile(path.join(root, "credential-holds.jsonl"), `${JSON.stringify({ pid: process.pid, routeId: pin.firstRouteId })}\n`, { mode: 0o600 });
        }
      }
    }

    const result = await reconcile(options);
    if (pin && options.routeIds[0] === pin.targetRouteId) {
      await appendFile(path.join(root, "credential-results.jsonl"), `${JSON.stringify(result.routes.map(({ routeId, status, lastError }) => ({ routeId, status, lastError })))}\n`, { mode: 0o600 });
    }

    return result;
  });
}
