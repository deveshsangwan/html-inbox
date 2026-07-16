import { strict as assert } from "node:assert";
import http from "node:http";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import { formatUsage, getCliVersion } from "./index";
import { loadPublishInput } from "./publish-input";
import { startViewer, VIEWER_PROTOCOL_VERSION } from "./viewer";

async function run(): Promise<void> {
  assert.match(formatUsage(), /publish <file\.html>/);
  assert.match(formatUsage(), /viewer/);
  assert.equal(getCliVersion(), "0.1.0");

  const inputHome = await mkdtemp(path.join(tmpdir(), "html-inbox-input-"));
  const inputPath = path.join(inputHome, "report.html");
  const inputHtml = "<!doctype html><html><body>bounded</body></html>";
  await writeFile(inputPath, inputHtml);
  await assert.rejects(
    loadPublishInput(
      { filePath: inputPath, title: "Report", type: "report" },
      { HTML_INBOX_MAX_BYTES: "8" },
    ),
    /the limit is 8 bytes/,
  );
  await assert.rejects(
    loadPublishInput(
      { filePath: inputPath, title: " ", type: "report" },
      { HTML_INBOX_MAX_BYTES: "1024" },
    ),
    /title must not be empty/,
  );

  if (process.platform !== "win32") {
    const unsafeHome = await mkdtemp(path.join(tmpdir(), "html-inbox-unsafe-"));
    const symlinkTarget = path.join(unsafeHome, "target.txt");
    await writeFile(symlinkTarget, "do not overwrite");
    await symlink(symlinkTarget, path.join(unsafeHome, "instance-id"));
    await assert.rejects(
      startViewer(new LocalDocumentBackend(unsafeHome), unsafeHome, 0),
      /Managed file is not a regular file/,
    );
    assert.equal(await readFile(symlinkTarget, "utf8"), "do not overwrite");
  }

  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-"));
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (warning) => warnings.push(warning));
  assert.equal(await backend.getDocument("missing"), null);
  await assert.rejects(
    stat(path.join(home, "documents", "missing")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const failedViewerHome = await mkdtemp(path.join(tmpdir(), "html-inbox-failed-viewer-"));
  await mkdir(path.join(failedViewerHome, "viewer.json"));
  const failedViewerPort = await availablePort();
  await assert.rejects(
    startViewer(new LocalDocumentBackend(failedViewerHome), failedViewerHome, failedViewerPort),
    /Managed file is not a regular file/,
  );
  await assertPortAvailable(failedViewerPort);

  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const server = await startViewer(backend, home, 0);
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.ok, true);
    const health = (await healthResponse.json()) as Record<string, unknown>;
    assert.equal(health.protocolVersion, VIEWER_PROTOCOL_VERSION);
    assert.equal(typeof health.instanceId, "string");
    assert.equal("home" in health, false);

    const hostileHost = await requestWithHost(address.port, "attacker.example");
    assert.equal(hostileHost.statusCode, 421);

    const interruptedStaging = path.join(home, "documents", ".staging", "interrupted");
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
    assert.equal(published.metadata.schemaVersion, 1);
    const stored = await readFile(
      path.join(home, "documents", published.metadata.id, "index.html"),
      "utf8",
    );
    assert.equal(stored, html);

    if (process.platform !== "win32") {
      assert.equal((await stat(home)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(home, "documents", published.metadata.id))).mode & 0o777,
        0o700,
      );
      assert.equal(
        (await stat(path.join(home, "documents", published.metadata.id, "index.html"))).mode &
          0o777,
        0o600,
      );
      assert.equal((await stat(path.join(home, "instance-id"))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(home, "viewer.json"))).mode & 0o777, 0o600);
    }

    const singularIndex = await fetch(baseUrl);
    const indexCsp = singularIndex.headers.get("content-security-policy") ?? "";
    assert.equal(indexCsp.includes("script-src 'self'"), true);
    assert.equal(indexCsp.includes("style-src 'self'"), true);
    assert.equal(indexCsp.includes("'unsafe-inline'"), false);
    assert.equal(emptyIndexCsp, indexCsp);
    const singularIndexHtml = await singularIndex.text();
    assert.equal(singularIndexHtml.includes('class="document-list"'), true);
    assert.equal(singularIndexHtml.includes("report.html"), true);
    assert.equal(singularIndexHtml.includes('data-theme-selector'), true);
    assert.equal(singularIndexHtml.includes("1 document"), true);
    assert.equal(singularIndexHtml.includes("1 documents"), false);

    const stylesheet = await fetch(`${baseUrl}/assets/viewer.css`);
    assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
    const stylesheetText = await stylesheet.text();
    assert.equal(stylesheetText.includes('[data-theme="dark"]'), true);
    assert.equal(stylesheetText.includes("--muted: #5d655f"), true);
    assert.equal(stylesheetText.includes("--faint: #646c66"), true);

    const viewerScript = await fetch(`${baseUrl}/assets/viewer.js`);
    assert.equal(viewerScript.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await viewerScript.text()).includes("html-inbox-theme"), true);

    const shell = await fetch(`${baseUrl}/documents/${published.metadata.id}`);
    assert.equal(shell.headers.get("content-security-policy")?.includes("frame-src 'self'"), true);
    const shellHtml = await shell.text();
    assert.equal(shellHtml.includes('<iframe sandbox="allow-scripts"'), true);
    assert.equal(shellHtml.includes("allow-same-origin"), false);
    assert.equal(shellHtml.includes("report.html"), true);
    assert.equal(shellHtml.includes("Back to inbox"), true);

    const content = await fetch(`${baseUrl}/documents/${published.metadata.id}/content`);
    const csp = content.headers.get("content-security-policy") ?? "";
    assert.equal(csp.includes("script-src 'unsafe-inline' https://cdn.tailwindcss.com"), true);
    assert.equal(csp.includes("https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"), true);
    assert.equal(csp.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/"), true);
    assert.equal(csp.includes("connect-src 'none'"), true);
    assert.equal(csp.includes("frame-src 'none'"), true);
    assert.equal(await content.text(), html);

    const hostileTitle = 'Title </h1><script>alert("title")</script>';
    const hostileType = "report\"><svg/onload=alert('type')>";
    const hostileSource = 'source.html\" autofocus onfocus="alert(\'source\')';
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
      await fetch(`${baseUrl}/documents/${hostile.metadata.id}`)
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

    const corruptId = "corrupt-record";
    const corruptDir = path.join(home, "documents", corruptId);
    await mkdir(corruptDir);
    await writeFile(path.join(corruptDir, "index.html"), html);
    await writeFile(path.join(corruptDir, "metadata.json"), "{not-json");

    const mismatchedId = "mismatched-record";
    const mismatchedDir = path.join(home, "documents", mismatchedId);
    await mkdir(mismatchedDir);
    await writeFile(path.join(mismatchedDir, "index.html"), html);
    await writeFile(
      path.join(mismatchedDir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "different-id",
        title: "Mismatched report",
        type: "report",
        createdAt: "2026-07-16T00:00:00.000Z",
        sourceFileName: "mismatched.html",
      }),
    );

    const documentsAfterCorruption = await backend.listDocuments();
    assert.equal(documentsAfterCorruption.length, 2);
    assert.equal(await backend.getDocument(corruptId), null);
    assert.equal(warnings.some((warning) => warning.includes(corruptId)), true);
    assert.equal(warnings.some((warning) => warning.includes(mismatchedId)), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertPortAvailable(port: number): Promise<void> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

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
        response.on("end", () => resolve({ statusCode: response.statusCode, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

void run();
