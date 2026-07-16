import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import {
  formatDeleteResult,
  formatDocumentList,
  formatStaticExportResult,
  formatUsage,
  getCliVersion,
} from "./index";
import { loadPublishInput } from "./publish-input";
import { exportStaticSnapshot, generateInboxCapability } from "./static-export";
import {
  documentCsp,
  ensureViewer,
  getViewerStatus,
  startViewer,
  stopViewer,
  VIEWER_PROTOCOL_VERSION,
} from "./viewer";

async function run(): Promise<void> {
  assert.match(formatUsage(), /publish <file\.html>/);
  assert.match(formatUsage(), /viewer/);
  assert.match(formatUsage(), /delete <id>/);
  assert.match(formatUsage(), /export --out <directory>/);
  assert.equal(getCliVersion(), "0.1.0");
  for (let index = 0; index < 10; index += 1) {
    const generatedCapability = generateInboxCapability();
    assert.equal(generatedCapability.length, 22);
    assert.equal(Buffer.from(generatedCapability, "base64url").byteLength, 16);
    assert.equal(
      Buffer.from(generatedCapability, "base64url").toString("base64url"),
      generatedCapability,
    );
  }

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

  const blockedHome = await mkdtemp(path.join(tmpdir(), "html-inbox-blocked-"));
  const blocker = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const blockerAddress = blocker.address();
  assert(blockerAddress && typeof blockerAddress !== "string");
  await assert.rejects(
    ensureViewer(blockedHome, blockerAddress.port),
    /Port .* is already in use/,
  );
  await new Promise<void>((resolve, reject) =>
    blocker.close((error) => (error ? reject(error) : resolve())),
  );

  const lifecycleHome = await mkdtemp(path.join(tmpdir(), "html-inbox-lifecycle-"));
  const lifecyclePort = await reservePort();
  const viewerProcess = spawn(process.execPath, [path.join(__dirname, "index.js"), "viewer"], {
    env: {
      ...process.env,
      HTML_INBOX_HOME: lifecycleHome,
      HTML_INBOX_PORT: String(lifecyclePort),
    },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 3000;
    while (
      (await getViewerStatus(lifecycleHome, lifecyclePort)).state !== "running" &&
      Date.now() < deadline
    ) {
      await delay(50);
    }
    assert.equal((await getViewerStatus(lifecycleHome, lifecyclePort)).state, "running");
    assert.equal((await stopViewer(lifecycleHome, lifecyclePort)).state, "stopped");
    if (viewerProcess.exitCode === null) {
      await once(viewerProcess, "exit");
    }
  } finally {
    if (viewerProcess.exitCode === null) {
      viewerProcess.kill("SIGTERM");
    }
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
    assert.equal((await getViewerStatus(home, address.port)).state, "running");

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

    const searchResultHtml = await (await fetch(`${baseUrl}/?q=report.html`)).text();
    assert.equal(searchResultHtml.includes("1 of 2 documents"), true);
    assert.equal(searchResultHtml.includes("Search documents"), true);
    assert.equal(searchResultHtml.includes('value="report.html"'), true);
    const noSearchResultHtml = await (await fetch(`${baseUrl}/?q=missing`)).text();
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

    const snapshotDirectory = path.join(home, "snapshot");
    const capability = "AAAAAAAAAAAAAAAAAAAAAA";
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const firstSnapshot = await exportStaticSnapshot(backend, {
      outputDir: snapshotDirectory,
      capability,
      ownerId,
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    assert.equal(firstSnapshot.inboxPath, `/i/${capability}`);
    assert.equal(firstSnapshot.manifest.documentCount, 2);
    assert.match(formatStaticExportResult(firstSnapshot, false), /Exported 2 documents/);
    assert.equal(
      JSON.parse(formatStaticExportResult(firstSnapshot, true)).capability,
      capability,
    );

    const snapshotRoot = await readFile(path.join(snapshotDirectory, "index.html"), "utf8");
    assert.equal(snapshotRoot.includes(capability), false);
    assert.equal(snapshotRoot.includes("no public inbox listing"), true);
    const snapshotIndex = await readFile(
      path.join(snapshotDirectory, "i", capability, "index.html"),
      "utf8",
    );
    assert.equal(snapshotIndex.includes(`src="/i/${capability}/assets/viewer.js"`), true);
    assert.equal(snapshotIndex.includes("data-client-search"), true);
    assert.equal(
      snapshotIndex.includes(`/i/${capability}/documents/${published.metadata.id}/`),
      true,
    );
    const snapshotShell = await readFile(
      path.join(
        snapshotDirectory,
        "i",
        capability,
        "documents",
        published.metadata.id,
        "index.html",
      ),
      "utf8",
    );
    assert.equal(
      snapshotShell.includes(
        `/i/${capability}/documents/${published.metadata.id}/content/`,
      ),
      true,
    );
    assert.deepEqual(
      await readFile(
        path.join(
          snapshotDirectory,
          "i",
          capability,
          "documents",
          published.metadata.id,
          "content",
          "index.html",
        ),
      ),
      Buffer.from(html),
    );

    const ownerMarker = JSON.parse(
      await readFile(path.join(snapshotDirectory, ".html-inbox-owner.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(ownerMarker, { schemaVersion: 1, ownerId });
    const securityHeaders = JSON.parse(
      await readFile(
        path.join(snapshotDirectory, "i", capability, "security-headers.json"),
        "utf8",
      ),
    ) as { routes: Array<{ path: string; headers: Record<string, string> }> };
    assert.equal(
      securityHeaders.routes.some(
        (route) =>
          route.path ===
            `/i/${capability}/documents/${published.metadata.id}/content/` &&
          route.headers["Content-Security-Policy"] === documentCsp(),
      ),
      true,
    );
    assert.deepEqual(
      firstSnapshot.manifest.files.map((file) => file.path),
      firstSnapshot.manifest.files.map((file) => file.path).sort(),
    );
    const manifestText = await readFile(
      path.join(snapshotDirectory, "i", capability, "snapshot-manifest.json"),
      "utf8",
    );
    assert.equal(manifestText.includes(home), false);

    const secondSnapshot = await exportStaticSnapshot(backend, {
      outputDir: snapshotDirectory,
      capability,
      ownerId,
      generatedAt: "2026-07-16T01:00:00.000Z",
    });
    assert.equal(secondSnapshot.manifest.snapshotHash, firstSnapshot.manifest.snapshotHash);
    await assert.rejects(
      exportStaticSnapshot(backend, {
        outputDir: path.join(home, "invalid-snapshot"),
        capability: "too-short",
      }),
      /exactly 128 bits/,
    );
    await assert.rejects(
      exportStaticSnapshot(backend, {
        outputDir: path.join(home, "noncanonical-snapshot"),
        capability: "BBBBBBBBBBBBBBBBBBBBBB",
      }),
      /exactly 128 bits/,
    );

    if (process.platform !== "win32") {
      assert.equal((await stat(snapshotDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(snapshotDirectory, "index.html"))).mode & 0o777,
        0o600,
      );
    }

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

    const textList = formatDocumentList(documentsAfterCorruption, false);
    assert.equal(textList.includes(published.metadata.id), true);
    assert.equal(JSON.parse(formatDocumentList(documentsAfterCorruption, true)).length, 2);

    const deleted = await backend.deleteDocument(hostile.metadata.id);
    assert(deleted);
    assert.equal(deleted.reclaimedBytes > 0, true);
    assert.match(formatDeleteResult(deleted, false), /reclaimed/);
    assert.equal(await backend.getDocument(hostile.metadata.id), null);
    assert.equal((await backend.listDocuments()).length, 1);
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

async function reservePort(): Promise<number> {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void run();
