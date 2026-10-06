import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "./skill-cli-fixtures.mjs";

const dispatcher = fileURLToPath(new URL("../skills/html-inbox/scripts/windows-cli.cjs", import.meta.url));

test("Windows dispatcher transports shell characters and Unicode as an argument array", async (t) => {
  const fixture = await createShim(t);
  const args = ["publish", "report&notes.html", "--title", 'R&D "results" %PATH% | $growth ^ café 🔎', "--type", "report", ""];
  const result = await runCommand(process.execPath, [dispatcher], {
    env: { HTML_INBOX_SKILL_INVOCATION: JSON.stringify({ command: fixture.shim, args }), HTML_INBOX_HOME: fixture.root },
  });
  assert.equal(result.code, 0, result.stderr);
  const recorded = JSON.parse(result.stdout);
  assert.deepEqual(recorded.args, args);
  assert.equal(recorded.home, fixture.root);
  await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
});

test("Windows dispatcher forwards native diagnostics and failure status", async (t) => {
  const fixture = await createShim(t);
  const result = await runCommand(process.execPath, [dispatcher], {
    env: { HTML_INBOX_SKILL_INVOCATION: JSON.stringify({ command: fixture.shim, args: ["--fail"] }) },
  });
  assert.equal(result.code, 23);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /original native failure/);
});

test("Windows dispatcher rejects unsupported shims without executing CMD", async (t) => {
  const fixture = await createShim(t);
  await writeFile(fixture.shim, `@echo 0.2.0\r\necho unsafe > "${fixture.marker}"\r\n`);
  const result = await runCommand(process.execPath, [dispatcher], {
    env: { HTML_INBOX_SKILL_INVOCATION: JSON.stringify({ command: fixture.shim, args: ["--version"] }) },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unsupported npm command shim/);
  assert.equal(result.stdout, "");
  await assert.rejects(readFile(fixture.marker), { code: "ENOENT" });
});

test("Windows dispatcher validates the JSON boundary before running a command", async () => {
  for (const invocation of ["invalid JSON", "null", JSON.stringify({ command: "relative.cmd", args: [] }), JSON.stringify({ command: process.execPath, args: [3] })]) {
    const result = await runCommand(process.execPath, [dispatcher], { env: { HTML_INBOX_SKILL_INVOCATION: invocation } });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert(result.stderr.length > 0);
  }
});

async function createShim(t) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox Windows argv "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const entry = path.join(root, "recording.cjs");
  const shim = path.join(bin, "npx.cmd");
  const marker = path.join(root, "CMD must never execute");
  await writeFile(entry, `
if (process.argv.includes("--fail")) {
  console.error("original native failure");
  process.exit(23);
}
console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.HTML_INBOX_HOME }));
`);
  await writeFile(shim, `@echo off\r\necho unsafe > "${marker}"\r\n"%_prog%" "%dp0%\\..\\recording.cjs" %*\r\n`);

  return { root, shim, marker };
}
