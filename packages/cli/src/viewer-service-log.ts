import { Console } from "node:console";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, ManagedStorageError } from "./private-storage";

export async function configureViewerServiceLogging(
  home: string,
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === 0) {
    throw new Error(
      "Viewer service diagnostics must be opened by the selected non-root user",
    );
  }

  await ensurePrivateDirectory(home);
  const logPath = path.join(home, "viewer.log");
  const log = await open(
    logPath,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    const info = await log.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (uid !== undefined && info.uid !== uid)
    ) {
      throw new ManagedStorageError(
        `Service diagnostic log must be a private regular file owned by the viewer user: ${logPath}`,
      );
    }

    await log.chmod(0o600);
  } catch (error) {
    await log.close();
    throw error;
  }

  const originalConsole = console;
  const output = log.createWriteStream();
  output.once("error", (error) => {
    originalConsole.error(
      `html-inbox: Service diagnostic log failed: ${error.message}`,
    );
    process.exitCode = 1;
    process.emit("SIGTERM");
  });
  process.once("beforeExit", () => output.end());
  globalThis.console = new Console({ stdout: output, stderr: output });
}
