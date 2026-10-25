import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { availablePort, temporaryHome } from "./test-fixtures";
import { readViewerRecord } from "./viewer-records";
import { getViewerStatus, startViewer, stopViewer } from "./viewer-server";
import * as viewerRecords from "./viewer-records";

for (const trigger of ["SIGTERM", "SIGINT", "viewer stop"] as const) {
  test(`foreground shutdown records ${trigger} without private control data`, {
    skip: process.platform === "win32" ? "Windows process termination does not deliver POSIX signals" : false,
    timeout: 10_000,
  }, async (t) => {
    const home = await temporaryHome(t);
    const port = await availablePort();
    const document = path.join(home, "synthetic.html");
    await writeFile(document, "<!doctype html><html><body>Synthetic document</body></html>");
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "viewer", "--foreground", "--port", String(port)], {
      env: { ...process.env, HTML_INBOX_HOME: home, HTML_INBOX_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const finished = once(child, "close");
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { diagnostics += chunk; });

    try {
      const deadline = Date.now() + 5000;
      while ((await getViewerStatus(home, port)).state !== "running" && Date.now() < deadline) {
        await delay(25);
      }

      const record = await readViewerRecord(home);
      assert.equal(record?.pid, child.pid);
      assert(record);
      const configuration = await readFile(path.join(home, "viewer-config.json"));
      if (trigger === "viewer stop") {
        assert.equal((await stopViewer(home)).state, "stopped");
      } else {
        child.kill(trigger);
      }

      assert.deepEqual(await finished, [0, null]);
      const reason = trigger === "viewer stop" ? "SIGTERM" : trigger;
      const lifecycle = diagnostics.split("\n").filter((line) => line.includes(`Viewer ${child.pid} `));
      assert.equal(lifecycle.length, 2, "one shutdown request and one completion must be recorded");
      assert.match(lifecycle[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+Z html-inbox: Viewer ${child.pid} shutting down \\(${reason}\\)$`));
      assert.match(lifecycle[1], new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+Z html-inbox: Viewer ${child.pid} stopped \\(${reason}\\)$`));
      assert(!diagnostics.includes(record.controlUrl));
      assert(!diagnostics.includes(record.processId));
      assert(!diagnostics.includes(record.instanceId));
      assert(!diagnostics.includes("/control/"));
      assert.equal(await readViewerRecord(home), null);
      assert.equal((await getViewerStatus(home)).state, "stopped");
      assert.deepEqual(await readFile(path.join(home, "viewer-config.json")), configuration);
      assert.match(await readFile(document, "utf8"), /Synthetic document/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }

      await finished;
    }
  });
}

test("reader close records completion only after process record cleanup", async (t) => {
  const home = await temporaryHome(t);
  const log = t.mock.method(console, "error", () => {});
  const server = await startViewer(new LocalDocumentBackend(home), home, 0);
  const removeRecord = viewerRecords.removeViewerRecord;
  let completeCleanup = () => {};
  let markCleanupStarted = () => {};
  const cleanupGate = new Promise<void>((resolve) => { completeCleanup = resolve; });
  const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
  const remove = t.mock.method(viewerRecords, "removeViewerRecord", async (recordHome: string, processId: string) => {
    markCleanupStarted();
    await cleanupGate;
    await removeRecord(recordHome, processId);
  });

  try {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await cleanupStarted;
    assert.equal(remove.mock.callCount(), 1);
    assert(await readViewerRecord(home));
    assert.equal(log.mock.callCount(), 1);
    assert.match(String(log.mock.calls[0].arguments[0]), /shutting down \(reader-close\)$/);
  } finally {
    completeCleanup();
    await remove.mock.calls[0]?.result;
  }

  assert.equal(await readViewerRecord(home), null);
  assert.equal(log.mock.callCount(), 2);
  assert.match(String(log.mock.calls[1].arguments[0]), /stopped \(reader-close\)$/);
});

test("startup rollback records its reason without reporting a running viewer", async (t) => {
  const home = await temporaryHome(t);
  const log = t.mock.method(console, "error", () => {});
  t.mock.method(viewerRecords, "writeViewerRecord", async () => { throw new Error("synthetic readiness write failure"); });

  await assert.rejects(startViewer(new LocalDocumentBackend(home), home, 0), /synthetic readiness write failure/);
  assert.equal(await readViewerRecord(home), null);
  assert.equal(log.mock.callCount(), 2);
  assert.match(String(log.mock.calls[0].arguments[0]), /shutting down \(startup-failure\)$/);
  assert.match(String(log.mock.calls[1].arguments[0]), /stopped \(startup-failure\)$/);
});
