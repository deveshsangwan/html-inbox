import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { availablePort, temporaryHome } from "./test-fixtures";
import { ensureViewer, getViewerStatus, startViewer, stopViewer } from "./viewer-server";
import { getInboxInstanceId, readViewerRecord, saveViewerConfiguration, writeViewerRecord } from "./viewer-records";
import { VIEWER_PROTOCOL_VERSION } from "./viewer-server";

const cliPath = path.join(__dirname, "index.js");

test("concurrent default starts detach once, reuse the saved port, and publish after stop", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  try {
    const starts = await Promise.all(Array.from({ length: 4 }, () => runCli(home, ["viewer", "--port", String(port)])));
    for (const result of starts) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), `http://127.0.0.1:${port}`);
    }

    const status = await getViewerStatus(home);
    assert.equal(status.state, "running");
    assert.equal(typeof status.pid, "number");
    assert.notEqual(status.pid, process.pid);
    assert.deepEqual(await (await fetch(`${status.url}/health`)).json(), { ok: true });
    assert.equal((await runCli(home, ["viewer"])).stdout.trim(), status.url);
    assert.equal((await getViewerStatus(home)).pid, status.pid);
    assert.equal((await readFile(path.join(home, "viewer.log"), "utf8")).match(/Starting loopback viewer/g)?.length, 1);

    const conflict = await runCli(home, ["viewer", "--lan"]);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /stop it before changing configuration/);
    assert.equal((await getViewerStatus(home)).pid, status.pid);
    assert.equal((await stopViewer(home)).state, "stopped");

    const sourcePath = path.join(home, "report.html");
    await writeFile(sourcePath, "<!doctype html><html><body>Background report</body></html>");
    const published = await runCli(home, ["publish", sourcePath, "--title", "Background report", "--type", "report"]);
    assert.equal(published.code, 0, published.stderr);
    assert.equal(new URL(published.stdout.trim()).origin, status.url);
    assert.equal((await fetch(published.stdout.trim())).status, 200);
    assert.equal((await getViewerStatus(home)).port, port);

    if (process.platform !== "win32") {
      for (const name of ["viewer.log", "viewer.json", "viewer-config.json", "instance-id"]) {
        assert.equal((await stat(path.join(home, name))).mode & 0o777, 0o600);
      }
    }
  } finally {
    await stopViewer(home);
  }
});

test("saved LAN configuration survives stop and --loopback resets it explicitly", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  try {
    const lan = await runCli(home, ["viewer", "--lan", "--host", "127.0.0.1", "--port", String(port)]);
    assert.equal(lan.code, 0, lan.stderr);
    assert.equal((await getViewerStatus(home)).exposure, "lan");
    await stopViewer(home);

    assert.equal((await runCli(home, ["viewer"])).code, 0);
    assert.equal((await getViewerStatus(home)).exposure, "lan");
    await stopViewer(home);

    assert.equal((await runCli(home, ["viewer", "--loopback"])).code, 0);
    assert.equal((await getViewerStatus(home)).exposure, "loopback");
  } finally {
    await stopViewer(home);
  }
});

test("malformed process records and abandoned startup locks recover without trusting a PID", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  await writeFile(path.join(home, "viewer.json"), "{broken");
  await writeFile(path.join(home, "viewer-start.lock"), JSON.stringify({ pid: 2_147_483_647, token: randomUUID() }));

  try {
    const starts = await Promise.all([runCli(home, ["viewer", "--port", String(port)]), runCli(home, ["viewer", "--port", String(port)])]);
    assert.equal(starts[0].code, 0, starts[0].stderr);
    assert.equal(starts[1].code, 0, starts[1].stderr);
    assert.equal((await getViewerStatus(home)).state, "running");
    assert.equal((await readFile(path.join(home, "viewer.log"), "utf8")).match(/Starting loopback viewer/g)?.length, 1);
  } finally {
    await stopViewer(home);
  }
});

test("older viewer records refuse upgrades without managing their recorded PID", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  await writeFile(path.join(home, "viewer.json"), JSON.stringify({
    host: "127.0.0.1", port, pid: process.pid, processId: randomUUID(), startedAt: new Date().toISOString(),
  }));

  const status = await getViewerStatus(home, port);
  assert.equal(status.state, "incompatible");
  assert.match(status.reason ?? "", /stop the older viewer with its previous executable/);
  assert.equal((await stopViewer(home, port)).state, "incompatible");
  const start = await runCli(home, ["viewer", "--port", String(port)]);
  assert.equal(start.code, 1);
  assert.match(start.stderr, /stop the older viewer with its previous executable/);
  await assert.rejects(readFile(path.join(home, "viewer.log")), /ENOENT/);
  await assert.rejects(startViewer(new LocalDocumentBackend(home), home, 0).then((server) => { server.close(); return server; }), /stop the older viewer with its previous executable/);
  assert.equal((await getViewerStatus(home, port)).state, "incompatible");
});

test("an explicit different stop port preserves the active loopback viewer and process record", async (t) => {
  const home = await temporaryHome(t);
  const started = await runCli(home, ["viewer", "--port", String(await availablePort())]);
  assert.equal(started.code, 0, started.stderr);
  const record = await readViewerRecord(home);
  assert(record);

  try {
    await assert.rejects(stopViewer(home, await availablePort()), /different port|port .*does not match/);
    assert.deepEqual(await readViewerRecord(home), record);
    assert.equal((await getViewerStatus(home)).state, "running");
    assert.deepEqual(await (await fetch(`${record.urls[0]}/health`)).json(), { ok: true });
  } finally {
    await stopViewer(home);
  }
});

test("foreground can select a free port when an unrelated service occupies the saved port without a process record", async (t) => {
  const home = await temporaryHome(t);
  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  assert(address && typeof address !== "string");
  await saveViewerConfiguration(home, {
    config: { port: address.port, exposure: "loopback", host: "127.0.0.1" },
    urls: [`http://127.0.0.1:${address.port}`],
  });

  try {
    const server = await startViewer(new LocalDocumentBackend(home), home, 0);
    assert.notEqual((await readViewerRecord(home))?.config.port, address.port);
    assert.equal((await getViewerStatus(home)).state, "running");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("a dead viewer record at a recycled port permits a verified detached start on another port", async (t) => {
  const home = await temporaryHome(t);
  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  assert(address && typeof address !== "string");
  const config = { port: address.port, exposure: "loopback" as const, host: "127.0.0.1" };
  const urls = [`http://127.0.0.1:${address.port}`];
  await saveViewerConfiguration(home, { config, urls });
  await writeViewerRecord(home, {
    pid: 2_147_483_647,
    instanceId: await getInboxInstanceId(home),
    processId: randomUUID(),
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    config,
    urls,
    controlUrl: `http://127.0.0.1:${await availablePort()}/control/${Buffer.alloc(32).toString("base64url")}`,
    startedAt: new Date().toISOString(),
  });

  try {
    const started = await runCli(home, ["viewer", "--port", String(await availablePort())]);
    assert.equal(started.code, 0, started.stderr);
    const status = await getViewerStatus(home);
    assert.equal(status.state, "running");
    assert.notEqual(status.port, address.port);
  } finally {
    await stopViewer(home);
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("an abandoned lock recovery guard fails with an actionable error", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  for (const name of ["viewer-start.lock", "viewer-start.lock.recovery"]) {
    await writeFile(path.join(home, name), JSON.stringify({ pid: 2_147_483_647, token: randomUUID() }));
  }

  const start = await runCli(home, ["viewer", "--port", String(port)]);
  assert.equal(start.code, 1);
  assert.match(start.stderr, /Abandoned viewer startup recovery guard/);
  await assert.rejects(readFile(path.join(home, "viewer.log")), /ENOENT/);
});

test("stale process identity and another inbox cannot reuse or stop a running reader", async (t) => {
  const home = await temporaryHome(t);
  const otherHome = await temporaryHome(t);
  const server = await startViewer(new LocalDocumentBackend(home), home, 0);
  const record = await readViewerRecord(home);
  assert(record);

  try {
    await writeFile(path.join(home, "viewer.json"), JSON.stringify({ ...record, processId: randomUUID() }));
    assert.equal((await getViewerStatus(home)).pid, undefined);
    await assert.rejects(ensureViewer(home, record.config.port), /missing or stale/);
    await assert.rejects(stopViewer(home), /missing or stale/);
    assert.equal((await fetch(record.urls[0])).status, 200);

    await writeFile(path.join(otherHome, "instance-id"), randomUUID());
    await writeFile(path.join(otherHome, "viewer.json"), JSON.stringify(record));
    assert.equal((await getViewerStatus(otherHome, record.config.port)).state, "conflict");
    assert.equal((await stopViewer(otherHome, record.config.port)).state, "conflict");
    await assert.rejects(startViewer(new LocalDocumentBackend(otherHome), otherHome, 0).then((otherServer) => { otherServer.close(); return otherServer; }), /different HTML_INBOX_HOME|unverified|conflict/);
    assert.deepEqual(await readViewerRecord(otherHome), record);
    assert.equal((await fetch(record.urls[0])).status, 200);
  } finally {
    await writeFile(path.join(home, "viewer.json"), JSON.stringify(record));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("early child exit captures private diagnostics and timeout kills only the failed child", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  const originalEntry = process.argv[1];
  const fixturePath = path.join(home, "failed-viewer.cjs");
  await writeFile(fixturePath, "console.error('recorded startup failure'); process.exit(23);\n");
  process.argv[1] = fixturePath;

  try {
    await assert.rejects(ensureViewer(home, port), /exited before readiness.*Private diagnostics/);
    assert.match(await readFile(path.join(home, "viewer.log"), "utf8"), /recorded startup failure/);
    assert.equal((await getViewerStatus(home, port)).state, "stopped");

    await writeFile(fixturePath, "console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2),config:JSON.parse(process.env.HTML_INBOX_VIEWER_CONFIG)})); setInterval(()=>{},1000);\n");
    await assert.rejects(ensureViewer(home, port), /did not become ready.*Private diagnostics/);
    const output = await readFile(path.join(home, "viewer.log"), "utf8");
    const line = output.split("\n").find((entry) => entry.startsWith('{"pid":'));
    assert(line);
    const child: unknown = JSON.parse(line);
    assert(child && typeof child === "object" && "pid" in child && typeof child.pid === "number");
    const failedChildPid = child.pid;
    assert.throws(() => process.kill(failedChildPid, 0), /ESRCH/);
    assert.deepEqual("args" in child ? child.args : null, ["viewer", "--foreground"]);
    assert.equal((await getViewerStatus(home, port)).state, "stopped");
  } finally {
    if (originalEntry === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalEntry;
    }
  }
});

test("foreground startup stays attached and exits cleanly on SIGTERM", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  const child = spawn(process.execPath, [cliPath, "viewer", "--foreground", "--port", String(port)], {
    env: { ...process.env, HTML_INBOX_HOME: home },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));

  try {
    const deadline = Date.now() + 5000;
    while ((await getViewerStatus(home, port)).state !== "running" && Date.now() < deadline) {
      await delay(25);
    }

    assert.equal(child.exitCode, null);
    assert.equal((await getViewerStatus(home, port)).pid, child.pid);
    child.kill("SIGTERM");
    await exited;
    assert.equal((await getViewerStatus(home, port)).state, "stopped");
  } finally {
    child.kill("SIGKILL");
  }
});

async function runCli(home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HTML_INBOX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
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
