import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { startHub, DEFAULT_HUB_PORT } from "./hub";
import { type HubConfiguration } from "./hub-config";
import { temporaryHome } from "./test-fixtures";
import { DOCUMENT_CSP, SHELL_CSP } from "./viewer-assets";
import { startViewerHttpServer } from "./viewer-http-server";
import { resolveViewerNetworkConfig } from "./viewer-network";
import { getInboxInstanceId } from "./viewer-records";
import { renderDocumentShell, renderIndex } from "./viewer-render";
import { DEFAULT_MAX_DOCUMENT_BYTES } from "./publish-input";

test("hub reads stopped viewers, namespaces colliding IDs, and preserves original metadata and bytes", async (t) => {
  const work = await hubSource(t, "work_notes", "Work report");
  const personal = await hubSource(t, "personal-", "Personal chart");
  const viewer = await startViewerHttpServer(work.backend, resolveViewerNetworkConfig(0), {
    instanceId: work.config.instanceId, processId: randomUUID(), protocolVersion: 1, pid: process.pid,
  });
  const hub = await startHub(hubConfig([work.config, personal.config]), 0);
  t.after(() => hub.close());
  t.after(() => viewer.close());
  await viewer.close();
  assert.equal(viewer.server.listening, false);
  assert.equal(viewer.controlServer.listening, false);
  assert.equal("controlServer" in hub, false);
  assert.equal(hub.config.exposure, "loopback");
  assert.equal(hub.config.host, "127.0.0.1");
  assert.equal(DEFAULT_HUB_PORT, 3218);

  const baseUrl = hub.urls[0];
  const index = await fetch(baseUrl);
  assert.equal(index.headers.get("content-security-policy"), SHELL_CSP);
  const indexHtml = await index.text();
  assert.match(indexHtml, /<h1 class="library__title">My reports &#60;local&#62;<\/h1>/);
  assert.match(indexHtml, /2 documents/);
  assert.match(indexHtml, /All selected inboxes/);

  for (const source of [work, personal]) {
    const documentPath = `/sources/${source.config.name}/documents/${source.metadata.id}`;
    assert(indexHtml.includes(`href="${documentPath}"`));
    assert(indexHtml.includes(`<span class="inbox-badge">${source.config.name}</span>`));
    const shell = await fetch(`${baseUrl}${documentPath}`);
    assert.equal(shell.headers.get("content-security-policy"), SHELL_CSP);
    const shellHtml = await shell.text();
    assert(shellHtml.includes(`<iframe sandbox="allow-scripts" src="${documentPath}/content"`));
    assert(shellHtml.includes(`href="/?inbox=${source.config.name}"`));
    assert(shellHtml.includes(`<dt>Inbox</dt><dd>${source.config.name}</dd>`));
    assert(shellHtml.includes('src="/assets/viewer.js"'));
    assert.equal(shellHtml.includes("allow-same-origin"), false);
    assert.equal(shellHtml.includes(source.config.home), false);
    assert.equal(shellHtml.includes(source.config.instanceId), false);

    const content = await fetch(`${baseUrl}${documentPath}/content`);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-security-policy"), DOCUMENT_CSP);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), source.originalBytes);
    assert.deepEqual(JSON.parse(await readFile(path.join(source.config.home, "documents", source.metadata.id, "metadata.json"), "utf8")), source.metadata);
    assert.equal((await readdir(source.config.home)).includes("viewer.json"), false);
  }

  const workOnly = await (await fetch(`${baseUrl}/?inbox=work_notes&q=report`)).text();
  assert.match(workOnly, /1 of 1 documents/);
  assert.match(workOnly, /value="work_notes" selected/);
  assert.match(workOnly, /href="\/\?inbox=work_notes">Clear/);
  assert.equal(workOnly.includes("Personal chart"), false);
  const combinedSearch = await (await fetch(`${baseUrl}/?q=chart`)).text();
  assert.match(combinedSearch, /1 of 2 documents/);
  assert.equal(combinedSearch.includes("Work report"), false);
  const empty = await (await fetch(`${baseUrl}/?inbox=personal-&q=work`)).text();
  assert.match(empty, /No matching documents/);
});

test("hub isolates unavailable, corrupt, mismatched, and replaced roots without leaking diagnostics", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (message: unknown) => {
    diagnostics.push(String(message));
  });

  const healthy = await hubSource(t, "healthy", "Still available");
  const mismatched = await hubSource(t, "mismatched", "Hidden UUID report");
  const corrupt = await hubSource(t, "corrupt", "Hidden corrupt report");
  const replaced = await hubSource(t, "replaced", "Hidden replaced report");
  const scratch = await realpath(await temporaryHome(t));
  const missingHome = path.join(scratch, "must-not-be-created");
  const hub = await startHub(hubConfig([
    healthy.config,
    { ...mismatched.config, instanceId: randomUUID() },
    corrupt.config,
    replaced.config,
    { name: "missing", home: missingHome, instanceId: randomUUID() },
  ]), 0);
  t.after(() => hub.close());
  const baseUrl = hub.urls[0];
  await fetch(baseUrl);
  await writeFile(path.join(corrupt.config.home, "documents", corrupt.metadata.id, "metadata.json"), '{"schemaVersion":99}');
  const previousRoot = path.join(scratch, "previous-root");
  await rename(replaced.config.home, previousRoot);
  await mkdir(replaced.config.home);
  await writeFile(path.join(replaced.config.home, "instance-id"), replaced.config.instanceId);
  diagnostics.length = 0;

  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Results are incomplete/);
  assert.match(html, /Still available/);
  assert.match(html, /1 document/);
  for (const hidden of ["Hidden UUID report", "Hidden corrupt report", "Hidden replaced report", scratch, healthy.config.home, "schemaVersion", "ENOENT", "controlUrl"]) {
    assert.equal(html.includes(hidden), false, hidden);
  }

  assert.equal(diagnostics.length, 4);
  assert(diagnostics.some((message) => message.includes("Hub source mismatched unavailable: Source instance identity does not match")));
  assert(diagnostics.some((message) => message.includes("Hub source replaced unavailable: Source root was replaced")));
  assert(diagnostics.some((message) => message.includes("Hub source missing unavailable: ENOENT:")));
  assert(diagnostics.some((message) => message.startsWith("html-inbox: Hub source corrupt unavailable: ")));

  for (const name of ["mismatched", "corrupt", "replaced", "missing"]) {
    for (const suffix of ["", "/content"]) {
      diagnostics.length = 0;
      const unavailable = await fetch(`${baseUrl}/sources/${name}/documents/shared-id${suffix}`);
      assert.equal(unavailable.status, 503);
      assert.equal(await unavailable.text(), "Inbox unavailable. Results may be incomplete.");
      assert.equal(unavailable.headers.get("cache-control"), "no-store");
      assert.equal(diagnostics.length, 1);
      assert(diagnostics[0]?.startsWith(`html-inbox: Hub source ${name} unavailable: `));
    }
  }

  await assert.rejects(lstat(missingHome), { code: "ENOENT" });
  assert.deepEqual(await readdir(scratch), ["previous-root"]);
  const healthyResponse = await fetch(`${baseUrl}/sources/healthy/documents/shared-id/content`);
  assert.equal(healthyResponse.status, 200);
  assert.deepEqual(Buffer.from(await healthyResponse.arrayBuffer()), healthy.originalBytes);
});

test("hub reader shares Host, GET/HEAD, CSP, and sandbox policies and exposes only selected mounts", async (t) => {
  const selected = await hubSource(t, "selected", "Selected report");
  const unselected = await hubSource(t, "unselected", "Unselected report");
  const configuration = hubConfig([selected.config]);
  const hub = await startHub(configuration, 0);
  t.after(() => hub.close());
  configuration.sources.push(unselected.config);
  const baseUrl = hub.urls[0];
  const documentPath = "/sources/selected/documents/shared-id";
  const readablePaths = ["/", "/health", "/assets/viewer.css", "/assets/viewer.js", documentPath, `${documentPath}/content`];

  for (const route of readablePaths) {
    const get = await request(baseUrl, { path: route });
    const head = await request(baseUrl, { path: route, method: "HEAD" });
    assert.equal(get.status, 200, route);
    assert.equal(head.status, 200, route);
    assert.equal(head.body.length, 0, route);
    assert.equal(head.headers["content-security-policy"], get.headers["content-security-policy"]);
    assertSecurityHeaders(get.headers);
    assertSecurityHeaders(head.headers);
  }

  assert.deepEqual(JSON.parse((await request(baseUrl, { path: "/health" })).body.toString()), { ok: true });
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const denied = await request(baseUrl, { path: `${documentPath}/content`, method });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.allow, "GET, HEAD");
    assertSecurityHeaders(denied.headers);
  }

  for (const headers of [
    { Host: "attacker.example", "X-Forwarded-Host": new URL(baseUrl).host },
    ["Host", new URL(baseUrl).host, "Host", "attacker.example"],
  ]) {
    const denied = await request(baseUrl, { path: "/", headers });
    assert.equal(denied.status, 421);
    assertSecurityHeaders(denied.headers);
  }

  const hiddenPaths = [
    "/documents/shared-id", "/sources/unselected/documents/shared-id/content",
    "/sources/selected/instance-id", "/sources/selected/viewer.json", "/sources/selected/remote/state.json",
    `${documentPath}/metadata.json`, "/sources/selected/documents/..%2Fshared-id/content",
    "/sources/selected/documents/%2e%2e/content", "/sources/selected/documents/.staging/content",
    "/sources/selected/documents/shared-id%00/content", "/viewer.json", "/hub.json", "/control/test", "/health/control",
  ];
  for (const route of hiddenPaths) {
    const hidden = await request(baseUrl, { path: route });
    assert.equal(hidden.status, 404, route);
    assert.equal(hidden.body.toString(), "Not Found");
    assertSecurityHeaders(hidden.headers);
  }

  assert.equal((await request(baseUrl, { path: "http://attacker.example/" })).status, 400);
  assert.equal((await request(baseUrl, { path: "//attacker.example/" })).status, 400);
  assert.equal((await (await fetch(baseUrl)).text()).includes("Unselected report"), false);
  const second = await startHub(hubConfig([unselected.config]), 0);
  t.after(() => second.close());
  assert.notEqual(second.config.port, hub.config.port);
  assert.equal((await fetch(`${second.urls[0]}${documentPath}`)).status, 404);
  assert.equal((await fetch(`${second.urls[0]}/sources/unselected/documents/shared-id`)).status, 200);
});

test("hub ignores source preferences and control files, including symlinks", { skip: process.platform === "win32" }, async (t) => {
  const source = await hubSource(t, "selected", "Readable report");
  const target = path.join(await temporaryHome(t), "do-not-read-or-change");
  await writeFile(target, "private control or preference data");
  await symlink(target, path.join(source.config.home, "preferences.json"));
  await symlink(target, path.join(source.config.home, "viewer.json"));
  const before = await lstat(target);
  const hub = await startHub(hubConfig([source.config]), 0);
  t.after(() => hub.close());

  for (const route of ["/", "/sources/selected/documents/shared-id"]) {
    const html = await (await fetch(`${hub.urls[0]}${route}`)).text();
    assert.match(html, /html-inbox-appearance" content="system"/);
    assert.equal(html.includes("private control"), false);
    assert.equal(html.includes("unavailable"), false);
  }

  const after = await lstat(target);
  assert.equal(after.mode, before.mode);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal(await readFile(target, "utf8"), "private control or preference data");
});

test("hub distinguishes unavailable results from an empty selected inbox and targets its publish example", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const instanceId = await getInboxInstanceId(home);
  const hub = await startHub(hubConfig([{ name: "empty_selected", home, instanceId }]), 0);
  t.after(() => hub.close());
  const empty = await (await fetch(hub.urls[0])).text();
  assert.match(empty, /No documents yet/);
  assert.match(empty, /publish \.\/document.html --inbox empty_selected/);
  assert.equal(empty.includes("unavailable"), false);
  assert.deepEqual(await readdir(home), ["instance-id"]);

  await writeFile(path.join(home, "instance-id"), randomUUID());
  const unavailable = await (await fetch(hub.urls[0])).text();
  assert.match(unavailable, /No readable documents/);
  assert.match(unavailable, /Results are incomplete/);
  assert.equal(unavailable.includes("No documents yet"), false);
  assert.equal(unavailable.includes("html-inbox publish"), false);
});

test("standalone label is optional and preserves legacy URLs and static export rendering", async (t) => {
  const source = await hubSource(t, "selected", "Standalone document");
  const options = { inboxName: 'Work <reports> "desk"' };
  const listener = await startViewerHttpServer(source.backend, resolveViewerNetworkConfig(0), {
    instanceId: source.config.instanceId, processId: randomUUID(), protocolVersion: 1, pid: process.pid,
  }, undefined, options);
  t.after(() => listener.close());
  const html = await (await fetch(listener.urls[0])).text();
  assert.match(html, /library__title">Work &#60;reports&#62; &#34;desk&#34;/);
  assert.match(html, /href="\/documents\/shared-id"/);
  const legacy = renderIndex([source.metadata], "");
  assert.match(legacy, /library__title">Inbox<\/h1>/);
  assert.match(legacy, /href="\/documents\/shared-id"/);
  assert.equal(legacy.includes("inbox-badge"), false);
  assert.equal(legacy.includes("inbox-filter"), false);
  const exported = renderIndex([source.metadata], "", { basePath: "/i/capability", clientSearch: true });
  assert.match(exported, /href="\/i\/capability\/documents\/shared-id\/"/);
  assert.match(exported, /data-client-search/);
  assert.match(renderDocumentShell(source.metadata, { basePath: "/i/capability" }), /src="\/i\/capability\/documents\/shared-id\/content\/"/);
});

test("hub accepts explicit LAN settings and rejects Tailscale configuration", async (t) => {
  const source = await hubSource(t, "selected", "Report");
  const configuration = hubConfig([source.config]);
  assert.throws(() => startHub(configuration, { port: 0, exposure: "tailscale" }), /loopback or explicit LAN/);
  assert.throws(() => startHub(configuration, { port: 0, host: "0.0.0.0" }), /loopback/);
  const hub = await startHub(configuration, { port: 0, exposure: "lan", host: "127.0.0.1" });
  t.after(() => hub.close());
  assert.equal(hub.config.exposure, "lan");
  assert.equal((await fetch(hub.urls[0])).status, 200);
});

test("hub honors HTML_INBOX_MAX_BYTES while keeping document reads bounded", async (t) => {
  const previousLimit = process.env.HTML_INBOX_MAX_BYTES;
  t.after(() => {
    if (previousLimit === undefined) {
      delete process.env.HTML_INBOX_MAX_BYTES;
      return;
    }

    process.env.HTML_INBOX_MAX_BYTES = previousLimit;
  });
  const source = await hubSource(t, "large", "Large report");
  const originalBytes = Buffer.alloc(DEFAULT_MAX_DOCUMENT_BYTES + 1, "x");
  await writeFile(path.join(source.config.home, "documents", source.metadata.id, "index.html"), originalBytes);
  delete process.env.HTML_INBOX_MAX_BYTES;
  const bounded = await startHub(hubConfig([source.config]), 0);
  t.after(() => bounded.close());
  assert.equal((await fetch(`${bounded.urls[0]}/sources/large/documents/shared-id/content`)).status, 503);
  assert.match(await (await fetch(bounded.urls[0])).text(), /Results are incomplete/);

  process.env.HTML_INBOX_MAX_BYTES = String(originalBytes.byteLength);
  const expanded = await startHub(hubConfig([source.config]), 0);
  t.after(() => expanded.close());
  const response = await fetch(`${expanded.urls[0]}/sources/large/documents/shared-id/content`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalBytes);
});

async function hubSource(t: TestContext, name: string, title: string) {
  const home = await realpath(await temporaryHome(t));
  const instanceId = await getInboxInstanceId(home);
  const backend = new LocalDocumentBackend(home, undefined, () => "shared-id");
  const originalBytes = Buffer.from(`\ufeff<!doctype html>\r\n<html><body>${title} π</body></html>\r\n`);
  const metadata = await backend.publish({ originalBytes, title, type: "report", sourceFileName: `${name}.html` });

  return { config: { name, home, instanceId }, backend, originalBytes, metadata };
}

function hubConfig(sources: HubConfiguration["sources"]): HubConfiguration {
  return { schemaVersion: 1, name: "My reports <local>", sources };
}

function request(url: string, options: http.RequestOptions = {}): Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function assertSecurityHeaders(headers: http.IncomingHttpHeaders): void {
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-content-type-options"], "nosniff");
}
