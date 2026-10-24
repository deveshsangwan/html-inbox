import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { createStorageCounters, DurableFiles, optionalStat } from "./sync-files";
import { assertExactKeys, parseArray, parseChoice, parseInteger, parseObject, parseString, parseUuid } from "./sync-model";
import { acquireWorkerExclusion, inspectWorkerOwner, readWorkerRecordOffline, workerPaths, type WorkerRecord } from "./sync-worker-records";
import { parseWorkerRun, type WorkerRunRequest } from "./sync-worker";

export interface WorkerControlStatus {
  processId: string;
  inboxId: string;
  storageIncarnation: string;
  pid: number;
  configRevision: number;
  processState: "idle" | "running-pass" | "stopping";
  ingestion: { state: "disabled" | "listening"; url: string | null };
  tickets: { ticketId: string; state: "queued" | "running" | "complete" | "cancelled"; error: string | null; routes: unknown[] }[];
}

export function parseWorkerControlStatus(value: unknown): WorkerControlStatus {
  const status = parseObject(value, "worker control status");
  assertExactKeys(status, ["processId", "inboxId", "storageIncarnation", "pid", "configRevision", "processState", "ingestion", "tickets"]);
  const ingestion = parseObject(status.ingestion, "ingestion status");
  return { processId: parseUuid(status.processId), inboxId: parseUuid(status.inboxId), storageIncarnation: parseUuid(status.storageIncarnation),
    pid: parseInteger(status.pid, 1, 2_147_483_647), configRevision: parseInteger(status.configRevision), processState: parseChoice(status.processState, ["idle", "running-pass", "stopping"]),
    ingestion: { state: parseChoice(ingestion.state, ["disabled", "listening"]), url: ingestion.url === undefined || ingestion.url === null ? null : parseString(ingestion.url) },
    tickets: parseArray(status.tickets, (entry) => {
      const ticket = parseObject(entry, "worker ticket status");
      assertExactKeys(ticket, ["ticketId", "state", "routes", "error"]);
      return { ticketId: parseUuid(ticket.ticketId), state: parseChoice(ticket.state, ["queued", "running", "complete", "cancelled"]),
        routes: parseArray(ticket.routes, (route) => parseObject(route, "route result"), 128), error: ticket.error === null ? null : parseString(ticket.error) };
    }, 32) };
}

export async function contactWorker(home: string, operation: "status" | "run" | "wake" | "cancel" | "quiesce" | "stop", argument: unknown = null, deadlineAt = Date.now() + 5000, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const owner = await inspectWorkerOwner(home);
  if (owner.state !== "owned" || !owner.record) {
    throw new Error("No verified running sync worker");
  }

  return contactRecord(owner.record, operation, argument, deadlineAt, signal);
}

async function contactRecord(record: WorkerRecord, operation: string, argument: unknown, deadlineAt: number, signal?: AbortSignal): Promise<unknown> {
  const remaining = Math.min(7000, deadlineAt - Date.now());
  if (remaining <= 0) {
    throw new Error("Worker control deadline exceeded");
  }

  const bytes = Buffer.from(JSON.stringify({ processId: record.processId, inboxId: record.inboxId, storageIncarnation: record.storageIncarnation, operation, argument }));
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const timer = setTimeout(() => controller.abort(), remaining);
    const request = http.request(new URL("/control", record.controlOrigin), { method: "POST", agent: false, signal: controller.signal,
      headers: { "x-html-inbox-worker": record.controlToken, "content-type": "application/json", "content-length": bytes.length, connection: "close" } }, (response) => {
      void (async () => {
        if (response.statusCode !== 200) {
          throw new Error("Worker control rejected the owned operation");
        }

        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
          const part = Buffer.from(chunk);
          size += part.length;
          if (size > 256 * 1024) {
            throw new Error("Worker control response exceeds limit");
          }

          chunks.push(part);
        }

        const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return result;
      })().then(resolve, reject).finally(cleanup);
    });
    request.once("error", (error) => { cleanup(); reject(error); });
    request.end(bytes);
  });
}

export interface OwnedWorkerStatus {
  enabled: boolean;
  retryPaused: boolean;
  running: boolean | null;
  processState: string;
  ingestion: { state: string; url: string | null };
  bootSupervised: boolean | null;
  setupReasons: string[];
  lastRunAt: number | null;
  lastError: string | null;
}

export async function getOwnedWorkerStatus(home: string, deadlineAt?: number): Promise<OwnedWorkerStatus> {
  const ledger = await assertManagedLifecycle(home);
  if (!ledger) {
    throw new Error("Sync status requires an enrolled inbox");
  }

  const base: OwnedWorkerStatus = { enabled: ledger.worker.enabled, retryPaused: ledger.worker.retryPaused, running: false,
    processState: "stopped", ingestion: { state: ledger.runtime?.config.listener && ledger.worker.lastError === "worker-startup-failed" ? "failed" : "disabled", url: null },
    bootSupervised: null, lastRunAt: ledger.worker.lastRunAt, lastError: ledger.worker.lastError, setupReasons: ["Boot supervision has not been observed; render and manually install a supervisor definition."] };
  try {
    const owner = await inspectWorkerOwner(home, ledger);
    if (owner.state === "stopped") {
      return base;
    }

    const status = parseWorkerControlStatus(await contactWorker(home, "status", null, deadlineAt));
    if (!owner.record || status.processId !== owner.record.processId || status.pid !== owner.record.pid || status.inboxId !== ledger.inboxId || status.storageIncarnation !== ledger.storageIncarnation) {
      throw new Error("Worker status identity differs from its local ownership record");
    }

    return { ...base, running: true, processState: status.processState, ingestion: status.ingestion };
  } catch {
    return { ...base, running: null, processState: "unknown", setupReasons: [...base.setupReasons, "Worker ownership or control could not be verified locally."] };
  }
}

export async function ensureOwnedSyncWorker(home: string, options: { deadlineAt?: number; entryPath?: string; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const ledger = await assertManagedLifecycle(home);
  if (!ledger?.worker.enabled) {
    throw new Error("Sync worker must be explicitly enabled before startup");
  }

  const deadlineAt = Math.min(options.deadlineAt ?? Date.now() + 10_000, Date.now() + 10_000);
  const paths = workerPaths(home);
  await new DurableFiles(createStorageCounters(), {}, home).directory(paths.directory);
  const exclusion = await acquireWorkerExclusion(home, deadlineAt, options.signal);
  try {
    const owner = await inspectWorkerOwner(home);
    if (owner.state === "owned") {
      const status = parseWorkerControlStatus(await contactWorker(home, "status", null, deadlineAt, options.signal));
      if (status.configRevision !== (ledger.runtime?.revision ?? 0)) {
        throw new Error("Worker configuration changed; stop and restart the verified worker");
      }

      return status;
    }

    if (owner.record) {
      await rm(paths.record);
    }

    const entryPath = path.resolve(options.entryPath ?? process.argv[1] ?? "");
    if (!options.entryPath && !process.argv[1]) {
      throw new Error("Cannot locate CLI entry for worker startup");
    }

    const log = await open(paths.log, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const info = await log.stat();
      if (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) {
        throw new Error("Worker log must be a regular owned private file");
      }

      await log.chmod(0o600);
      child = spawn(process.execPath, [entryPath, "sync", "worker", "start", "--foreground", "--home", home, "--json"], {
        detached: true, env: { ...process.env, HTML_INBOX_NAME: undefined, HTML_INBOX_HOME: home, HTML_INBOX_SYNC_START_LOCK: exclusion.owner.token }, stdio: ["ignore", log.fd, log.fd, "ipc"] });
      const ownedChild = child;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Worker child readiness deadline exceeded")), Math.max(1, deadlineAt - Date.now()));
        const finish = (error?: Error) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          ownedChild.off("message", onMessage);
          ownedChild.off("error", onError);
          ownedChild.off("exit", onExit);
          if (error) reject(error); else resolve();
        };
        const onMessage = (value: unknown) => {
          try {
            const message = parseObject(value, "worker private readiness handshake");
            if (message.type !== "sync-worker-ready" || message.pid !== ownedChild.pid || message.inboxId !== ledger.inboxId || message.storageIncarnation !== ledger.storageIncarnation) {
              throw new Error("Worker child handshake identity mismatch");
            }

            finish();
          } catch { finish(new Error("Worker child readiness was invalid")); }
        };
        const onAbort = () => finish(new Error("Worker startup cancelled"));
        const onError = (error: Error) => finish(error);
        const onExit = () => finish(new Error("Worker child exited before readiness"));
        ownedChild.on("message", onMessage);
        ownedChild.once("error", onError);
        ownedChild.once("exit", onExit);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
      const status = parseWorkerControlStatus(await contactWorker(home, "status", null, deadlineAt, options.signal));
      if (status.pid !== ownedChild.pid || status.inboxId !== ledger.inboxId || status.storageIncarnation !== ledger.storageIncarnation) {
        throw new Error("Worker readiness does not match the known child");
      }

      ownedChild.disconnect();
      ownedChild.unref();
      return status;
    } catch (error) {
      if (child) {
        await terminateKnownWorkerChild(child, options.signal?.aborted);
      }

      throw error;
    } finally {
      await log.close();
    }
  } finally {
    await exclusion.release();
  }
}

export async function stopOwnedSyncWorker(home: string, deadlineAt = Date.now() + 10_000) {
  await assertManagedLifecycle(home);
  if (!await optionalStat(workerPaths(home).directory)) {
    return { stopped: true, alreadyStopped: true };
  }

  const exclusion = await acquireWorkerExclusion(home, deadlineAt);
  try {
    return await stopWorkerUnderExclusion(home, deadlineAt);
  } finally {
    await exclusion.release();
  }
}

async function stopWorkerUnderExclusion(home: string, deadlineAt: number) {
  const owner = await inspectWorkerOwner(home);
  if (owner.state === "stopped") {
    return { stopped: true, alreadyStopped: true };
  }

  await contactWorker(home, "stop", null, deadlineAt);
  while (Date.now() < deadlineAt) {
    const remaining = await readWorkerRecordOffline(home);
    if (!remaining) {
      return { stopped: true, alreadyStopped: false };
    }

    if (remaining.processId !== owner.record?.processId) {
      throw new Error("Worker ownership changed during stop; no signal was sent");
    }

    await delay(20);
  }

  throw new Error("Worker shutdown deadline exceeded; ownership retained and no saved PID was signalled");
}

export async function submitWorkerRun(home: string, run: WorkerRunRequest) {
  parseWorkerRun(run);
  await contactWorker(home, "run", run, run.deadlineAt);
  while (Date.now() < run.deadlineAt) {
    const status = parseWorkerControlStatus(await contactWorker(home, "status", null, run.deadlineAt));
    const ticket = status.tickets.find((entry) => entry.ticketId === run.ticketId);
    if (ticket?.state === "complete" || ticket?.state === "cancelled") {
      return ticket;
    }

    await delay(Math.min(40, Math.max(1, run.deadlineAt - Date.now())));
  }

  throw new Error("Worker foreground ticket deadline exceeded");
}

async function terminateKnownWorkerChild(child: ReturnType<typeof spawn>, immediate = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill(immediate ? "SIGKILL" : "SIGTERM");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
