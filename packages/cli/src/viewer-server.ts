import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { DocumentBackend } from "./documents";
import { assertUuidV4, isRecord } from "./validation";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
  writeAtomicPrivateJson,
} from "./private-storage";
import { startViewerHttpServer } from "./viewer-http-server";
import { resolveViewerNetworkConfig } from "./viewer-network";

const HOST = "127.0.0.1";
export const VIEWER_PROTOCOL_VERSION = 2;

export interface ViewerStatus {
  state: "running" | "stopped" | "conflict" | "incompatible";
  url: string;
  pid?: number;
}

export async function ensureViewer(home: string, port: number): Promise<void> {
  const instanceId = await getInboxInstanceId(home);
  const health = await getHealth(home, port);
  if (isMatchingViewer(health, instanceId, port)) {
    return;
  }

  await assertPortAvailable(port);

  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot locate html-inbox executable to start viewer");
  }

  const child = spawn(process.execPath, [entry, "viewer"], {
    detached: true,
    env: {
      ...process.env,
      HTML_INBOX_HOME: home,
      HTML_INBOX_PORT: String(port),
    },
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const nextHealth = await getHealth(home, port);
    if (isMatchingViewer(nextHealth, instanceId, port)) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Viewer did not start at http://${HOST}:${port}/health`);
}

export async function getViewerStatus(
  home: string,
  port: number,
): Promise<ViewerStatus> {
  const url = `http://${HOST}:${port}`;
  const health = await getHealth(home, port);
  if (health.state === "unavailable") {
    const isListening = await isPortListening(port);
    return { state: isListening ? "conflict" : "stopped", url };
  }
  if (health.state === "incompatible") {
    return { state: "incompatible", url };
  }

  if (health.state === "invalid") {
    return { state: "conflict", url };
  }

  const instanceId = await getInboxInstanceId(home);
  if (health.instanceId !== instanceId) {
    return { state: "conflict", url };
  }

  const viewerInfo = await readViewerInfo(home);
  return {
    state: "running",
    url,
    pid:
      viewerInfo?.port === port &&
      viewerInfo.processId === health.processId &&
      viewerInfo.pid === health.pid
        ? viewerInfo.pid
        : undefined,
  };
}

export async function stopViewer(
  home: string,
  port: number,
): Promise<ViewerStatus> {
  const status = await getViewerStatus(home, port);
  if (status.state !== "running") {
    return status;
  }
  if (!status.pid) {
    throw new Error(
      "Viewer is running but its process record is missing or stale",
    );
  }

  process.kill(status.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await getHealth(home, port)).state === "unavailable") {
      await rm(path.join(home, "viewer.json"), { force: true });
      return { state: "stopped", url: status.url };
    }
    await sleep(50);
  }
  throw new Error(`Viewer did not stop at ${status.url}`);
}

export async function startViewer(
  backend: DocumentBackend,
  home: string,
  port: number,
): Promise<http.Server> {
  const instanceId = await getInboxInstanceId(home);
  const processId = randomUUID();
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig(port), {
    instanceId,
    processId,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    pid: process.pid,
  });

  try {
    await writeViewerInfo(home, listener.config.port, processId, listener.controlUrl);
  } catch (error) {
    await listener.close();
    throw error;
  }

  return listener.server;
}

type ViewerHealth =
  | { state: "unavailable" }
  | { state: "invalid" }
  | { state: "incompatible" }
  | { state: "ready"; instanceId: string; processId: string; pid: number };

function isMatchingViewer(
  health: ViewerHealth,
  instanceId: string,
  port: number,
): boolean {
  switch (health.state) {
    case "unavailable":
      return false;
    case "invalid":
      throw new Error(
        `Port ${port} is already in use by a service with an invalid health response`,
      );
    case "incompatible":
      throw new Error(
        `Viewer at http://${HOST}:${port} uses an incompatible protocol`,
      );
    case "ready":
      if (health.instanceId !== instanceId) {
        throw new Error(
          `Viewer at http://${HOST}:${port} uses a different HTML_INBOX_HOME`,
        );
      }
      return true;
  }
}

function parseViewerHealth(body: unknown): ViewerHealth {
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.instanceId !== "string" ||
    typeof body.protocolVersion !== "number" ||
    !Number.isInteger(body.protocolVersion) ||
    body.protocolVersion <= 0
  ) {
    return { state: "invalid" };
  }

  try {
    assertUuidV4(body.instanceId, "Viewer inbox identity");
    if (body.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
      return { state: "incompatible" };
    }
    if (
      typeof body.processId !== "string" ||
      typeof body.pid !== "number" ||
      !Number.isSafeInteger(body.pid) ||
      body.pid <= 0
    ) {
      return { state: "invalid" };
    }
    assertUuidV4(body.processId, "Viewer process identity");
    return {
      state: "ready",
      instanceId: body.instanceId,
      processId: body.processId,
      pid: body.pid,
    };
  } catch {
    return { state: "invalid" };
  }
}

async function getHealth(home: string, port: number): Promise<ViewerHealth> {
  try {
    const record = await readViewerInfo(home);
    const controlUrl = record?.port === port ? record.controlUrl : undefined;
    const response = await fetch(controlUrl ?? `http://${HOST}:${port}/health`, {
      signal: AbortSignal.timeout(400),
    });
    if (!response.ok) {
      return { state: "invalid" };
    }
    try {
      const body: unknown = await response.json();
      if (!controlUrl && isRecord(body) && body.ok === true && Object.keys(body).length === 1) {
        return { state: "unavailable" };
      }

      return parseViewerHealth(body);
    } catch {
      return { state: "invalid" };
    }
  } catch {
    return { state: "unavailable" };
  }
}

async function writeViewerInfo(
  home: string,
  port: number,
  processId: string,
  controlUrl: string,
): Promise<void> {
  await writeAtomicPrivateJson(path.join(home, "viewer.json"), {
    host: HOST,
    port,
    controlUrl,
    pid: process.pid,
    processId,
    startedAt: new Date().toISOString(),
  });
}

async function readViewerInfo(
  home: string,
): Promise<{ pid: number; port: number; processId: string; controlUrl?: string } | null> {
  const viewerInfoPath = path.join(home, "viewer.json");
  try {
    await hardenPrivateFile(viewerInfoPath);
    const value: unknown = JSON.parse(await readFile(viewerInfoPath, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      !("port" in value) ||
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port <= 0 ||
      value.port > 65535 ||
      !("processId" in value) ||
      typeof value.processId !== "string"
    ) {
      throw new Error(`Invalid viewer process record at ${viewerInfoPath}`);
    }
    assertUuidV4(value.processId, "Viewer process identity");
    const controlUrl = "controlUrl" in value ? value.controlUrl : undefined;
    if (controlUrl !== undefined && (
      typeof controlUrl !== "string" ||
      !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/control\/[A-Za-z0-9_-]{43}$/.test(controlUrl)
    )) {
      throw new Error(`Invalid viewer control URL at ${viewerInfoPath}`);
    }

    return { pid: value.pid, port: value.port, processId: value.processId, controlUrl };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getInboxInstanceId(home: string): Promise<string> {
  await ensurePrivateDirectory(home);
  const identityPath = path.join(home, "instance-id");

  try {
    await writePrivateFile(identityPath, randomUUID(), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  await hardenPrivateFile(identityPath);
  const instanceId = (await readFile(identityPath, "utf8")).trim();
  assertUuidV4(instanceId, `HTML Inbox instance identity at ${identityPath}`);
  return instanceId;
}

async function isPortListening(port: number): Promise<boolean> {
  // Status checks must not bind a port that a viewer may be starting on.
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: HOST });
    const finish = (isListening: boolean) => {
      socket.destroy();
      resolve(isListening);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "ECONNREFUSED");
    });
    socket.setTimeout(400, () => finish(true));
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use; set HTML_INBOX_PORT to another port`,
          ),
        );
      } else {
        reject(error);
      }
    });
    probe.listen(port, HOST, resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}
