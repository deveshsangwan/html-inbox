import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import https from "node:https";
import type { RequestListener } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { checkServerIdentity } from "node:tls";
import { loopbackHttpsOrigin, parseSyncFixtureProxyConfig } from "./sync-fixture-proxy";
import {
  createSyncHttpsCredentials,
  startSyncHttpsProxy,
  type SyncFixtureServerCredentials,
} from "./sync-https-fixtures";

// These exercise TLS and fault plumbing only. No fixture response proves application custody or sync acceptance.
test("real subprocess HTTPS fixtures validate trust, faults and cleanup", { timeout: 60_000 }, async (t) => {
  const credentials = await createSyncHttpsCredentials(t);
  const ca = await readFile(credentials.caPath);
  const routes = [{ label: "body", pathname: "/body", method: "POST" }];
  const children: Awaited<ReturnType<typeof startSyncHttpsProxy>>[] = [];
  const upstream = await startServer(t, credentials.trusted, (request, response) => {
    request.on("error", () => {});
    request.resume();
    request.once("end", () => {
      response.writeHead(201, { "content-type": "text/plain", "content-length": "12" });
      response.end("fixture-only");
    });
  });
  const proxyOptions = {
    directory: credentials.directory, server: credentials.trusted, upstreamCaPath: credentials.caPath,
    upstreamUrl: upstream.url, routes,
  };
  async function proxy(options: Partial<Parameters<typeof startSyncHttpsProxy>[1]> = {}) {
    const running = await startSyncHttpsProxy(t, { ...proxyOptions, ...options });
    children.push(running);

    return running;
  }

  await t.test("normal SAN verification succeeds with explicit trust for both profile labels", async () => {
    for (const profile of ["lan", "tailscale"] as const) {
      const running = await proxy({ profile });
      assert.equal(running.profile, profile);
      assert.equal(new URL(running.url).hostname, "127.0.0.1");
      assert.equal((await requestHttps(`${running.url}/body`, ca, "input")).body.toString(), "fixture-only");
      assert.equal((await requestHttps(`${running.url.replace("127.0.0.1", "localhost")}/body`, ca, "input")).statusCode, 201);
      assert.equal((await running.stats()).routes.body.starts, 2);
      assert.deepEqual(await running.stop(), { code: 0, signal: null });
    }

    if (process.platform !== "win32") {
      for (const server of [credentials.trusted, credentials.rogue, credentials.wrongHost, credentials.expired]) {
        assert.equal((await stat(server.keyPath)).mode & 0o777, 0o600);
      }

      assert.equal((await stat(credentials.directory)).mode & 0o777, 0o700);
    }
  });

  const ipv6Certificate = new X509Certificate(await readFile(credentials.trusted.certPath));
  assert.equal(ipv6Certificate.checkIP("::1"), "::1");
  const ipv6VerificationError = checkServerIdentity("::1", ipv6Certificate.toLegacyObject());
  await t.test("IPv6 IP SAN forwarding uses native certificate verification", {
    skip: ipv6VerificationError ? `Native ${process.version} IPv6 SAN verification rejects the generated ::1 SAN` : false,
  }, async () => {
    const ipv6 = await proxy({ host: "::1" });
    assert.equal(new URL(ipv6.url).hostname, "[::1]");
    assert.equal((await requestHttps(`${ipv6.url}/body`, ca, "input")).statusCode, 201);
    const ipv6Forward = await proxy({ upstreamUrl: ipv6.url });
    assert.equal((await requestHttps(`${ipv6Forward.url}/body`, ca, "input")).statusCode, 201);
    await ipv6Forward.stop();
    await ipv6.stop();
  });

  await t.test("rogue trust, wrong hostname and expired listener certificates are rejected before HTTP", async () => {
    for (const server of [credentials.rogue, credentials.wrongHost, credentials.expired]) {
      const running = await proxy({ server });
      await assert.rejects(requestHttps(`${running.url}/body`, ca, "input"), /certificate|issuer|expired|altname/i);
      assert.equal((await running.stats()).routes.body.starts, 0);
      await running.stop();
    }

    const running = await proxy();
    await assert.rejects(requestHttps(`${running.url}/body`, await readFile(credentials.rogueCaPath), "input"), /certificate|issuer/i);
    assert.equal((await running.stats()).routes.body.starts, 0);
    await running.stop();
  });

  await t.test("forwarding keeps upstream CA, hostname and expiry verification enabled", async () => {
    for (const server of [credentials.rogue, credentials.wrongHost, credentials.expired]) {
      let starts = 0;
      const invalid = await startServer(t, server, (_request, response) => { starts++; response.end("unreachable"); });
      const running = await proxy({ upstreamUrl: invalid.url });
      await assert.rejects(requestHttps(`${running.url}/body`, ca, "input"));
      const finished = await running.waitForEvent((event) => event.type === "request-finished");
      assert(finished.type === "request-finished");
      assert.equal(finished.outcome, "upstream-error");
      assert.equal(starts, 0);
      await running.stop();
      await invalid.stop();
      await assertListenerReleased(invalid.url);
    }

    const running = await proxy({ upstreamUrl: upstream.url.replace("127.0.0.1", "localhost") });
    assert.equal((await requestHttps(`${running.url}/body`, ca, "input")).statusCode, 201);
    await running.stop();
  });

  await t.test("a lost response follows the full upstream response and retries pass through", async () => {
    const running = await proxy({ faults: [{ id: "lost", route: "body", kind: "drop-response" }] });
    const secret = "synthetic-secret-do-not-log";
    await assert.rejects(requestHttps(`${running.url}/body?token=${secret}`, ca, "synthetic-input", { authorization: secret }));
    const hit = await running.waitForEvent((event) => event.type === "fault-hit");
    const ended = running.events.find((event) => event.type === "upstream-end");
    assert(ended?.type === "upstream-end");
    assert.equal(ended.statusCode, 201);
    assert.equal(ended.responseBytes, 12);
    assert(ended.sequence < hit.sequence);
    assert.equal((await requestHttps(`${running.url}/body`, ca, "synthetic-input")).body.toString(), "fixture-only");
    const stats = await running.stats();
    assert.equal(stats.routes.body.starts, 2);
    assert.equal(stats.routes.body.requestBytes, 30);
    assert.equal(stats.routes.body.upstreamRequestBytes, 30);
    assert.equal(stats.routes.body.responseBytes, 24);
    assert.equal(stats.routes.body.clientResponseBytes, 12);
    assert.equal(stats.faultHits.lost, 1);
    assert(!JSON.stringify(running.events).includes(secret));
    await running.stop();

    const interrupted = await startServer(t, credentials.trusted, (_request, response) => {
      response.writeHead(201, { "content-length": "12" });
      response.write("short", () => response.destroy());
    });
    const incomplete = await proxy({
      upstreamUrl: interrupted.url, faults: [{ id: "incomplete", route: "body", kind: "drop-response" }],
    });
    await assert.rejects(requestHttps(`${incomplete.url}/body`, ca, "input"));
    assert.equal((await incomplete.stats()).faultHits.incomplete, 0);
    assert(!incomplete.events.some((event) => event.type === "upstream-end"));
    await incomplete.stop();
    await interrupted.stop();
    await assertListenerReleased(interrupted.url);
  });

  await t.test("response pause is observable and releases only the chosen request", async () => {
    const running = await proxy({ faults: [{ id: "paused", route: "body", kind: "pause-response", times: 2 }] });
    let hasSettled = false;
    const first = requestHttps(`${running.url}/body`, ca, "input").finally(() => { hasSettled = true; });
    const firstHit = await running.waitForEvent((event) => event.type === "fault-hit");
    assert(firstHit.type === "fault-hit");
    assert.equal(hasSettled, false);
    assert.equal((await running.stats()).routes.body.clientResponseBytes, 0);
    const cancellation = new AbortController();
    const cancelled = assert.rejects(requestHttps(`${running.url}/body`, ca, "input", { signal: cancellation.signal }), /abort/i);
    const secondHit = await running.waitForEvent((event) => event.type === "fault-hit", { after: firstHit.sequence });
    assert(secondHit.type === "fault-hit");
    assert.notEqual(secondHit.requestId, firstHit.requestId);
    assert.equal((await running.stats()).activeRequests, 2);
    running.release(firstHit.requestId);
    assert.equal((await first).body.toString(), "fixture-only");
    assert.equal((await running.stats()).activeRequests, 1);
    cancellation.abort();
    await cancelled;
    await running.waitForEvent((event) => event.type === "request-finished" && event.requestId === secondHit.requestId);
    assert.equal((await running.stats()).activeRequests, 0);
    assert.equal((await running.stats()).faultHits.paused, 2);
    await assert.rejects(running.waitForEvent(() => false, { timeoutMs: 20 }), /timed out/);
    await running.stop();
  });

  await t.test("request and response body stalls and truncation hit explicit byte limits", async () => {
    for (const kind of ["stall-request", "truncate-request", "stall-response", "truncate-response"] as const) {
      const running = await proxy({
        requestTimeoutMs: 500,
        faults: [{ id: "body-fault", route: "body", kind, afterBytes: 4 }],
      });
      const rejected = assert.rejects(requestHttps(`${running.url}/body`, ca, "synthetic-input"));
      await running.waitForEvent((event) => event.type === "fault-hit");
      await rejected;
      const finished = await running.waitForEvent((event) => event.type === "request-finished");
      assert(finished.type === "request-finished");
      assert.equal(finished.outcome, kind.startsWith("stall") ? "timeout" : "fault");
      const stats = await running.stats();
      assert.equal(stats.faultHits["body-fault"], 1);
      assert.equal(stats.routes.body.starts, 1);
      assert.equal(stats.routes.body[kind.endsWith("request") ? "upstreamRequestBytes" : "clientResponseBytes"], 4);
      assert.equal(stats.activeRequests, 0);
      await running.stop();
    }
  });

  await t.test("selectors isolate application routes and active listeners stop within deadlines", async () => {
    const running = await proxy({
      routes: [
        { label: "a", pathname: "/body", requestHeader: { name: "x-test-route", value: "synthetic-route-a" } },
        { label: "b", pathname: "/body", requestHeader: { name: "x-test-route", value: "synthetic-route-b" } },
      ],
    });
    await requestHttps(`${running.url}/body`, ca, "input");
    await requestHttps(`${running.url}/body`, ca, "input", { route: "synthetic-route-a" });
    await requestHttps(`${running.url}/body`, ca, "input", { route: "synthetic-route-b" });
    assert.equal((await running.stats()).routes.unmatched.starts, 1);
    assert.equal((await running.stats()).routes.a.starts, 1);
    assert.equal((await running.stats()).routes.b.starts, 1);
    assert(!JSON.stringify(running.events).includes("synthetic-route-"));
    await running.stop();

    const paused = await proxy({ faults: [{ id: "stop-paused", route: "body", kind: "pause-response" }] });
    const rejected = assert.rejects(requestHttps(`${paused.url}/body`, ca, "input"));
    await paused.waitForEvent((event) => event.type === "fault-hit");
    assert.deepEqual(await paused.stop(), { code: 0, signal: null });
    await rejected;

    const expires = await proxy({ maxLifetimeMs: 100 });
    await assert.rejects(expires.waitForEvent(() => false, { timeoutMs: 2000 }), /closed/);
    assert.deepEqual(await expires.stop(), { code: 0, signal: null });
    assert.equal(children.filter((entry) => entry.isRunning).length, 0);

    if (process.platform !== "win32") {
      const unresponsive = await proxy();
      process.kill(unresponsive.pid, "SIGSTOP");
      const start = Date.now();
      assert.deepEqual(await unresponsive.stop(), { code: null, signal: "SIGKILL" });
      assert(Date.now() - start < 5000);
    }
  });

  await t.test("non-loopback origins and listener hosts are rejected without starting children", async () => {
    for (const value of [
      "http://127.0.0.1:443", "https://0.0.0.0:443", "https://[::]:443", "https://192.0.2.1:443",
      "https://example.invalid", "https://localhost.example.invalid", "https://user:secret@localhost",
      "https://127.0.0.1/path", "https://localhost?token=secret", "https://localhost#fragment",
    ]) {
      assert.throws(() => loopbackHttpsOrigin(value));
      await assert.rejects(startSyncHttpsProxy(t, { ...proxyOptions, upstreamUrl: value }));
    }

    await assert.rejects(startSyncHttpsProxy(t, { ...proxyOptions, requestTimeoutMs: Infinity }));
    const valid = parseSyncFixtureProxyConfig({
      ...proxyOptions, ...credentials.trusted, host: "127.0.0.1", profile: "lan", faults: [],
      requestTimeoutMs: 1000, maxLifetimeMs: 5000, maxBodyBytes: 1024,
    });
    for (const host of ["0.0.0.0", "::", "192.0.2.1", "localhost"]) {
      assert.throws(() => parseSyncFixtureProxyConfig({ ...valid, host }), /Invalid fixture proxy configuration/);
    }

    assert.equal(children.filter((entry) => entry.isRunning).length, 0);
  });

  await upstream.stop();
  for (const child of children) {
    assert.equal(child.isRunning, false);
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
    await assertListenerReleased(child.url);
  }

  await assertListenerReleased(upstream.url);
  t.diagnostic(`Cleanup checked ${children.length} exited proxy children and rebound every owned listener`);
});

async function startServer(t: TestContext, credentials: SyncFixtureServerCredentials, handler: RequestListener) {
  const [key, cert] = await Promise.all([readFile(credentials.keyPath), readFile(credentials.certPath)]);
  const sockets = new Set<Duplex>();
  const server = https.createServer({ key, cert }, handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture validation server failed to close")), 2000);
      for (const socket of sockets) socket.destroy();
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      });
    });

    return stopped;
  };
  t.after(stop);

  return { url: `https://127.0.0.1:${address.port}`, stop };
}

function requestHttps(url: string, ca: Buffer, body: string, options: { signal?: AbortSignal; authorization?: string; route?: string } = {}) {
  return new Promise<{ statusCode: number; body: Buffer }>((resolve, reject) => {
    const target = new URL(loopbackHttpsOrigin(new URL(url).origin));
    target.pathname = new URL(url).pathname;
    target.search = new URL(url).search;
    const request = https.request(target, {
      ca, rejectUnauthorized: true, method: "POST", agent: false, signal: options.signal,
      family: target.hostname === "localhost" ? 4 : undefined,
      headers: {
        "content-length": Buffer.byteLength(body), authorization: options.authorization ?? "synthetic-token",
        "x-test-route": options.route ?? "unmatched",
      },
    });
    const timer = setTimeout(() => request.destroy(new Error("Fixture validation client deadline")), 3000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    request.on("error", fail);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", fail);
      response.once("end", () => {
        clearTimeout(timer);
        resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
    });
    request.end(body);
  });
}

async function assertListenerReleased(value: string) {
  const url = new URL(value);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), url.hostname === "[::1]" ? "::1" : "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
