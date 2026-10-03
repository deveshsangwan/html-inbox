import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory, hardenPrivateFile } from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";
import { hasErrorCode, isValidPid } from "./viewer-records";

export interface ViewerStartLock {
  token: string;
  release(): Promise<void>;
}

export async function acquireViewerStartLock(home: string): Promise<ViewerStartLock> {
  await ensurePrivateDirectory(home);
  const lockPath = path.join(home, "viewer-start.lock");
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      return await createLock(lockPath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }

    const record = await readLock(lockPath);
    if (record && !isProcessAlive(record.pid)) {
      await recoverAbandonedLock(lockPath, record.token);
      continue;
    }

    await delay(50);
  }

  throw new Error(`Another viewer startup is still running; inspect ${lockPath}`);
}

export async function hasInheritedViewerStartLock(home: string): Promise<boolean> {
  const token = process.env.HTML_INBOX_START_LOCK;
  if (!token) {
    return false;
  }

  assertUuidV4(token, "Viewer startup lock token");
  const record = await readLock(path.join(home, "viewer-start.lock"));
  if (!record || record.token !== token || record.pid !== process.ppid || !isProcessAlive(record.pid)) {
    throw new Error("Detached viewer startup lock is missing or stale");
  }

  delete process.env.HTML_INBOX_START_LOCK;

  return true;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

async function createLock(lockPath: string): Promise<ViewerStartLock> {
  const token = randomUUID();
  const file = await open(lockPath, "wx", 0o600);

  try {
    await file.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
  } catch (error) {
    await file.close();
    await rm(lockPath, { force: true });
    throw error;
  }

  return {
    token,
    async release() {
      await file.close();
      const record = await readLock(lockPath);
      if (record?.token === token) {
        await rm(lockPath, { force: true });
      }
    },
  };
}

async function readLock(lockPath: string) {
  try {
    await hardenPrivateFile(lockPath);
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!isRecord(value) || !isValidPid(value.pid) || typeof value.token !== "string") {
      throw new Error("invalid lock record");
    }

    assertUuidV4(value.token, "Viewer startup lock token");
    return { pid: value.pid, token: value.token };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    const fileStat = await lstat(lockPath).catch((statError: unknown) => {
      if (hasErrorCode(statError, "ENOENT")) {
        return null;
      }

      throw statError;
    });
    if (!fileStat || Date.now() - fileStat.mtimeMs < 1000) {
      return null;
    }

    throw new Error(`Cannot verify viewer startup lock ${lockPath}; stop viewer startup commands before removing the malformed lock`);
  }
}

async function recoverAbandonedLock(lockPath: string, token: string): Promise<void> {
  let guard: ViewerStartLock;
  try {
    guard = await createLock(`${lockPath}.recovery`);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      const recovery = await readLock(`${lockPath}.recovery`);
      if (recovery && !isProcessAlive(recovery.pid)) {
        throw new Error(`Abandoned viewer startup recovery guard ${lockPath}.recovery; stop viewer startup commands before removing this guard`);
      }

      await delay(50);
      return;
    }

    throw error;
  }

  try {
    const record = await readLock(lockPath);
    if (record?.token === token && !isProcessAlive(record.pid)) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await guard.release();
  }
}
