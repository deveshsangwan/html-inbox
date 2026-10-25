import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withViewerSystemdFixture } from "./viewer-systemd-fixtures.mjs";

// This opt-in suite creates only temporary user units, never installed boot services.
const run = promisify(execFile);
const cli = process.env.HTML_INBOX_TEST_CLI
  ? path.resolve(process.env.HTML_INBOX_TEST_CLI)
  : fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
const commandOptions = { timeout: 10_000, maxBuffer: 128 * 1024 };
const ownerSource = String.raw`
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const run = (command, args) => execFileSync(command, args, { timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (config.serviceArgs) {
  run("systemd-run", config.serviceArgs);
  const deadline = Date.now() + 10_000;
  while (JSON.parse(run(process.execPath, [config.cli, "viewer", "status", "--json"])).state !== "running") {
    if (Date.now() > deadline) throw new Error("Synthetic service readiness timed out");
    await delay(50);
  }
}

const url = run(process.execPath, [config.cli, "publish", config.source, "--title", "Synthetic scope probe", "--type", "test"]).trim();
writeFileSync(config.ready, JSON.stringify({ url, pid: process.pid }));
setInterval(() => {}, 1000);
`;

for (const supervised of [false, true]) {
  test(supervised ? "separately supervised viewer survives launching scope stop" : "native detached viewer records SIGTERM when its owning scope stops", {
    skip: process.platform !== "linux" ? "Requires Linux and an available user systemd manager" : false,
    timeout: 45_000,
  }, () => withViewerSystemdFixture(supervised, async ({ home, scope, service, environment, watchOwner }) => {
    const source = path.join(home, "synthetic.html");
    const readyPath = path.join(home, "ready.json");
    const ownerPath = path.join(home, "owner.mjs");
    const configPath = path.join(home, "probe.json");
    const sourceBytes = "<!doctype html><html><body>Synthetic scope lifecycle probe</body></html>";
    const serviceArgs = [
      "--user", "--quiet", "--collect", `--unit=${service}`, "--property=Type=exec",
      "--property=RuntimeMaxSec=60", "--property=TimeoutStopSec=5", "--property=Restart=no",
      `--property=StandardOutput=append:${path.join(home, "viewer.log")}`,
      `--property=StandardError=append:${path.join(home, "viewer.log")}`,
      `--setenv=HTML_INBOX_HOME=${home}`, `--setenv=HTML_INBOX_PORT=${environment.HTML_INBOX_PORT}`,
      process.execPath, cli, "viewer", "--foreground", "--loopback",
    ];
    await run("systemctl", ["--user", "show", "--property=Version", "--value"], commandOptions);
    await writeFile(source, sourceBytes);
    await writeFile(ownerPath, ownerSource);
    await writeFile(configPath, JSON.stringify({ cli, source, ready: readyPath, ...(supervised ? { serviceArgs } : {}) }));
    const owner = spawn("systemd-run", [
      "--user", "--quiet", "--scope", `--unit=${scope}`, "--property=RuntimeMaxSec=60",
      process.execPath, ownerPath, configPath,
    ], { env: environment, stdio: "ignore" });
    const ownerExit = watchOwner(owner);
    await waitUntil(async () => {
      assert.equal(owner.exitCode, null, "Synthetic scope owner exited before readiness");
      return readFile(readyPath, "utf8").then(() => true).catch((error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    });

    const ready = JSON.parse(await readFile(readyPath, "utf8"));
    const record = JSON.parse(await readFile(path.join(home, "viewer.json"), "utf8"));
    const configuration = await readFile(path.join(home, "viewer-config.json"));
    const cgroup = await readFile(`/proc/${record.pid}/cgroup`, "utf8");
    assert(cgroup.includes(supervised ? service : scope), "Viewer must belong to the expected synthetic unit");
    if (!supervised) {
      const stat = await readFile(`/proc/${record.pid}/stat`, "utf8");
      const session = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
      assert.equal(session, record.pid, "Native detached viewer must be a new session leader");
    }
    assert.equal(await httpStatus(ready.url), 200);

    await run("systemctl", ["--user", "stop", scope], commandOptions);
    await ownerExit;
    const status = JSON.parse((await run(process.execPath, [cli, "viewer", "status", "--json"], { ...commandOptions, env: environment })).stdout);
    assert.equal(status.state, supervised ? "running" : "stopped");
    assert.equal(await httpStatus(ready.url), supervised ? 200 : null);
    if (supervised) {
      assert.equal(status.pid, record.pid);
      await run("systemctl", ["--user", "stop", service], commandOptions);
    }

    await assert.rejects(readFile(path.join(home, "viewer.json")), { code: "ENOENT" });
    assert.deepEqual(await readFile(path.join(home, "viewer-config.json")), configuration);
    const documentPath = new URL(ready.url).pathname.replace(/\/$/, "");
    assert.equal(await readFile(path.join(home, documentPath, "index.html"), "utf8"), sourceBytes);
    const log = await readFile(path.join(home, "viewer.log"), "utf8");
    assert.match(log, new RegExp(`Viewer ${record.pid} shutting down \\(SIGTERM\\)`));
    assert.match(log, new RegExp(`Viewer ${record.pid} stopped \\(SIGTERM\\)`));
    assert(!log.includes(record.controlUrl));
    assert(!log.includes("/control/"));
  }));
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, "Synthetic scope readiness timed out");
    await delay(50);
  }
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("timeout", () => request.destroy(new Error("Synthetic HTTP probe timed out")));
    request.once("error", (error) => error.code === "ECONNREFUSED" ? resolve(null) : reject(error));
  });
}
