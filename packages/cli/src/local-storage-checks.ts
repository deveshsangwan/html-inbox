import { type Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export function isSameAccount(uid: number): boolean {
  return !process.getuid || uid === process.getuid();
}

export function isOwnedDirectory(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && isSameAccount(info.uid);
}

export function isOwnedRegularFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && isSameAccount(info.uid);
}

export async function checkCanonicalDirectory(directory: string) {
  const info = await lstat(directory);
  const canonicalPath = path.isAbsolute(directory) ? directory : path.join(await realpath("."), directory);

  if (!isOwnedDirectory(info) || await realpath(directory) !== canonicalPath) {
    throw new Error("Local directory must be canonical and owned by the current account");
  }

  return info;
}

export async function checkRegularFile(filePath: string) {
  const info = await lstat(filePath);

  if (!isOwnedRegularFile(info)) {
    throw new Error("Local file must be a regular file owned by the current account without hardlinks");
  }

  return info;
}
