import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { availablePort, temporaryHome } from "./test-fixtures";
import { readViewerRecord } from "./viewer-records";

const serviceLoggingSkip =
  process.platform === "win32"
    ? "LaunchDaemon private log ownership and signal checks require a POSIX normal account."
    : false;

test(
  "the normal-account foreground service opens and hardens its own diagnostic log",
  { skip: serviceLoggingSkip },
  async (t) => {
    const home = await temporaryHome(t);
    const logPath = path.join(home, "viewer.log");
    await writeFile(logPath, "Existing diagnostics\n", { mode: 0o644 });
    const worker = serviceWorker(home, await availablePort());

    try {
      const deadline = Date.now() + 5000;
      while (!(await readViewerRecord(home)) && Date.now() < deadline) {
        await delay(10);
      }

      const record = await readViewerRecord(home);
      assert(record, worker.diagnostics());
      const log = await lstat(logPath);
      assert.equal(log.uid, process.getuid?.());
      assert.equal(log.mode & 0o777, 0o600);
      assert.equal(log.nlink, 1);
      assert.deepEqual(
        await (
          await fetch(`http://127.0.0.1:${record.config.port}/health`)
        ).json(),
        { ok: true },
      );
    } finally {
      worker.child.kill("SIGTERM");
      assert.equal(await worker.exited, 0, worker.diagnostics());
    }

    const contents = await readFile(logPath, "utf8");
    assert.match(contents, /^Existing diagnostics\n/);
    assert.match(
      contents,
      /html-inbox viewer listening on http:\/\/127\.0\.0\.1:/,
    );
    assert.equal(await readViewerRecord(home), null);
  },
);

for (const replacement of ["symlink", "hardlink"] as const) {
  test(
    `the normal-account service refuses a ${replacement} diagnostic log before startup`,
    { skip: serviceLoggingSkip },
    async (t) => {
      const home = await temporaryHome(t);
      const target = path.join(home, "unrelated-file");
      await writeFile(target, "untouched", { mode: 0o640 });
      const before = await lstat(target);
      const logPath = path.join(home, "viewer.log");
      if (replacement === "symlink") {
        await symlink(target, logPath);
      } else {
        await link(target, logPath);
      }

      const worker = serviceWorker(home, await availablePort());
      assert.equal(await worker.exited, 1, worker.diagnostics());
      assert.match(worker.diagnostics(), /ELOOP|private regular file/);
      assert.equal(await readFile(target, "utf8"), "untouched");
      assert.equal((await lstat(target)).mode, before.mode);
      assert.equal(await readViewerRecord(home), null);
    },
  );
}

function serviceWorker(home: string, port: number) {
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, "index.js"),
      "viewer",
      "--foreground",
      "--loopback",
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        HTML_INBOX_HOME: home,
        HTML_INBOX_VIEWER_SERVICE_LOG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  let diagnostics = "";
  child.stdout.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  return { child, exited, diagnostics: () => diagnostics };
}
