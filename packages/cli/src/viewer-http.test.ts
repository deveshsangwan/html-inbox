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
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/health", headers: { Host: host } },
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
