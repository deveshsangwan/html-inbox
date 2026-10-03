import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getViewerStatus, startViewer, stopViewer } from "./viewer-server";
import { LocalDocumentBackend } from "./backend";
import * as viewerTailscale from "./viewer-tailscale";
import { readSavedViewerConfiguration, readViewerRecord, saveViewerConfiguration } from "./viewer-records";
import { getTailscaleStatus, prepareTailscale, startTailscale } from "./viewer-tailscale";
import { recordingTailscale, TAILSCALE_TEST_HOSTNAME, TAILSCALE_RECORDING_SKIP_REASON } from "./tailscale-test-fixtures";
import { availablePort } from "./test-fixtures";
import { getControlHealth } from "./viewer-status";

test("detached Tailscale startup preserves executable and URLs, publish reuses it, and stop waits for cleanup", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));

  try {
    const start = await runCli(fixture.home, fixture.executable, ["viewer", "--tailscale", "--port", String(fixture.options.backendPort)]);
    assert.equal(start.code, 0, start.stderr);
    assert.equal(start.stdout.trim(), `https://${TAILSCALE_TEST_HOSTNAME}`);
    const status = await getViewerStatus(fixture.home);
    assert.equal(status.state, "running");
    assert.equal(status.exposure, "tailscale");
    assert.notEqual(status.pid, process.pid);
    assert.equal((await readSavedViewerConfiguration(fixture.home))?.tailscaleExecutable, fixture.executable);

    const record = await readViewerRecord(fixture.home);
    assert(record);
    assert.equal((await fetch(record.controlUrl)).status, 200);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${status.port}/health`)).json(), { ok: true });
    const sourcePath = path.join(fixture.home, "report.html");
    await writeFile(sourcePath, "<!doctype html><html><body>Tailnet report</body></html>");
    const published = await runCli(fixture.home, fixture.executable, ["publish", sourcePath, "--title", "Tailnet report", "--type", "report"]);
    assert.equal(published.code, 0, published.stderr);
    assert.equal(new URL(published.stdout.trim()).origin, status.url);
    assert.equal((await getViewerStatus(fixture.home)).pid, status.pid);

    await fixture.update({ delayOperation: "off", delayMs: 300 });
    const stopped = await stopViewer(fixture.home).catch(async (error: unknown) => {
      t.diagnostic(await readFile(path.join(fixture.home, "viewer.log"), "utf8"));
      const remaining = await readViewerRecord(fixture.home);
      t.diagnostic(JSON.stringify(remaining && { pid: remaining.pid, config: remaining.config, shutdownError: remaining.shutdownError }));
      t.diagnostic(JSON.stringify(await fixture.liveConfig()));
      throw error;
    });
    assert.equal(stopped.state, "stopped");
    assert.deepEqual(await fixture.liveConfig(), {});
    assert.equal(await readViewerRecord(fixture.home), null);
    await assert.rejects(fixture.journal(), /ENOENT/);
    assert.deepEqual(await getTailscaleStatus(fixture.home), { state: "stopped" });
  } finally {
    await fixture.update({ delayOperation: undefined, failOn: undefined });
    await stopViewer(fixture.home);
  }
});

test("shutdown closes an incomplete private control request before scoped cleanup", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "viewer", "--foreground", "--tailscale", "--port", String(fixture.options.backendPort)], {
    env: { ...process.env, HTML_INBOX_HOME: fixture.home, HTML_INBOX_TAILSCALE_COMMAND: fixture.executable },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let connection: net.Socket | undefined;

  try {
    const deadline = Date.now() + 5000;
    while (!(await readViewerRecord(fixture.home)) && Date.now() < deadline) {
      await delay(10);
    }

    const record = await readViewerRecord(fixture.home);
    assert(record, "foreground viewer must commit readiness");
    const control = new URL(record.controlUrl);
    connection = net.createConnection({ host: "127.0.0.1", port: Number(control.port) });
    await new Promise<void>((resolve, reject) => {
      connection?.once("error", reject);
      connection?.once("connect", resolve);
    });
    connection.write(`GET ${control.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${control.port}\r\n`);
    await delay(25);

    child.kill("SIGTERM");
    const completed = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
    assert(completed, "an incomplete control request must not block shutdown and route cleanup");
    assert.equal(await exited, 0);
    assert.deepEqual(await fixture.liveConfig(), {});
    assert.equal(await readViewerRecord(fixture.home), null);
    await assert.rejects(fixture.journal(), /ENOENT/);
  } finally {
    connection?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }

    await exited;
    await stopViewer(fixture.home);
  }
});

test("an explicit Tailscale executable overrides the previously saved detached executable", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  const previousExecutable = path.join(fixture.home, "previous-tailscale.cjs");
  await copyFile(fixture.executable, previousExecutable);
  await saveViewerConfiguration(fixture.home, {
    config: { port: fixture.options.backendPort, exposure: "tailscale", host: "127.0.0.1", tailscaleHostname: TAILSCALE_TEST_HOSTNAME },
    urls: [`https://${TAILSCALE_TEST_HOSTNAME}`],
    tailscaleExecutable: previousExecutable,
  });

  try {
    const started = await runCli(fixture.home, fixture.executable, ["viewer"]);
    assert.equal(started.code, 0, started.stderr);
    assert.equal((await readSavedViewerConfiguration(fixture.home))?.tailscaleExecutable, fixture.executable);
    assert.equal((await fixture.journal()).executable, fixture.executable);
  } finally {
    await stopViewer(fixture.home);
  }
});

test("SIGTERM during the pending Tailscale mutation waits for scoped startup rollback", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  await fixture.update({ delayOperation: "serve", delayMs: 600 });
  const child = spawn(process.execPath, [path.join(__dirname, "index.js"), "viewer", "--foreground", "--tailscale", "--port", String(fixture.options.backendPort)], {
    env: { ...process.env, HTML_INBOX_HOME: fixture.home, HTML_INBOX_TAILSCALE_COMMAND: fixture.executable },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  try {
    const deadline = Date.now() + 5000;
    while (!(await fixture.commands()).some((args) => args[0] === "serve" && args[1] !== "status") && Date.now() < deadline) {
      await delay(10);
    }

    assert((await fixture.commands()).some((args) => args[0] === "serve" && args[1] !== "status"), "recorded Serve mutation must be in flight");
    child.kill("SIGTERM");
    assert.equal(await exited, 1, output);
    assert.deepEqual(await fixture.liveConfig(), {}, output);
    await assert.rejects(fixture.journal(), /ENOENT/);
    assert.equal(await readViewerRecord(fixture.home), null);
  } finally {
    child.kill("SIGKILL");
    await exited;
    await fixture.update({ delayOperation: undefined });
    await stopViewer(fixture.home);
  }
});

test("SIGTERM during retained-route recovery waits for the scoped off command and releases its lock", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await startTailscale(await prepareTailscale(fixture.options, fixture.command), fixture.command);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  await fixture.update({ delayOperation: "off", delayMs: 300 });
  const cleanup = viewerTailscale.cleanupTailscale;
  t.mock.method(viewerTailscale, "cleanupTailscale", async (home: string, owner?: viewerTailscale.TailscaleOwner, command?: viewerTailscale.TailscaleCommandOptions) => {
    const recovering = cleanup(home, owner, command);
    const deadline = Date.now() + 5000;
    while (!(await fixture.commands()).some((args) => args.at(-1) === "off") && Date.now() < deadline) {
      await delay(10);
    }

    const handled = process.emit("SIGTERM");
    const result = await recovering;
    assert(handled, "the graceful signal handler must be installed before scoped recovery mutates Tailscale");
    return result;
  });

  await assert.rejects(startViewer(new LocalDocumentBackend(fixture.home), fixture.home, fixture.options.backendPort), /startup interrupted before readiness/);
  assert.deepEqual(await fixture.liveConfig(), {});
  assert.equal(await readViewerRecord(fixture.home), null);
  await assert.rejects(fixture.journal(), /ENOENT/);
  assert.deepEqual(await cleanup(fixture.home), { state: "stopped" });
});

test("Tailscale route drift is not healthy and failed cleanup retains its process record and journal", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  let ownedConfig: unknown;

  try {
    const start = await runCli(fixture.home, fixture.executable, ["viewer", "--tailscale", "--port", String(fixture.options.backendPort)]);
    assert.equal(start.code, 0, start.stderr);
    ownedConfig = await fixture.liveConfig();
    await fixture.update({ config: { TCP: { "443": { HTTPS: true } }, Web: { [`${TAILSCALE_TEST_HOSTNAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } } });
    const drift = await getViewerStatus(fixture.home);
    assert.equal(drift.state, "conflict");
    assert.match(drift.reason ?? "", /Tailscale exposure drift/);
    const conflicting = await runCli(fixture.home, fixture.executable, ["viewer", "--loopback", "--port", String(await availablePort())]);
    assert.equal(conflicting.code, 1);
    assert.match(conflicting.stderr, /Tailscale exposure drift/);

    await assert.rejects(stopViewer(fixture.home), /drift|retry viewer stop/);
    assert(await readViewerRecord(fixture.home));
    assert.equal((await fixture.journal()).phase, "active");
    assert.equal((await fixture.commands()).some((args) => args.at(-1) === "off"), false);
    await fixture.update({ config: ownedConfig });
    assert.equal((await stopViewer(fixture.home)).state, "stopped");
    assert.deepEqual(await fixture.liveConfig(), {});
  } finally {
    if (ownedConfig !== undefined) {
      await fixture.update({ config: ownedConfig });
    }

    await stopViewer(fixture.home);
  }
});

test("an explicit different stop port preserves the live Tailscale viewer and owned route", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));

  try {
    const started = await runCli(fixture.home, fixture.executable, ["viewer", "--tailscale", "--port", String(fixture.options.backendPort)]);
    assert.equal(started.code, 0, started.stderr);
    const record = await readViewerRecord(fixture.home);
    const journal = await fixture.journal();
    const ownedConfig = await fixture.liveConfig();
    assert(record);

    await assert.rejects(stopViewer(fixture.home, await availablePort()), /different port|port .*does not match/);
    assert.deepEqual(await readViewerRecord(fixture.home), record);
    assert.deepEqual(await fixture.journal(), journal);
    assert.deepEqual(await fixture.liveConfig(), ownedConfig);
    assert.equal((await getViewerStatus(fixture.home)).state, "running");
    assert.equal((await fixture.commands()).some((args) => args.at(-1) === "off"), false);
  } finally {
    await stopViewer(fixture.home);
  }
});

test("stop waits for externally requested Tailscale shutdown before attempting journal recovery", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));

  try {
    const started = await runCli(fixture.home, fixture.executable, ["viewer", "--tailscale", "--port", String(fixture.options.backendPort)]);
    assert.equal(started.code, 0, started.stderr);
    const record = await readViewerRecord(fixture.home);
    assert(record);
    assert.equal((await getViewerStatus(fixture.home)).pid, record.pid);
    await fixture.update({ delayOperation: "off", delayMs: 300 });
    process.kill(record.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while ((await getControlHealth(record.controlUrl)).state !== "unavailable" && Date.now() < deadline) {
      await delay(10);
    }

    assert.equal((await getControlHealth(record.controlUrl)).state, "unavailable");
    assert.equal((await stopViewer(fixture.home)).state, "stopped");
    assert.deepEqual(await fixture.liveConfig(), {});
    assert.equal(await readViewerRecord(fixture.home), null);
    await assert.rejects(fixture.journal(), /ENOENT/);
  } finally {
    await fixture.update({ delayOperation: undefined });
    await stopViewer(fixture.home);
  }
});

test("viewer stop recovers a pending Tailscale journal before any viewer process record exists", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  const prepared = await prepareTailscale(fixture.options, fixture.command);
  await startTailscale(prepared, fixture.command);
  const journal = await fixture.journal();
  await writeFile(path.join(fixture.home, "tailscale-serve.json"), JSON.stringify({ ...journal, phase: "pending" }));
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));

  assert.equal(await readViewerRecord(fixture.home), null);
  assert.equal((await stopViewer(fixture.home)).state, "stopped");
  assert.deepEqual(await fixture.liveConfig(), {});
  await assert.rejects(fixture.journal(), /ENOENT/);
});

test("an explicit current Tailscale executable recovers ownership after the recorded executable moved", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await startTailscale(await prepareTailscale(fixture.options, fixture.command), fixture.command);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  const currentExecutable = path.join(fixture.home, "current-tailscale.cjs");
  await rename(fixture.executable, currentExecutable);

  const stopped = await runCli(fixture.home, currentExecutable, ["viewer", "stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(await fixture.liveConfig(), {});
  await assert.rejects(fixture.journal(), /ENOENT/);
  assert.equal((await fixture.commands()).filter((args) => args.at(-1) === "off").length, 1);
});

test("status uses the explicit current Tailscale executable after its recorded path moved", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  const previousOverride = process.env.HTML_INBOX_TAILSCALE_COMMAND;
  process.env.HTML_INBOX_TAILSCALE_COMMAND = fixture.executable;

  try {
    await startViewer(new LocalDocumentBackend(fixture.home), fixture.home, {
      port: fixture.options.backendPort,
      exposure: "tailscale",
    });
    const record = await readViewerRecord(fixture.home);
    const journal = await fixture.journal();
    assert(record);
    const currentExecutable = path.join(fixture.home, "current-tailscale.cjs");
    await rename(fixture.executable, currentExecutable);
    process.env.HTML_INBOX_TAILSCALE_COMMAND = currentExecutable;

    const status = await runCli(fixture.home, currentExecutable, ["viewer", "status"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /running/);
    assert.match(status.stdout, new RegExp(TAILSCALE_TEST_HOSTNAME.replaceAll(".", "\\.")));
    assert.deepEqual(await readViewerRecord(fixture.home), record);
    assert.deepEqual(await fixture.journal(), journal);
    assert.equal((await stopViewer(fixture.home)).state, "stopped");
    assert.deepEqual(await fixture.liveConfig(), {});
    await assert.rejects(fixture.journal(), /ENOENT/);
  } finally {
    await stopViewer(fixture.home);
    if (previousOverride === undefined) {
      delete process.env.HTML_INBOX_TAILSCALE_COMMAND;
    } else {
      process.env.HTML_INBOX_TAILSCALE_COMMAND = previousOverride;
    }
  }
});

test("a retained Tailscale route refuses a loopback startup when scoped cleanup cannot be verified", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  const fixture = await recordingTailscale(t);
  await startTailscale(await prepareTailscale(fixture.options, fixture.command), fixture.command);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  await fixture.update({ failOn: "off" });

  try {
    const start = await runCli(fixture.home, fixture.executable, ["viewer", "--loopback", "--port", String(fixture.options.backendPort)]);
    assert.equal(start.code, 1);
    assert.match(start.stderr, /permission denied/);
    assert.equal(await readViewerRecord(fixture.home), null);
    assert.equal((await fixture.journal()).phase, "active");
  } finally {
    await fixture.update({ failOn: undefined });
    await stopViewer(fixture.home);
  }
});

test("failed detached child cleanup includes in-flight command descendants", { skip: TAILSCALE_RECORDING_SKIP_REASON }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX detached process group verification");
    return;
  }

  const fixture = await recordingTailscale(t);
  await new Promise<void>((resolve) => fixture.reader.close(() => resolve()));
  const failedEntry = path.join(fixture.home, "failed-child.cjs");
  const delayedOutput = path.join(fixture.home, "late-command-output");
  await writeFile(failedEntry, `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(delayedOutput)},'late'),500);`)}],{stdio:'ignore'}); process.exit(23);\n`);
  const originalEntry = process.argv[1];
  process.argv[1] = failedEntry;

  try {
    const { ensureViewer } = await import("./viewer-server.js");
    await assert.rejects(ensureViewer(fixture.home, fixture.options.backendPort), /exited before readiness/);
    await delay(700);
    await assert.rejects(readFile(delayedOutput), /ENOENT/);
  } finally {
    if (originalEntry === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalEntry;
    }

    await rm(delayedOutput, { force: true });
  }
});

async function runCli(home: string, executable: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "index.js"), ...args], {
      env: { ...process.env, HTML_INBOX_HOME: home, HTML_INBOX_TAILSCALE_COMMAND: executable },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 55_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
