import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
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

export class StoreLockQueueDeadlineError extends Error {
  constructor() {
    super("Managed store lock deadline exceeded");
  }
}

export async function withStoreLock<T>(directory: string, deadlineMs: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();

  const deadline = Date.now() + deadlineMs;
  const previous = localQueues.get(directory) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queue = previous.then(() => current);
  localQueues.set(directory, queue);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;

  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreLockQueueDeadlineError()), Math.max(1, deadline - Date.now()));
      if (signal) {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
    })]);
    if (timer) {
      clearTimeout(timer);
    }

    if (abort) signal?.removeEventListener("abort", abort);
    signal?.throwIfAborted();

    return await withProcessLock(directory, deadline, operation, signal);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }

    if (abort) signal?.removeEventListener("abort", abort);

    release();
    if (localQueues.get(directory) === queue) {
      queue.then(() => { if (localQueues.get(directory) === queue) localQueues.delete(directory); });
    }
  }
}

async function withProcessLock<T>(directory: string, deadline: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const ownership = await acquireSyncOwnership(path.join(directory, "mutation.lock"), deadline, signal);
  return finishLockOperation(async () => {
    checkAcquisition(deadline, signal);
    return await operation();
  }, () => ownership.release());
}

export interface SyncOwnershipOptions { mode?: "managed" | "portable" }

export async function acquireSyncOwnership(lockPath: string, deadline: number, signal?: AbortSignal, options: SyncOwnershipOptions = {}) {
  const owner: LockOwner = { token: randomUUID(), pid: process.pid, start: await processStart(process.pid) };
  if (options.mode === "portable") {
    return acquirePortableOwnership(lockPath, owner, deadline, signal);
  }

  checkAcquisition(deadline, signal);
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Managed ownership requires local POSIX file and directory fsync");
  }

  const parent = await openLockDirectory(path.dirname(lockPath));
  const candidate = ownerCandidate(lockPath, owner.token);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, ...owner }));
  let created: Stats | undefined;
  let held: FileHandle | undefined;
  let linkInvoked = false;

  try {
    const writable = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const completedCandidate = await finishLockOperation(async () => {
      created = await writable.stat();
      checkLockFile(created, 1);
      await writable.writeFile(bytes);
      await writable.sync();
      const complete = await writable.stat();
      checkLockFile(complete, 1);
      requireSameInode(complete, created);
      if (complete.size !== bytes.length) throw new Error("Incomplete ownership candidate");
      return created;
    }, () => closeLockHandle(writable));

    held = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await validateCandidate(candidate, held, completedCandidate, bytes);
    await parent.flush();

    while (Date.now() < deadline) {
      checkAcquisition(deadline, signal);
      await validateCandidate(candidate, held, completedCandidate, bytes);
      linkInvoked = true;
      try {
        await link(candidate, lockPath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;

        const current = await optionalStat(lockPath);
        if (current && sameInode(current, await held.stat())) throw error;

        // EEXIST never grants authority over a different public inode.
        linkInvoked = false;
        await reclaimDeadLock(lockPath, parent);
        await waitForOwnershipRetry(Math.min(20, Math.max(1, deadline - Date.now())), signal);
        continue;
      }

      await validateHeldLock(lockPath, held, bytes);
      await held.sync();
      await parent.flush();
      await removeCandidate(candidate, held, bytes);
      await validateHeldLock(lockPath, held, bytes, 1);
      await held.sync();
      await parent.flush();
      checkAcquisition(deadline, signal);
      const file = held;
      return retainedOwnership(owner, () => removeHeldLock(lockPath, file, bytes, parent), async () => {
        const results = await Promise.allSettled([closeLockHandle(file), parent.close()]);
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 1) throw new AggregateError(failures, "Ownership handles could not be closed");
        if (failures.length === 1) throw failures[0];
      });
    }

    checkAcquisition(deadline, signal);
    throw new Error("Managed store lock deadline exceeded; unknown or live owners are never stolen");
  } catch (error) {
    const failures = [error];
    try {
      if (held && linkInvoked) {
        const current = await optionalStat(lockPath);
        if (current && sameInode(current, await held.stat())) {
          await removeHeldLock(lockPath, held, bytes, parent);
        }
      }

      if (created) {
        const current = await optionalStat(candidate);
        if (current) {
          requireSameInode(current, created);
          checkLockFile(current, 1);
          await unlink(candidate);
          if (held) await held.sync();
          await parent.flush();
        }
      }
    } catch (cleanupError) {
      failures.push(cleanupError);
    }

    try { if (held) await closeLockHandle(held); } catch (closeError) { failures.push(closeError); }
    try { await parent.close(); } catch (closeError) { failures.push(closeError); }

    if (failures.length > 1) throw new AggregateError(failures, "Ownership acquisition failed; namespace uncertainty retained");
    throw error;
  }
}

// Both ownership modes serialize namespace release against descriptor disposal.
// Disposal alone deliberately leaves names as conservative authority evidence.
function retainedOwnership(owner: LockOwner, releaseNames: () => Promise<void>, dispose: () => Promise<void>) {
  let releasing: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const disposeHandles = () => disposing ??= Promise.resolve().then(dispose);

  function release(): Promise<void> {
    if (releasing) {
      return releasing;
    }

    if (disposing) {
      return releasing = Promise.reject(new Error("Ownership handles were disposed; namespace authority retained"));
    }

    return releasing = Promise.resolve().then(() => finishLockOperation(releaseNames, disposeHandles));
  }

  function closeHandles(): Promise<void> {
    return closing ??= releasing ? releasing.then(disposeHandles, disposeHandles) : disposeHandles();
  }

  return { owner, release, closeHandles };
}

async function closeLockHandle(file: FileHandle) {
  try {
    await file.close();
  } catch (error) {
    // A failed close can leave a live descriptor. A second close is safe even if the first completed.
    try { await file.close(); } catch (retryError) { throw new AggregateError([error, retryError], "Ownership handle close failed"); }
    throw error;
  }
}

async function finishLockOperation<T>(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Ownership operation and cleanup failed; namespace uncertainty retained");
    }

    throw error;
  }

  await cleanup();
  return result;
}

function checkAcquisition(deadline: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) {
    throw new Error("Managed store lock deadline exceeded; unknown or live owners are never stolen");
  }
}

async function waitForOwnershipRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    // Only this native timer's abort wrapper is normalized, before owned cleanup
    // can combine its reason with a separate filesystem or disposal failure.
    if (signal?.aborted && error instanceof Error && !(error instanceof AggregateError) &&
        error.name === "AbortError" && "code" in error && error.code === "ABORT_ERR" && error.cause === signal.reason) {
      throw signal.reason;
    }

    throw error;
  }
}

function sameInode(first: Stats, second: Stats) {
  return first.dev === second.dev && first.ino === second.ino;
}

function requireSameInode(first: Stats, second: Stats) {
  if (!sameInode(first, second)) throw new UnverifiableLockError("Ownership inode changed");
}

function checkLockFile(info: Stats, links = info.nlink, privateMode = true) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== links || links < 1 || links > 2 || info.size > 4096 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (privateMode && ((info.mode & 0o7177) !== 0 || (info.mode & 0o400) === 0))) {
    throw new UnverifiableLockError("Ownership requires a bounded private account-owned regular file with verified links");
  }
}

function sameEvidence(first: Stats, second: Stats) {
  return sameInode(first, second) && first.nlink === second.nlink && first.size === second.size &&
    first.uid === second.uid && first.mode === second.mode && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

async function lockBytes(file: FileHandle) {
  const bytes = Buffer.alloc(4097);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }

  if (offset > 4096) throw new UnverifiableLockError("Ownership record exceeds byte limit");
  return bytes.subarray(0, offset);
}

function parseLock(bytes: Buffer) {
  try {
    return decodeLock(bytes);
  } catch (error) {
    // Only pure decoding/validation is classified here; filesystem errors escape.
    throw new UnverifiableLockError("Unverifiable ownership record", false, { cause: error });
  }
}

function decodeLock(bytes: Buffer) {
  const record = parseObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "lock owner");
  const version = record.schemaVersion;
  assertExactKeys(record, version === 2 ? ["schemaVersion", "token", "pid", "start"] : ["token", "pid", "start"]);
  const owner: LockOwner = { token: parseString(record.token), pid: parseInteger(record.pid, 1, 2147483647),
    start: record.start === null ? null : parseString(record.start, "process start", 1024) };
  if (version !== undefined && version !== 2 || version === 2 && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner.token)) {
    throw new Error("Unknown or invalid ownership record");
  }

  return { owner, version };
}

function ownerCandidate(lockPath: string, token: string) {
  return path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.owner-${token}`);
}

async function openLockDirectory(directory: string) {
  const checked = await checkDirectory(directory);
  if ((checked.mode & 0o7777) !== 0o700) throw new Error("Managed lock parent must be private mode 0700");
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const validate = async () => {
    const current = await checkDirectory(directory);
    const held = await file.stat();
    requireSameInode(current, checked);
    requireSameInode(held, checked);
    if ((current.mode & 0o7777) !== 0o700 || (held.mode & 0o7777) !== 0o700) throw new Error("Managed lock parent permissions changed");
  };

  try { await validate(); } catch (error) {
    try { await closeLockHandle(file); } catch (closeError) {
      throw new AggregateError([error, closeError], "Ownership directory validation and close failed");
    }

    throw error;
  }
  return { async flush() { await validate(); await file.sync(); await validate(); }, close: () => closeLockHandle(file) };
}

type LockDirectory = Awaited<ReturnType<typeof openLockDirectory>>;

class UnverifiableLockError extends Error {
  constructor(message: string, readonly changed = false, options?: ErrorOptions) {
    super(message, options);
  }
}

// This exception belongs only to lock publication. General private-file readers still require one link.
async function lockSnapshot(lockPath: string, privateMode = true) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const checked = await lstat(lockPath);
    checkLockFile(checked, checked.nlink, privateMode);
    const file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      checkLockFile(before, before.nlink, privateMode);
      if (!sameEvidence(checked, before)) throw new UnverifiableLockError("Ownership changed during open", true);
      const bytes = await lockBytes(file);
      const record = parseLock(bytes);
      let candidate: string | null = null;

      if (before.nlink === 2) {
        if (record.version !== 2) throw new UnverifiableLockError("Legacy ownership must have one link");
        const pairPath = ownerCandidate(lockPath, record.owner.token);
        candidate = pairPath;
        const named = await lstat(pairPath);
        checkLockFile(named, 2, privateMode);
        requireSameInode(named, before);
        const pair = await open(pairPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        await finishLockOperation(async () => {
          const pairBefore = await pair.stat();
          if (!sameEvidence(before, pairBefore) || !bytes.equals(await lockBytes(pair)) ||
              !sameEvidence(pairBefore, await pair.stat()) || !sameEvidence(pairBefore, await lstat(pairPath))) {
            throw new UnverifiableLockError("Ownership candidate pair changed", true);
          }
        }, () => closeLockHandle(pair));
      }

      if (!sameEvidence(before, await file.stat()) || !sameEvidence(before, await lstat(lockPath))) {
        throw new UnverifiableLockError("Ownership changed during snapshot", true);
      }

      return { file, info: before, bytes, ...record, candidate };
    } catch (error) {
      // A holder may unlink C while this reader opens the exact pair. Retry only that transition.
      const failures = [error];
      let after: Stats | undefined;
      try { after = await file.stat(); } catch (inspectionError) { failures.push(inspectionError); }
      try { await closeLockHandle(file); } catch (closeError) { failures.push(closeError); }

      if (failures.length > 1) throw new AggregateError(failures, "Ownership snapshot failed; namespace uncertainty retained");
      const changed = hasCode(error, "ENOENT") || error instanceof UnverifiableLockError && error.changed;
      if (changed && checked.nlink === 2 && after?.nlink === 1 && sameInode(checked, after) && attempt < 3) continue;
      throw error;
    }
  }

  throw new UnverifiableLockError("Ownership snapshot did not stabilize");
}

async function reaperSnapshot(lockPath: string, privateMode: boolean) {
  try {
    return await lockSnapshot(lockPath, privateMode);
  } catch (error) {
    if (error instanceof UnverifiableLockError || hasCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

async function validateCandidate(candidate: string, file: FileHandle, created: Stats, bytes: Buffer) {
  const before = await file.stat();
  checkLockFile(before, 1);
  requireSameInode(before, created);
  if (!sameEvidence(before, await lstat(candidate)) || !bytes.equals(await lockBytes(file)) || !sameEvidence(before, await file.stat()) || !sameEvidence(before, await lstat(candidate))) {
    throw new Error("Ownership candidate changed");
  }
}

async function validateHeldLock(lockPath: string, file: FileHandle, bytes: Buffer, links?: number) {
  const snapshot = await lockSnapshot(lockPath);
  return finishLockOperation(async () => {
    if (!sameEvidence(snapshot.info, await file.stat())) throw new Error("Ownership inode or metadata changed");
    if (!snapshot.bytes.equals(bytes) || links !== undefined && snapshot.info.nlink !== links) throw new Error("Ownership identity changed");
    return snapshot;
  }, () => closeLockHandle(snapshot.file));
}

async function removeCandidate(candidate: string, file: FileHandle, bytes: Buffer) {
  const info = await file.stat();
  const named = await optionalStat(candidate);
  if (!named) return;
  checkLockFile(named, info.nlink);
  requireSameInode(named, info);
  if (!bytes.equals(await lockBytes(file)) || !sameEvidence(info, await file.stat()) || !sameEvidence(named, await lstat(candidate))) {
    throw new Error("Ownership bytes or candidate changed before removal");
  }

  await unlink(candidate);
}

async function removeHeldLock(lockPath: string, file: FileHandle, bytes: Buffer, parent: LockDirectory) {
  const snapshot = await validateHeldLock(lockPath, file, bytes);
  if (snapshot.candidate) {
    await removeCandidate(snapshot.candidate, file, bytes);
    await validateHeldLock(lockPath, file, bytes, 1);
    await file.sync();
    await parent.flush();
  }

  await validateHeldLock(lockPath, file, bytes, 1);
  await unlink(lockPath);
  // Never inspect or target L after unlink: a successor can already own that name.
  await parent.flush();
}

async function reclaimDeadLock(lockPath: string, parent?: LockDirectory): Promise<void> {
  const original = await reaperSnapshot(lockPath, Boolean(parent));
  if (!original) return;

  const failures: unknown[] = [];
  try {
    if (!await isDeadOwner(original.owner)) return;
    await reclaimCheckedDeadLock(lockPath, original, parent);
  } catch (error) {
    failures.push(error);
  } finally {
    try { await closeLockHandle(original.file); } catch (error) { failures.push(error); }

    if (failures.length > 1) throw new AggregateError(failures, "Reaper failed; namespace uncertainty retained");
    if (failures.length === 1) throw failures[0];
  }
}

async function reclaimCheckedDeadLock(lockPath: string, original: Awaited<ReturnType<typeof lockSnapshot>>, parent?: LockDirectory) {
  const guardPath = `${lockPath}.reap`;
  const guard = await open(guardPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((error: unknown) => {
    if (hasCode(error, "EEXIST")) return null;
    throw error;
  });
  if (!guard) return;

  let guardInfo: Stats | undefined;
  const failures: unknown[] = [];
  try {
    guardInfo = await guard.stat();
    const snapshot = await reaperSnapshot(lockPath, Boolean(parent));
    if (!snapshot) return;
    try {
      if (!sameEvidence(snapshot.info, original.info) || !snapshot.bytes.equals(original.bytes) ||
          snapshot.owner.token !== original.owner.token || snapshot.owner.pid !== original.owner.pid || snapshot.owner.start !== original.owner.start ||
          !await isDeadOwner(snapshot.owner)) return;
      if (parent) {
        await removeHeldLock(lockPath, snapshot.file, snapshot.bytes, parent);
      } else {
        await validatePortableLock(lockPath, snapshot.file, snapshot.bytes);
        await unlink(lockPath);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try { await closeLockHandle(snapshot.file); } catch (error) { failures.push(error); }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (!guardInfo) throw new Error("Reaper guard identity is uncertain");
      const current = await lstat(guardPath);
      checkLockFile(current, 1, Boolean(parent));
      requireSameInode(current, guardInfo);
      requireSameInode(await guard.stat(), guardInfo);
      await unlink(guardPath);
      if (parent) await parent.flush();
    } catch (error) {
      failures.push(error);
    }

    try { await closeLockHandle(guard); } catch (error) { failures.push(error); }

    if (failures.length > 1) throw new AggregateError(failures, "Reaper cleanup failed; namespace uncertainty retained");
    if (failures.length === 1) throw failures[0];
  }
}

async function readLock(filePath: string): Promise<LockOwner | null> {
  try {
    const snapshot = await lockSnapshot(filePath, process.platform !== "win32");
    try { return snapshot.owner; } finally { await closeLockHandle(snapshot.file); }
  } catch {
    // Empty, partial, unknown and unsafe records never establish owner death.
    return null;
  }
}

export const readSyncOwnership = readLock;

async function validatePortableLock(lockPath: string, file: FileHandle, bytes: Buffer) {
  const current = await lockSnapshot(lockPath, false);
  return finishLockOperation(async () => {
    requireSameInode(current.info, await file.stat());
    if (!current.bytes.equals(bytes) || current.info.nlink !== 1) throw new Error("Portable ownership changed");
  }, () => closeLockHandle(current.file));
}

async function acquirePortableOwnership(lockPath: string, owner: LockOwner, deadline: number, signal?: AbortSignal) {
  const bytes = Buffer.from(JSON.stringify(owner));
  while (Date.now() < deadline) {
    checkAcquisition(deadline, signal);
    const file = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
      if (hasCode(error, "EEXIST")) return null;
      throw error;
    });
    if (file) {
      let created: Stats | undefined;
      try {
        created = await file.stat();
        await file.writeFile(bytes);
        await file.sync();
        checkAcquisition(deadline, signal);
      } catch (error) {
        return finishLockOperation(async () => { throw error; }, () => finishLockOperation(async () => {
          if (!created) return;

          requireSameInode(await lstat(lockPath), created);
          await unlink(lockPath);
        }, () => closeLockHandle(file)));
      }

      return retainedOwnership(owner, async () => {
        await validatePortableLock(lockPath, file, bytes);
        await unlink(lockPath);
      }, () => closeLockHandle(file));
    }

    await reclaimDeadLock(lockPath);
    await waitForOwnershipRetry(Math.min(20, Math.max(1, deadline - Date.now())), signal);
  }

  checkAcquisition(deadline, signal);
  throw new Error("Managed store lock deadline exceeded; unknown or live owners are never stolen");
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
