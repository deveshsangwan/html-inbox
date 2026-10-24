import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedFile } from "./bounded-file";
import { parseObject, assertExactKeys, parseInteger, parseString } from "./sync-model";

export type StorageEvent = "directory-created" | "directory-flushed" | "migration-intent" | "migration-evacuated" | "migration-barrier" | "migration-enumeration" |
  "body-staged" | "body-flushed" | "body-installed" | "body-directory-flushed" | "ledger-temp-written" | "ledger-temp-fsynced" | "ledger-renamed" | "ledger-dir-fsynced" |
  "committed-before-receipt" | "receipt-before-retirement";

export interface StorageTestHooks {
  onEvent?: (event: StorageEvent) => void | Promise<void>;
}

export interface StorageCounters {
  htmlOpens: number;
  htmlBytes: number;
  hashPasses: number;
  bodyTransfers: number;
  events: Partial<Record<StorageEvent, number>>;
}

export function createStorageCounters(): StorageCounters {
  return { htmlOpens: 0, htmlBytes: 0, hashPasses: 0, bodyTransfers: 0, events: {} };
}

// Tests explicitly pass this object. Production never reads fault settings from the environment.
export function createOneShotStorageFault(event: StorageEvent, action: () => void | Promise<void> = () => { throw new Error(`Injected storage fault: ${event}`); }) {
  let armed = true;
  let hits = 0;
  return { hooks: { async onEvent(current: StorageEvent) {
    if (current === event && armed) {
      armed = false;
      hits += 1;
      await action();
    }
  } }, proof: () => ({ event, armed, hits }) };
}

const uncertainStores = new Set<string>();

export class DurableFiles {
  get uncertain(): boolean { return uncertainStores.has(this.storeHome); }
  set uncertain(value: boolean) {
    if (value) {
      uncertainStores.add(this.storeHome);
    } else {
      uncertainStores.delete(this.storeHome);
    }
  }

  constructor(readonly counters: StorageCounters, private readonly hooks: StorageTestHooks, private readonly storeHome: string) {}

  async event(event: StorageEvent): Promise<void> {
    this.counters.events[event] = (this.counters.events[event] ?? 0) + 1;
    await this.hooks.onEvent?.(event);
  }

  async directory(directory: string): Promise<void> {
    const existing = await optionalStat(directory);
    if (!existing) {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error("Cannot create filesystem root");
      }

      if (await optionalStat(parent)) {
        await checkCanonicalDirectory(parent);
      } else {
        await this.directory(parent);
      }
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      });
      await this.event("directory-created");
      await this.flushDirectory(parent);
    }

    await checkDirectory(directory);
    await this.flushDirectory(directory);
  }

  async flushDirectory(directory: string): Promise<void> {
    await checkCanonicalDirectory(directory);
    const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await file.sync();
      await this.event("directory-flushed");
    } finally {
      await file.close();
    }
  }

  async replaceLedger(destination: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await this.event("ledger-temp-written");
      await file.sync();
      await this.event("ledger-temp-fsynced");
    } finally {
      await file.close();
    }

    // Once rename begins, a failure cannot be interpreted as a rollback.
    this.uncertain = true;
    await rename(temporary, destination);
    await this.event("ledger-renamed");
    await this.flushDirectory(path.dirname(destination));
    await this.event("ledger-dir-fsynced");
    this.uncertain = false;
  }

  async exclusiveFile(destination: string, bytes: string | Buffer): Promise<void> {
    const file = await open(destination, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }

    await this.flushDirectory(path.dirname(destination));
  }

  async flushFile(filePath: string, maximumBytes: number): Promise<void> {
    const file = await openPrivateFile(filePath, maximumBytes);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

export async function optionalStat(filePath: string) {
  return lstat(filePath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  });
}

export async function checkDirectory(directory: string) {
  const info = await checkCanonicalDirectory(directory);
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error("Managed directory must be canonical and owned by the current account");
  }

  return info;
}

async function checkCanonicalDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error("Directory flush requires a canonical regular directory");
  }

  return info;
}

export async function openPrivateFile(filePath: string, maximumBytes: number) {
  const checked = await lstat(filePath);
  if (!checked.isFile() || checked.isSymbolicLink() || checked.nlink !== 1 || checked.size > maximumBytes || (process.getuid && checked.uid !== process.getuid())) {
    throw new Error("Managed file must be a bounded regular file owned by the current account");
  }

  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1 || info.dev !== checked.dev || info.ino !== checked.ino || info.size > maximumBytes) {
    await file.close();
    throw new Error("Managed file changed during open");
  }

  return file;
}

export async function readPrivateFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const file = await openPrivateFile(filePath, maximumBytes);
  try {
    return await readBoundedFile(file, maximumBytes, "Managed file exceeds byte limit");
  } finally {
    await file.close();
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface LockOwner { token: string; pid: number; start: string | null }
const localQueues = new Map<string, Promise<void>>();

export async function withStoreLock<T>(directory: string, deadlineMs: number, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  const previous = localQueues.get(directory) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queue = previous.then(() => current);
  localQueues.set(directory, queue);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Managed store lock deadline exceeded")), Math.max(1, deadline - Date.now()));
    })]);
    if (timer) {
      clearTimeout(timer);
    }

    return await withProcessLock(directory, deadline, operation);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }

    release();
    if (localQueues.get(directory) === queue) {
      queue.then(() => { if (localQueues.get(directory) === queue) localQueues.delete(directory); });
    }
  }
}

async function withProcessLock<T>(directory: string, deadline: number, operation: () => Promise<T>): Promise<T> {
  const ownership = await acquireSyncOwnership(path.join(directory, "mutation.lock"), deadline);
  try {
    return await operation();
  } finally {
    await ownership.release();
  }
}

export async function acquireSyncOwnership(lockPath: string, deadline: number, signal?: AbortSignal) {
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, start: await processStart(process.pid) };
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const file = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
      if (hasCode(error, "EEXIST")) {
        return null;
      }

      throw error;
    });
    if (file) {
      try {
        await file.writeFile(JSON.stringify(owner));
        await file.sync();
      } catch (error) {
        await file.close();
        await rm(lockPath, { force: true });
        throw error;
      }

      return { owner, async release() {
        await file.close();
        const current = await readLock(lockPath);
        if (current?.token === owner.token) {
          await rm(lockPath);
        }
      } };
    }

    await reclaimDeadLock(lockPath);
    await delay(Math.min(20, Math.max(1, deadline - Date.now())), undefined, { signal });
  }

  throw new Error("Managed store lock deadline exceeded; unknown or live owners are never stolen");
}

export const readSyncOwnership = readLock;

async function reclaimDeadLock(lockPath: string): Promise<void> {
  // Reapers serialize too. An interrupted reaper blocks safely and requires explicit local inspection.
  const guard = await open(`${lockPath}.reap`, "wx", 0o600).catch((error: unknown) => {
    if (hasCode(error, "EEXIST")) {
      return null;
    }

    throw error;
  });
  if (!guard) {
    return;
  }

  try {
    const owner = await readLock(lockPath);
    if (!owner || !await isDeadOwner(owner)) {
      return;
    }

    const checked = await readLock(lockPath);
    if (checked?.token === owner.token && checked.pid === owner.pid && checked.start === owner.start) {
      await rm(lockPath);
    }
  } finally {
    await guard.close();
    await rm(`${lockPath}.reap`);
  }
}

async function readLock(filePath: string): Promise<LockOwner | null> {
  try {
    const record = parseObject(JSON.parse((await readPrivateFile(filePath, 4096)).toString("utf8")), "lock owner");
    assertExactKeys(record, ["token", "pid", "start"]);
    return { token: parseString(record.token), pid: parseInteger(record.pid, 1), start: record.start === null ? null : parseString(record.start) };
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof SyntaxError) {
      return null;
    }

    // A partially written or unknown ownership record blocks reclamation.
    return null;
  }
}

export async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    return start ? `${boot.trim()}:${start}` : null;
  } catch {
    return null;
  }
}

export async function isDeadOwner(owner: LockOwner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return hasCode(error, "ESRCH");
  }

  const currentStart = await processStart(owner.pid);
  return owner.start !== null && currentStart !== null && owner.start !== currentStart;
}
