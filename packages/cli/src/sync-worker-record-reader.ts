import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { readBoundedFile } from "./bounded-file";
import { hasCode } from "./sync-files";
import { parseCanonicalFilePath } from "./sync-runtime-config";

const maximumBytes = 8192;

function assertSafeRecord(info: BigIntStats): void {
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077n) !== 0n ||
      info.size < 0n || info.size > BigInt(maximumBytes) ||
      process.getuid && info.uid !== BigInt(process.getuid())) {
    throw new Error("Worker record must be a bounded regular owned file with private permissions");
  }

  if (info.nlink !== 0n && info.nlink !== 1n) {
    throw new Error("Worker record must have at most one link");
  }
}

function isSameSnapshot(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode &&
    first.uid === second.uid && first.size === second.size && first.mtimeNs === second.mtimeNs;
}

async function readSnapshot(recordPath: string): Promise<Buffer | undefined> {
  if (await realpath(recordPath) !== recordPath) {
    throw new Error("Runtime file references cannot contain symbolic links");
  }

  const checked = await lstat(recordPath, { bigint: true });
  assertSafeRecord(checked);
  // Shutdown removes this immutable record. An unlinked observation authorizes
  // another bounded lookup, never use of the removed process's control credential.
  if (checked.nlink === 0n) {
    return undefined;
  }

  const file = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    assertSafeRecord(opened);
    if (checked.dev !== opened.dev) {
      throw new Error("Worker record changed filesystem during open");
    }

    if (checked.ino !== opened.ino) {
      return undefined;
    }

    if (!isSameSnapshot(checked, opened)) {
      throw new Error("Worker record metadata changed during open");
    }

    if (opened.nlink === 0n) {
      return undefined;
    }

    const bytes = await readBoundedFile(file, maximumBytes, "Worker record exceeds byte limit");
    const completed = await file.stat({ bigint: true });
    assertSafeRecord(completed);
    if (!isSameSnapshot(opened, completed)) {
      throw new Error("Worker record metadata changed during read");
    }

    if (completed.nlink === 0n) {
      return undefined;
    }

    return bytes;
  } finally {
    await file.close();
  }
}

/** Runtime records are immutable publications that may disappear during worker shutdown. */
export async function readWorkerRecordBytes(recordPath: string): Promise<Buffer | null> {
  parseCanonicalFilePath(recordPath);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const bytes = await readSnapshot(recordPath);
      if (bytes !== undefined) {
        return bytes;
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    }
  }

  throw new Error("Worker record changed repeatedly during read");
}
