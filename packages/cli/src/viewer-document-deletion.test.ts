import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, cp, lstat, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { createDocumentDeleter, type DocumentDeleter, DocumentCleanupError } from "./document-deletion";
import { startHub } from "./hub";
import { temporaryHome } from "./test-fixtures";
import { LIVE_SHELL_CSP, DOCUMENT_CSP } from "./viewer-assets";
import { startViewerHttpServer } from "./viewer-http-server";
import { resolveViewerNetworkConfig, type ViewerExposure } from "./viewer-network";
import { getInboxInstanceId } from "./viewer-records";

for (const exposure of ["loopback", "lan", "tailscale"] satisfies ViewerExposure[]) {
  test(`${exposure} deletion uses the same origin, token and pinned local inbox`, async (t) => {
    const f = await deletionFixture(t, exposure);
    const index = await request(f.url, "/", { headers: { Host: f.host } });
    const token = deletionToken(index.body);
    assert.equal(index.headers["content-security-policy"], LIVE_SHELL_CSP);
    assert.equal(index.headers["cache-control"], "no-store");

    const content = await request(f.url, `/documents/${f.document.id}/content`, { headers: { Host: f.host } });
    assert.equal(content.headers["content-security-policy"], DOCUMENT_CSP);
    assert.equal(content.body, f.bytes.toString());
    assert.equal(content.body.includes(token), false);

    const headers = { Host: f.host, Origin: f.origin, "X-HTML-Inbox-CSRF": token };
    const deleted = await request(f.url, `/api/documents/${f.document.id}`, { method: "DELETE", headers });
    assert.equal(deleted.status, 204);
    assert.equal(await f.backend.getDocument(f.document.id), null);
    assert.equal((await request(f.url, `/api/documents/${f.document.id}`, { method: "DELETE", headers })).status, 404);
    assert.equal((await request(f.url, "/health", { headers: { Host: f.host } })).status, 200);
  });
}

test("deletion rejects invalid authority, request aliases and bodies before storage calls", async (t) => {
  let calls = 0;
  const f = await deletionFixture(t, "loopback", async () => {
    calls += 1;
    return null;
  });
  const token = deletionToken((await request(f.url, "/")).body);
  const headers = { Origin: f.origin, "X-HTML-Inbox-CSRF": token };
  const target = `/api/documents/${f.document.id}`;

  for (const deniedHeaders of [
    {}, { Origin: f.origin }, { ...headers, Origin: "null" },
    { ...headers, Origin: "http://attacker.example" },
    { ...headers, Origin: `${f.origin}/` },
    { ...headers, "X-HTML-Inbox-CSRF": "wrong" },
    { ...headers, "X-HTML-Inbox-CSRF": "é".repeat(43) },
    { ...headers, Host: "attacker.example", "X-Forwarded-Host": new URL(f.url).host },
  ]) {
    const result = await request(f.url, target, { method: "DELETE", headers: deniedHeaders });
    assert([403, 421].includes(result.status), JSON.stringify(deniedHeaders));
  }

  for (const rawHeaders of [
    ["Host", new URL(f.url).host, "Origin", f.origin, "Origin", f.origin, "X-HTML-Inbox-CSRF", token],
    ["Host", new URL(f.url).host, "Origin", f.origin, "X-HTML-Inbox-CSRF", token, "X-HTML-Inbox-CSRF", token],
    ["Host", new URL(f.url).host, "Host", new URL(f.url).host, "Origin", f.origin, "X-HTML-Inbox-CSRF", token],
  ]) {
    const result = await request(f.url, target, { method: "DELETE", headers: rawHeaders });
    assert([403, 421].includes(result.status));
  }

  for (const alias of [`${target}?home=/tmp`, `${target}/`, "/api/documents/other/../safe-id", "/api/documents/%2e%2e", "/api/sources/work/documents/safe-id", "/api/documents/safe-id/content"]) {
    assert.equal((await request(f.url, alias, { method: "DELETE", headers })).status, 404, alias);
  }

  assert.equal((await request(f.url, target, { method: "DELETE", headers: { ...headers, "Content-Length": "1" }, body: "x" })).status, 400);

  for (const method of ["GET", "HEAD", "POST", "PUT", "OPTIONS"]) {
    const result = await request(f.url, target, { method, headers });
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, "DELETE");
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }

  assert.equal(calls, 0);
});

test("tokens cannot be reused between viewer processes", async (t) => {
  const first = await deletionFixture(t, "loopback");
  const second = await deletionFixture(t, "loopback");
  const token = deletionToken((await request(first.url, "/")).body);
  const result = await request(second.url, `/api/documents/${second.document.id}`, {
    method: "DELETE", headers: { Origin: second.origin, "X-HTML-Inbox-CSRF": token },
  });
  assert.equal(result.status, 403);
  assert(await second.backend.getDocument(second.document.id));
});

test("hub deletion uses source-qualified identity and retains the other colliding record", async (t) => {
  const root = await temporaryHome(t);
  const sources = await Promise.all(["work", "personal"].map(async (name) => {
    const home = path.join(root, name);
    const backend = new LocalDocumentBackend(home, () => {}, () => "shared-id");
    await backend.publish({ originalBytes: Buffer.from(`<html>${name}</html>`), title: name, type: "report", sourceFileName: `${name}.html` });
    return { name, home, instanceId: await getInboxInstanceId(home) };
  }));
  const hub = await startHub({ schemaVersion: 1, name: "Reports", sources }, { port: 0, exposure: "lan", host: "127.0.0.1" });
  t.after(() => hub.close());
  const url = hub.urls[0];
  const token = deletionToken((await request(url, "/?inbox=work")).body);
  const result = await request(url, "/api/sources/work/documents/shared-id", {
    method: "DELETE", headers: { Origin: new URL(url).origin, "X-HTML-Inbox-CSRF": token },
  });

  assert.equal(result.status, 204);
  assert.equal((await request(url, "/sources/work/documents/shared-id")).status, 404);
  assert.equal((await request(url, "/sources/personal/documents/shared-id/content")).body, "<html>personal</html>");
  assert.equal((await request(url, "/?inbox=work")).body.includes("No documents yet"), true);
});

test("replaced roots refuse deletion without mutating the replacement", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await deletionFixture(t, "loopback");
  const token = deletionToken((await request(f.url, "/")).body);
  const oldHome = `${f.home}-old`;
  t.after(() => rm(oldHome, { recursive: true, force: true }));
  await rename(f.home, oldHome);
  await cp(oldHome, f.home, { recursive: true });
  const htmlPath = path.join(f.home, "documents", f.document.id, "index.html");
  const before = await lstat(htmlPath);
  const result = await request(f.url, `/api/documents/${f.document.id}`, {
    method: "DELETE", headers: { Origin: f.origin, "X-HTML-Inbox-CSRF": token },
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.includes(f.home), false);
  assert.equal((await lstat(htmlPath)).ino, before.ino);
  assert.deepEqual(await readFile(htmlPath), f.bytes);
});

test("HTTP distinguishes cleanup failure after removal from an unconfirmed failure", async (t) => {
  t.mock.method(console, "error", () => {});
  const cleanup = await deletionFixture(t, "loopback", async () => {
    throw new DocumentCleanupError({ schemaVersion: 1, id: "test", title: "Report", type: "report", sourceFileName: "report.html", createdAt: new Date().toISOString() }, new Error("private cleanup path"));
  });
  const failed = await deletionFixture(t, "loopback", async () => { throw new Error("private filesystem path"); });

  for (const { fixture, status } of [{ fixture: cleanup, status: 200 }, { fixture: failed, status: 500 }]) {
    const token = deletionToken((await request(fixture.url, "/")).body);
    const result = await request(fixture.url, `/api/documents/${fixture.document.id}`, {
      method: "DELETE", headers: { Origin: fixture.origin, "X-HTML-Inbox-CSRF": token },
    });
    assert.equal(result.status, status);
    assert.equal(result.body.includes("private"), false);

    if (status === 200) {
      assert.deepEqual(JSON.parse(result.body), { status: "removed", cleanup: "failed" });
    }
  }
});

async function deletionFixture(t: TestContext, exposure: ViewerExposure, customDelete?: DocumentDeleter) {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const bytes = Buffer.from("<!doctype html><html><body>Report</body></html>");
  const document = await backend.publish({ originalBytes: bytes, title: "Report", type: "report", sourceFileName: "report.html" });
  const instanceId = await getInboxInstanceId(home);
  const config = resolveViewerNetworkConfig({ port: 0, exposure, host: exposure === "lan" ? "0.0.0.0" : "127.0.0.1", ...(exposure === "tailscale" ? { tailscaleHostname: "reports.tailnet.ts.net" } : {}) });
  const viewer = await startViewerHttpServer(backend, config, { instanceId, processId: randomUUID(), protocolVersion: 3, pid: process.pid }, home, {}, customDelete ?? await createDocumentDeleter({ home, instanceId }));
  t.after(() => viewer.close());
  const url = exposure === "lan" ? viewer.urls[0] : `http://127.0.0.1:${viewer.config.port}`;
  const host = exposure === "tailscale" ? "reports.tailnet.ts.net" : new URL(url).host;
  const origin = exposure === "tailscale" ? `https://${host}` : url;

  return { home, backend, bytes, document, viewer, url, host, origin };
}

function deletionToken(html: string): string {
  const match = /(?<![a-zA-Z0-9_-])[a-zA-Z0-9_-]{43}(?![a-zA-Z0-9_-])/.exec(html);
  assert(match, "live shell must contain its per-process deletion token");
  return match[0];
}

function request(baseUrl: string, target: string, options: { method?: string; headers?: http.OutgoingHttpHeaders | readonly string[]; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const pending = http.request(baseUrl, { path: target, method: options.method ?? "GET", headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.once("error", reject);
    });
    pending.once("error", reject);
    pending.end(options.body);
  });
}
