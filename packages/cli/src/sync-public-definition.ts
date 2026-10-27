import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";

/** Public boot definitions can be installed by root; their contents must never be writable by other users. */
export async function readPublicSyncDefinition(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || await realpath(filePath) !== filePath) {
    throw new Error("Supervisor definition requires a canonical absolute file");
  }

  const checked = await lstat(filePath);
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const hasTrustedOwner = info.uid === 0 || !process.getuid || info.uid === process.getuid();
    if (!info.isFile() || checked.isSymbolicLink() || info.nlink !== 1 || info.dev !== checked.dev || info.ino !== checked.ino ||
        info.size > 64 * 1024 || !hasTrustedOwner || (info.mode & 0o022) !== 0) {
      throw new Error("Supervisor definition must be a bounded regular root/current-account file without shared write permissions");
    }

    return (await readBoundedFile(file, 64 * 1024, "Supervisor definition exceeds limit")).toString("utf8");
  } finally {
    await file.close();
  }
}
