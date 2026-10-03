import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { DocumentBackend, isSafeDocumentId } from "./documents";
import {
  DOCUMENT_CSP,
  SHELL_CSP,
  VIEWER_SCRIPT,
  VIEWER_STYLES,
} from "./viewer-assets";
import { renderDocumentShell, renderIndex } from "./viewer-render";
import {
  getViewerUrls,
  isAllowedViewerHost,
  resolveViewerNetworkConfig,
  ViewerNetworkConfig,
} from "./viewer-network";

export interface ViewerControlHealth {
  instanceId: string;
  processId: string;
  protocolVersion: number;
  pid: number;
}

export interface ViewerHttpServer {
  server: http.Server;
  controlServer: http.Server;
  config: ViewerNetworkConfig;
  urls: string[];
  controlUrl: string;
  close(): Promise<void>;
}

export async function startViewerHttpServer(
  backend: DocumentBackend,
  configuration: ViewerNetworkConfig,
  health: ViewerControlHealth,
): Promise<ViewerHttpServer> {
  let config = resolveViewerNetworkConfig(configuration);
  let urls = getViewerUrls(config);
  const server = http.createServer((request, response) => {
    if (
      (config.host === "0.0.0.0" || config.host === "::") &&
      !isAllowedViewerHost(request.headers.host, config, urls)
    ) {
      try {
        urls = getViewerUrls(config);
      } catch {
        // Keep the last known URLs if interface discovery is temporarily unavailable.
      }
    }

    void routeReaderRequest(backend, config, urls, request, response).catch((error: unknown) => {
      console.error(error);

      if (response.headersSent) {
        response.destroy();
        return;
      }

      sendText(response, 500, "Internal Server Error");
    });
  });
  const controlPath = `/control/${randomBytes(32).toString("base64url")}`;
  let controlPort = 0;
  const controlServer = http.createServer((request, response) => {
    routeControlRequest(health, controlPort, controlPath, request, response);
  });
  let readerClosed: Promise<void> | undefined;
  let controlClosed: Promise<void> | undefined;
  let controlClose: Promise<void> | undefined;
  const closeControl = () => controlClose ??= closeServer(controlServer, controlClosed);

  server.once("close", () => {
    void closeControl();
  });

  try {
    await listen(server, config.port, config.host);
    readerClosed = new Promise((resolve) => server.once("close", resolve));
    config = { ...config, port: getServerPort(server) };
    urls = getViewerUrls(config);

    await listen(controlServer, 0, "127.0.0.1");
    controlClosed = new Promise((resolve) => controlServer.once("close", resolve));
    controlPort = getServerPort(controlServer);
  } catch (error) {
    await Promise.all([closeServer(server, readerClosed), closeControl()]);
    throw error;
  }

  return {
    server,
    controlServer,
    config,
    urls,
    controlUrl: `http://127.0.0.1:${controlPort}${controlPath}`,
    async close() {
      await Promise.all([closeServer(server, readerClosed), closeControl()]);
    },
  };
}

async function routeReaderRequest(
  backend: DocumentBackend,
  config: ViewerNetworkConfig,
  urls: readonly string[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!hasSingleHost(request) || !isAllowedViewerHost(request.headers.host, config, urls)) {
    sendText(response, 421, "Misdirected Request");
    return;
  }

  if (!isReadRequest(request, response)) {
    return;
  }

  const url = parseRequestUrl(request, response);
  if (!url) {
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, { ok: true });
    return;
  }

  if (url.pathname === "/assets/viewer.css") {
    sendAsset(response, VIEWER_STYLES, "text/css; charset=utf-8");
    return;
  }

  if (url.pathname === "/assets/viewer.js") {
    sendAsset(response, VIEWER_SCRIPT, "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/") {
    const documents = await backend.listDocuments();
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    sendHtml(response, renderIndex(documents, query), SHELL_CSP);
    return;
  }

  const documentMatch = /^\/documents\/([^/]+)(\/content)?$/.exec(url.pathname);
  if (!documentMatch || !isSafeDocumentId(documentMatch[1])) {
    sendText(response, 404, "Not Found");
    return;
  }

  const id = documentMatch[1];
  if (documentMatch[2]) {
    const document = await backend.getDocument(id);
    if (!document) {
      sendText(response, 404, "Not Found");
      return;
    }

    sendHtml(response, document.originalBytes, DOCUMENT_CSP);
    return;
  }

  const metadata = await backend.getDocumentMetadata(id);
  if (!metadata) {
    sendText(response, 404, "Not Found");
    return;
  }

  sendHtml(response, renderDocumentShell(metadata), SHELL_CSP);
}

function routeControlRequest(
  health: ViewerControlHealth,
  port: number,
  controlPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const config = { port, host: "127.0.0.1", exposure: "loopback" } satisfies ViewerNetworkConfig;
  if (!hasSingleHost(request) || !isAllowedViewerHost(request.headers.host, config, [])) {
    sendText(response, 421, "Misdirected Request");
    return;
  }

  if (!isReadRequest(request, response)) {
    return;
  }

  const url = parseRequestUrl(request, response);
  if (!url) {
    return;
  }

  if (url.pathname !== controlPath || url.search) {
    sendText(response, 404, "Not Found");
    return;
  }

  sendJson(response, { ok: true, ...health });
}

function hasSingleHost(request: IncomingMessage): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "host") {
      count += 1;
    }
  }

  return count === 1;
}

function isReadRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "GET" || request.method === "HEAD") {
    return true;
  }

  response.setHeader("Allow", "GET, HEAD");
  sendText(response, 405, "Method Not Allowed");
  return false;
}

function parseRequestUrl(request: IncomingMessage, response: ServerResponse): URL | null {
  const target = request.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) {
    sendText(response, 400, "Bad Request");
    return null;
  }

  try {
    const url = new URL(target, "http://127.0.0.1");
    if (url.origin !== "http://127.0.0.1") {
      sendText(response, 400, "Bad Request");
      return null;
    }

    return url;
  } catch {
    sendText(response, 400, "Bad Request");
    return null;
  }
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rejectListen = (error: Error) => reject(error);
    server.once("error", rejectListen);
    server.listen({ port, host }, () => {
      server.off("error", rejectListen);
      resolve();
    });
  });
}

async function closeServer(server: http.Server, closed?: Promise<void>): Promise<void> {
  if (!server.listening) {
    // Closing stops the listener before active requests finish.
    await closed;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function getServerPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Viewer did not expose a TCP port");
  }

  return address.port;
}

function sendHtml(response: ServerResponse, body: string | Buffer, csp: string): void {
  response.writeHead(200, securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
  }));
  response.end(body);
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
  response.end(body);
}

function sendAsset(response: ServerResponse, body: string, contentType: string): void {
  response.writeHead(200, securityHeaders({ "Content-Type": contentType }));
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
