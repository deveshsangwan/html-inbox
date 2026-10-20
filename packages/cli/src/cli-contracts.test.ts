import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertExportOutsideHome, getCliVersion } from "./index";
import { generateInboxCapability } from "./static-export";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { temporaryHome } from "./test-fixtures";

const executeFile = promisify(execFile);

test("preferences CLI shows the default, saves overrides, and restores system", async (t) => {
  const home = path.join(await temporaryHome(t), "inbox");
  const run = async (...args: string[]) => executeFile(process.execPath, [path.join(__dirname, "index.js"), "preferences", ...args], {
    env: { ...process.env, HTML_INBOX_HOME: home },
  });

  assert.equal((await run()).stdout, "Appearance: system\n");
  assert.deepEqual(JSON.parse((await run("--appearance=dark", "--json")).stdout), { appearance: "dark" });
  assert.equal((await run()).stdout, "Appearance: dark\n");
  assert.equal((await run("--appearance", "light")).stdout, "Appearance: light\n");
  assert.deepEqual(JSON.parse((await run("--json")).stdout), { appearance: "light" });
  assert.equal((await run("--appearance", "system")).stdout, "Appearance: system\n");

  await assert.rejects(run("--appearance", "invalid"), /Appearance must be system, light, or dark/);
  assert.deepEqual(JSON.parse((await run("--json")).stdout), { appearance: "system" });
});

test("CLI contracts and export paths", async () => {
  assert.equal(
    getCliVersion(),
    JSON.parse(await readFile(path.join(__dirname, "../package.json"), "utf8"))
      .version,
  );
  assert.throws(
    () =>
      assertExportOutsideHome(
        "/tmp/html-inbox-home/export",
        "/tmp/html-inbox-home",
      ),
    /must not contain or be inside/,
  );
  assert.throws(
    () => assertExportOutsideHome("/tmp", "/tmp/html-inbox-home"),
    /must not contain or be inside/,
  );
  assert.doesNotThrow(() =>
    assertExportOutsideHome("/tmp/html-inbox-export", "/tmp/html-inbox-home"),
  );
  for (let index = 0; index < 10; index += 1) {
    const generatedCapability = generateInboxCapability();
    assert.equal(generatedCapability.length, 22);
    assert.equal(Buffer.from(generatedCapability, "base64url").byteLength, 16);
    assert.equal(
      Buffer.from(generatedCapability, "base64url").toString("base64url"),
      generatedCapability,
    );
  }
});
