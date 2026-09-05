import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import {
  ensureViewer,
  getViewerStatus,
  stopViewer,
  VIEWER_PROTOCOL_VERSION,
} from "./viewer-server";
import { temporaryHome, availablePort } from "./test-fixtures";

test("occupied viewer port", async (t) => {
  const blockedHome = await temporaryHome(t);
  const blocker = http.createServer((_request, response) => {
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
  assert.equal(
    (await getViewerStatus(blockedHome, blockerAddress.port)).state,
    "conflict",
  );
  await assert.rejects(
    ensureViewer(blockedHome, blockerAddress.port),
    /Port .* is already in use/,
  );
});
test("viewer starts and stops", async (t) => {
  const lifecycleHome = await temporaryHome(t);
  const lifecyclePort = await availablePort();
  const viewerProcess = spawn(
    process.execPath,
    [path.join(__dirname, "index.js"), "viewer"],
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

  for (const invalid of [
    null,
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
      /invalid health response/,
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
