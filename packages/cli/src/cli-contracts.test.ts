import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertExportOutsideHome, USAGE, getCliVersion } from "./index";
import { generateInboxCapability } from "./static-export";

test("CLI contracts and export paths", async () => {
  assert.match(USAGE, /publish <file\.html>/);
  assert.match(USAGE, /viewer/);
  assert.match(USAGE, /delete <id>/);
  assert.match(USAGE, /export --out <directory>/);
  assert.match(USAGE, /remote init --account/);
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
