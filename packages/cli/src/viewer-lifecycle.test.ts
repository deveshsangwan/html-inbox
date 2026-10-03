import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import {
  ensureViewer,
  getViewerStatus,
  startViewer,
  stopViewer,
  VIEWER_PROTOCOL_VERSION,
} from "./viewer-server";
import { temporaryHome, availablePort } from "./test-fixtures";

test("occupied viewer port", async (t) => {
  const blockedHome = await temporaryHome(t);
  const blocker = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const blockerAddress = blocker.address();
  assert(blockerAddress && typeof blockerAddress !== "string");
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${blockerAddress.port}/health`)).json(), { ok: true });
  assert.equal(
    (await getViewerStatus(blockedHome, blockerAddress.port)).state,
    "conflict",
  );
  await assert.rejects(
    ensureViewer(blockedHome, blockerAddress.port),
    /Port .* is already in use/,
  );
});

test("status polling cannot take the port from a starting viewer", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  let beginStartup = () => {};
  const startupGate = new Promise<void>((resolve) => {
    beginStartup = resolve;
  });
  const startup = startupGate.then(() =>
    startViewer(new LocalDocumentBackend(home), home, port),
  );
  const startupOutcome = Promise.allSettled([startup]);

  t.after(async () => {
    beginStartup();
    const [outcome] = await startupOutcome;
    if (outcome.status === "fulfilled") {
      await new Promise<void>((resolve) => outcome.value.close(() => resolve()));
    }
  });

  // Hold any status probe open until startup tries to bind, making the race deterministic.
  const createProbe = net.createServer;
  t.mock.method(net, "createServer", () => {
    const probe = createProbe();
    const closeProbe = probe.close.bind(probe);
    t.mock.method(probe, "close", (callback?: (error?: Error) => void) => {
      beginStartup();
      void startupOutcome.then(() => closeProbe(callback));

      return probe;
    });

    return probe;
  });

  try {
    assert.equal((await getViewerStatus(home, port)).state, "stopped");
  } finally {
    beginStartup();
  }

  await startup;
  assert.equal((await getViewerStatus(home, port)).state, "running");
});

test("status detects a non-HTTP listener without reserving its port", async (t) => {
  const home = await temporaryHome(t);
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const address = blocker.address();
  assert(address && typeof address !== "string");

  assert.equal((await getViewerStatus(home, address.port)).state, "conflict");
});

test("viewer starts and stops", async (t) => {
  const lifecycleHome = await temporaryHome(t);
  const lifecyclePort = await availablePort();
  const viewerProcess = spawn(
    process.execPath,
    [path.join(__dirname, "index.js"), "viewer", "--foreground"],
    {
      env: {
        ...process.env,
        HTML_INBOX_HOME: lifecycleHome,
        HTML_INBOX_PORT: String(lifecyclePort),
      },
      stdio: "ignore",
    },
  );
  const viewerExit = once(viewerProcess, "exit");
  try {
    const deadline = Date.now() + 3000;
    while (
      (await getViewerStatus(lifecycleHome, lifecyclePort)).state !==
        "running" &&
      Date.now() < deadline
    ) {
      await delay(50);
    }
    assert.equal(
      (await getViewerStatus(lifecycleHome, lifecyclePort)).state,
      "running",
    );
    assert.equal(
      (await stopViewer(lifecycleHome, lifecyclePort)).state,
      "stopped",
    );
    await viewerExit;
  } finally {
    if (viewerProcess.exitCode === null) {
      viewerProcess.kill("SIGTERM");
    }
  }
});

test("viewer rejects malformed current health and recognizes an older protocol", async (t) => {
  const home = await temporaryHome(t);
  const instanceId = randomUUID();
  await writeFile(path.join(home, "instance-id"), instanceId);
  const validHealth = {
    ok: true,
    instanceId,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    processId: randomUUID(),
    pid: process.pid,
  };
  let body: unknown = validHealth;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  await writeFile(path.join(home, "viewer.json"), JSON.stringify({
    pid: process.pid,
    instanceId,
    processId: validHealth.processId,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    config: { port: address.port, exposure: "loopback", host: "127.0.0.1" },
    urls: [`http://127.0.0.1:${address.port}`],
    controlUrl: `http://127.0.0.1:${address.port}/control/${"A".repeat(43)}`,
    startedAt: new Date().toISOString(),
  }));

  for (const invalid of [
    null,
    { ok: true },
    { ...validHealth, ok: false },
    { ...validHealth, pid: undefined },
    { ...validHealth, pid: 0 },
    { ...validHealth, pid: -1 },
    { ...validHealth, pid: 1.5 },
    { ...validHealth, processId: undefined },
    { ...validHealth, processId: "invalid" },
    { ...validHealth, instanceId: "invalid" },
  ]) {
    body = invalid;
    assert.equal((await getViewerStatus(home, address.port)).state, "conflict");
    await assert.rejects(
      ensureViewer(home, address.port),
      /process record is unverified/,
    );
  }

  body = { ok: true, instanceId, protocolVersion: 1 };
  assert.equal(
    (await getViewerStatus(home, address.port)).state,
    "incompatible",
  );
  await assert.rejects(
    ensureViewer(home, address.port),
    /incompatible protocol/,
  );

  body = validHealth;
  await ensureViewer(home, address.port);
  assert.equal((await getViewerStatus(home, address.port)).state, "running");
});
