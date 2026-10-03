import assert from "node:assert/strict";
import childProcess, {
  type ExecFileException,
  type SpawnOptions,
} from "node:child_process";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { availablePort, temporaryHome } from "./test-fixtures";
import { spawnDetachedViewer } from "./viewer-process";
import { ensureViewer } from "./viewer-server";
import * as viewerTailscale from "./viewer-tailscale";
import { isValidPid } from "./viewer-records";

test("an already exited Windows child keeps startup failure context and is never targeted by its saved PID", async (t) => {
  const home = await temporaryHome(t);
  const port = await availablePort();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert(originalPlatform);
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const viewerChild = new childProcess.ChildProcess();
  Object.defineProperty(viewerChild, "pid", { value: 4242 });
  Object.defineProperty(viewerChild, "exitCode", { value: 23 });
  let cleanupCalls = 0;
  t.mock.method(viewerTailscale, "cleanupTailscale", async () => {
    cleanupCalls += 1;
    return { state: "stopped" as const };
  });
  t.mock.method(childProcess, "spawn", (command: string) => {
    assert.equal(
      command,
      process.execPath,
      "An exited child's saved PID must not be targeted with taskkill",
    );
    return viewerChild;
  });
  t.mock.method(viewerChild, "kill", () =>
    assert.fail("An exited child's saved PID must not be signalled"),
  );

  await assert.rejects(
    ensureViewer(home, port),
    /exited before readiness.*process tree.*journal retained.*Private diagnostics/,
  );
  assert.equal(
    cleanupCalls,
    1,
    "Journal cleanup must not run after process-tree verification fails",
  );
});

test("Windows detached rollback waits for taskkill to stop the whole process tree before returning", async (t) => {
  const home = await temporaryHome(t);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert(originalPlatform);
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const viewerChild = new childProcess.ChildProcess();
  Object.defineProperty(viewerChild, "pid", { value: 4242 });
  const killer = new childProcess.ChildProcess();
  let directSignals = 0;
  t.mock.method(viewerChild, "kill", () => {
    directSignals += 1;
    return true;
  });
  const invocations: string[][] = [];
  t.mock.method(
    childProcess,
    "spawn",
    (command: string, args: string[], options: SpawnOptions) => {
      invocations.push([command, ...args]);
      if (command === "taskkill") {
        assert.deepEqual(args, ["/pid", "4242", "/t", "/f"]);
        assert.equal(options.stdio, "ignore");
        return killer;
      }

      assert.equal(command, process.execPath);
      return viewerChild;
    },
  );

  const detached = await spawnDetachedViewer(
    home,
    { port: 3217, exposure: "loopback", host: "127.0.0.1" },
    "recorded-lock",
  );
  let hasFinished = false;
  const closing = detached.close().then(() => {
    hasFinished = true;
  });
  await delay(25);
  assert.equal(hasFinished, false);
  assert.equal(directSignals, 0);
  assert.equal(invocations.length, 2);

  Object.defineProperty(viewerChild, "exitCode", { value: 0 });
  killer.emit("close", 0, null);
  await closing;
  assert.equal(hasFinished, true);
  assert.equal(directSignals, 0);
});

test("Windows process-tree termination failure refuses rollback instead of killing only its root", async (t) => {
  const home = await temporaryHome(t);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert(originalPlatform);
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const viewerChild = new childProcess.ChildProcess();
  Object.defineProperty(viewerChild, "pid", { value: 4242 });
  const killer = new childProcess.ChildProcess();
  let directSignals = 0;
  t.mock.method(viewerChild, "kill", () => {
    directSignals += 1;
    return true;
  });
  t.mock.method(childProcess, "spawn", (command: string) =>
    command === "taskkill" ? killer : viewerChild,
  );
  const detached = await spawnDetachedViewer(
    home,
    { port: 3217, exposure: "loopback", host: "127.0.0.1" },
    "recorded-lock",
  );
  const closing = detached.close();
  const refused = assert.rejects(closing, /process tree.*could not be stopped/);
  killer.emit("close", 128, null);

  await refused;
  assert.equal(directSignals, 0);
});

test(
  "a FIFO diagnostic path is refused before detached startup can block",
  {
    skip:
      process.platform === "win32"
        ? "mkfifo and FIFO diagnostic paths require POSIX."
        : false,
  },
  async (t) => {
    const home = await temporaryHome(t);
    const logPath = path.join(home, "viewer.log");
    await new Promise<void>((resolve, reject) => {
      childProcess.execFile("mkfifo", [logPath], { timeout: 5000 }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const port = await availablePort();
    const result = await new Promise<{
      error: ExecFileException | null;
      stderr: string;
    }>((resolve) => {
      childProcess.execFile(
        process.execPath,
        [path.join(__dirname, "index.js"), "viewer", "--port", String(port)],
        {
          env: { ...process.env, HTML_INBOX_HOME: home },
          timeout: 2000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
        (error, _stdout, stderr) => resolve({ error, stderr }),
      );
    });

    assert(result.error);
    assert.equal(
      result.error.killed,
      false,
      "The viewer must refuse the FIFO before the external test deadline kills it",
    );
    assert.equal(result.error.code, 1);
    assert.match(result.stderr, /ENXIO|regular private file/);
  },
);

test(
  "Windows rollback stops a real temporary descendant before its delayed file write",
  {
    skip:
      process.platform !== "win32"
        ? "The real taskkill process-tree check requires Windows."
        : false,
  },
  async (t) => {
    const home = await temporaryHome(t);
    const markerPath = path.join(home, "descendant-write");
    const fixturePath = path.join(home, "viewer-parent.cjs");
    const descendantSource =
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'unexpected descendant write'), 750); setTimeout(() => process.exit(0), 5000);";
    await writeFile(
      fixturePath,
      `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, ${JSON.stringify(markerPath)}], { stdio: 'ignore' }); console.log(JSON.stringify({descendantPid: child.pid})); setTimeout(() => process.exit(0), 6000);\n`,
    );
    const originalEntry = process.argv[1];
    process.argv[1] = fixturePath;

    try {
      const detached = await spawnDetachedViewer(
        home,
        { port: 3217, exposure: "loopback", host: "127.0.0.1" },
        "recorded-lock",
      );
      try {
        let descendantPid: number | undefined;
        const deadline = Date.now() + 5000;
        while (descendantPid === undefined && Date.now() < deadline) {
          const line = (await readFile(detached.logPath, "utf8"))
            .split("\n")
            .find((entry) => entry.startsWith('{"descendantPid":'));
          if (line) {
            const value: unknown = JSON.parse(line);
            assert(
              value &&
                typeof value === "object" &&
                "descendantPid" in value &&
                isValidPid(value.descendantPid),
            );
            descendantPid = value.descendantPid;
          } else {
            await delay(25);
          }
        }

        assert(
          descendantPid !== undefined,
          "The temporary parent must report its descendant before cleanup",
        );
        await detached.close();
        await delay(1500);
        await assert.rejects(readFile(markerPath), { code: "ENOENT" });
        assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
      } finally {
        if (
          detached.child.exitCode === null &&
          detached.child.signalCode === null
        )
          await detached.close();
      }
    } finally {
      if (originalEntry === undefined) delete process.argv[1];
      else process.argv[1] = originalEntry;
    }
  },
);
