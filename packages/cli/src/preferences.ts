import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { hardenPrivateDirectory, ManagedStorageError, PRIVATE_FILE_MODE, writeAtomicPrivateJson } from "./private-storage";
import { isRecord } from "./validation";

export type Appearance = "system" | "light" | "dark";

export function parseAppearance(value: unknown): Appearance {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new Error("Appearance must be system, light, or dark");
  }

  return value;
}

export async function readPreferences(home: string): Promise<{ appearance: Appearance }> {
  try {
    await hardenPrivateDirectory(home);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { appearance: "system" };
    }

    throw error;
  }

  const filePath = path.join(home, "preferences.json");
  const checked = await lstat(filePath).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  });
  if (!checked) {
    return { appearance: "system" };
  }

  if (!checked.isFile() || checked.isSymbolicLink() || checked.nlink > 1) {
    throw new ManagedStorageError(`Preferences must be a regular private file: ${filePath}`);
  }

  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink > 1 || (!constants.O_NOFOLLOW && (info.dev !== checked.dev || info.ino !== checked.ino))) {
      throw new ManagedStorageError(`Preferences must be a regular private file: ${filePath}`);
    }

    await file.chmod(PRIVATE_FILE_MODE);
    const bytes = await readBoundedFile(file, 4096, `Preferences file is too large: ${filePath}`);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Preferences file contains invalid JSON: ${filePath}`, { cause: error });
    }

    if (!isRecord(value) || value.schemaVersion !== 1) {
      throw new Error(`Preferences file must use schema version 1: ${filePath}`);
    }

    return { appearance: parseAppearance(value.appearance) };
  } finally {
    await file.close();
  }
}

export async function setAppearancePreference(home: string, appearance: Appearance): Promise<{ appearance: Appearance }> {
  const preferences = { appearance: parseAppearance(appearance) };
  await readPreferences(home);

  await writeAtomicPrivateJson(path.join(home, "preferences.json"), { schemaVersion: 1, ...preferences });
  return preferences;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
