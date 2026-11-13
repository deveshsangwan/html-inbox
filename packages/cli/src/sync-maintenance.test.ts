import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as platformTest, type TestContext } from "node:test";
import { maintainSyncIdentity } from "./sync-maintenance";
import { ManagedSyncStore } from "./sync-store";
import { workerPaths } from "./sync-worker-records";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const html = Buffer.from("<!doctype html><html><body>synthetic maintenance fixture</body></html>");

async function fixture(t: TestContext, worker: boolean, viewer: boolean) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "inbox-maintenance-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new ManagedSyncStore(home);
  await store.enroll();
  await store.publish({ originalBytes: html, title: "Fixture", type: "report", sourceFileName: "fixture.html" }, "fixture");
  const ledger = await store.snapshot();
  ledger.ownerAnchor.dev += 1;
  const ledgerPath = path.join(home, "sync", "ledger.json");
  await fs.writeFile(ledgerPath, JSON.stringify(ledger));
  const paths = workerPaths(home);
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(child.status, 0);
  const owner = { token: randomUUID(), pid: child.pid, start: null };
  if (worker) {
    await fs.writeFile(paths.record, JSON.stringify({ schemaVersion: 1, inboxId: ledger.inboxId, storageIncarnation: ledger.storageIncarnation,
      ownerAnchor: ledger.ownerAnchor, processId: owner.token, pid: owner.pid, start: null, controlOrigin: "http://127.0.0.1:1",
      controlToken: randomBytes(32).toString("base64url"), startedAt: Date.now(), configRevision: 0 }), { mode: 0o600 });
    await fs.writeFile(paths.lifetime, JSON.stringify({ schemaVersion: 2, ...owner }), { mode: 0o600 });
  }
  if (viewer) {
    await fs.writeFile(path.join(home, "viewer.json"), JSON.stringify({ schemaVersion: 1, protocolVersion: 3, instanceId: ledger.inboxId,
      processId: randomUUID(), pid: owner.pid, config: { port: 3217, exposure: "loopback", host: "127.0.0.1" }, urls: ["http://127.0.0.1:3217"], controlUrl: `http://127.0.0.1:1/control/${randomBytes(32).toString("base64url")}`,
      startedAt: new Date().toISOString(), localOwner: { ...ledger.ownerAnchor, start: null } }), { mode: 0o600 });
  }
  return { home, store, ledger, ledgerPath, paths, owner };
}

for (const [worker, viewer] of [[true, false], [false, true], [true, true]]) {
  test(`dev change permits deliberate quarantine with dead worker=${worker} viewer=${viewer}`, async (t) => {
    const f = await fixture(t, worker, viewer);
    const result = await maintainSyncIdentity(f.home, f.ledger.inboxId, "quarantine");
    assert.equal(result.quarantined, true);
    assert.equal(result.inboxId, f.ledger.inboxId);
    assert.equal(result.trustedOwnerRecoveryAvailable, false);
    assert.deepEqual((await f.store.getDocument("fixture"))?.originalBytes, html);
    await assert.rejects(fs.stat(f.paths.lifetime), { code: "ENOENT" });
  });
}

for (const scenario of ["worker", "viewer", "lifetime-only", "unknown-lock", "disagreeing-lock", "unanchored-viewer", "permission-denied"]) {
  test(`dev change rejects ${scenario} without changing durable state`, async (t) => {
    const f = await fixture(t, true, true);
    if (scenario === "worker") {
      const record = JSON.parse(await fs.readFile(f.paths.record, "utf8"));
      record.pid = process.pid;
      await fs.writeFile(f.paths.record, JSON.stringify(record));
    } else if (scenario === "viewer") {
      const record = JSON.parse(await fs.readFile(path.join(f.home, "viewer.json"), "utf8"));
      record.pid = process.pid;
      await fs.writeFile(path.join(f.home, "viewer.json"), JSON.stringify(record));
    } else if (scenario === "lifetime-only") {
      await fs.rm(f.paths.record);
      await fs.writeFile(f.paths.lifetime, JSON.stringify({ schemaVersion: 2, token: randomUUID(), pid: process.pid, start: null }));
    } else if (scenario === "unknown-lock") {
      await fs.writeFile(f.paths.lifetime, "{}");
    } else if (scenario === "disagreeing-lock") {
      await fs.writeFile(f.paths.lifetime, JSON.stringify({ schemaVersion: 2, ...f.owner, token: randomUUID() }));
    } else if (scenario === "unanchored-viewer") {
      const record = JSON.parse(await fs.readFile(path.join(f.home, "viewer.json"), "utf8"));
      delete record.localOwner;
      await fs.writeFile(path.join(f.home, "viewer.json"), JSON.stringify(record));
    } else {
      const kill = process.kill;
      t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
        if (args[0] === f.owner.pid && args[1] === 0) {
          throw Object.assign(new Error("synthetic denied probe"), { code: "EPERM" });
        }
        return kill(...args);
      });
    }
    const before = await snapshot(f.home);
    await assert.rejects(maintainSyncIdentity(f.home, f.ledger.inboxId, "quarantine"), /ambiguous|unknown|disagree|Unanchored/);
    assert.deepEqual(await snapshot(f.home), before);
  });
}

async function snapshot(home: string) {
  const entries = await fs.readdir(home, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async (file) => [path.relative(home, file), (await fs.readFile(file)).toString("base64")]));
}

test("later acquisition failure releases viewer startup exclusion", async (t) => {
  const f = await fixture(t, false, false);
  const records: typeof import("./sync-worker-records") = require("./sync-worker-records");
  t.mock.method(records, "acquireWorkerExclusion", async () => { throw new Error("synthetic acquisition failure"); });
  await assert.rejects(maintainSyncIdentity(f.home, f.ledger.inboxId, "quarantine"), /synthetic acquisition/);
  await assert.rejects(fs.stat(path.join(f.home, "viewer-start.lock")), { code: "ENOENT" });
});

for (const replacement of ["worker", "viewer", "identity"]) {
  test(`rechecks ${replacement} replacement inside the store transaction`, async (t) => {
    const f = await fixture(t, true, true);
    const files: typeof import("node:fs/promises") = require("node:fs/promises");
    const link = files.link;
    let injected = false;
    t.mock.method(files, "link", async (...args: Parameters<typeof link>) => {
      await link(...args);
      if (args[1] === path.join(f.home, "sync", "mutation.lock")) {
        injected = true;
        if (replacement === "identity") {
          await fs.writeFile(path.join(f.home, "instance-id"), randomUUID());
        } else {
          const file = replacement === "worker" ? f.paths.record : path.join(f.home, "viewer.json");
          const record = JSON.parse(await fs.readFile(file, "utf8"));
          record.processId = randomUUID();
          await fs.writeFile(file, JSON.stringify(record));
        }
      }
    });
    const before = await fs.readFile(f.ledgerPath);
    await assert.rejects(maintainSyncIdentity(f.home, f.ledger.inboxId, "quarantine"), /changed during maintenance/);
    assert.equal(injected, true);
    assert.deepEqual(await fs.readFile(f.ledgerPath), before);
  });
}

test("CLI quarantine and deliberate fork preserve bodies and never contact saved controls", async (t) => {
  const f = await fixture(t, true, true);
  let contacts = 0;
  const server = createServer((_request, response) => { contacts += 1; response.writeHead(500).end(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const worker = JSON.parse(await fs.readFile(f.paths.record, "utf8"));
  worker.controlOrigin = origin;
  await fs.writeFile(f.paths.record, JSON.stringify(worker));
  const viewerPath = path.join(f.home, "viewer.json");
  const viewer = JSON.parse(await fs.readFile(viewerPath, "utf8"));
  viewer.controlUrl = `${origin}/control/${randomBytes(32).toString("base64url")}`;
  await fs.writeFile(viewerPath, JSON.stringify(viewer));
  await fs.writeFile(path.join(f.home, "viewer-config.json"), "synthetic copied exposure");
  await fs.writeFile(path.join(f.home, "tailscale-serve.json"), "synthetic copied ownership");
  const env = { PATH: path.dirname(process.execPath), HOME: f.home, HTML_INBOX_CATALOG_HOME: path.join(f.home, "catalog") };
  const run = promisify(execFile);
  const cli = (args: string[]) => run(process.execPath, [path.join(__dirname, "index.js"), ...args, "--home", f.home, "--json"], { env, timeout: 10000 });
  const inspection = JSON.parse((await cli(["sync", "restore", "inspect"])).stdout);
  assert.equal(inspection.anchorMatches, false);
  assert.equal(inspection.currentAnchor.dev + 1, inspection.ownerAnchor.dev);
  await cli(["sync", "restore", "quarantine", "--expect-inbox", f.ledger.inboxId, "--yes"]);
  const quarantined = await f.store.snapshot();
  assert.equal(quarantined.worker.enabled, false);
  assert.equal(quarantined.worker.ownerQuarantined, true);
  assert.notEqual(quarantined.storageIncarnation, f.ledger.storageIncarnation);
  for (const name of ["viewer-config.json", "tailscale-serve.json"]) {
    await assert.rejects(fs.stat(path.join(f.home, name)), { code: "ENOENT" });
  }
  const fork = JSON.parse((await cli(["sync", "fork", "--expect-inbox", f.ledger.inboxId, "--yes"])).stdout);
  assert.notEqual(fork.inboxId, f.ledger.inboxId);
  const ledger = await new ManagedSyncStore(f.home).snapshot();
  assert.deepEqual(ledger.routes, {});
  const retained = Object.values(ledger.records)[0];
  assert.ok(retained);
  assert.equal(retained.originInboxId, f.ledger.inboxId);
  assert.deepEqual(retained.contributions, []);
  assert.deepEqual((await new ManagedSyncStore(f.home).getDocument(retained.localId))?.originalBytes, html);
  assert.equal(contacts, 0);
});

test("ordinary publication still rejects a dev-only mismatch and explains the differing field", async (t) => {
  const f = await fixture(t, false, false);
  const before = await snapshot(f.home);
  await assert.rejects(f.store.publish({ originalBytes: html, title: "Blocked", type: "report", sourceFileName: "fixture.html" }, "blocked"), /ownership anchor changed \(dev\)/);
  assert.deepEqual(await snapshot(f.home), before);
});

for (const scenario of ["dead-lifetime-only", "matching-anchor", "copied-home"]) {
  test(`explicit quarantine supports ${scenario}`, async (t) => {
    const f = await fixture(t, true, true);
    if (scenario === "dead-lifetime-only") {
      await fs.rm(f.paths.record);
    } else {
      if (scenario === "matching-anchor") {
        f.ledger.ownerAnchor.dev -= 1;
      } else {
        f.ledger.ownerAnchor.home = path.join(f.home, "synthetic-former-home");
      }
      await fs.writeFile(f.ledgerPath, JSON.stringify(f.ledger));
      const worker = JSON.parse(await fs.readFile(f.paths.record, "utf8"));
      worker.ownerAnchor = f.ledger.ownerAnchor;
      await fs.writeFile(f.paths.record, JSON.stringify(worker));
      const file = path.join(f.home, "viewer.json");
      const viewer = JSON.parse(await fs.readFile(file, "utf8"));
      viewer.localOwner = { ...f.ledger.ownerAnchor, start: null };
      await fs.writeFile(file, JSON.stringify(viewer));
    }
    assert.equal((await maintainSyncIdentity(f.home, f.ledger.inboxId, "quarantine")).quarantined, true);
    assert.deepEqual((await f.store.getDocument("fixture"))?.originalBytes, html);
  });
}

test("a live runtime appearing during startup exclusion acquisition blocks quarantine", async (t) => {
  const f = await fixture(t, true, false);
  const records: typeof import("./sync-worker-records") = require("./sync-worker-records");
  const acquire = records.acquireWorkerExclusion;
  t.mock.method(records, "acquireWorkerExclusion", async (...args: Parameters<typeof acquire>) => {
    const lock = await acquire(...args);
    const record = JSON.parse(await fs.readFile(f.paths.record, "utf8"));
    record.pid = process.pid;
    await fs.writeFile(f.paths.record, JSON.stringify(record));
    return lock;
  });
  const before = await fs.readFile(f.ledgerPath);
  await assert.rejects(maintainSyncIdentity(f.home, f.ledger.inboxId, "quarantine"), /live or ambiguous/);
  assert.deepEqual(await fs.readFile(f.ledgerPath), before);
  await assert.rejects(fs.stat(path.join(f.home, "viewer-start.lock")), { code: "ENOENT" });
  await assert.rejects(fs.stat(f.paths.startup), { code: "ENOENT" });
});
