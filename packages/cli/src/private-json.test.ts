import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { writeAtomicPrivateJson } from "./private-storage";
import { temporaryHome } from "./test-fixtures";

test("private JSON replacement remains readable and preserves the previous value on failure", async (t) => {
  const home = await temporaryHome(t);
  const filePath = path.join(home, "state.json");
  const previous = { revision: 1, content: "a".repeat(65536) };
  const next = { revision: 2, content: "b".repeat(65536) };
  await writeAtomicPrivateJson(filePath, previous);

  await Promise.all([
    writeAtomicPrivateJson(filePath, next),
    (async () => {
      for (let index = 0; index < 20; index += 1) {
        const observed = JSON.parse(await readFile(filePath, "utf8"));
        assert.deepEqual(observed, observed.revision === 1 ? previous : next);
      }
    })(),
  ]);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), next);

  await assert.rejects(
    writeAtomicPrivateJson(filePath, { unsupported: 1n }),
    /BigInt/,
  );
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), next);
  assert.deepEqual(await readdir(home), ["state.json"]);
});
