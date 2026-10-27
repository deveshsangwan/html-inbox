import { assertManagedLifecycle } from "./sync-lifecycle";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { type DocumentSource, isSafeDocumentId } from "./documents";
import { extractDocumentCopyContent } from "./document-copy";
import {
  DOCUMENT_CSP,
  LIVE_SHELL_CSP,
  SHELL_CSP,
  VIEWER_SCRIPT,
  VIEWER_STYLES,
} from "./viewer-assets";
import { renderDocumentShell, renderIndex, renderHubIndex, type ViewerRenderOptions } from "./viewer-render";
import { readPreferences, type Appearance } from "./preferences";
import {
  getViewerUrls,
  isAllowedViewerHost,
  resolveViewerNetworkConfig,
  ViewerNetworkConfig,
} from "./viewer-network";
import type { DocumentDeleter } from "./document-deletion";
import { createViewerDocumentDeletion, hasSingleHeader } from "./viewer-document-deletion";

export interface ViewerControlHealth {
  capabilities?: { managedLedgerSchemas: number[]; dynamicFormatSwitch: boolean };
  instanceId: string;
  processId: string;
  protocolVersion: number;
  pid: number;
}

export interface ViewerReaderServer {
  server: http.Server;
  config: ViewerNetworkConfig;
  urls: string[];
  close(): Promise<void>;
}

export interface ViewerHttpServer extends ViewerReaderServer {
  controlServer: http.Server;
  controlUrl: string;
}

export interface ViewerSourceMount {
  name: string;
  source: DocumentSource;
  deleteDocument?: DocumentDeleter;
}

type ReaderConfiguration = {
  source: DocumentSource;
  deleteDocument?: DocumentDeleter;
  preferencesHome?: string;
  renderOptions: ViewerRenderOptions;
} | {
  mounts: readonly ViewerSourceMount[];
  renderOptions: ViewerRenderOptions;
};

export async function startViewerHttpServer(
  source: DocumentSource,
  configuration: ViewerNetworkConfig,
  health: ViewerControlHealth,
  preferencesHome?: string,
  renderOptions: ViewerRenderOptions = {},
  deleteDocument?: DocumentDeleter,
): Promise<ViewerHttpServer> {
  if (preferencesHome) await assertManagedLifecycle(preferencesHome);

  const startingReader = startReaderServer({ source, preferencesHome, renderOptions, deleteDocument }, configuration);
  const controlPath = `/control/${randomBytes(32).toString("base64url")}`;
  let controlPort = 0;
  const controlServer = http.createServer((request, response) => {
    routeControlRequest(health, controlPort, controlPath, request, response);
  });
  let controlClosed: Promise<void> | undefined;
  let controlClose: Promise<void> | undefined;
  const closeControl = () => controlClose ??= closeServer(controlServer, controlClosed);
  const reader = await startingReader.catch(async (error: unknown) => {
    await closeControl();
    throw error;
  });

  reader.server.once("close", () => {
    void closeControl();
  });

  try {
    await listen(controlServer, 0, "127.0.0.1");
    controlClosed = new Promise((resolve) => controlServer.once("close", resolve));
    controlPort = getServerPort(controlServer);
  } catch (error) {
    await Promise.all([reader.close(), closeControl()]);
    throw error;
  }

  return {
    ...reader,
    controlServer,
    controlUrl: `http://127.0.0.1:${controlPort}${controlPath}`,
    async close() {
      await Promise.all([reader.close(), closeControl()]);
    },
  };
}

export function startHubHttpServer(
  mounts: readonly ViewerSourceMount[],
  configuration: ViewerNetworkConfig,
  renderOptions: ViewerRenderOptions = {},
): Promise<ViewerReaderServer> {
  return startReaderServer({ mounts, renderOptions }, configuration);
}

async function startReaderServer(
  reader: ReaderConfiguration,
  configuration: ViewerNetworkConfig,
): Promise<ViewerReaderServer> {
  let config = resolveViewerNetworkConfig(configuration);
  let urls = getViewerUrls(config);
  const deletion = createViewerDocumentDeletion(reader);
  reader = { ...reader, renderOptions: {
    ...reader.renderOptions,
    deletion: deletion ? { token: deletion.token } : undefined,
  } };
  const pendingMutations = new Set<Promise<void>>();
  let isClosing = false;
  let closing: Promise<void> | undefined;
  const server = http.createServer((request, response) => {
    if (isClosing) {
      response.setHeader("Connection", "close");
      sendText(response, 503, "Reader is closing");
      return;
    }

    if (
      hasSingleHeader(request, "host") &&
      (config.host === "0.0.0.0" || config.host === "::") &&
      !isAllowedViewerHost(request.headers.host, config, urls)
    ) {
      try {
        urls.splice(0, urls.length, ...getViewerUrls(config));
      } catch {
        // Removed interface addresses must not remain trusted when enumeration fails.
        urls.length = 0;
      }
    }

    const handling = routeReaderRequest(reader, config, urls, request, response, deletion).catch((error: unknown) => {
      console.error(error);

      if (response.headersSent) {
        response.destroy();
        return;
      }

      sendText(response, 500, "Internal Server Error");
    });

    if (deletion && request.url?.startsWith("/api/")) {
      pendingMutations.add(handling);
      void handling.then(() => pendingMutations.delete(handling), () => pendingMutations.delete(handling));
    }
  });
  let closed: Promise<void> | undefined;

  function close(): Promise<void> {
    isClosing = true;
    return closing ??= (async () => {
      try {
        await closeServer(server, closed);
      } finally {
        // A disconnected request can still own a store mutation or helper child.
        await Promise.allSettled([...pendingMutations]);
      }
    })();
  }

  try {
    await listen(server, config.port, config.host);
    closed = new Promise((resolve) => server.once("close", resolve));
    config = { ...config, port: getServerPort(server) };
    urls = getViewerUrls(config);
  } catch (error) {
    await close();
    throw error;
  }

  return { server, config, urls, close };
}

async function routeReaderRequest(
  reader: ReaderConfiguration,
  config: ViewerNetworkConfig,
  urls: readonly string[],
  request: IncomingMessage,
  response: ServerResponse,
  deletion: ReturnType<typeof createViewerDocumentDeletion>,
): Promise<void> {
  if (!hasSingleHeader(request, "host") || !isAllowedViewerHost(request.headers.host, config, urls)) {
    sendText(response, 421, "Misdirected Request");
    return;
  }

  if (deletion && request.url?.startsWith("/api/")) {
    await deletion.handle(request, response, config);
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
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    if ("mounts" in reader) {
      const sources = await Promise.all(reader.mounts.map(async ({ name, source }) => {
        try {
          return { name, available: true, documents: await source.listDocuments() };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`html-inbox: Hub source ${name} unavailable: ${message}`);

          return { name, available: false, documents: [] };
        }
      }));
      sendHtml(response, renderHubIndex(sources, query, url.searchParams.get("inbox") ?? "", reader.renderOptions), deletion ? LIVE_SHELL_CSP : SHELL_CSP);
      return;
    }

    const preferences = await readViewerPreferences(reader.preferencesHome);
    const renderOptions = { ...reader.renderOptions, ...preferences };
    sendHtml(response, renderIndex(await reader.source.listDocuments(), query, renderOptions), deletion ? LIVE_SHELL_CSP : SHELL_CSP);
    return;
  }

  const documentMatch = "mounts" in reader
    ? /^\/sources\/([^/]+)\/documents\/([^/]+)(\/content|\/copy\.json)?$/.exec(url.pathname)
    : /^\/documents\/([^/]+)(\/content|\/copy\.json)?$/.exec(url.pathname);
  const sourceName = "mounts" in reader ? documentMatch?.[1] : undefined;
  const id = "mounts" in reader ? documentMatch?.[2] : documentMatch?.[1];
  const resource = "mounts" in reader ? documentMatch?.[3] : documentMatch?.[2];
  const source = "mounts" in reader ? reader.mounts.find((mount) => mount.name === sourceName)?.source : reader.source;
  if (!id || !isSafeDocumentId(id) || !source) {
    sendText(response, 404, "Not Found");
    return;
  }

  try {
    if (resource) {
      const document = await source.getDocument(id);
      if (!document) {
        sendText(response, 404, "Not Found");
        return;
      }

      if (resource === "/copy.json") {
        sendJson(response, extractDocumentCopyContent(document.originalBytes));
      } else {
        sendHtml(response, document.originalBytes, DOCUMENT_CSP);
      }

      return;
    }

    const metadata = await source.getDocumentMetadata(id);
    if (!metadata) {
      sendText(response, 404, "Not Found");
      return;
    }

    const preferences = "source" in reader ? await readViewerPreferences(reader.preferencesHome) : undefined;
    sendHtml(response, renderDocumentShell(metadata, {
      ...reader.renderOptions,
      ...preferences,
      ...(sourceName ? {
        inboxName: sourceName,
        homePath: `/?inbox=${encodeURIComponent(sourceName)}`,
        documentBasePath: `/sources/${sourceName}`,
      } : {}),
    }), deletion ? LIVE_SHELL_CSP : SHELL_CSP);
  } catch (error) {
    if (!("mounts" in reader)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`html-inbox: Hub source ${sourceName} unavailable: ${message}`);

    sendText(response, 503, "Inbox unavailable. Results may be incomplete.");
  }
}

async function readViewerPreferences(home?: string): Promise<{ appearance: Appearance } | undefined> {
  if (!home) {
    return undefined;
  }

  try {
    return await readPreferences(home);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`html-inbox: Ignoring unreadable preferences: ${message}`);

    return { appearance: "system" };
  }
}

function routeControlRequest(
  health: ViewerControlHealth,
  port: number,
  controlPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const config = { port, host: "127.0.0.1", exposure: "loopback" } satisfies ViewerNetworkConfig;
  if (!hasSingleHeader(request, "host") || !isAllowedViewerHost(request.headers.host, config, [])) {
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
