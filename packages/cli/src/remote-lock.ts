import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { hardenPrivateFile } from "./private-storage";
import { isRecord } from "./validation";

export async function acquireRemoteLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  const token = randomUUID();

  try {
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
        if (isRecord(record) && record.token === token)
          await rm(lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          process.emitWarning(
            `Could not release remote mutation lock: ${(error as Error).message}`,
          );
        }
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    await hardenPrivateFile(lockPath);
    let record: Record<string, unknown>;

    try {
      const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (!isRecord(parsed)) throw new Error("invalid lock record");

      record = parsed;
    } catch {
      throw staleLockError(lockPath);
    }

    if (typeof record.pid === "number" && isProcessAlive(record.pid)) {
      throw new Error(
        `Another HTML Inbox remote command is running (pid ${record.pid})`,
      );
    }

    // Removing a stale lock automatically could race a process starting its operation.
    throw staleLockError(lockPath);
  }
}

function staleLockError(lockPath: string): Error {
  return new Error(
    `Stale HTML Inbox remote lock found at ${lockPath}; remove it after confirming no command is running`,
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
