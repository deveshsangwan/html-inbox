import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import os from "node:os";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { DOCUMENT_CSP, SHELL_CSP } from "./viewer-assets";
import { startViewerHttpServer } from "./viewer-http-server";
import { getViewerUrls, resolveViewerNetworkConfig } from "./viewer-network";
import { temporaryHome } from "./test-fixtures";

test("LAN wildcard listener serves its advertised interface URLs with an anonymous health check", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "lan" }), controlHealth());
  t.after(() => listener.close());

  const address = listener.server.address();
  assert(address && typeof address !== "string");
  assert.equal(address.address, "0.0.0.0");
  assert.equal(listener.config.port, address.port);
  assert.equal(listener.config.exposure, "lan");
  assert.equal(listener.config.host, "0.0.0.0");
  assert(listener.urls.length > 0);

  for (const url of listener.urls) {
    const parsed = new URL(url);
    assert.notEqual(parsed.hostname, "0.0.0.0");
    assert.notEqual(parsed.hostname, "127.0.0.1");
    assert.equal(Number(parsed.port), address.port);
    assert.equal((await requestUrl(url)).status, 200);
    const health = await requestUrl(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
  }

  const invalidHost = await requestUrl(`http://127.0.0.1:${address.port}`, {
    headers: { Host: `0.0.0.0:${address.port}` },
  });
  assert.equal(invalidHost.status, 421);
});

for (const host of ["0.0.0.0", "::"]) {
  test(`${host} refreshes interface Hosts and keeps cached URLs when discovery fails`, async (t) => {
    const home = await temporaryHome(t);
    let address = "192.0.2.10";
    let unavailable = false;
    const interfaces = t.mock.method(os, "networkInterfaces", () => {
      if (unavailable) throw new Error("Interface discovery unavailable");
      return { eth0: [{ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` }] };
    });
    const backend = new LocalDocumentBackend(home);
    const list = t.mock.method(backend, "listDocuments");
    const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "lan", host }), controlHealth());
    t.after(() => listener.close());
    const url = `http://127.0.0.1:${listener.config.port}`;
    const requestHost = (hostname: string) => requestUrl(url, {
      headers: { Host: `${hostname}:${listener.config.port}` },
    });

    address = "192.0.2.11";
    assert.equal((await requestHost(address)).status, 200);
    const callsAfterRefresh = interfaces.mock.callCount();
    assert.equal((await requestHost(address)).status, 200);
    assert.equal(interfaces.mock.callCount(), callsAfterRefresh);
    assert.equal((await requestHost("192.0.2.10")).status, 421);
    assert.equal((await requestHost("attacker.example")).status, 421);
    assert.equal((await requestUrl(url, {
      headers: ["Host", `${address}:${listener.config.port}`, "Host", "attacker.example"],
    })).status, 421);
    assert.equal(list.mock.callCount(), 2);

    unavailable = true;
    assert.equal((await requestHost("192.0.2.12")).status, 421);
    assert.equal((await requestHost(address)).status, 200);
    assert.equal(list.mock.callCount(), 3);
  });
}

test("LAN reads the live inbox without granting HTTP mutations and preserves document protections", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const originalBytes = Buffer.from("<!doctype html><html><body><h1>LAN report</h1></body></html>");
  const title = '<script>alert("title")</script>';
  const document = await backend.publish({ originalBytes, title, type: 'report"><svg/onload=alert(1)>', sourceFileName: 'report.html" onfocus="alert(1)' });
  const publish = t.mock.method(backend, "publish");
  const remove = t.mock.method(backend, "deleteDocument");
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "lan", host: "127.0.0.1" }), controlHealth());
  t.after(() => listener.close());
  const [url] = listener.urls;

  const index = await requestUrl(url);
  assert.equal(index.status, 200);
  assert.equal(index.headers["content-security-policy"], SHELL_CSP);
  assert.equal(index.body.includes(title), false);
  assert.match(index.body, /&#60;script&#62;/);
  assert.equal(index.body.includes('onfocus="alert'), false);

  const search = await requestUrl(`${url}/?q=missing`);
  assert.equal(search.status, 200);
  assert.match(search.body, /No matching documents/);
  const hostileSearch = await requestUrl(`${url}/?q=${encodeURIComponent('<svg/onload=alert(1)>')}`);
  assert.equal(hostileSearch.body.includes('<svg/onload=alert(1)>'), false);

  const shell = await requestUrl(`${url}/documents/${document.id}`);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers["content-security-policy"], SHELL_CSP);
  assert.match(shell.body, /<iframe sandbox="allow-scripts"/);
  assert.equal(shell.body.includes("allow-same-origin"), false);
  assert.equal(shell.body.includes(title), false);
  const content = await requestUrl(`${url}/documents/${document.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.body, originalBytes.toString());
  assert.equal(content.headers["content-security-policy"], DOCUMENT_CSP);
  assert.match(DOCUMENT_CSP, /sandbox allow-scripts/);
  assert.match(DOCUMENT_CSP, /connect-src 'none'/);
  assert.match(DOCUMENT_CSP, /form-action 'none'/);

  for (const route of ["/", "/health", "/assets/viewer.js", "/assets/viewer.css", `/documents/${document.id}`, `/documents/${document.id}/content`]) {
    const response = await requestUrl(`${url}${route}`);
    assert.equal(response.status, 200, route);
    assertSecurityHeaders(response.headers);
    const head = await requestUrl(`${url}${route}`, { method: "HEAD" });
    assert.equal(head.status, 200, route);
    assert.equal(head.body, "");
    assertSecurityHeaders(head.headers);
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    for (const route of ["/", "/health", `/documents/${document.id}`, `/documents/${document.id}/content`, "/viewer/stop", "/publish"]) {
      const response = await requestUrl(`${url}${route}`, { method });
      assert.equal(response.status, 405, `${method} ${route}`);
      assert.equal(response.headers.allow, "GET, HEAD");
      assertSecurityHeaders(response.headers);
    }
  }

  for (const route of ["/publish", "/delete", "/viewer/stop", "/viewer/status", "/service/install", "/instance-id", "/viewer.json", "/documents/missing", "/documents/missing/content", "/documents/%2e%2e%2fviewer.json", "/documents/%2Fetc%2Fpasswd/content"]) {
    const response = await requestUrl(`${url}${route}`);
    assert.equal(response.status, 404, route);
    assertSecurityHeaders(response.headers);
  }

  assert.equal(publish.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);
  assert.deepEqual(await backend.getDocument(document.id), { metadata: document, originalBytes });

  publish.mock.restore();
  const nextDocument = await backend.publish({ originalBytes, title: "Live update", type: "note", sourceFileName: "live.html" });
  assert.match((await requestUrl(url)).body, /Live update/);
  assert.equal((await requestUrl(`${url}/documents/${nextDocument.id}/content`)).status, 200);
});

test("an explicit interface address keeps control reachable from the local CLI", async (t) => {
  const home = await temporaryHome(t);
  const [interfaceUrl] = getViewerUrls(resolveViewerNetworkConfig({ port: 0, exposure: "lan" }));
  const selectedHost = new URL(interfaceUrl).hostname;
  const health = controlHealth();
  const listener = await startViewerHttpServer(new LocalDocumentBackend(home), resolveViewerNetworkConfig({
    port: 0,
    exposure: "lan",
    host: selectedHost,
  }), health);
  t.after(() => listener.close());

  const address = listener.server.address();
  assert(address && typeof address !== "string");
  assert.equal(address.address, selectedHost);
  assert.deepEqual(listener.urls, [`http://${selectedHost}:${address.port}`]);
  assert.equal((await requestUrl(listener.urls[0])).status, 200);
  assert.deepEqual(JSON.parse((await requestUrl(listener.controlUrl)).body), { ok: true, ...health });

  const unboundLocalHost = await requestUrl(listener.urls[0], {
    headers: { Host: `127.0.0.1:${address.port}` },
  });
  assert.equal(unboundLocalHost.status, 421);
});

test("every LAN reader route rejects an unrecognized Host before accessing storage", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const list = t.mock.method(backend, "listDocuments");
  const metadata = t.mock.method(backend, "getDocumentMetadata");
  const content = t.mock.method(backend, "getDocument");
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "lan", host: "127.0.0.1" }), controlHealth());
  t.after(() => listener.close());
  const [url] = listener.urls;
  const localHost = new URL(url).host;

  for (const route of ["/", "/?q=report", "/health", "/assets/viewer.js", "/assets/viewer.css", "/documents/report", "/documents/report/content"]) {
    const response = await requestUrl(`${url}${route}`, {
      headers: {
        Host: "attacker.example",
        Forwarded: `host=${localHost};for=127.0.0.1;proto=https`,
        "X-Forwarded-Host": localHost,
        "X-Forwarded-For": "127.0.0.1",
        "Tailscale-User-Login": "owner@example.com",
      },
    });
    assert.equal(response.status, 421, route);
    assertSecurityHeaders(response.headers);
  }

  for (const host of ["127.0.0.1", `${localHost}@attacker.example`, "127.0.0.1:1", `http://${localHost}`, `localhost.:${listener.config.port}`]) {
    assert.equal((await requestUrl(url, { headers: { Host: host } })).status, 421, host);
  }

  assert.equal(list.mock.callCount(), 0);
  assert.equal(metadata.mock.callCount(), 0);
  assert.equal(content.mock.callCount(), 0);

  const duplicateHost = await requestUrl(url, { headers: ["Host", localHost, "Host", "attacker.example"] });
  assert.equal(duplicateHost.status, 421);
  const missingHost = await requestUrl(url, { setHost: false, headers: { Host: "" } });
  assert.equal(missingHost.status, 421);

  const forwarded = await requestUrl(`${url}/health`, { headers: {
    Forwarded: "host=attacker.example;for=203.0.113.1",
    "X-Forwarded-Host": "attacker.example",
    "X-Forwarded-Proto": "https",
  } });
  assert.equal(forwarded.status, 200);
  assert.deepEqual(JSON.parse(forwarded.body), { ok: true });

  for (const requestTarget of ["http://attacker.example/", "//attacker.example/", "/\\attacker.example/", "http://127.0.0.1/health"]) {
    assert.equal((await requestUrl(url, { path: requestTarget })).status, 400, requestTarget);
  }
});

test("private control URL is secret, loopback only, and never serves documents", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const health = controlHealth();
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "lan" }), health);
  t.after(() => listener.close());

  const control = new URL(listener.controlUrl);
  const address = listener.controlServer.address();
  assert(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(control.hostname, "127.0.0.1");
  assert.match(control.pathname, /^\/control\/[A-Za-z0-9_-]{43}$/);
  assert.notEqual(Number(control.port), listener.config.port);

  const response = await requestUrl(listener.controlUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, ...health });
  assertSecurityHeaders(response.headers);
  assert.equal((await requestUrl(listener.controlUrl, { method: "HEAD" })).body, "");

  for (const route of ["/", "/health", "/assets/viewer.js", "/documents/report", "/documents/report/content", "/viewer/stop", "/control/guess", `${control.pathname}?token=anything`]) {
    const denied = await requestUrl(`${control.origin}${route}`);
    assert.equal(denied.status, 404, route);
    assert.equal(denied.body.includes(health.instanceId), false);
  }

  assert.equal((await requestUrl(listener.controlUrl, { headers: { Host: "attacker.example", "X-Forwarded-Host": control.host } })).status, 421);
  assert.equal((await requestUrl(listener.controlUrl, { method: "POST" })).status, 405);

  const reader = `http://127.0.0.1:${listener.config.port}`;
  for (const path of ["/health", control.pathname]) {
    const publicResponse = await requestUrl(`${reader}${path}`, { headers: {
      Host: new URL(reader).host,
      Forwarded: `host=${control.host};for=127.0.0.1`,
      "X-Forwarded-Host": control.host,
    } });
    assert.equal(publicResponse.body.includes(health.instanceId), false);
    assert.equal(publicResponse.body.includes(health.processId), false);
    assert.equal(publicResponse.body.includes("protocolVersion"), false);
    assert.equal(publicResponse.body.includes(control.pathname), false);
  }
});

test("Tailscale proxy Host and local Host share only anonymous reader health", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const health = controlHealth();
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "tailscale", tailscaleHostname: "server.tailnet.ts.net" }), health);
  t.after(() => listener.close());
  assert.deepEqual(listener.urls, ["https://server.tailnet.ts.net"]);

  const reader = `http://127.0.0.1:${listener.config.port}`;
  for (const host of [new URL(reader).host, "server.tailnet.ts.net", "server.tailnet.ts.net:443"]) {
    const response = await requestUrl(`${reader}/health`, { headers: {
      Host: host,
      "X-Forwarded-For": "127.0.0.1",
      "Tailscale-User-Login": "owner@example.com",
    } });
    assert.equal(response.status, 200, host);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
  }

  assert.equal((await requestUrl(reader, { headers: { Host: "other.tailnet.ts.net", "X-Forwarded-Host": "server.tailnet.ts.net" } })).status, 421);
  assert.deepEqual(JSON.parse((await requestUrl(listener.controlUrl)).body), { ok: true, ...health });
});

test("explicit IPv6 binding is reachable and enforces bracketed Host", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const health = controlHealth();
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig({ port: 0, exposure: "lan", host: "::1" }), health);
  t.after(() => listener.close());

  assert.deepEqual(listener.urls, [`http://[::1]:${listener.config.port}`]);
  assert.equal((await requestUrl(listener.urls[0])).status, 200);
  assert.equal((await requestUrl(listener.urls[0], { headers: { Host: `::1:${listener.config.port}` } })).status, 421);
  assert.equal((await requestUrl(listener.urls[0], { headers: { Host: `[::2]:${listener.config.port}` } })).status, 421);
  assert.deepEqual(JSON.parse((await requestUrl(listener.controlUrl)).body), { ok: true, ...health });
});

test("IPv6 wildcard listener serves advertised IPv4 addresses and IPv6 loopback", async (t) => {
  const home = await temporaryHome(t);
  const listener = await startViewerHttpServer(new LocalDocumentBackend(home), resolveViewerNetworkConfig({
    port: 0,
    exposure: "lan",
    host: "::",
  }), controlHealth());
  t.after(() => listener.close());

  const address = listener.server.address();
  assert(address && typeof address !== "string");
  assert.equal(address.address, "::");
  assert(listener.urls.some((url) => !new URL(url).hostname.startsWith("[")));

  for (const url of listener.urls) {
    assert.equal((await requestUrl(url)).status, 200, url);
  }

  const ipv6Loopback = `http://[::1]:${listener.config.port}/health`;
  assert.deepEqual(JSON.parse((await requestUrl(ipv6Loopback)).body), { ok: true });
  assert.equal((await requestUrl(ipv6Loopback, { headers: { Host: `[::]:${listener.config.port}` } })).status, 421);
});

test("closing the reader automatically closes control and close remains safe to repeat", async (t) => {
  const home = await temporaryHome(t);
  const listener = await startViewerHttpServer(new LocalDocumentBackend(home), resolveViewerNetworkConfig(0), controlHealth());
  t.after(() => listener.close());
  const controlClosed = once(listener.controlServer, "close");
  await new Promise<void>((resolve, reject) => listener.server.close((error) => error ? reject(error) : resolve()));
  await controlClosed;

  assert.equal(listener.server.listening, false);
  assert.equal(listener.controlServer.listening, false);
  await assert.rejects(requestUrl(listener.controlUrl), /ECONNREFUSED/);
  await listener.close();
  await listener.close();
});

test("close waits for an active request even after http.Server.close was called", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  let releaseStorage = () => {};
  let markRequestStarted = () => {};
  const storageGate = new Promise<void>((resolve) => {
    releaseStorage = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  t.mock.method(backend, "listDocuments", async () => {
    markRequestStarted();
    await storageGate;
    return [];
  });
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig(0), controlHealth());
  t.after(async () => {
    releaseStorage();
    await listener.close();
  });
  const response = requestUrl(listener.urls[0], { headers: { Connection: "close" } });
  await requestStarted;
  listener.server.close();

  let hasClosed = false;
  const closing = listener.close().then(() => {
    hasClosed = true;
  });
  await nextTurn();
  assert.equal(hasClosed, false);

  releaseStorage();
  assert.equal((await response).status, 200);
  await closing;
  assert.equal(hasClosed, true);
  assert.equal(listener.controlServer.listening, false);
});

test("reader bind failure closes both attempted listeners", async (t) => {
  const home = await temporaryHome(t);
  const blocker = http.createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const address = blocker.address();
  assert(address && typeof address !== "string");
  const createServer = http.createServer;
  const created: http.Server[] = [];
  t.mock.method(http, "createServer", (handler?: http.RequestListener) => {
    const server = createServer(handler);
    created.push(server);
    return server;
  });

  await assert.rejects(startViewerHttpServer(new LocalDocumentBackend(home), resolveViewerNetworkConfig(address.port), controlHealth()), /EADDRINUSE/);
  assert.equal(created.length, 2);
  assert(created.every((server) => !server.listening));
  assert.equal((await requestUrl(`http://127.0.0.1:${address.port}`)).body, "occupied");
});

test("control bind failure closes a reader that already started listening", async (t) => {
  const home = await temporaryHome(t);
  const createServer = http.createServer;
  const created: http.Server[] = [];
  t.mock.method(http, "createServer", (handler?: http.RequestListener) => {
    const server = createServer(handler);
    created.push(server);

    if (created.length === 2) {
      t.mock.method(server, "listen", () => {
        queueMicrotask(() => server.emit("error", new Error("control bind failed")));
        return server;
      });
    }

    return server;
  });

  await assert.rejects(startViewerHttpServer(new LocalDocumentBackend(home), resolveViewerNetworkConfig(0), controlHealth()), /control bind failed/);
  assert.equal(created.length, 2);
  assert(created.every((server) => !server.listening));
});

test("reader storage errors produce a generic response and keep health available", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const logError = t.mock.method(console, "error", () => {});
  t.mock.method(backend, "listDocuments", async () => {
    throw new Error("private storage error containing the inbox path");
  });
  const listener = await startViewerHttpServer(backend, resolveViewerNetworkConfig(0), controlHealth());
  t.after(() => listener.close());

  const response = await requestUrl(listener.urls[0]);
  assert.equal(response.status, 500);
  assert.equal(response.body, "Internal Server Error");
  assertSecurityHeaders(response.headers);
  assert.equal(logError.mock.callCount(), 1);
  assert.deepEqual(JSON.parse((await requestUrl(`${listener.urls[0]}/health`)).body), { ok: true });
});

function controlHealth() {
  return { instanceId: randomUUID(), processId: randomUUID(), protocolVersion: 2, pid: process.pid };
}

function assertSecurityHeaders(headers: http.IncomingHttpHeaders): void {
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-content-type-options"], "nosniff");
}

function requestUrl(
  url: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders | readonly string[]; path?: string; setHost?: boolean } = {},
): Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(url), options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.setTimeout(2000, () => request.destroy(new Error("HTTP test request timed out")));
    request.on("error", reject);
    request.end();
  });
}
