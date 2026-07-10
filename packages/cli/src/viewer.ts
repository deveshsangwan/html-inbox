import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  DocumentBackend,
  DocumentMetadata,
  DOCUMENT_SCRIPT_CSP_SOURCES,
  isSafeDocumentId,
} from "@html-inbox/shared";

const HOST = "127.0.0.1";

export async function ensureViewer(home: string, port: number): Promise<void> {
  const health = await getHealth(port);
  if (health.ok && health.home === home) {
    return;
  }
  if (health.ok) {
    throw new Error(`Viewer at http://${HOST}:${port} uses a different HTML_INBOX_HOME`);
  }

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
    if (nextHealth.ok && nextHealth.home === home) {
      return;
    }
    if (nextHealth.ok) {
      throw new Error(`Viewer at http://${HOST}:${port} uses a different HTML_INBOX_HOME`);
    }
    await sleep(100);
  }

  throw new Error(`Viewer did not start at http://${HOST}:${port}/health`);
}

export async function startViewer(
  backend: DocumentBackend,
  home: string,
  port: number,
): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    void routeRequest(backend, home, request, response).catch((error) => {
      console.error(error);
      sendText(response, 500, "Internal Server Error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });

  const actualPort = getServerPort(server);
  await writeViewerInfo(home, actualPort);
  return server;
}

async function routeRequest(
  backend: DocumentBackend,
  home: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }

  const url = new URL(request.url ?? "/", `http://${HOST}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true, home });
    return;
  }

  if (url.pathname === "/") {
    const documents = await backend.listDocuments();
    sendHtml(response, 200, renderIndex(documents), shellCsp());
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

async function getHealth(port: number): Promise<{ ok: boolean; home?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 400);

  try {
    const response = await fetch(`http://${HOST}:${port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false };
    }
    const body = (await response.json()) as { home?: unknown };
    return { ok: true, home: typeof body.home === "string" ? body.home : undefined };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeViewerInfo(home: string, port: number): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "viewer.json"),
    JSON.stringify({ host: HOST, port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
  );
}

function getServerPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Viewer did not expose a TCP port");
  }
  return address.port;
}

function renderIndex(documents: DocumentMetadata[]): string {
  const rows =
    documents.length === 0
      ? "<p>No documents yet.</p>"
      : `<ul>${documents
          .map(
            (document) =>
              `<li><a href="/documents/${escapeAttribute(document.id)}">${escapeHtml(
                document.title,
              )}</a> <span>${escapeHtml(document.type)}</span> <time>${escapeHtml(
                document.createdAt,
              )}</time></li>`,
          )
          .join("")}</ul>`;

  return page("HTML Inbox", `<main><h1>HTML Inbox</h1>${rows}</main>`);
}

function renderDocumentShell(metadata: DocumentMetadata): string {
  return page(
    metadata.title,
    `<main><p><a href="/">Inbox</a></p><h1>${escapeHtml(metadata.title)}</h1><p>${escapeHtml(
      metadata.type,
    )} - ${escapeHtml(metadata.createdAt)}</p><iframe sandbox="allow-scripts" src="/documents/${escapeAttribute(
      metadata.id,
    )}/content" title="${escapeAttribute(metadata.title)}"></iframe></main>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#171717;background:#fafafa}
main{max-width:960px;margin:0 auto;padding:32px 20px}
a{color:#0645ad} li{margin:10px 0} span,time{color:#555;margin-left:8px}
iframe{width:100%;height:75vh;border:1px solid #ccc;background:white}
</style>
</head>
<body>${body}</body>
</html>`;
}

function shellCsp(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'";
}

function documentCsp(): string {
  return `default-src 'none'; script-src 'unsafe-inline' ${DOCUMENT_SCRIPT_CSP_SOURCES.join(" ")}; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
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

function securityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
