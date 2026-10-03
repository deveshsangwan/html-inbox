import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { availablePort, temporaryHome } from "./test-fixtures";
import { ensureViewer, getViewerStatus } from "./viewer-server";

test("detached readiness waits for the private record after anonymous reader health is available", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  const preloadPath = path.join(home, "delay-viewer-record.cjs");
  await writeFile(preloadPath, `
const files = require("node:fs/promises");
const path = require("node:path");
const rename = files.rename;
files.rename = async (source, target) => {
  if (target === path.join(process.env.HTML_INBOX_HOME, "viewer.json")) {
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  return rename(source, target);
};
`);

  const originalEntry = process.argv[1];
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const spawn = childProcess.spawn;
  let child: ChildProcess | undefined;
  t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
    child = spawn(command, args, options);
    return child;
  });
  process.argv[1] = path.join(__dirname, "index.js");
  process.env.NODE_OPTIONS = `${originalNodeOptions ?? ""} --require ${JSON.stringify(preloadPath.replaceAll("\\", "/"))}`.trim();

  try {
    await ensureViewer(home, port);
    const status = await getViewerStatus(home, port);
    assert.equal(status.state, "running");
    assert(child);
    assert.equal(status.pid, child.pid);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true });
  } finally {
    if (originalEntry === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalEntry;
    }

    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }

    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
});
