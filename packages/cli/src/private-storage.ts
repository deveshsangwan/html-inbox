import { randomUUID } from "node:crypto";
import path from "node:path";
import { chmod, lstat, mkdir, writeFile, rename, rm } from "node:fs/promises";

export class ManagedStorageError extends Error {}

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDirectory(
  directoryPath: string,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await hardenPrivateDirectory(directoryPath);
}

export async function hardenPrivateDirectory(
  directoryPath: string,
): Promise<void> {
  const fileStat = await lstat(directoryPath);
  if (!fileStat.isDirectory() || fileStat.isSymbolicLink()) {
    throw new ManagedStorageError(
      `Managed directory is not a regular directory: ${directoryPath}`,
    );
  }
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export async function hardenPrivateFile(filePath: string): Promise<void> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new ManagedStorageError(
      `Managed file is not a regular file: ${filePath}`,
    );
  }
  await chmod(filePath, PRIVATE_FILE_MODE);
}

export async function writePrivateFile(
  filePath: string,
  contents: string | Uint8Array,
  options: { flag?: string } = {},
): Promise<void> {
  try {
    await hardenPrivateFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(filePath, contents, {
    flag: options.flag,
    mode: PRIVATE_FILE_MODE,
  });
  await hardenPrivateFile(filePath);
}

export async function writeAtomicPrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writePrivateFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx" },
    );
    try {
      await hardenPrivateFile(filePath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await rename(temporaryPath, filePath);
    await hardenPrivateFile(filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
