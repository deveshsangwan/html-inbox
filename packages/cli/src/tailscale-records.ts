import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import {
  hardenPrivateDirectory,
  hardenPrivateFile,
  writeAtomicPrivateJson,
} from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";
import { assertTailnetHostname } from "./tailscale-config";
import type {
  PreparedTailscale,
  TailscaleViewerOptions,
} from "./viewer-tailscale";

export interface TailscaleOwnership extends PreparedTailscale {
  version: 1;
  phase: "pending" | "active";
  httpsPort: 443;
  mount: "/";
  proxy: string;
}

export function assertViewerOptions(options: TailscaleViewerOptions): void {
  if (!path.isAbsolute(options.home) || options.home.includes("\0")) {
    throw new Error("Tailscale viewer home must be an absolute path");
  }

  if (
    !Number.isSafeInteger(options.backendPort) ||
    options.backendPort < 0 ||
    options.backendPort > 65535
  ) {
    throw new Error(
      "Tailscale backend port must be an integer between 0 and 65535",
    );
  }

  assertUuidV4(options.instanceId, "Tailscale inbox identity");
  assertUuidV4(options.processId, "Tailscale viewer process identity");
}

export function assertPreparedTailscale(value: PreparedTailscale): void {
  assertViewerOptions(value);
  assertTailnetHostname(value.hostname);
  if (
    !value.nodeId ||
    value.nodeId.length > 256 ||
    /[\x00-\x20]/.test(value.nodeId)
  ) {
    throw new Error("Tailscale connected node ID is invalid");
  }

  if (
    value.url !== `https://${value.hostname}` ||
    !path.isAbsolute(value.executable) ||
    value.executable.includes("\0")
  ) {
    throw new Error(
      "Tailscale URL or executable does not match the prepared configuration",
    );
  }
}

function ownershipPath(home: string) {
  return path.join(home, "tailscale-serve.json");
}

export async function readTailscaleOwnership(
  home: string,
): Promise<TailscaleOwnership | undefined> {
  if (!path.isAbsolute(home) || home.includes("\0")) {
    throw new Error("Tailscale viewer home must be an absolute path");
  }

  const filePath = ownershipPath(home);
  try {
    await hardenPrivateDirectory(home);
    await hardenPrivateFile(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const file = await open(
    filePath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let value: unknown;
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error("Tailscale ownership record is not a regular file");
    }

    const bytes = await readBoundedFile(
      file,
      16 * 1024,
      "Tailscale ownership record is too large to trust",
    );
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      "Tailscale ownership record cannot be read; inspect tailscale-serve.json before recovery",
      { cause: error },
    );
  } finally {
    await file.close();
  }

  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "phase",
          "home",
          "backendPort",
          "instanceId",
          "processId",
          "nodeId",
          "hostname",
          "url",
          "executable",
          "httpsPort",
          "mount",
          "proxy",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    (value.phase !== "pending" && value.phase !== "active") ||
    value.home !== home ||
    typeof value.backendPort !== "number" ||
    typeof value.instanceId !== "string" ||
    typeof value.processId !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.hostname !== "string" ||
    typeof value.url !== "string" ||
    typeof value.executable !== "string" ||
    value.httpsPort !== 443 ||
    value.mount !== "/" ||
    value.proxy !== `http://127.0.0.1:${value.backendPort}` ||
    value.backendPort === 0
  ) {
    throw new Error(
      "Tailscale ownership record is invalid and cannot authorize cleanup",
    );
  }

  const ownership: TailscaleOwnership = {
    version: 1,
    phase: value.phase,
    home,
    backendPort: value.backendPort,
    instanceId: value.instanceId,
    processId: value.processId,
    nodeId: value.nodeId,
    hostname: value.hostname,
    url: value.url,
    executable: value.executable,
    httpsPort: 443,
    mount: "/",
    proxy: `http://127.0.0.1:${value.backendPort}`,
  };
  assertPreparedTailscale(ownership);

  return ownership;
}

export async function writeTailscaleOwnership(
  ownership: TailscaleOwnership,
): Promise<void> {
  await writeAtomicPrivateJson(ownershipPath(ownership.home), ownership);
}

export async function removeTailscaleOwnership(home: string): Promise<void> {
  await rm(ownershipPath(home), { force: true });
}

export async function withTailscaleServeLock<T>(
  nodeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const nodeHash = createHash("sha256")
    .update(nodeId)
    .digest("hex")
    .slice(0, 24);
  const userId = process.getuid?.() ?? process.env.USERNAME ?? "user";
  const lockPath = path.join(
    tmpdir(),
    `html-inbox-tailscale-${userId}-${nodeHash}.lock`,
  );
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(
        `Another HTML Inbox operation owns this Tailscale node lock: ${lockPath}. Retry when it finishes. If its process crashed, inspect owner.json and remove only this stale lock directory.`,
      );
    }

    throw error;
  }

  try {
    await writeAtomicPrivateJson(path.join(lockPath, "owner.json"), {
      pid: process.pid,
      nodeId,
    });
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
