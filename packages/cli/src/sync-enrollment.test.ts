import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { test as platformTest } from "node:test";
import { promisify } from "node:util";
import { createInbox } from "./inbox-catalog";
import { createOneShotStorageFault } from "./sync-files";
import { ManagedSyncStore } from "./sync-store";
import { temporaryHome } from "./test-fixtures";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const runNode = promisify(execFile);

test("actual CLI resumes recorded enrollment intent through named selection without starting a reader", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const catalog = path.join(root, "catalog");
  const entry = await createInbox("source", path.join(root, "source"), catalog);
  const fault = createOneShotStorageFault("migration-intent");
  await assert.rejects(new ManagedSyncStore(entry.home, { testHooks: fault.hooks }).enroll(), /Injected storage fault/);
  assert.equal(fault.proof().hits, 1);
  const result = await runNode(process.execPath, [path.join(__dirname, "index.js"), "sync", "enroll", "--inbox", "source", "--yes", "--json"], {
    env: { PATH: process.env.PATH, HOME: root, HTML_INBOX_CATALOG_HOME: catalog }, timeout: 5000,
  });
  assert.equal(JSON.parse(result.stdout).enrolled, true);
  const ledger = await new ManagedSyncStore(entry.home).snapshot();
  assert.equal(ledger.migration.phase, "complete");
  assert.equal(ledger.inboxId, entry.instanceId);
  assert.equal(ledger.worker.enabled, false);
  const { optionalStat } = await import("./sync-files.js");
  assert.equal(await optionalStat(path.join(entry.home, "viewer.json")), null);
});
