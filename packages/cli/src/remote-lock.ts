import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { hardenPrivateFile } from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";

export async function acquireRemoteLock(
  lockPath: string,
  recoverLock = false,
): Promise<() => Promise<void>> {
  try {
    return await createRemoteLock(lockPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  if (recoverLock) {
    return recoverRemoteLock(lockPath);
  }

  await readAbandonedRemoteLock(lockPath);
  throw staleLockError(lockPath);
}

async function createRemoteLock(lockPath: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const handle = await open(lockPath, "wx", 0o600);

  try {
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }

  return async () => {
    await handle.close();

    try {
      const record: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (isRecord(record) && record.token === token) {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        process.emitWarning(`Could not release remote mutation lock: ${message}`);
      }
    }
  };
}

async function recoverRemoteLock(lockPath: string): Promise<() => Promise<void>> {
  const recoveryPath = `${lockPath}.recovery`;
  let releaseRecovery: () => Promise<void>;

  try {
    releaseRecovery = await createRemoteLock(recoveryPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }

    throw new Error(
      `Remote lock recovery is already in progress or was interrupted: ${recoveryPath}; stop all remote commands before following the manual lock recovery procedure in docs/remote-migration.md`,
    );
  }

  try {
    // Only the recovery guard's owner may unlink an abandoned mutation lock.
    // An interrupted guard stays in place for deliberate offline recovery.
    const record = await readAbandonedRemoteLock(lockPath);
    const current = await readAbandonedRemoteLock(lockPath);
    if (
      current.token !== record.token ||
      current.pid !== record.pid ||
      current.createdAt !== record.createdAt
    ) {
      throw new Error(`Remote lock changed during recovery: ${lockPath}; retry remote reconcile`);
    }

    await rm(lockPath);

    // A normal writer can win this gap. Exclusive creation must reject it;
    // recovery must never unlink that writer's replacement lock.
    return await acquireRemoteLock(lockPath);
  } finally {
    await releaseRecovery();
  }
}

async function readAbandonedRemoteLock(lockPath: string) {
  await hardenPrivateFile(lockPath);
  let record: { pid: number; token: string; createdAt: string };

  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      !isRecord(value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid > 2_147_483_647
    ) {
      throw new Error("invalid lock owner PID");
    }

    if (typeof value.token !== "string") {
      throw new Error("invalid lock token");
    }

    assertUuidV4(value.token, "remote lock token");
    if (
      typeof value.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      throw new Error("invalid lock creation time");
    }

    record = {
      pid: value.pid,
      token: value.token,
      createdAt: value.createdAt,
    };
  } catch {
    throw new Error(
      `Stale HTML Inbox remote lock at ${lockPath}. Cannot verify this remote lock; stop all remote commands before following the manual lock recovery procedure in docs/remote-migration.md`,
    );
  }

  // A reused PID or an inconclusive probe remains a live owner. Lock age is
  // never proof that the owner has stopped, and recovery sends no kill signal.
  if (isProcessAlive(record.pid)) {
    throw new Error(`Another HTML Inbox remote command is running (pid ${record.pid})`);
  }

  return record;
}

function staleLockError(lockPath: string): Error {
  return new Error(
    `Stale HTML Inbox remote lock found at ${lockPath}; after confirming the previous command terminated on this machine, run html-inbox remote reconcile --recover-lock`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error) || !("code" in error) || error.code !== "ESRCH";
  }
}
