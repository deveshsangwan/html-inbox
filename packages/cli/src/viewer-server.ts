import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { DocumentBackend } from "./documents";
import { ManagedStorageError } from "./private-storage";
import { startViewerHttpServer, type ViewerHttpServer } from "./viewer-http-server";
import { resolveViewerNetworkConfig, type ViewerNetworkOptions } from "./viewer-network";
import { cleanupTailscale, prepareTailscale, startTailscale, type PreparedTailscale } from "./viewer-tailscale";
import { getInboxInstanceId, hasErrorCode, readSavedViewerConfiguration, readViewerRecord, removeViewerRecord, saveViewerConfiguration, writeViewerRecord, type ViewerRecord } from "./viewer-records";
import { acquireViewerStartLock, hasInheritedViewerStartLock, isProcessAlive } from "./viewer-start-lock";
import { spawnDetachedViewer } from "./viewer-process";
import { getControlHealth, getViewerStatus, isPortListening, resolveViewerConfiguration, VIEWER_PROTOCOL_VERSION, type ViewerStatus } from "./viewer-status";

export { getViewerStatus, resolveViewerConfiguration, VIEWER_PROTOCOL_VERSION, type ViewerStatus } from "./viewer-status";

export async function ensureViewer(
  home: string,
  input?: number | ViewerNetworkOptions,
): Promise<ViewerStatus> {
  const lock = await acquireViewerStartLock(home);
  try {
    const config = await resolveViewerConfiguration(home, input);
    const existing = await getViewerStatus(home, undefined, { refreshLanUrls: false });
    if (existing.state === "running") {
      const record = await readViewerRecord(home);
      if (!record || !existing.pid) {
        throw new Error("Viewer is running but its process record is missing or stale");
      }

      if (record.config.port !== config.port || record.config.exposure !== config.exposure || record.config.host !== config.host) {
        throw new Error(`Viewer is already running with ${record.config.exposure} exposure on ${record.config.host}:${record.config.port}; stop it before changing configuration`);
      }

      return getViewerStatus(home);
    }

    await assertCanReplaceViewerRecord(home, existing);
    const status = await getViewerStatus(home, config.port, { refreshLanUrls: false });
    assertCanStart(status);
    await clearPreviousTailscaleRoute(home);
    await getInboxInstanceId(home);
    await rm(path.join(home, "viewer.json"), { force: true });

    const saved = await readSavedViewerConfiguration(home);
    const detached = await spawnDetachedViewer(home, config, lock.token, saved?.tailscaleExecutable);
    try {
      const startupTimeout = config.exposure === "tailscale" ? 45_000 : 10_000;
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        const failure = detached.getFailure();
        if (failure) {
          throw new Error(`Viewer child could not start: ${failure.message}`);
        }

        if (detached.child.exitCode !== null || detached.child.signalCode !== null) {
          throw new Error(`Viewer child exited before readiness (${detached.child.signalCode ?? detached.child.exitCode})`);
        }

        const ready = await getViewerStatus(home, config.port);
        if (ready.state === "running" && ready.pid === detached.child.pid) {
          return ready;
        }

        if (ready.state === "incompatible") {
          throw new Error("Viewer child uses an incompatible protocol");
        }

        await delay(50);
      }

      throw new Error(`Viewer child did not become ready within ${startupTimeout / 1000} seconds`);
    } catch (error) {
      await detached.close();
      try {
        // A failed child may journal a route before committing viewer.json.
        await clearPreviousTailscaleRoute(home);
        const record = await readViewerRecord(home).catch(() => null);
        if (record && record.pid === detached.child.pid) {
          await removeViewerRecord(home, record.processId);
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Viewer startup failed and scoped cleanup failed. Private diagnostics: ${detached.logPath}. Ownership journal retained; retry viewer stop`);
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}. Private diagnostics: ${detached.logPath}`, { cause: error });
    }
  } finally {
    await lock.release();
  }
}

export async function stopViewer(home: string, port?: number): Promise<ViewerStatus> {
  const lock = await acquireViewerStartLock(home);
  try {
    const status = await getViewerStatus(home, port, { refreshLanUrls: false });
    const record = await readViewerRecord(home).catch((error: unknown) => {
      if (error instanceof ManagedStorageError) {
        throw error;
      }

      return null;
    });
    if (record && port !== undefined && record.config.port !== port) {
      throw new Error(`Selected stop port ${port} does not match the viewer record port ${record.config.port}; stop without a port override to manage that viewer`);
    }

    if (status.state !== "running" && !(status.pid && record?.config.exposure === "tailscale")) {
      let remaining = record;
      if (status.state === "stopped" && record && !record.shutdownError) {
        remaining = await waitForViewerRecordCleanup(home, record, shutdownDeadline(record));
      }

      await clearPreviousTailscaleRoute(home, record ?? undefined);
      if (status.state === "stopped" && remaining) {
        await removeViewerRecord(home, remaining.processId);
      }

      return status;
    }

    if (!status.pid || !record) {
      throw new Error("Viewer is running but its process record is missing or stale");
    }

    // Recheck the private endpoint immediately before signalling a recorded PID.
    const current = await getControlHealth(record.controlUrl);
    if (current.state !== "ready" || current.pid !== status.pid || current.processId !== record.processId || current.instanceId !== record.instanceId) {
      throw new Error("Viewer process identity changed before stop; no signal sent");
    }

    try {
      process.kill(status.pid, "SIGTERM");
    } catch (error) {
      if (!hasErrorCode(error, "ESRCH")) {
        throw error;
      }
    }

    const deadline = shutdownDeadline(record);
    while (Date.now() < deadline) {
      if ((await getControlHealth(record.controlUrl)).state === "unavailable" && !(await isPortListening(record.config))) {
        const remaining = await waitForViewerRecordCleanup(home, record, deadline);
        await clearPreviousTailscaleRoute(home, record);
        if (remaining) {
          await removeViewerRecord(home, record.processId);
        }

        return { ...status, state: "stopped", pid: undefined };
      }

      await delay(50);
    }

    if (record.config.exposure === "tailscale") {
      throw new Error(`Viewer shutdown or Tailscale cleanup did not finish. Ownership journal retained; retry viewer stop. Private diagnostics: ${path.join(home, "viewer.log")}`);
    }

    throw new Error(`Viewer did not stop at ${status.url}`);
  } finally {
    await lock.release();
  }
}

export async function startViewer(
  backend: DocumentBackend,
  home: string,
  input: number | ViewerNetworkOptions,
): Promise<http.Server> {
  const inherited = await hasInheritedViewerStartLock(home);
  const lock = inherited ? null : await acquireViewerStartLock(home);
  try {
    const existing = await getViewerStatus(home, undefined, { refreshLanUrls: false });
    if (existing.state === "running") {
      throw new Error(`Viewer is already running at ${existing.url}`);
    }

    await assertCanReplaceViewerRecord(home, existing);
    const instanceId = await getInboxInstanceId(home);
    const processId = randomUUID();
    const health = { instanceId, processId, protocolVersion: VIEWER_PROTOCOL_VERSION, pid: process.pid };
    let reader: ViewerHttpServer | undefined;
    let prepared: PreparedTailscale | undefined;
    let startup: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let hasReportedShutdownFailure = false;
    const close = () => closing ??= (async () => {
      try {
        // Startup owns route mutation and readiness writes until its promise settles.
        await startup?.catch(() => undefined);
        if (reader) {
          const listenersClosed = reader.close();
          reader.server.closeAllConnections();
          reader.controlServer.closeAllConnections();
          await listenersClosed;
        }

        if (prepared) {
          await clearPreviousTailscaleRoute(home, { instanceId, processId });
        }

        await removeViewerRecord(home, processId);
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
    })();
    const reportShutdownFailure = (error: unknown) => {
      if (hasReportedShutdownFailure) {
        return;
      }

      hasReportedShutdownFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`html-inbox: Viewer shutdown failed: ${message}`);
      process.exitCode = 1;
      void readViewerRecord(home).then((record) => {
        if (record?.processId === processId) {
          return writeViewerRecord(home, { ...record, shutdownError: message });
        }
      }).catch((recordError: unknown) => {
        console.error(`html-inbox: Could not record shutdown failure: ${String(recordError)}`);
      });
    };
    const onSignal = () => { void close().catch(reportShutdownFailure); };

    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    startup = (async () => {
      await clearPreviousTailscaleRoute(home);
      if (closing) {
        return;
      }

      const initialConfig = resolveViewerNetworkConfig(input);
      const saved = await readSavedViewerConfiguration(home);
      if (initialConfig.exposure === "tailscale") {
        prepared = await prepareTailscale({ home, backendPort: initialConfig.port, instanceId, processId }, {
          executable: process.env.HTML_INBOX_TAILSCALE_COMMAND ?? saved?.tailscaleExecutable,
        });
      }

      if (closing) {
        return;
      }

      const config = prepared ? { ...initialConfig, tailscaleHostname: prepared.hostname } : initialConfig;
      reader = await startViewerHttpServer(backend, config, health);
      reader.server.once("close", () => { void close().catch(reportShutdownFailure); });
      if (closing) {
        return;
      }

      if (prepared) {
        await startTailscale({ ...prepared, backendPort: reader.config.port });
      }

      if (closing) {
        return;
      }

      await saveViewerConfiguration(home, {
        config: reader.config,
        urls: reader.urls,
        ...(prepared ? { tailscaleExecutable: prepared.executable } : {}),
      });
      if (closing) {
        return;
      }

      await writeViewerRecord(home, {
        ...health,
        config: reader.config,
        urls: reader.urls,
        controlUrl: reader.controlUrl,
        startedAt: new Date().toISOString(),
      });
    })();

    try {
      await startup;
      if (closing) {
        await closing;
        throw new Error("Viewer startup interrupted before readiness");
      }

      if (!reader) {
        throw new Error("Viewer startup finished without a reader");
      }

      return reader.server;
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Viewer startup failed and Tailscale cleanup failed; private ownership journal retained");
      }

      throw error;
    }
  } finally {
    await lock?.release();
  }
}

function shutdownDeadline(record: ViewerRecord): number {
  return Date.now() + (record.config.exposure === "tailscale" ? 45_000 : 5000);
}

async function waitForViewerRecordCleanup(home: string, record: ViewerRecord, deadline: number): Promise<ViewerRecord | null> {
  while (Date.now() < deadline) {
    const remaining = await readViewerRecord(home);
    if (!remaining) {
      return null;
    }

    if (remaining.processId !== record.processId) {
      throw new Error("Viewer process identity changed during shutdown; no cleanup was attempted");
    }

    if (remaining.shutdownError) {
      throw new Error(`${remaining.shutdownError}. Ownership journal retained; retry viewer stop`);
    }

    if (!isProcessAlive(record.pid)) {
      return remaining;
    }

    await delay(50);
  }

  throw new Error(`Viewer shutdown cleanup did not finish. Private records retained; retry viewer stop. Private diagnostics: ${path.join(home, "viewer.log")}`);
}

function assertCanStart(status: ViewerStatus): void {
  if (status.state === "stopped") {
    return;
  }

  if (status.state === "incompatible") {
    throw new Error(status.reason ?? `Viewer at ${status.url} uses an incompatible protocol`);
  }

  throw new Error(status.reason ?? `Port ${status.port} is already in use by a service with an invalid health response or another inbox; choose another --port`);
}

async function assertCanReplaceViewerRecord(home: string, status: ViewerStatus): Promise<void> {
  if (status.state === "incompatible") {
    assertCanStart(status);
  }

  if (status.state !== "conflict") {
    return;
  }

  const record = await readViewerRecord(home);
  if (!record) {
    return;
  }

  const hasLiveProcess = isProcessAlive(record.pid) || (await getControlHealth(record.controlUrl)).state !== "unavailable";
  if (hasLiveProcess) {
    throw new Error(status.reason ?? "Existing viewer process record is unverified; stop that viewer before starting another");
  }
}

async function clearPreviousTailscaleRoute(home: string, owner?: { instanceId: string; processId: string }): Promise<void> {
  try {
    const result = await cleanupTailscale(home, owner, { executable: process.env.HTML_INBOX_TAILSCALE_COMMAND });
    if (result.state !== "stopped") {
      throw new Error(`Tailscale cleanup ${result.state}: ${result.reason ?? "private ownership journal retained"}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tailscale cleanup failed: ${message}. Ownership journal retained; retry viewer stop`, { cause: error });
  }
}
