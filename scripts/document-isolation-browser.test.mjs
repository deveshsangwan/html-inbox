import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { exportStaticSnapshot } from "../packages/cli/dist/static-export.js";
import { startViewer } from "../packages/cli/dist/viewer-server.js";

const storageKey = "html-inbox-isolation-secret";
const viewerSecret = "viewer-only-data";
const cdnScripts = new Map([
  ["https://cdn.tailwindcss.com/", "document.querySelector('#tailwind').textContent = 'executed';"],
  ["https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4", "document.querySelector('#tailwind-browser').textContent = 'executed';"],
  ["https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs", "import { markExecuted } from './chunk.mjs'; markExecuted();"],
  ["https://cdn.jsdelivr.net/npm/mermaid@11/dist/chunk.mjs", "export function markExecuted() { document.querySelector('#mermaid').textContent = 'executed'; }"],
]);

test("response sandbox isolates direct documents and reader frames", { timeout: 120_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-document-isolation-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const backend = new LocalDocumentBackend(home);
  const published = await backend.publish({
    title: "Document isolation probe",
    type: "report",
    sourceFileName: "isolation.html",
    originalBytes: Buffer.from(renderIsolationProbe()),
  });
  const viewer = await startViewer(backend, home, 0);
  t.after(() => closeServer(viewer));
  const localOrigin = serverOrigin(viewer);

  const snapshot = await exportStaticSnapshot(backend, {
    outputDir: path.join(home, "snapshot"),
    capability: "AAAAAAAAAAAAAAAAAAAAAA",
  });
  const staticServer = await serveSnapshot(snapshot, published.id);
  t.after(() => closeServer(staticServer));
  const staticOrigin = serverOrigin(staticServer);

  const browser = await chromium.launch(
    process.env.HTML_INBOX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE }
      : {},
  );
  t.after(() => browser.close());

  const documentPaths = [
    { name: "local content", origin: localOrigin, inboxPath: "", contentPath: `/documents/${published.id}/content` },
    ...["", "/", "/index.html"].map((alias) => ({
      name: `exported content${alias || " without trailing slash"}`,
      origin: staticOrigin,
      inboxPath: snapshot.inboxPath,
      contentPath: `${snapshot.inboxPath}/documents/${published.id}/content${alias}`,
    })),
  ];

  for (const { name, origin, inboxPath, contentPath } of documentPaths) {
    await t.test(`${name} blocks opener data and storage`, async (t) => {
      const { page, cdnRequests } = await createViewerPage(t, browser, origin, inboxPath);

      const popupPromise = page.waitForEvent("popup");
      await page.evaluate((contentPath) => window.open(contentPath), contentPath);
      const contentPage = await popupPromise;
      await contentPage.waitForLoadState();

      await assertIsolation(contentPage);
      assert.deepEqual([...cdnRequests].sort(), [...cdnScripts.keys()].sort());
      await assertViewerUnchanged(page);
    });
  }

  for (const { name, origin, inboxPath } of [
    { name: "local reader", origin: localOrigin, inboxPath: "" },
    { name: "exported reader", origin: staticOrigin, inboxPath: snapshot.inboxPath },
  ]) {
    await t.test(`${name} keeps iframe isolation and supported scripts`, async (t) => {
      const { page, cdnRequests } = await createViewerPage(t, browser, origin, inboxPath);

      await page.goto(`${origin}${inboxPath}/documents/${published.id}${inboxPath ? "/" : ""}`);
      assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");

      await assertIsolation(page.frameLocator("iframe"));
      assert.deepEqual([...cdnRequests].sort(), [...cdnScripts.keys()].sort());
      await assertViewerUnchanged(page);
    });
  }
});

function renderIsolationProbe() {
  return `<!doctype html><html><body>
<pre id="probe">pending</pre>
<p id="tailwind">pending</p><p id="tailwind-browser">pending</p><p id="mermaid">pending</p>
<script>(${probeDocument.toString()})(${JSON.stringify(storageKey)});</script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"></script>
</body></html>`;
}

async function probeDocument(storageKey) {
  function attempt(operation) {
    try {
      operation();

      return "allowed";
    } catch (error) {
      return error.name;
    }
  }

  const relatedWindow = window.opener ?? window.parent;
  const results = {
    origin: window.origin,
    hasRelatedWindow: relatedWindow !== window,
    viewerDomRead: attempt(() => relatedWindow.document.title),
    viewerDomWrite: attempt(() => {
      relatedWindow.document.documentElement.dataset.compromised = "yes";
    }),
    viewerStorageRead: attempt(() => relatedWindow.localStorage.getItem(storageKey)),
    localStorageRead: attempt(() => localStorage.getItem(storageKey)),
    localStorageWrite: attempt(() => localStorage.setItem(storageKey, "compromised")),
    sessionStorageRead: attempt(() => sessionStorage.getItem(storageKey)),
    sessionStorageWrite: attempt(() => sessionStorage.setItem(storageKey, "compromised")),
    cookieRead: attempt(() => document.cookie),
    cookieWrite: attempt(() => {
      document.cookie = `${storageKey}=compromised; path=/`;
    }),
    indexedDb: attempt(() => indexedDB.open(storageKey)),
  };

  // The local health response and exported manifest both contain viewer data.
  const capabilityMatch = /^\/i\/[^/]+/.exec(location.pathname);
  const viewerDataPath = capabilityMatch ? `${capabilityMatch[0]}/snapshot-manifest.json` : "/health";

  try {
    await fetch(viewerDataPath);
    results.viewerDataFetch = "allowed";
  } catch (error) {
    results.viewerDataFetch = error.name;
  }

  document.querySelector("#probe").textContent = JSON.stringify(results);
}

async function createViewerPage(t, browser, origin, inboxPath) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => context.close());
  context.setDefaultTimeout(5_000);
  const cdnRequests = new Set();

  // Fulfill every supported CDN request and abort other external traffic.
  // Module stubs need CORS because the sandbox gives the document a null origin.
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const script = cdnScripts.get(requestUrl);
    if (script !== undefined) {
      cdnRequests.add(requestUrl);
      await route.fulfill({
        contentType: "text/javascript",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: script,
      });

      return;
    }

    if (new URL(requestUrl).origin === origin) {
      await route.continue();

      return;
    }

    await route.abort();
    assert.fail(`Unexpected external request: ${requestUrl}`);
  });

  const page = await context.newPage();
  await page.goto(`${origin}${inboxPath}/`);
  await page.evaluate(({ storageKey, viewerSecret }) => {
    localStorage.setItem(storageKey, viewerSecret);
    sessionStorage.setItem(storageKey, viewerSecret);
    document.cookie = `${storageKey}=${viewerSecret}; path=/`;
  }, { storageKey, viewerSecret });

  return { page, cdnRequests };
}

async function assertIsolation(documentPage) {
  await documentPage.locator("#probe").filter({ hasText: '"viewerDataFetch"' }).waitFor();
  const results = JSON.parse(await documentPage.locator("#probe").textContent());
  assert.deepEqual(results, {
    origin: "null",
    hasRelatedWindow: true,
    viewerDomRead: "SecurityError",
    viewerDomWrite: "SecurityError",
    viewerStorageRead: "SecurityError",
    localStorageRead: "SecurityError",
    localStorageWrite: "SecurityError",
    sessionStorageRead: "SecurityError",
    sessionStorageWrite: "SecurityError",
    cookieRead: "SecurityError",
    cookieWrite: "SecurityError",
    indexedDb: "SecurityError",
    viewerDataFetch: "TypeError",
  });

  for (const scriptId of ["tailwind", "tailwind-browser", "mermaid"]) {
    await documentPage.locator(`#${scriptId}`).getByText("executed", { exact: true }).waitFor();
  }
}

async function assertViewerUnchanged(page) {
  assert.deepEqual(await page.evaluate((storageKey) => ({
    localStorage: localStorage.getItem(storageKey),
    sessionStorage: sessionStorage.getItem(storageKey),
    cookie: document.cookie,
    compromised: document.documentElement.dataset.compromised,
  }), storageKey), {
    localStorage: viewerSecret,
    sessionStorage: viewerSecret,
    cookie: `${storageKey}=${viewerSecret}`,
    compromised: undefined,
  });
}

async function serveSnapshot(snapshot, documentId) {
  const security = JSON.parse(await readFile(
    path.join(snapshot.outputDir, snapshot.inboxPath.slice(1), "security-headers.json"),
    "utf8",
  ));
  const documentPath = `${snapshot.inboxPath}/documents/${documentId}`;
  const routes = new Map();

  for (const [routePath, filePath, headers, contentType] of [
    [`${snapshot.inboxPath}/`, `${snapshot.inboxPath}/index.html`, security.shell, "text/html"],
    [`${documentPath}/`, `${documentPath}/index.html`, security.shell, "text/html"],
    [`${documentPath}/content/`, `${documentPath}/content/index.html`, security.document, "text/html"],
    [`${documentPath}/content/index.html`, `${documentPath}/content/index.html`, security.document, "text/html"],
    [`${snapshot.inboxPath}/assets/viewer.js`, `${snapshot.inboxPath}/assets/viewer.js`, {}, "text/javascript"],
    [`${snapshot.inboxPath}/assets/viewer.css`, `${snapshot.inboxPath}/assets/viewer.css`, {}, "text/css"],
    [`${snapshot.inboxPath}/snapshot-manifest.json`, `${snapshot.inboxPath}/snapshot-manifest.json`, {}, "application/json"],
  ]) {
    routes.set(routePath, {
      body: await readFile(path.join(snapshot.outputDir, filePath.slice(1))),
      headers: { ...security.common, ...headers, "Content-Type": contentType },
    });
  }

  // Directory requests without a trailing slash redirect before serving content.
  const server = http.createServer((request, response) => {
    if (request.url === `${documentPath}/content`) {
      response.writeHead(308, { Location: `${documentPath}/content/` });
      response.end();

      return;
    }

    const route = routes.get(request.url);
    if (!route) {
      response.writeHead(404);
      response.end();

      return;
    }

    response.writeHead(200, route.headers);
    response.end(route.body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return server;
}

function serverOrigin(server) {
  const address = server.address();
  assert(address && typeof address !== "string");

  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
