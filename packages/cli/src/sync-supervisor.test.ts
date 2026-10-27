import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { renderSyncSupervisor, type SyncSupervisorDefinition } from "./sync-supervisor";
import { temporaryHome } from "./test-fixtures";

const runNode = promisify(execFile);

function definition(): SyncSupervisorDefinition {
  return { schemaVersion: 1, platform: "systemd", inboxId: randomUUID(), home: "/synthetic/home $cash%name", user: "fixture", nodePath: "/synthetic/node $binary", cliPath: "/synthetic/cli $entry.js" };
}

test("supervisor templates escape literal dollar/percent paths, reject control characters, and expose no credential values", () => {
  const value = definition();
  const systemd = renderSyncSupervisor(value);
  const command = systemd.split("\n").find((line) => line.startsWith("ExecStart="));
  assert(command);
  assert(command.includes("$$binary"));
  assert(command.includes("$$entry"));
  assert(command.includes("$$cash%%name"));
  assert(systemd.includes("UMask=0077"));
  assert(systemd.includes("WantedBy=multi-user.target"));
  assert(systemd.includes("Environment=\"HOME="));
  const launchd = renderSyncSupervisor({ ...value, platform: "launchd" });
  assert(launchd.includes("<key>RunAtLoad</key><true/>"));
  assert(launchd.includes("<key>UserName</key><string>fixture</string>"));
  assert(launchd.includes("<key>SuccessfulExit</key><false/>"));
  for (const key of ["home", "nodePath", "cliPath"]) {
    assert.throws(() => renderSyncSupervisor({ ...value, [key]: "/synthetic/path\nExecStart=/unsafe" }), /control characters/);
  }
});

test("public root-owned supervisor definition uses its checked handle and refuses shared write permissions", { skip: process.platform === "win32" }, async (t) => {
  const root = await realpath(await temporaryHome(t));
  const file = path.join(root, "synthetic.service");
  await writeFile(file, "public definition bytes", { mode: 0o644 });
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const [modulePath, target] = process.argv.slice(1);
    const perform = fs.open;
    let hits = 0;
    let unsafe = false;
    fs.open = async (...args) => {
      const file = await perform(...args);
      const stat = file.stat.bind(file);
      file.stat = async () => {
        const info = await stat();
        Object.defineProperty(info, "uid", { value: 0 });
        if (unsafe) Object.defineProperty(info, "mode", { value: info.mode | 0o002 });
        hits += 1;
        return info;
      };
      return file;
    };
    (async () => {
      const { readPublicSyncDefinition } = require(modulePath);
      assert.equal(await readPublicSyncDefinition(target), "public definition bytes");
      unsafe = true;
      await assert.rejects(readPublicSyncDefinition(target), /without shared write/);
      assert.equal(hits, 2);
      process.stdout.write(JSON.stringify({ rootOwnedChecks: hits }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runNode(process.execPath, ["-e", script, path.join(__dirname, "sync-public-definition.js"), file], { timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { rootOwnedChecks: 2 });
});

test("supervision requires exact current definition and owned PID, with no drop-ins or pending daemon reload", { skip: process.platform === "win32" }, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const [directory, home] = process.argv.slice(1);
    (async () => {
      const store = new (require(path.join(directory, "sync-store.js")).ManagedSyncStore)(home);
      await store.enroll();
      await store.setWorkerEnabled(true);
      const runtime = await require(path.join(directory, "sync-worker.js")).startOwnedSyncWorker(home);
      const { createSyncSupervisorDefinition, renderSyncSupervisor, inspectSyncSupervisor } = require(path.join(directory, "sync-supervisor.js"));
      const definition = await createSyncSupervisorDefinition(home, "systemd", "fixture", path.join(directory, "index.js"));
      const expectedPath = "/etc/systemd/system/html-inbox-sync-" + definition.inboxId + ".service";
      const contents = renderSyncSupervisor(definition);
      let reads = 0;
      require(path.join(directory, "sync-public-definition.js")).readPublicSyncDefinition = async file => {
        assert.equal(file, expectedPath);
        reads += 1;
        return contents;
      };
      let calls = 0;
      let dropIns = "";
      let reload = "no";
      const runner = { async run(invocation) {
        calls += 1;
        assert.equal(invocation.command, "/usr/bin/systemctl");
        assert(invocation.args.some(arg => arg.includes("DropInPaths,NeedDaemonReload")));
        return { code: 0, signal: null, stderr: "", stdout: "UnitFileState=enabled\\nActiveState=active\\nMainPID=" + process.pid + "\\nFragmentPath=" + expectedPath + "\\nDropInPaths=" + dropIns + "\\nNeedDaemonReload=" + reload + "\\n" };
      } };
      try {
        assert.equal((await inspectSyncSupervisor(home, expectedPath, runner)).bootSupervised, true);
        dropIns = "/synthetic/override.conf";
        assert.equal((await inspectSyncSupervisor(home, expectedPath, runner)).bootSupervised, false);
        dropIns = "";
        reload = "yes";
        assert.equal((await inspectSyncSupervisor(home, expectedPath, runner)).bootSupervised, false);
        assert.equal(calls, 3);
        assert.equal(reads, 3);
      } finally {
        await runtime.close();
      }
      process.stdout.write(JSON.stringify({ recordingCalls: calls, liveManagerCalls: 0 }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runNode(process.execPath, ["-e", script, __dirname, home], { timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { recordingCalls: 3, liveManagerCalls: 0 });
});
