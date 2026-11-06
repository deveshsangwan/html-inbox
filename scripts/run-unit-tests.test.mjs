import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("unit runner shards partition all discovered files and preserve failure status", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-test-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scripts = path.join(root, "scripts");
  const compiled = path.join(root, "packages", "cli", "dist");
  await mkdir(scripts);
  await mkdir(path.join(compiled, "nested"), { recursive: true });
  const runner = path.join(scripts, "run-unit-tests.mjs");
  await copyFile(new URL("./run-unit-tests.mjs", import.meta.url), runner);

  for (const name of ["alpha.test.js", "beta.test.js", "nested/gamma.test.js"]) {
    await writeFile(path.join(compiled, name), `require("node:test")(${JSON.stringify(name)}, () => {});\n`);
  }

  const env = { ...process.env, GITHUB_ACTIONS: "true" };
  // The fixture must emit its own TAP rather than inherit the parent's test IPC protocol.
  delete env.NODE_TEST_CONTEXT;

  const run = (...args) => execute(process.execPath, [runner, ...args], {
    env,
    timeout: 15_000,
  });
  const names = (output) => [...output.matchAll(/^# Subtest: (.+)$/gm)].map((match) => match[1]);
  const all = names((await run()).stdout);
  const first = names((await run("--test-shard=1/2")).stdout);
  const second = names((await run("--test-shard=2/2")).stdout);

  assert.equal(all.length, 3);
  assert(first.length > 0);
  assert(second.length > 0);
  assert.deepEqual([...first, ...second].sort(), all.sort());
  assert.equal(new Set([...first, ...second]).size, all.length);

  await assert.rejects(run("--test-shard=0/2"), { code: 1 });

  await writeFile(path.join(compiled, "failure.test.js"), 'require("node:test")("failure", () => { throw new Error("expected failure"); });\n');
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /not ok \d+ - failure/);

    return true;
  });
});
