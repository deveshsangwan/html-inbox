import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";

/** The probes own no services. Join their process group before removing their TMPDIR. */
export async function runManagedViewProbe(t: TestContext, kind: "actual-view" | "retention") {
  assert.notEqual(process.platform, "win32", "Managed storage probes require POSIX enrollment");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-view-ci-")));
  const repo = path.resolve(__dirname, "../../..");
  const script = kind === "actual-view" ? "managed-view-contract.cjs" : "managed-view-retention.cjs";
  const args = [...(kind === "retention" ? ["--expose-gc"] : []), "--test", "--test-reporter=tap", path.join(repo, "scripts", "bench", script)];
  const child = spawn(process.execPath, args, {
    cwd: repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // In particular, do not inherit the outer test runner's NODE_TEST_CONTEXT.
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: root, TMPDIR: root,
      XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_DATA_HOME: root,
      HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"), HTML_INBOX_CONTRACT_DIST: __dirname },
  });
  t.diagnostic(JSON.stringify({ probe: script, executable: process.execPath, args, fixtureRoot: root, pid: child.pid, processGroup: child.pid }));
  let failure: Error | undefined;
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let escalation: NodeJS.Timeout | undefined;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) {
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }

      failure = new AggregateError([...(failure ? [failure] : []), error], "Managed view probe group signalling failed");
    }
  };
  const stop = (error: Error) => {
    if (failure) {
      return;
    }

    failure = error;
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 2000);
  };
  const record = (bytes: Buffer, stream: "stdout" | "stderr") => {
    outputBytes += bytes.length;
    if (outputBytes > 1024 * 1024) {
      stop(new Error("Managed view probe exceeded 1 MiB of output"));
      return;
    }

    if (stream === "stdout") stdout += bytes.toString("utf8");
    else stderr += bytes.toString("utf8");
  };
  child.stdout.on("data", (bytes: Buffer) => record(bytes, "stdout"));
  child.stderr.on("data", (bytes: Buffer) => record(bytes, "stderr"));
  child.once("error", stop);
  const onAbort = () => stop(new Error("Managed view probe test was cancelled"));
  t.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => stop(new Error("Managed view probe exceeded 60 seconds")), 60_000);
  if (t.signal.aborted) {
    onAbort();
  }
  let hasProbeFailed = false;
  let probeFailure: unknown;

  try {
    const result = await closed;
    t.diagnostic(`${script}:\n${stdout}${stderr}`);
    t.diagnostic(JSON.stringify({ pid: child.pid, processGroup: child.pid, ...result }));
    if (failure) {
      throw failure;
    }

    assert.equal(result.signal, null);
    assert.equal(result.code, 0, `${script} failed; its complete output is above`);
    const expected = kind === "actual-view" ? 44 : 1;
    assert.match(stdout, new RegExp(`^# tests ${expected}$`, "m"));
    assert.match(stdout, new RegExp(`^# pass ${expected}$`, "m"));
    assert.match(stdout, /^# fail 0$/m);
    assert.match(stdout, /^# skipped 0$/m);
    assert.match(stdout, /^# cancelled 0$/m);
  } catch (error) {
    hasProbeFailed = true;
    probeFailure = error;
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    t.signal.removeEventListener("abort", onAbort);
    try {
      await closed;
      signalGroup("SIGKILL");
      const until = Date.now() + 3000;
      let absent = false;
      while (Date.now() < until) {
        try {
          if (!child.pid) {
            absent = true;
            break;
          }

          process.kill(-child.pid, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            absent = true;
            break;
          }

          throw error;
        }
        await delay(20);
      }

      assert(absent, `Managed view probe group remains; preserve ${root}`);
      await rm(root, { recursive: true, force: true });
      await assert.rejects(lstat(root), { code: "ENOENT" });
      t.diagnostic(`${script}: process group reaped, private fixture root removed`);
      if (failure && !hasProbeFailed) {
        throw failure;
      }
    } catch (error) {
      if (hasProbeFailed) {
        throw new AggregateError([probeFailure, error], "Managed view probe and cleanup both failed");
      }

      throw error;
    }
  }
}
