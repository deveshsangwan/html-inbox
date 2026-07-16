import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { DocumentBackend, isSafeDocumentId } from "@html-inbox/shared";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
} from "./private-storage";
import {
  documentCsp,
  shellCsp,
  VIEWER_SCRIPT,
  VIEWER_STYLES,
} from "./viewer-assets";
import { renderDocumentShell, renderIndex } from "./viewer-render";

const HOST = "127.0.0.1";
export const VIEWER_PROTOCOL_VERSION = 1;

export interface ViewerStatus {
  state: "running" | "stopped" | "conflict" | "incompatible";
  url: string;
  pid?: number;
}

export async function ensureViewer(home: string, port: number): Promise<void> {
  const instanceId = await getInboxInstanceId(home);
  const health = await getHealth(port);
  if (health.ok && health.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
    throw new Error(`Viewer at http://${HOST}:${port} uses an incompatible protocol`);
  }
  if (health.ok && health.instanceId === instanceId) {
    return;
  }
  if (health.ok) {
    throw new Error(`Viewer at http://${HOST}:${port} uses a different HTML_INBOX_HOME`);
  }

  await assertPortAvailable(port);

  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot locate html-inbox executable to start viewer");
  }

  const child = spawn(process.execPath, [entry, "viewer"], {
    detached: true,
    env: { ...process.env, HTML_INBOX_HOME: home, HTML_INBOX_PORT: String(port) },
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const nextHealth = await getHealth(port);
    if (nextHealth.ok && nextHealth.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
      throw new Error(`Viewer at http://${HOST}:${port} uses an incompatible protocol`);
    }
    if (nextHealth.ok && nextHealth.instanceId === instanceId) {
      return;
    }
    if (nextHealth.ok) {
      throw new Error(`Viewer at http://${HOST}:${port} uses a different HTML_INBOX_HOME`);
    }
    await sleep(100);
  }

  throw new Error(`Viewer did not start at http://${HOST}:${port}/health`);
}

export async function getViewerStatus(home: string, port: number): Promise<ViewerStatus> {
  const url = `http://${HOST}:${port}`;
  const health = await getHealth(port);
  if (!health.ok) {
    return { state: "stopped", url };
  }
  if (health.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
    return { state: "incompatible", url };
  }

  const instanceId = await getInboxInstanceId(home);
  if (health.instanceId !== instanceId) {
    return { state: "conflict", url };
  }

  const viewerInfo = await readViewerInfo(home);
  return {
    state: "running",
    url,
    pid: viewerInfo?.port === port ? viewerInfo.pid : undefined,
  };
}

export async function stopViewer(home: string, port: number): Promise<ViewerStatus> {
  const status = await getViewerStatus(home, port);
  if (status.state !== "running") {
    return status;
  }
  if (!status.pid) {
    throw new Error("Viewer is running but its process record is missing or stale");
  }

  process.kill(status.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await getHealth(port)).ok) {
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
  const server = http.createServer((request, response) => {
    void routeRequest(
      backend,
      instanceId,
      getServerPort(server),
      request,
      response,
    ).catch((error) => {
      console.error(error);
      sendText(response, 500, "Internal Server Error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });

  const actualPort = getServerPort(server);
  try {
    await writeViewerInfo(home, actualPort);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return server;
}

async function routeRequest(
  backend: DocumentBackend,
  instanceId: string,
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!isAllowedHost(request.headers.host, port)) {
    sendText(response, 421, "Misdirected Request");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      instanceId,
      protocolVersion: VIEWER_PROTOCOL_VERSION,
    });
    return;
  }

  if (url.pathname === "/assets/viewer.css") {
    sendAsset(response, 200, VIEWER_STYLES, "text/css; charset=utf-8");
    return;
  }

  if (url.pathname === "/assets/viewer.js") {
    sendAsset(response, 200, VIEWER_SCRIPT, "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/") {
    const documents = await backend.listDocuments();
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    sendHtml(response, 200, renderIndex(documents, query), shellCsp());
    return;
  }

  const documentMatch = /^\/documents\/([^/]+)$/.exec(url.pathname);
  if (documentMatch) {
    const id = documentMatch[1];
    const document = await backend.getDocument(id);
    if (!document) {
      sendText(response, 404, "Not Found");
      return;
    }
    sendHtml(response, 200, renderDocumentShell(document.metadata), shellCsp());
    return;
  }

  const contentMatch = /^\/documents\/([^/]+)\/content$/.exec(url.pathname);
  if (contentMatch) {
    const id = contentMatch[1];
    if (!isSafeDocumentId(id)) {
      sendText(response, 404, "Not Found");
      return;
    }
    const document = await backend.getDocument(id);
    if (!document) {
      sendText(response, 404, "Not Found");
      return;
    }
    sendHtml(response, 200, document.html, documentCsp());
    return;
  }

  sendText(response, 404, "Not Found");
}

interface ViewerHealth {
  ok: boolean;
  instanceId?: string;
  protocolVersion?: number;
}

async function getHealth(port: number): Promise<ViewerHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 400);

  try {
    const response = await fetch(`http://${HOST}:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false };
    }
    const body = (await response.json()) as {
      instanceId?: unknown;
      protocolVersion?: unknown;
    };
    return {
      ok: true,
      instanceId: typeof body.instanceId === "string" ? body.instanceId : undefined,
      protocolVersion:
        typeof body.protocolVersion === "number" ? body.protocolVersion : undefined,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeViewerInfo(home: string, port: number): Promise<void> {
  await ensurePrivateDirectory(home);
  await writePrivateFile(
    path.join(home, "viewer.json"),
    JSON.stringify({ host: HOST, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
  );
}

async function readViewerInfo(home: string): Promise<{ pid: number; port: number } | null> {
  const viewerInfoPath = path.join(home, "viewer.json");
  try {
    await hardenPrivateFile(viewerInfoPath);
    const value = JSON.parse(await readFile(viewerInfoPath, "utf8")) as {
      pid?: unknown;
      port?: unknown;
    };
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.port)) {
      throw new Error(`Invalid viewer process record at ${viewerInfoPath}`);
    }
    return { pid: value.pid as number, port: value.port as number };
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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      instanceId,
    )
  ) {
    throw new Error(`Invalid HTML Inbox instance identity at ${identityPath}`);
  }
  return instanceId;
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const normalized = hostHeader.toLowerCase();
  const allowedHosts = [`${HOST}:${port}`, `localhost:${port}`];
  if (port === 80) {
    allowedHosts.push(HOST, "localhost");
  }
  return allowedHosts.includes(normalized);
}

async function assertPortAvailable(port: number): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use; set HTML_INBOX_PORT to another port`));
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

function getServerPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Viewer did not expose a TCP port");
  }
  return address.port;
}

function sendHtml(response: ServerResponse, status: number, body: string, csp: string): void {
  response.writeHead(status, securityHeaders({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp }));
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
  response.end(body);
}

function sendAsset(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, securityHeaders({ "Content-Type": contentType }));
  response.end(body);
}

function securityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
