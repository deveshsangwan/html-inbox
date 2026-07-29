import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import {
  DocumentBackend,
  DocumentMetadata,
  DOCUMENT_SCRIPT_CSP_SOURCES,
  isSafeDocumentId,
} from "@html-inbox/shared";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
} from "./private-storage";

const HOST = "127.0.0.1";
export const VIEWER_PROTOCOL_VERSION = 1;

export interface ViewerStatus {
  state: "running" | "stopped" | "conflict" | "incompatible";
  url: string;
  pid?: number;
}

export const VIEWER_SCRIPT = `(() => {
  const root = document.documentElement;
  const storageKey = "html-inbox-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const modes = new Set(["system", "light", "dark"]);

  const readMode = () => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved && modes.has(saved) ? saved : "system";
    } catch {
      return "system";
    }
  };

  const applyMode = (mode) => {
    const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  };

  let mode = readMode();
  applyMode(mode);

  const initialize = () => {
    const selector = document.querySelector("[data-theme-selector]");
    if (selector instanceof HTMLSelectElement) {
      selector.value = mode;
      selector.addEventListener("change", () => {
        mode = modes.has(selector.value) ? selector.value : "system";
        try {
          window.localStorage.setItem(storageKey, mode);
        } catch {}
        applyMode(mode);
      });
    }

    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    document.querySelectorAll("time[data-local-date]").forEach((element) => {
      const date = new Date(element.dateTime);
      if (!Number.isNaN(date.valueOf())) {
        element.textContent = dateFormatter.format(date);
      }
    });

    const searchForm = document.querySelector("[data-client-search]");
    if (searchForm instanceof HTMLFormElement) {
      const input = searchForm.querySelector('input[name="q"]');
      const rows = Array.from(document.querySelectorAll("[data-search-text]"));
      const count = document.querySelector("[data-document-count]");
      const empty = document.querySelector("[data-client-empty]");
      const clear = searchForm.querySelector("[data-search-clear]");
      const total = rows.length;

      const applySearch = (value) => {
        const query = value.trim().toLowerCase();
        let visible = 0;
        rows.forEach((row) => {
          const matches = !query || (row.dataset.searchText || "").includes(query);
          row.hidden = !matches;
          if (matches) visible += 1;
        });
        if (count) {
          count.textContent = query
            ? visible + " of " + total + " documents"
            : total + (total === 1 ? " document" : " documents");
        }
        if (empty) empty.hidden = !query || visible > 0;
        if (clear) clear.hidden = !query;
      };

      const initialQuery = new URL(window.location.href).searchParams.get("q") || "";
      if (input instanceof HTMLInputElement) input.value = initialQuery;
      applySearch(initialQuery);

      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input instanceof HTMLInputElement ? input.value : "";
        const url = new URL(window.location.href);
        if (value.trim()) url.searchParams.set("q", value.trim());
        else url.searchParams.delete("q");
        window.history.replaceState(null, "", url);
        applySearch(value);
      });
      if (clear) {
        clear.addEventListener("click", (event) => {
          event.preventDefault();
          if (input instanceof HTMLInputElement) input.value = "";
          const url = new URL(window.location.href);
          url.searchParams.delete("q");
          window.history.replaceState(null, "", url);
          applySearch("");
          if (input instanceof HTMLInputElement) input.focus();
        });
      }
    }
  };

  media.addEventListener("change", () => {
    if (mode === "system") applyMode(mode);
  });
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
})();`;

export const VIEWER_STYLES = `
:root {
  --canvas: #f3f4f5;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-hover: #e9eeeb;
  --text: #343a36;
  --text-strong: #161a17;
  --muted: #5d655f;
  --faint: #646c66;
  --border: #d9ddda;
  --border-strong: #bcc4be;
  --accent: #2f6a50;
  --accent-soft: #e1ebe5;
  --accent-contrast: #f7faf8;
  --focus: #2f6a50;
  --iframe-canvas: #ffffff;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color-scheme: light;
}

[data-theme="dark"] {
  --canvas: #111412;
  --surface: #171b18;
  --surface-raised: #1a1f1b;
  --surface-hover: #202621;
  --text: #d8ded9;
  --text-strong: #f4f7f5;
  --muted: #aab2ac;
  --faint: #89918b;
  --border: #2e3530;
  --border-strong: #434c45;
  --accent: #8ab79c;
  --accent-soft: #223a2c;
  --accent-contrast: #111412;
  --focus: #a6d1b7;
  --iframe-canvas: #ffffff;
  color-scheme: dark;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-height: 100%; background: var(--canvas); }
body {
  min-height: 100dvh;
  margin: 0;
  color: var(--text);
  background: var(--canvas);
  font-size: 0.9375rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
button, select { font: inherit; }
a { color: inherit; }

.skip-link {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 2;
  padding: 0.55rem 0.8rem;
  color: var(--surface-raised);
  background: var(--text-strong);
  border-radius: 0.4rem;
  transform: translateY(-180%);
  transition: transform 150ms ease;
}
.skip-link:focus { transform: translateY(0); }

.site-header {
  border-bottom: 1px solid var(--border);
  background: var(--canvas);
}
.site-header__inner,
.library,
.document-view {
  width: min(100% - 2.5rem, 72rem);
  margin-inline: auto;
}
.site-header__inner {
  min-height: 4rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.68rem;
  color: var(--text-strong);
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.015em;
  text-decoration: none;
}
.brand__mark {
  width: 1.75rem;
  height: 1.75rem;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 0.4rem;
}
.theme-field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 550;
}
.theme-field select {
  min-height: 2.125rem;
  padding: 0 1.9rem 0 0.7rem;
  color: var(--text);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  cursor: pointer;
}

.library { padding-block: 3rem 4rem; }
.library__heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 2rem;
  padding-bottom: 1.5rem;
}
h1 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 2rem;
  font-weight: 680;
  letter-spacing: -0.03em;
  line-height: 1.1;
  text-wrap: balance;
}
.library__intro {
  max-width: 42rem;
  margin: 0.5rem 0 0;
  color: var(--muted);
  font-size: 0.9375rem;
  text-wrap: pretty;
}
.document-count {
  margin: 0 0 0.15rem;
  color: var(--faint);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.search-form {
  max-width: 38rem;
  margin-bottom: 2rem;
}
.search-form label {
  display: block;
  margin-bottom: 0.45rem;
  color: var(--text-strong);
  font-size: 0.8rem;
  font-weight: 620;
}
.search-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.55rem;
  align-items: center;
}
.search-control input {
  min-width: 0;
  min-height: 2.55rem;
  padding: 0 0.75rem;
  color: var(--text-strong);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 0.375rem;
  font: inherit;
}
.search-control input::placeholder { color: var(--faint); }
.search-control button,
.search-clear {
  min-height: 2.55rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.85rem;
  border-radius: 0.375rem;
  font-size: 0.82rem;
  font-weight: 620;
  text-decoration: none;
  white-space: nowrap;
}
.search-control button {
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
  cursor: pointer;
}
.search-clear {
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
}
.search-control button:hover { filter: brightness(0.94); }
.search-clear:hover { border-color: var(--border-strong); }
.search-control button:active,
.search-clear:active { transform: translateY(1px); }

.document-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-strong);
}
.document-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(15rem, 22rem) 1.25rem;
  gap: 1rem;
  align-items: center;
  min-height: 4.75rem;
  padding: 0.9rem 0.35rem;
  border-bottom: 1px solid var(--border);
  transition: background-color 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.document-row:hover,
.document-row:focus-within {
  background: var(--surface-hover);
}
.document-row__link {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 1rem;
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: 1.3;
  text-decoration: none;
  text-wrap: pretty;
}
.document-row__link::after { content: ""; position: absolute; inset: 0; }
.document-row__meta { min-width: 0; }
.document-row__details {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
  margin-bottom: 0.35rem;
}
.document-type {
  min-width: 0;
  max-width: 100%;
  padding: 0.12rem 0.38rem;
  overflow-wrap: anywhere;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.45;
}
.document-date {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}
.document-source {
  display: block;
  overflow: hidden;
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-row__arrow {
  color: var(--faint);
  font-size: 1.2rem;
  transition: color 180ms cubic-bezier(0.22, 1, 0.36, 1), transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.document-row:hover .document-row__arrow,
.document-row:focus-within .document-row__arrow {
  color: var(--accent);
  transform: translateX(0.2rem);
}

.empty-state {
  padding: 2.5rem 0;
  border-top: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border);
}
.empty-state h2 { margin: 0; color: var(--text-strong); font-size: 1.15rem; letter-spacing: -0.02em; }
.empty-state p { max-width: 38rem; margin: 0.5rem 0 0; color: var(--muted); }
.empty-state code {
  display: inline-block;
  max-width: 100%;
  margin-top: 1.2rem;
  padding: 0.55rem 0.75rem;
  overflow-x: auto;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem;
  white-space: nowrap;
}

.document-view { padding-block: 1.5rem 2rem; }
.document-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2rem;
  align-items: end;
  margin-bottom: 1.35rem;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 1rem;
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 570;
  text-decoration: none;
  transition: color 160ms cubic-bezier(0.22, 1, 0.36, 1), transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.back-link:hover { color: var(--accent); transform: translateX(-0.15rem); }
.document-title {
  max-width: 48rem;
  font-size: 1.75rem;
  line-height: 1.12;
}
.document-header__meta {
  min-width: min(18rem, 32vw);
  max-width: min(24rem, 38vw);
  padding-bottom: 0.15rem;
  text-align: right;
}
.document-header__meta .document-row__details { justify-content: flex-end; }
.document-header__source {
  display: block;
  overflow: hidden;
  margin-top: 0.55rem;
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.73rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-frame {
  padding: 0.25rem;
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 0.5rem;
}
iframe {
  width: 100%;
  height: max(35rem, calc(100dvh - 12.5rem));
  display: block;
  background: var(--iframe-canvas);
  border: 0;
  border-radius: 0.25rem;
}

:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.document-row__link:focus-visible { outline-offset: 0.35rem; border-radius: 0.15rem; }
select:hover { border-color: var(--border-strong); }
select:active { transform: translateY(1px); }

@media (max-width: 42rem) {
  .site-header__inner, .library, .document-view { width: min(100% - 1.5rem, 72rem); }
  .theme-field > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .library { padding-block: 2.25rem 3rem; }
  .library__heading, .document-header { grid-template-columns: 1fr; gap: 0.85rem; }
  .document-count { margin: 0; }
  .search-control { grid-template-columns: minmax(0, 1fr) auto; }
  .search-clear { grid-column: 1 / -1; justify-self: start; }
  .document-row { grid-template-columns: minmax(0, 1fr) 1.25rem; gap: 0.8rem; padding-block: 1.25rem; }
  .document-row__meta { grid-column: 1; }
  .document-row__arrow { grid-column: 2; grid-row: 1 / span 2; }
  .document-header__meta { min-width: 0; max-width: none; text-align: left; }
  .document-header__meta .document-row__details { justify-content: flex-start; }
  .document-view { padding-top: 1.25rem; }
  iframe { height: max(30rem, calc(100dvh - 15.5rem)); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
`;

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

export interface ViewerRenderOptions {
  basePath?: string;
  clientSearch?: boolean;
  timeZone?: string;
}

export function renderIndex(
  allDocuments: DocumentMetadata[],
  query: string,
  options: ViewerRenderOptions = {},
): string {
  const basePath = options.basePath ?? "";
  const homePath = basePath ? `${basePath}/` : "/";
  const normalizedQuery = query.toLowerCase();
  const documents = normalizedQuery
    ? allDocuments.filter((document) =>
        [document.title, document.type, document.sourceFileName].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        ),
      )
    : allDocuments;
  const documentContent =
    documents.length === 0
      ? `<section class="empty-state" aria-labelledby="empty-title">
          <h2 id="empty-title">${query ? "No matching documents" : "No documents yet"}</h2>
          <p>${
            query
              ? "Try another title, type, or source file name."
              : "Publish an HTML file from the CLI. It will appear here with its title, type, and source file."
          }</p>
          ${
            query
              ? ""
              : '<code>html-inbox publish ./document.html --title "My document" --type report</code>'
          }
        </section>`
      : `<ol class="document-list" aria-label="Published documents">${documents
          .map(
            (document) =>
              `<li class="document-row" data-search-text="${escapeAttribute(
                [document.title, document.type, document.sourceFileName]
                  .join(" ")
                  .toLowerCase(),
              )}">
                <a class="document-row__link" href="${basePath}/documents/${escapeAttribute(document.id)}${basePath ? "/" : ""}">${escapeHtml(document.title)}</a>
                <div class="document-row__meta">
                  <div class="document-row__details">
                    <span class="document-type">${escapeHtml(document.type)}</span>
                    <time class="document-date" datetime="${escapeAttribute(document.createdAt)}" data-local-date>${escapeHtml(formatDate(document.createdAt, options.timeZone))}</time>
                  </div>
                  <span class="document-source" title="${escapeAttribute(document.sourceFileName)}">${escapeHtml(document.sourceFileName)}</span>
                </div>
                <span class="document-row__arrow" aria-hidden="true">&#8594;</span>
              </li>`,
          )
          .join("")}</ol>`;

  const countLabel = query
    ? `${documents.length} of ${allDocuments.length} documents`
    : `${documents.length} ${documents.length === 1 ? "document" : "documents"}`;

  return page(
    "HTML Inbox",
    `<main class="library" id="main-content">
      <header class="library__heading">
        <div>
          <h1>Documents</h1>
          <p class="library__intro">Reports, notes, dashboards, and other HTML published to this inbox.</p>
        </div>
        <p class="document-count" aria-live="polite" data-document-count>${countLabel}</p>
      </header>
      <form class="search-form" role="search" method="get" action="${homePath}" ${options.clientSearch ? "data-client-search" : ""}>
        <label for="document-search">Search documents</label>
        <div class="search-control">
          <input id="document-search" name="q" type="search" value="${escapeAttribute(query)}" placeholder="Title, type, or source file" maxlength="200">
          <button type="submit">Search</button>
          ${
            options.clientSearch
              ? `<a class="search-clear" href="${homePath}" data-search-clear${
                  query ? "" : " hidden"
                }>Clear</a>`
              : query
                ? `<a class="search-clear" href="${homePath}">Clear</a>`
                : ""
          }
        </div>
      </form>
      ${
        options.clientSearch && allDocuments.length > 0
          ? '<section class="empty-state" aria-labelledby="client-empty-title" data-client-empty hidden><h2 id="client-empty-title">No matching documents</h2><p>Try another title, type, or source file name.</p></section>'
          : ""
      }
      ${documentContent}
    </main>`,
    "Your published HTML documents, collected in one quiet library.",
    basePath,
  );
}

export function renderDocumentShell(
  metadata: DocumentMetadata,
  options: ViewerRenderOptions = {},
): string {
  const basePath = options.basePath ?? "";
  const homePath = basePath ? `${basePath}/` : "/";
  const contentPath = basePath
    ? `${basePath}/documents/${escapeAttribute(metadata.id)}/content/`
    : `/documents/${escapeAttribute(metadata.id)}/content`;
  return page(
    metadata.title,
    `<main class="document-view" id="main-content">
      <a class="back-link" href="${homePath}"><span aria-hidden="true">&#8592;</span> Back to inbox</a>
      <header class="document-header">
        <div>
          <h1 class="document-title">${escapeHtml(metadata.title)}</h1>
        </div>
        <div class="document-header__meta">
          <div class="document-row__details">
            <span class="document-type">${escapeHtml(metadata.type)}</span>
            <time class="document-date" datetime="${escapeAttribute(metadata.createdAt)}" data-local-date>${escapeHtml(formatDate(metadata.createdAt, options.timeZone))}</time>
          </div>
          <span class="document-header__source" title="${escapeAttribute(metadata.sourceFileName)}">${escapeHtml(metadata.sourceFileName)}</span>
        </div>
      </header>
      <div class="preview-frame">
        <iframe sandbox="allow-scripts" src="${contentPath}" title="${escapeAttribute(metadata.title)}"></iframe>
      </div>
    </main>`,
    `Preview of ${metadata.title}`,
    basePath,
  );
}

function page(title: string, body: string, description: string, basePath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttribute(description)}">
<script src="${basePath}/assets/viewer.js"></script>
<link rel="stylesheet" href="${basePath}/assets/viewer.css">
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
${renderSiteHeader(basePath)}
${body}
</body>
</html>`;
}

function renderSiteHeader(basePath: string): string {
  const homePath = basePath ? `${basePath}/` : "/";
  return `<header class="site-header">
    <div class="site-header__inner">
      <a class="brand" href="${homePath}" aria-label="HTML Inbox home">
        <span class="brand__mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3.25h10v9.5H3zM3 9h2.65l1.1 1.5h2.5l1.1-1.5H13" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>
        </span>
        <span>HTML Inbox</span>
      </a>
      <label class="theme-field">
        <span>Appearance</span>
        <select data-theme-selector aria-label="Appearance">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </div>
  </header>`;
}

function formatDate(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

export function shellCsp(): string {
  return "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'";
}

export function documentCsp(): string {
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
