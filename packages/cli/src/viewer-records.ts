import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { ensurePrivateDirectory, hardenPrivateFile, ManagedStorageError, writeAtomicPrivateJson, writePrivateFile } from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";
import { parseViewerNetworkConfig, type ViewerNetworkConfig } from "./viewer-network";

export interface ViewerRecord {
  pid: number;
  instanceId: string;
  processId: string;
  protocolVersion: number;
  config: ViewerNetworkConfig;
  urls: string[];
  controlUrl: string;
  startedAt: string;
  shutdownError?: string;
}

export interface SavedViewerConfiguration {
  config: ViewerNetworkConfig;
  urls: string[];
  tailscaleExecutable?: string;
}

export async function getInboxInstanceId(home: string): Promise<string> {
  await ensurePrivateDirectory(home);
  const identityPath = path.join(home, "instance-id");

  try {
    await writePrivateFile(identityPath, randomUUID(), { flag: "wx" });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  await hardenPrivateFile(identityPath);
  const instanceId = (await readFile(identityPath, "utf8")).trim();
  assertUuidV4(instanceId, `HTML Inbox instance identity at ${identityPath}`);

  return instanceId;
}

export async function readViewerRecord(home: string): Promise<ViewerRecord | null> {
  const value = await readPrivateJson(path.join(home, "viewer.json"));
  if (value === null) {
    return null;
  }

  if (isRecord(value) && value.config === undefined && value.controlUrl === undefined &&
      typeof value.host === "string" && typeof value.port === "number" && isValidPid(value.pid)) {
    throw new Error("Older viewer process record: stop the older viewer with its previous executable before starting this version");
  }

  if (!isRecord(value) || !isValidPid(value.pid) || typeof value.instanceId !== "string" ||
      typeof value.processId !== "string" || typeof value.protocolVersion !== "number" ||
      !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1 ||
      typeof value.controlUrl !== "string" || typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      (value.shutdownError !== undefined && typeof value.shutdownError !== "string")) {
    throw new Error(`Invalid viewer process record at ${path.join(home, "viewer.json")}`);
  }

  assertUuidV4(value.instanceId, "Viewer inbox identity");
  assertUuidV4(value.processId, "Viewer process identity");
  const config = parseViewerNetworkConfig(value.config);
  if (config.port === 0) {
    throw new Error("Viewer process record has no listening port");
  }

  const control = new URL(value.controlUrl);
  const controlToken = /^\/control\/([A-Za-z0-9_-]{43})$/.exec(control.pathname)?.[1];
  if (control.protocol !== "http:" || control.hostname !== "127.0.0.1" || !control.port ||
      control.username || control.password || control.search || control.hash || !controlToken ||
      Buffer.from(controlToken, "base64url").toString("base64url") !== controlToken) {
    throw new Error("Viewer control endpoint must be a private loopback URL");
  }

  return {
    pid: value.pid,
    instanceId: value.instanceId,
    processId: value.processId,
    protocolVersion: value.protocolVersion,
    config,
    urls: parseViewerUrls(value.urls, config),
    controlUrl: value.controlUrl,
    startedAt: value.startedAt,
    ...(value.shutdownError ? { shutdownError: value.shutdownError } : {}),
  };
}

export async function readSavedViewerConfiguration(home: string): Promise<SavedViewerConfiguration | null> {
  const value = await readPrivateJson(path.join(home, "viewer-config.json"));
  if (value === null) {
    return null;
  }

  if (!isRecord(value) || value.version !== 1 ||
      (value.tailscaleExecutable !== undefined && (typeof value.tailscaleExecutable !== "string" ||
        !path.isAbsolute(value.tailscaleExecutable)))) {
    throw new Error(`Invalid saved viewer configuration at ${path.join(home, "viewer-config.json")}`);
  }

  const config = parseViewerNetworkConfig(value.config);
  if (config.port === 0) {
    throw new Error("Saved viewer configuration has no selected port");
  }

  return {
    config,
    urls: parseViewerUrls(value.urls, config),
    tailscaleExecutable: value.tailscaleExecutable,
  };
}

export async function writeViewerRecord(home: string, record: ViewerRecord): Promise<void> {
  await writeAtomicPrivateJson(path.join(home, "viewer.json"), record);
}

export async function saveViewerConfiguration(home: string, saved: SavedViewerConfiguration): Promise<void> {
  await writeAtomicPrivateJson(path.join(home, "viewer-config.json"), { version: 1, ...saved });
}

export async function removeViewerRecord(home: string, processId: string): Promise<void> {
  const record = await readViewerRecord(home);
  if (record?.processId === processId) {
    await rm(path.join(home, "viewer.json"), { force: true });
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

async function readPrivateJson(filePath: string, remainingAttempts = 3): Promise<unknown> {
  const checked = constants.O_NOFOLLOW ? undefined : await lstat(filePath).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    });
  if (checked === null) {
    return null;
  }

  if (checked && (!checked.isFile() || checked.isSymbolicLink())) {
    throw new ManagedStorageError(`Managed file is not a regular file: ${filePath}`);
  }

  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0)).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    if (hasErrorCode(error, "ELOOP")) {
      throw new ManagedStorageError(`Managed file is not a regular file: ${filePath}`, { cause: error });
    }

    throw error;
  });
  if (!file) {
    return null;
  }

  try {
    const info = await file.stat();
    if (!info.isFile()) {
      throw new ManagedStorageError(`Managed file is not a regular file: ${filePath}`);
    }

    const current = checked && info.nlink > 0 ? await lstat(filePath).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    }) : undefined;
    if (info.nlink > 1 || (current && (!current.isFile() || current.isSymbolicLink() || current.nlink > 1))) {
      throw new ManagedStorageError(`Viewer record must be a regular private file: ${filePath}`);
    }

    const hasSameFallbackFile = !checked || (checked.dev === info.dev && checked.ino === info.ino &&
      current !== undefined && current !== null && current.dev === info.dev && current.ino === info.ino);
    if (info.nlink === 0 || current === null || !hasSameFallbackFile) {
      if (remainingAttempts === 0) {
        throw new ManagedStorageError(`Viewer record changed repeatedly during read; retry the command: ${filePath}`);
      }

      return readPrivateJson(filePath, remainingAttempts - 1);
    }

    // Administrator service commands read selected-user records without changing them.
    if (process.getuid?.() !== 0) {
      await file.chmod(0o600);
    }

    const bytes = await readBoundedFile(file, 64 * 1024, `Viewer record is too large: ${filePath}`);
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await file.close();
  }
}

function parseViewerUrls(value: unknown, config: ViewerNetworkConfig): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("Viewer record must contain usable URLs");
  }

  return value.map((entry: unknown) => {
    if (typeof entry !== "string") {
      throw new Error("Viewer URL must be a string");
    }

    const url = new URL(entry);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || url.hostname === "0.0.0.0" || url.hostname === "[::]") {
      throw new Error("Viewer URL must be a usable HTTP origin");
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (config.exposure === "tailscale") {
      if (url.protocol !== "https:" || hostname !== config.tailscaleHostname || port !== 443) {
        throw new Error("Viewer URL does not match its Tailscale configuration");
      }
    } else if (url.protocol !== "http:" || port !== config.port || isIP(hostname) === 0 ||
        (config.host !== "0.0.0.0" && config.host !== "::" && hostname !== config.host) ||
        (config.host === "0.0.0.0" && isIP(hostname) !== 4)) {
      throw new Error("Viewer URL does not match its listening configuration");
    }

    return url.origin;
  });
}
