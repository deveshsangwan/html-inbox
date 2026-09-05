import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  NodeCommandRunner,
  createWranglerInvocation,
  parseWranglerDeployUrls,
} from "./cloudflare-pages";
import { temporaryHome } from "./test-fixtures";

test("command execution separates stdout from diagnostic stderr", async () => {
  const commandResult = await new NodeCommandRunner().run({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write(process.env.HTML_INBOX_RUNNER_TEST || ""); process.stderr.write(" stderr")',
    ],
    cwd: process.cwd(),
    env: { HTML_INBOX_RUNNER_TEST: "runner-ok" },
    timeoutMs: 5_000,
  });
  assert.equal(commandResult.code, 0);
  assert.equal(commandResult.stdout, "runner-ok");
  assert.equal(commandResult.stderr, " stderr");
});

test("Windows Wrangler invocation uses npm through Node", () => {
  const windowsInvocation = createWranglerInvocation(
    [],
    process.cwd(),
    "A".repeat(32),
    5_000,
    "win32",
    "C:\\Program Files\\nodejs\\node.exe",
  );
  assert.equal(
    windowsInvocation.command,
    "C:\\Program Files\\nodejs\\node.exe",
  );
  assert.equal(
    windowsInvocation.args[0],
    "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
  );
});

test("Wrangler deployment URLs retain assigned hostnames", () => {
  assert.deepEqual(
    parseWranglerDeployUrls(
      "\u001b[32mDeployment: https://abc123.assigned-project.pages.dev\u001b[0m",
    ),
    {
      deploymentUrl: "https://abc123.assigned-project.pages.dev",
      projectUrl: "https://assigned-project.pages.dev",
    },
  );
});

test("Wrangler deployment output without a URL is rejected", () => {
  assert.throws(
    () => parseWranglerDeployUrls("deployment finished without a URL"),
    /without returning/,
  );
});

test("command timeout stops descendant processes", async (t) => {
  const runnerHome = await temporaryHome(t);
  const lateMarker = path.join(runnerHome, "late.txt");
  const descendantScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(lateMarker)}, "late"), 300)`;
  const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;
  await assert.rejects(
    new NodeCommandRunner().run({
      command: process.execPath,
      args: ["-e", parentScript],
      cwd: runnerHome,
      env: {},
      timeoutMs: 50,
    }),
    /did not finish/,
  );
  await delay(400);
  await assert.rejects(readFile(lateMarker), /ENOENT/);
});
