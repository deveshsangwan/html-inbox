import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { LocalDocumentBackend } from "./backend";
import { ManagedSyncStore } from "./sync-store";
import { temporaryHome } from "./test-fixtures";

const runNode = promisify(execFile);
const input = { originalBytes: Buffer.from("<!doctype html><html><body>ordinary unenrolled library</body></html>"), title: "Ordinary", type: "report", sourceFileName: "ordinary.html" };

test("Windows opt-in enrollment rejects before managed mutation while ordinary unenrolled publication remains available", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const backend = new LocalDocumentBackend(home);
  const original = await backend.publish(input);
  const before = await readdir(home);
  if (process.platform === "win32") {
    await assert.rejects(new ManagedSyncStore(home).enroll(), /requires local POSIX/);
    t.diagnostic("Native Windows safe opt-in rejection exercised");
  } else {
    const script = `
      const assert = require("node:assert/strict");
      const [modulePath, home] = process.argv.slice(1);
      Object.defineProperty(process, "platform", { value: "win32" });
      assert.rejects(new (require(modulePath).ManagedSyncStore)(home).enroll(), /requires local POSIX/)
        .then(() => process.stdout.write("rejected-before-mutation"))
        .catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = await runNode(process.execPath, ["-e", script, path.join(__dirname, "sync-store.js"), home], { timeout: 5000 });
    assert.equal(result.stdout, "rejected-before-mutation");
    t.diagnostic("Windows platform rejection simulated in an isolated subprocess; native Windows execution is untested here");
  }

  assert.deepEqual(await readdir(home), before);
  assert.deepEqual((await backend.getDocument(original.id))?.originalBytes, input.originalBytes);
  assert.equal((await backend.publish(input)).title, "Ordinary");
  assert.equal((await backend.listDocuments()).length, 2);
  assert.equal((await readdir(home)).includes("sync"), false);
});
