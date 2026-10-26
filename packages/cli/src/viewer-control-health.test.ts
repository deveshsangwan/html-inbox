import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { getControlHealth, VIEWER_PROTOCOL_VERSION } from "./viewer-status";

const health = { ok: true, instanceId: randomUUID(), processId: randomUUID(), pid: process.pid,
  protocolVersion: VIEWER_PROTOCOL_VERSION, capabilities: { managedLedgerSchemas: [1], dynamicFormatSwitch: true } };

async function controlServer(t: TestContext, listener: http.RequestListener) {
  const server = http.createServer(listener);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  return `http://127.0.0.1:${address.port}/`;
}

test("viewer health uses native HTTP without entering the runtime fetch dispatcher", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("The runtime fetch dispatcher must not handle viewer health");
  });
  let requests = 0;
  const url = await controlServer(t, (_request, response) => {
    requests += 1;
    response.end(JSON.stringify(health));
  });

  assert.deepEqual(await getControlHealth(url), { state: "ready", instanceId: health.instanceId,
    processId: health.processId, pid: health.pid, managedCompatible: true });
  assert.equal(requests, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const budget of ["default", "caller"] as const) {
  test(`viewer health rejects an HTTP upgrade with the ${budget} deadline and closes its socket`, { timeout: 2000 }, async (t) => {
    let closed = () => {};
    const peerClosed = new Promise<void>((resolve) => { closed = resolve; });
    let requests = 0;
    const url = await controlServer(t, (request, response) => {
      requests += 1;
      request.socket.once("close", closed);
      response.writeHead(101, { connection: "Upgrade", upgrade: "unexpected-health-protocol" });
      response.end();
    });
    const options = budget === "caller" ? { deadlineAt: Date.now() + 60 } : {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [result] = await Promise.race([
        Promise.all([getControlHealth(url, options), peerClosed]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("HTTP upgrade bypassed the viewer health deadline")), 800);
        }),
      ]);

      assert.deepEqual(result, { state: "unavailable" });
      assert.equal(requests, 1);
    } finally {
      clearTimeout(timer);
    }
  });
}

test("viewer health collects fragmented JSON and preserves capability checks", async (t) => {
  const bytes = JSON.stringify({ ...health, capabilities: {} });
  const url = await controlServer(t, (_request, response) => {
    response.write(bytes.slice(0, 20));
    setImmediate(() => response.end(bytes.slice(20)));
  });

  assert.deepEqual(await getControlHealth(url), { state: "ready", instanceId: health.instanceId,
    processId: health.processId, pid: health.pid, managedCompatible: false });
});

for (const status of [302, 403, 500]) {
  test(`viewer health rejects HTTP ${status} without following a redirect`, async (t) => {
    let requests = 0;
    const url = await controlServer(t, (_request, response) => {
      requests += 1;
      response.writeHead(status, { location: "/unexpected" });
      response.end(JSON.stringify(health));
    });

    assert.deepEqual(await getControlHealth(url), { state: status === 302 ? "unavailable" : "invalid" });
    assert.equal(requests, 1);
  });
}

for (const status of [302, 304]) {
  test(`viewer health keeps a non-redirecting HTTP ${status} response invalid`, async (t) => {
    const url = await controlServer(t, (_request, response) => {
      response.writeHead(status, status === 304 ? { location: "/unexpected" } : {});
      response.end();
    });

    assert.deepEqual(await getControlHealth(url), { state: "invalid" });
  });
}

for (const [label, body, state] of [
  ["malformed JSON", "{", "invalid"],
  ["missing identity", JSON.stringify({ ok: true }), "invalid"],
  ["wrong protocol", JSON.stringify({ ...health, protocolVersion: VIEWER_PROTOCOL_VERSION + 1 }), "incompatible"],
  ["invalid UUID", JSON.stringify({ ...health, instanceId: "not-a-uuid" }), "unavailable"],
] as const) {
  test(`viewer health retains the ${label} diagnosis`, async (t) => {
    const url = await controlServer(t, (_request, response) => response.end(body));
    assert.deepEqual(await getControlHealth(url), { state });
  });
}

test("viewer health rejects a response larger than its local control budget", async (t) => {
  const url = await controlServer(t, (_request, response) => response.end(JSON.stringify({ ...health, excess: "x".repeat(16 * 1024) })));
  assert.deepEqual(await getControlHealth(url), { state: "invalid" });
});

test("viewer health applies the caller deadline through the response body", async (t) => {
  const url = await controlServer(t, (_request, response) => {
    response.writeHead(200);
    response.write("{");
  });

  assert.deepEqual(await getControlHealth(url, { deadlineAt: Date.now() + 60 }), { state: "unavailable" });
});

test("viewer health cancellation closes an admitted response", { timeout: 2000 }, async (t) => {
  let admit = () => {};
  let closed = () => {};
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
  const responseClosed = new Promise<void>((resolve) => { closed = resolve; });
  const url = await controlServer(t, (_request, response) => {
    response.once("close", closed);
    response.write("{");
    admit();
  });
  const controller = new AbortController();
  const pending = getControlHealth(url, { signal: controller.signal });
  await admitted;
  controller.abort();

  assert.deepEqual(await pending, { state: "unavailable" });
  await responseClosed;
});

test("already cancelled viewer health sends no request", async (t) => {
  let requests = 0;
  const url = await controlServer(t, (_request, response) => { requests += 1; response.end(JSON.stringify(health)); });

  assert.deepEqual(await getControlHealth(url, { signal: AbortSignal.abort() }), { state: "unavailable" });
  assert.equal(requests, 0);
});

test("a peer closing mid-response makes viewer health unavailable", async (t) => {
  const url = await controlServer(t, (_request, response) => {
    response.writeHead(200, { "content-length": 100 });
    response.write("{");
    setImmediate(() => response.destroy());
  });

  assert.deepEqual(await getControlHealth(url), { state: "unavailable" });
});
