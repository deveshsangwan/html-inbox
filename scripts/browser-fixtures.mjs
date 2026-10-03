import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { exportStaticSnapshot } from "../packages/cli/dist/static-export.js";
import { startViewer } from "../packages/cli/dist/viewer-server.js";
import { validateHtml } from "../packages/cli/dist/html-validation.js";

export const isolationHtml = `<!doctype html><html><body>
  <h1>Quarterly results</h1><p id="isolation">loading</p><p id="network">loading</p>
  <script>
    let isolated = false;
    try { parent.document.documentElement.dataset.compromised = 'yes'; } catch { isolated = true; }
    document.querySelector('#isolation').textContent = isolated ? 'isolated' : 'parent allowed';
    fetch('/health').then(() => document.querySelector('#network').textContent = 'network allowed')
      .catch(() => document.querySelector('#network').textContent = 'network blocked');
  </script>
</body></html>`;

export const libraryEntryPoints = [
  { title: "Tailwind classic", url: "https://cdn.tailwindcss.com" },
  { title: "Tailwind plugins", url: "https://cdn.tailwindcss.com?plugins=typography,forms" },
  { title: "Tailwind browser", url: "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" },
];

export async function publishBrowserDocument(backend, title, sourceFileName, html, type = "report") {
  const validation = validateHtml(html);
  assert.deepEqual(validation, { ok: true, errors: [], warnings: [] });

  return backend.publish({
    title,
    type,
    sourceFileName,
    originalBytes: Buffer.from(html),
  });
}

export async function publishLibraryFixtures(backend) {
  const template = await readFile(new URL("./fixtures/library-entry-points.html", import.meta.url), "utf8");
  const documents = [];

  for (const entryPoint of libraryEntryPoints) {
    const document = await publishBrowserDocument(
      backend,
      entryPoint.title,
      "library-entry-points.html",
      template.replace("{{TAILWIND_ENTRY_POINT}}", entryPoint.url),
    );

    documents.push({ ...document, entryPoint: entryPoint.url });
  }

  return documents;
}

export async function createBrowserFixture(t, mode, publishDocuments) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-browser-"));
  let server;
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (server) {
          await closeServer(server);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  const home = path.join(root, "home");
  const backend = new LocalDocumentBackend(home);
  const documents = await publishDocuments(backend);
  const requests = [];
  let inboxPath = "";

  if (mode === "static") {
    const snapshot = await exportStaticSnapshot(backend, { outputDir: path.join(root, "snapshot") });
    assert.equal(snapshot.manifest.documentCount, documents.length);
    inboxPath = snapshot.inboxPath;
    server = await startStaticServer(snapshot, requests);
  } else {
    assert.equal(mode, "local");
    server = await startViewer(backend, home, 0);
  }

  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(
    process.env.HTML_INBOX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE }
      : {},
  );
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);

  return { page, context, documents, requests, origin, inboxUrl: `${origin}${inboxPath}/` };
}

async function startStaticServer(snapshot, requests) {
  const headers = JSON.parse(await readFile(
    path.join(snapshot.outputDir, snapshot.inboxPath.slice(1), "security-headers.json"),
    "utf8",
  ));
  assert.equal(headers.schemaVersion, 1);
  for (const group of [headers.common, headers.root, headers.shell, headers.document]) {
    assert(group && typeof group === "object" && !Array.isArray(group));
    assert(Object.values(group).every((value) => typeof value === "string"));
  }

  const files = new Map();
  for (const file of snapshot.manifest.files) {
    files.set(`/${file.path}`, file.path);
    if (file.path.endsWith("index.html")) {
      const directoryPath = `/${file.path.slice(0, -"index.html".length)}`;
      files.set(directoryPath, file.path);

      if (directoryPath !== "/") {
        files.set(directoryPath.slice(0, -1), file.path);
      }
    }
  }

  const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
  ]);
  const server = http.createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(pathname);
      const filePath = files.get(pathname);

      if (!filePath || request.method !== "GET") {
        response.writeHead(404);
        response.end("Not Found");
        return;
      }

      const bytes = await readFile(path.join(snapshot.outputDir, filePath));
      // A static host must install the generated policy on shells and original content.
      const policy = filePath === "index.html"
        ? headers.root
        : filePath.includes("/content/") ? headers.document : headers.shell;
      response.writeHead(200, {
        ...headers.common,
        ...policy,
        "Content-Type": contentTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      });
      response.end(bytes);
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

export async function installCdnFixtures(context) {
  const requestedUrls = [];
  const unexpectedUrls = [];
  const fixtureDirectory = new URL("./fixtures/", import.meta.url);
  const sources = new Map([
    ...libraryEntryPoints.map(({ url }) => [new URL(url).href, "tailwind-entry-point.js"]),
    ["https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs", "mermaid-entry-point.mjs"],
    ["https://cdn.jsdelivr.net/npm/mermaid@11/dist/chunks/fixture-render.mjs", "mermaid-render.mjs"],
  ]);

  // These stand-ins verify source/CSP/module contracts. Only the opt-in live check uses upstream libraries.
  await context.route(/^https:\/\//, async (route) => {
    const url = route.request().url();
    requestedUrls.push(url);
    const source = sources.get(url);

    if (!source) {
      unexpectedUrls.push(url);
      await route.abort("blockedbyclient");
      return;
    }

    await route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: await readFile(new URL(source, fixtureDirectory), "utf8"),
    });
  });

  return { requestedUrls, unexpectedUrls };
}
