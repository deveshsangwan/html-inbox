import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as reconciliation from "./sync-reconciliation";
import * as files from "./sync-files";
import { parseObject, parseUuid } from "./sync-model";
import * as worker from "./sync-worker";
import * as workerClient from "./sync-worker-client";
import * as workerRecordReader from "./sync-worker-record-reader";

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

async function reportPrivateFileFailure(root: string, filename: string, error: unknown) {
  const checks = ["Managed file must be a bounded regular file owned by the current account", "Managed file changed during open", "Worker record changed repeatedly during read"];
  if (!(error instanceof Error) || !checks.includes(error.message)) {
    return;
  }

  try {
    const relative = path.relative(root, filename);
    const location = path.isAbsolute(relative) || relative.split(path.sep).includes("..") ? "outside-fixture" : relative;
    const info = await lstat(filename).catch(() => null);
    process.stderr.write(`${JSON.stringify({ type: "credential-private-file-failure", pid: process.pid, location,
      check: error.message === checks[0] ? "path" : error.message === checks[1] ? "opened-handle" : "snapshot-retries",
      frames: error.stack?.split("\n").filter((line) => line.trimStart().startsWith("at ") && line.includes(`${__dirname}${path.sep}`))
        .slice(0, 8).map((line) => line.trim().replace(__dirname, "<cli>")),
      observedAfterFailure: info && { isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink(), nlink: info.nlink,
        size: info.size, mode: info.mode & 0o777, owned: !process.getuid || info.uid === process.getuid() },
    })}\n`);
  } catch {
    // Metadata is observed after rejection and must not replace the original failure.
  }
}

// This preload holds a real reconciliation call, before either implementation
// starts the later route. Credential resolution itself is never replaced.
const catalog = process.env.HTML_INBOX_CATALOG_HOME;
if (catalog) {
  const root = path.dirname(catalog);
  const readWorkerRecordBytes = workerRecordReader.readWorkerRecordBytes;
  mock.method(workerRecordReader, "readWorkerRecordBytes", async (...args: Parameters<typeof readWorkerRecordBytes>) => {
    try {
      return await readWorkerRecordBytes(...args);
    } catch (error) {
      await reportPrivateFileFailure(root, args[0], error);
      throw error;
    }
  });

  const openPrivateFile = files.openPrivateFile;
  mock.method(files, "openPrivateFile", async (...args: Parameters<typeof openPrivateFile>) => {
    try {
      return await openPrivateFile(...args);
    } catch (error) {
      await reportPrivateFileFailure(root, args[0], error);
      throw error;
    }
  });

  const readPrivateFile = files.readPrivateFile;
  mock.method(files, "readPrivateFile", async (...args: Parameters<typeof readPrivateFile>) => {
    try {
      return await readPrivateFile(...args);
    } catch (error) {
      await reportPrivateFileFailure(root, args[0], error);
      throw error;
    }
  });

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

    const startedAt = Date.now();
    const result = await reconcile(options).catch(async (error: unknown) => {
      try {
        const names = ["Error", "AggregateError", "TypeError", "RangeError", "AbortError"];
        await appendFile(path.join(root, "credential-pass-results.jsonl"), `${JSON.stringify({ pid: process.pid, elapsedMs: Date.now() - startedAt,
          routeIds: options.routeIds, outcome: "rejected", name: error instanceof Error && names.includes(error.name) ? error.name : "other",
          messageSHA256: createHash("sha256").update(error instanceof Error ? error.message : typeof error).digest("hex") })}\n`, { mode: 0o600 });
      } finally {
        // A failed observation must not replace the real reconciliation rejection.
        throw error;
      }
    });
    try {
      await appendFile(path.join(root, "credential-pass-results.jsonl"), `${JSON.stringify({ pid: process.pid, elapsedMs: Date.now() - startedAt,
        routes: result.routes.map(({ routeId, direction, status, lastError }) => ({ routeId, direction, status, lastError })), counters: result.counters })}\n`, { mode: 0o600 });
    } catch {
      // Fixture observations must not alter the real reconciliation result.
    }
    if (pin && options.routeIds[0] === pin.targetRouteId) {
      await appendFile(path.join(root, "credential-results.jsonl"), `${JSON.stringify(result.routes.map(({ routeId, status, lastError }) => ({ routeId, status, lastError })))}\n`, { mode: 0o600 });
    }

    return result;
  });
}
