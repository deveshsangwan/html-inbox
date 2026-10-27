import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { type OwnerAnchor, type SyncLedger } from "./sync-ledger";
import { acquireSyncOwnership, checkDirectory, hasCode, isDeadOwner, optionalStat, processStart, readSyncOwnership } from "./sync-files";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { assertExactKeys, parseInteger, parseObject, parseString, parseUuid } from "./sync-model";
import { readRuntimeFile } from "./sync-runtime-config";

export interface WorkerRecord {
  schemaVersion: 1;
  inboxId: string;
  storageIncarnation: string;
  ownerAnchor: OwnerAnchor;
  processId: string;
  pid: number;
  start: string | null;
  controlOrigin: string;
  controlToken: string;
  startedAt: number;
  configRevision: number;
}

export function workerPaths(home: string) {
  const directory = path.join(home, "sync", "worker");
  return { directory, record: path.join(directory, "runtime.json"), lifetime: path.join(directory, "lifetime.lock"),
    startup: path.join(directory, "startup.lock"), log: path.join(directory, "worker.log") };
}

export function parseWorkerRecord(value: unknown): WorkerRecord {
  const record = parseObject(value, "worker runtime record");
  assertExactKeys(record, ["schemaVersion", "inboxId", "storageIncarnation", "ownerAnchor", "processId", "pid", "start", "controlOrigin", "controlToken", "startedAt", "configRevision"]);
  if (record.schemaVersion !== 1) {
    throw new Error("Unsupported worker runtime record");
  }

  const anchor = parseObject(record.ownerAnchor, "worker owner anchor");
  assertExactKeys(anchor, ["home", "dev", "ino"]);
  const controlOrigin = parseString(record.controlOrigin);
  const url = new URL(controlOrigin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== controlOrigin || url.username || url.password) {
    throw new Error("Worker control must use a literal private loopback origin");
  }

  const controlToken = parseString(record.controlToken, "worker control token", 64);
  if (Buffer.from(controlToken, "base64url").length !== 32 || Buffer.from(controlToken, "base64url").toString("base64url") !== controlToken) {
    throw new Error("Invalid worker control credential");
  }

  return { schemaVersion: 1, inboxId: parseUuid(record.inboxId), storageIncarnation: parseUuid(record.storageIncarnation),
    ownerAnchor: { home: parseString(anchor.home), dev: parseInteger(anchor.dev), ino: parseInteger(anchor.ino) }, processId: parseUuid(record.processId),
    pid: parseInteger(record.pid, 1, 2_147_483_647), start: record.start === null ? null : parseString(record.start), controlOrigin, controlToken,
    startedAt: parseInteger(record.startedAt, 1), configRevision: parseInteger(record.configRevision) };
}

export async function readWorkerRecordOffline(home: string): Promise<WorkerRecord | null> {
  const paths = workerPaths(home);
  if (!await optionalStat(paths.record)) {
    return null;
  }

  await checkDirectory(paths.directory);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return parseWorkerRecord(JSON.parse((await readRuntimeFile(paths.record, 8192, true)).toString("utf8")));
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }

      if (error instanceof Error && error.message === "Managed file must be a bounded regular file owned by the current account" && !await optionalStat(paths.record)) {
        return null;
      }

      if (!(error instanceof Error) || error.message !== "Managed file changed during open" || attempt === 3) {
        throw error;
      }
    }
  }

  throw new Error("Worker record changed repeatedly during read");
}

export async function inspectWorkerOwner(home: string, ledger?: SyncLedger): Promise<{ state: "stopped" | "owned"; record: WorkerRecord | null }> {
  const managed = ledger ?? await assertManagedLifecycle(home);
  if (!managed) {
    throw new Error("Sync worker requires an enrolled inbox");
  }

  const record = await readWorkerRecordOffline(home);
  const paths = workerPaths(home);
  if (!record) {
    if (await optionalStat(paths.lifetime)) {
      const owner = await readSyncOwnership(paths.lifetime);
      if (!owner || !await isDeadOwner(owner)) {
        throw new Error("Worker lifetime ownership is live or unknown without a runtime record");
      }
    }

    return { state: "stopped", record: null };
  }

  if (record.inboxId !== managed.inboxId || record.storageIncarnation !== managed.storageIncarnation ||
      record.ownerAnchor.home !== home || record.ownerAnchor.home !== managed.ownerAnchor.home ||
      record.ownerAnchor.dev !== managed.ownerAnchor.dev || record.ownerAnchor.ino !== managed.ownerAnchor.ino) {
    throw new Error("Copied or stale worker identity; no control endpoint was contacted");
  }

  if (await isDeadOwner({ token: record.processId, pid: record.pid, start: record.start })) {
    return { state: "stopped", record };
  }

  if (record.start !== null && await processStart(record.pid) !== record.start) {
    throw new Error("Worker process start ownership is unknown; no endpoint was contacted");
  }

  const owner = await readSyncOwnership(paths.lifetime);
  if (!owner || owner.token !== record.processId || owner.pid !== record.pid || owner.start !== record.start) {
    throw new Error("Worker lifetime lock does not prove the saved process ownership");
  }

  return { state: "owned", record };
}

export function matchesWorkerToken(actual: string | undefined, expected: string): boolean {
  const bytes = Buffer.from(actual ?? "");
  const trusted = Buffer.from(expected);
  return bytes.length === trusted.length && timingSafeEqual(bytes, trusted);
}

export async function acquireWorkerExclusion(home: string, deadlineAt = Date.now() + 10_000, signal?: AbortSignal) {
  return acquireSyncOwnership(workerPaths(home).startup, deadlineAt, signal);
}
