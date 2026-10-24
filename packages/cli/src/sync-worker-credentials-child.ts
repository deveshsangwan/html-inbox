import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as reconciliation from "./sync-reconciliation";
import { parseObject, parseUuid } from "./sync-model";

// This preload holds a real reconciliation call, before either implementation
// starts the later route. Credential resolution itself is never replaced.
const catalog = process.env.HTML_INBOX_CATALOG_HOME;
if (catalog) {
  const root = path.dirname(catalog);
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
