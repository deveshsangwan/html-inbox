import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

for (const [fixtureName, prefixArguments] of [["npm-bundled-npx.cmd", []], ["npm-legacy-npx.cmd", ["prefix", "-g"]]]) {
  for (const hasGlobalNpm of [false, true]) {
    test(`Windows dispatcher runs ${fixtureName} with ${hasGlobalNpm ? "global" : "bundled"} npm`, async (t) => {
      const fixture = await createShim(t);
      await copyFile(new URL(`./fixtures/${fixtureName}`, import.meta.url), fixture.shim);
      const npmBin = path.join(path.dirname(fixture.shim), "node_modules", "npm", "bin");
      const prefix = path.join(fixture.root, "configured npm prefix");
      await mkdir(npmBin, { recursive: true });
      const prefixScript = prefixArguments.length ? "npm-cli.js" : "npm-prefix.js";
      await writeFile(path.join(npmBin, prefixScript), `
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(prefixArguments)});
console.log(${JSON.stringify(prefix)});
`);
      await writeFile(path.join(npmBin, "npx-cli.js"), 'console.log(JSON.stringify({ entry: "bundled", args: process.argv.slice(2) }));\n');
      if (hasGlobalNpm) {
        const globalBin = path.join(prefix, "node_modules", "npm", "bin");
        await mkdir(globalBin, { recursive: true });
        await writeFile(path.join(globalBin, "npx-cli.js"), 'console.log(JSON.stringify({ entry: "global", args: process.argv.slice(2) }));\n');
      }

      const args = ["--yes", "html-inbox@0.2.0", "publish", "R&D.html", "--title", '"Results" %PATH%'];
      const result = await runCommand(process.execPath, [dispatcher], {
        env: { HTML_INBOX_SKILL_INVOCATION: JSON.stringify({ command: fixture.shim, args }) },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { entry: hasGlobalNpm ? "global" : "bundled", args });
    });
  }
}

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
