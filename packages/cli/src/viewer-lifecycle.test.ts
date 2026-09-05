import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { ensureViewer, getViewerStatus, stopViewer } from "./viewer-server";
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
