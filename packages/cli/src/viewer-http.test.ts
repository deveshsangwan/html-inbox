import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import {
  getViewerStatus,
  startViewer,
  stopViewer,
} from "./viewer-server";
import { temporaryHome } from "./test-fixtures";
import { DOCUMENT_CSP } from "./viewer-assets";
import { readPreferences, setAppearancePreference } from "./preferences";
import { startViewerHttpServer } from "./viewer-http-server";
import { resolveViewerNetworkConfig } from "./viewer-network";

test("viewer copy resource reads only the requested document and preserves reader policies", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const originalBytes = Buffer.from("\ufeff<!doctype html>\r\n<body><h1>Copy report</h1><pre><code>\tconst x = &lt;tag&gt;;  \r\n</code></pre></body>\r\n");
  const metadata = await backend.publish({ originalBytes, title: "Copy report", type: "report", sourceFileName: "copy.html" });
  const getDocument = t.mock.method(backend, "getDocument");
  const server = await startViewerHttpServer(backend, resolveViewerNetworkConfig(0), {
    instanceId: "test-instance", processId: "test-process", protocolVersion: 1, pid: process.pid,
  }, undefined, { inboxName: "reports" });
  t.after(() => server.close());
  const baseUrl = server.urls[0];
  const documentUrl = `${baseUrl}/documents/${metadata.id}`;

  assert.equal((await fetch(documentUrl)).status, 200);
  assert.equal((await fetch(documentUrl, { method: "HEAD" })).status, 200);
  assert.equal(getDocument.mock.callCount(), 0);

  const response = await fetch(`${documentUrl}/copy.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.has("content-security-policy"), false);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1, status: "ready", text: "Copy report\n\tconst x = <tag>;  \n", codeBlocks: ["\tconst x = <tag>;  \n"],
  });
  assert.equal(getDocument.mock.callCount(), 1);

  const head = await fetch(`${documentUrl}/copy.json`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), response.headers.get("content-type"));
  assert.equal(await head.text(), "");

  const content = await fetch(`${documentUrl}/content`);
  assert.equal(content.headers.get("content-security-policy"), DOCUMENT_CSP);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), originalBytes);
  assert.deepEqual(await readFile(path.join(home, "documents", metadata.id, "index.html")), originalBytes);

  const readsBeforeDeniedRequests = getDocument.mock.callCount();

  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const denied = await fetch(`${documentUrl}/copy.json`, { method });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get("allow"), "GET, HEAD");
  }

  assert.equal((await requestWithHost(server.config.port, "attacker.example", `/documents/${metadata.id}/copy.json`)).statusCode, 421);
  assert.equal(getDocument.mock.callCount(), readsBeforeDeniedRequests);

  for (const route of ["/documents/missing/copy.json", "/documents/%2e%2e/copy.json", "/documents/bad%2Fid/copy.json", `/documents/${metadata.id}/copy.json/`, `/sources/reports/documents/${metadata.id}/copy.json`]) {
    const missing = await fetch(`${baseUrl}${route}`);
    assert.equal(missing.status, 404, route);
    assert.equal(await missing.text(), "Not Found");
  }

  await backend.deleteDocument(metadata.id);
  assert.equal((await fetch(`${documentUrl}/copy.json`)).status, 404);
});

test("viewer copy failures leave shells and original content readable", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const metadata = await backend.publish({ originalBytes: Buffer.from("<body>Original</body>"), title: "Copy limits", type: "report", sourceFileName: "limits.html" });
  const server = await startViewerHttpServer(backend, resolveViewerNetworkConfig(0), {
    instanceId: "test-instance", processId: "test-process", protocolVersion: 1, pid: process.pid,
  });
  t.after(() => server.close());
  const documentUrl = `${server.urls[0]}/documents/${metadata.id}`;
  const documentPath = path.join(home, "documents", metadata.id, "index.html");
  const previousLimit = process.env.HTML_INBOX_MAX_BYTES;
  t.after(() => {
    if (previousLimit === undefined) {
      delete process.env.HTML_INBOX_MAX_BYTES;
      return;
    }

    process.env.HTML_INBOX_MAX_BYTES = previousLimit;
  });
  process.env.HTML_INBOX_MAX_BYTES = "128";

  for (const [bytes, reason] of [
    [Buffer.from([0xff]), "invalid-encoding"],
    [Buffer.alloc(129, "x"), "too-large"],
  ] as const) {
    await writeFile(documentPath, bytes);
    const copy = await fetch(`${documentUrl}/copy.json`);
    assert.equal(copy.status, 200);
    assert.deepEqual(await copy.json(), { schemaVersion: 1, status: "unavailable", reason });
    assert.equal((await fetch(documentUrl)).status, 200);

    const content = await fetch(`${documentUrl}/content`);
    assert.equal(content.headers.get("content-security-policy"), DOCUMENT_CSP);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  }
});

test("viewer falls back to system for unreadable preferences without repairing them", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const originalBytes = Buffer.from("<!doctype html><html><body>Readable report</body></html>");
  const metadata = await backend.publish({
    originalBytes,
    title: "Readable report",
    type: "report",
    sourceFileName: "readable.html",
  });
  const diagnostics: unknown[] = [];
  t.mock.method(console, "error", (message: unknown) => {
    diagnostics.push(message);
  });
  const server = await startViewer(backend, home, 0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const documentUrl = `${baseUrl}/documents/${metadata.id}`;
  const preferencesPath = path.join(home, "preferences.json");
  const invalidRecords = [
    "{",
    '{"schemaVersion":2,"appearance":"dark"}',
    '{"schemaVersion":1,"appearance":"invalid"}',
    " ".repeat(4097),
  ];

  for (const contents of invalidRecords) {
    await writeFile(preferencesPath, contents);
    const diagnosticCount = diagnostics.length;

    for (const url of [baseUrl, documentUrl]) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /name="html-inbox-appearance" content="system"/);
    }

    assert.equal(diagnostics.length, diagnosticCount + 2);
    for (const diagnostic of diagnostics.slice(diagnosticCount)) {
      assert.match(String(diagnostic), /^html-inbox: Ignoring unreadable preferences:/);
    }

    await assert.rejects(readPreferences(home));
    await assert.rejects(setAppearancePreference(home, "dark"));
    assert.equal(await readFile(preferencesPath, "utf8"), contents);
  }

  const content = await fetch(`${documentUrl}/content`);
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), originalBytes);
  assert.equal(content.headers.get("content-security-policy"), DOCUMENT_CSP);
});

test("viewer reads the saved appearance without restarting or modifying documents", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const originalBytes = Buffer.from("<!doctype html><html><body>Original report</body></html>");
  const metadata = await backend.publish({
    originalBytes,
    title: "Appearance report",
    type: "report",
    sourceFileName: "appearance.html",
  });
  const server = await startViewer(backend, home, 0);
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const documentUrl = `${baseUrl}/documents/${metadata.id}`;
  const systemIndex = await fetch(baseUrl);
  assert.match(await systemIndex.text(), /name="html-inbox-appearance" content="system"/);

  for (const appearance of ["dark", "light", "system"] as const) {
    await setAppearancePreference(home, appearance);

    for (const url of [baseUrl, documentUrl]) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`name="html-inbox-appearance" content="${appearance}"`));
    }
  }

  const content = await fetch(`${documentUrl}/content`);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), originalBytes);
  assert.equal(content.headers.get("content-security-policy"), DOCUMENT_CSP);
});

test("viewer serves isolated documents and searches metadata", async (t) => {
  const home = await temporaryHome(t);
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (warning) =>
    warnings.push(warning),
  );
  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const server = await startViewer(backend, home, 0);
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.ok, true);
  const health: unknown = await healthResponse.json();
  assert.deepEqual(health, { ok: true });

  const hostileHost = await requestWithHost(address.port, "attacker.example");
  assert.equal(hostileHost.statusCode, 421);
  assert.equal((await getViewerStatus(home, address.port)).state, "running");
  const processRecordPath = path.join(home, "viewer.json");
  const processRecord = await readFile(processRecordPath, "utf8");
  await writeFile(
    processRecordPath,
    JSON.stringify({
      ...JSON.parse(processRecord),
      processId: "11111111-1111-4111-8111-111111111111",
    }),
  );
  const staleStatus = await getViewerStatus(home, address.port);
  assert.equal(staleStatus.state, "running");
  assert.equal(staleStatus.pid, undefined);
  await assert.rejects(stopViewer(home, address.port), /missing or stale/);
  await writeFile(processRecordPath, processRecord);

  const interruptedStaging = path.join(
    home,
    "documents",
    ".staging",
    "interrupted",
  );
  await mkdir(interruptedStaging, { recursive: true });
  await writeFile(path.join(interruptedStaging, "index.html"), html);

  const emptyIndex = await fetch(baseUrl);
  const emptyIndexCsp = emptyIndex.headers.get("content-security-policy") ?? "";
  const emptyIndexHtml = await emptyIndex.text();
  assert.equal(emptyIndexHtml.includes('class="empty-state"'), true);
  assert.equal(emptyIndexHtml.includes("No documents yet"), true);
  assert.equal(emptyIndexHtml.includes("0 documents"), true);

  const published = await backend.publish({
    originalBytes: Buffer.from(html),
    title: "Report",
    type: "report",
    sourceFileName: "report.html",
  });
  assert.equal(published.schemaVersion, 1);
  const stored = await readFile(
    path.join(home, "documents", published.id, "index.html"),
    "utf8",
  );
  assert.equal(stored, html);

  if (process.platform !== "win32") {
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(home, "documents", published.id))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await stat(path.join(home, "documents", published.id, "index.html")))
        .mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(path.join(home, "instance-id"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(path.join(home, "viewer.json"))).mode & 0o777,
      0o600,
    );
  }

  const singularIndex = await fetch(baseUrl);
  const indexCsp = singularIndex.headers.get("content-security-policy") ?? "";
  assert.equal(indexCsp.includes("script-src 'self'"), true);
  assert.equal(indexCsp.includes("style-src 'self'"), true);
  assert.equal(indexCsp.includes("form-action 'self'"), true);
  assert.equal(indexCsp.includes("'unsafe-inline'"), false);
  assert.equal(emptyIndexCsp, indexCsp);
  const singularIndexHtml = await singularIndex.text();
  assert.equal(singularIndexHtml.includes('class="document-list"'), true);
  assert.equal(singularIndexHtml.includes("report.html"), true);
  assert.equal(singularIndexHtml.match(/data-theme-option/g)?.length, 3);
  assert.equal(singularIndexHtml.includes("1 document"), true);
  assert.equal(singularIndexHtml.includes("1 documents"), false);

  const stylesheet = await fetch(`${baseUrl}/assets/viewer.css`);
  assert.equal(
    stylesheet.headers.get("content-type"),
    "text/css; charset=utf-8",
  );
  assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);

  const viewerScript = await fetch(`${baseUrl}/assets/viewer.js`);
  assert.equal(
    viewerScript.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.match(viewerScript.headers.get("content-type") ?? "", /javascript/);

  const shell = await fetch(`${baseUrl}/documents/${published.id}`);
  assert.equal(
    shell.headers.get("content-security-policy")?.includes("frame-src 'self'"),
    true,
  );
  const shellHtml = await shell.text();
  assert.equal(shellHtml.includes('<iframe sandbox="allow-scripts"'), true);
  assert.equal(shellHtml.includes("allow-same-origin"), false);
  assert.equal(shellHtml.includes("report.html"), true);
  assert.equal(shellHtml.includes("Back to inbox"), true);

  const content = await fetch(`${baseUrl}/documents/${published.id}/content`);
  const csp = content.headers.get("content-security-policy") ?? "";
  assert.equal(csp, DOCUMENT_CSP);
  assert.match(csp, /(?:^|;\s*)sandbox allow-scripts(?:;|$)/);
  assert.equal(csp.includes("allow-same-origin"), false);
  assert.equal(
    csp.includes("script-src 'unsafe-inline' https://cdn.tailwindcss.com"),
    true,
  );
  assert.equal(csp.includes("script-src-attr 'none'"), true);
  assert.equal(
    csp.includes("https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"),
    true,
  );
  assert.equal(
    csp.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/"),
    true,
  );
  assert.equal(csp.includes("connect-src 'none'"), true);
  assert.equal(csp.includes("frame-src 'none'"), true);
  assert.equal(csp.includes("form-action 'none'"), true);
  assert.equal(csp.includes("base-uri 'none'"), true);
  assert.equal(await content.text(), html);

  const contentHead = await fetch(`${baseUrl}/documents/${published.id}/content`, {
    method: "HEAD",
  });
  assert.equal(contentHead.status, 200);
  assert.equal(contentHead.headers.get("content-security-policy"), csp);
  assert.equal(await contentHead.text(), "");

  const hostileTitle = 'Title </h1><script>alert("title")</script>';
  const hostileType = "report\"><svg/onload=alert('type')>";
  const hostileSource = "source.html\" autofocus onfocus=\"alert('source')";
  const hostile = await backend.publish({
    originalBytes: Buffer.from(html),
    title: hostileTitle,
    type: hostileType,
    sourceFileName: hostileSource,
  });

  const pluralIndexHtml = await (await fetch(baseUrl)).text();
  assert.equal(pluralIndexHtml.includes("2 documents"), true);
  assert.equal(pluralIndexHtml.includes(hostileTitle), false);
  assert.equal(pluralIndexHtml.includes(hostileType), false);
  assert.equal(pluralIndexHtml.includes(hostileSource), false);

  const searchResultHtml = await (
    await fetch(`${baseUrl}/?q=report.html`)
  ).text();
  assert.equal(searchResultHtml.includes("1 of 2 documents"), true);
  assert.equal(searchResultHtml.includes("Search documents"), true);
  assert.equal(searchResultHtml.includes('value="report.html"'), true);
  const noSearchResultHtml = await (
    await fetch(`${baseUrl}/?q=missing`)
  ).text();
  assert.equal(noSearchResultHtml.includes("No matching documents"), true);
  assert.equal(
    pluralIndexHtml.includes(
      "Title &#60;/h1&#62;&#60;script&#62;alert(&#34;title&#34;)&#60;/script&#62;",
    ),
    true,
  );
  assert.equal(
    pluralIndexHtml.includes(
      "report&#34;&#62;&#60;svg/onload=alert(&#39;type&#39;)&#62;",
    ),
    true,
  );
  assert.equal(
    pluralIndexHtml.includes(
      "source.html&#34; autofocus onfocus=&#34;alert(&#39;source&#39;)",
    ),
    true,
  );

  const hostileShellHtml = await (
    await fetch(`${baseUrl}/documents/${hostile.id}`)
  ).text();
  assert.equal(hostileShellHtml.includes(hostileTitle), false);
  assert.equal(hostileShellHtml.includes(hostileType), false);
  assert.equal(hostileShellHtml.includes(hostileSource), false);
  assert.equal(hostileShellHtml.includes("&#60;/h1&#62;"), true);
  assert.equal(
    hostileShellHtml.includes(
      "report&#34;&#62;&#60;svg/onload=alert(&#39;type&#39;)&#62;",
    ),
    true,
  );
  assert.equal(
    hostileShellHtml.includes(
      "source.html&#34; autofocus onfocus=&#34;alert(&#39;source&#39;)",
    ),
    true,
  );
  assert.equal(hostileShellHtml.includes('onfocus="alert'), false);
});
async function requestWithHost(
  port: number,
  host: string,
  requestPath = "/health",
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, headers: { Host: host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}
