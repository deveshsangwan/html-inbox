import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import fs, { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { createInbox, setDefaultInbox } from "./inbox-catalog";
import { resolveInboxSelection } from "./inbox-selection";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { parseObject, parseString } from "./sync-model";
import { saveViewerConfiguration } from "./viewer-records";
import { preflightViewerServiceHome, runViewerOwnerPreflight, VIEWER_OWNER_PREFLIGHT } from "./viewer-service-owner";
import { queryViewerServiceProcess } from "./viewer-service-status";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

async function ownerFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-owner-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "library");
  const catalog = path.join(root, "catalog");
  const entry = await createInbox("fixture", home, catalog);
  await setDefaultInbox("fixture", catalog);
  await new ManagedSyncStore(home).enroll();
  const getuid = process.getuid;
  const getgid = process.getgid;
  assert.ok(getuid && getgid);
  const user = { name: "fixture", uid: getuid(), gid: getgid(), home: root };
  let launches = 0;
  let mode = "normal";
  process.getuid = () => 0;
  t.after(() => { process.getuid = getuid; process.getgid = getgid; });
  t.mock.method(childProcess, "execFile", (command: string, args: string[], options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    launches += 1;
    assert.equal(command, process.execPath);
    assert.equal(options.cwd, "/");
    assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
    const configuration = parseObject(JSON.parse(args[3]), "helper launch");
    assert.equal(configuration.cliPath, path.join(__dirname, "index.js"));
    assert.equal(configuration.nodePath, process.execPath);
    const environment = parseObject(configuration.environment, "clean selected environment");
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.NODE_PATH, undefined);
    assert.ok(Array.isArray(configuration.args));
    const action = configuration.args[0];
    assert.equal(action, VIEWER_OWNER_PREFLIGHT);
    const argument = parseString(configuration.args[1]);
    void (async () => {
      if (mode === "timeout") {
        callback(new Error("Recorded helper timeout"), "", "");
        return;
      }

      if (mode === "malformed") {
        callback(null, "{}", "");
        return;
      }

      process.getuid = getuid;
      process.getgid = getgid;
      try {
        const result = await runViewerOwnerPreflight(argument);
        callback(null, JSON.stringify(result), "");
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Owner preflight failed"), "", "");
      } finally {
        process.getuid = () => 0;
      }
    })();
    return new childProcess.ChildProcess();
  });

  return { root, home, catalog, entry, user, getuid, getgid, launches: () => launches, mode: (next: string) => { mode = next; } };
}

test("administrator preflight reads only owner-validated lifecycle and saved configuration", async (t) => {
  const f = await ownerFixture(t);
  process.getuid = f.getuid;
  const store = new ManagedSyncStore(f.home);
  const credential = path.join(f.root, "credential");
  await writeFile(credential, "private fixture bytes", { mode: 0o600 });
  await store.configureRuntime({ ...defaultRuntimeConfig(), credentials: { token: credential } });
  const ledger = await store.snapshot();
  const ownerKey = path.join(f.home, "sync", `owner-${ledger.inboxId}.pem`);
  assert.ok((await fs.stat(ownerKey)).isFile());
  await saveViewerConfiguration(f.home, { config: { exposure: "loopback", port: 4567, host: "127.0.0.1" }, urls: ["http://127.0.0.1:4567"] });
  const before = await readFile(path.join(f.home, "sync", "ledger.json"));
  const saved = await fs.stat(path.join(f.home, "viewer-config.json"));
  const open = fs.open;
  t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => {
    assert.notEqual(String(args[0]), credential);
    assert.notEqual(String(args[0]), ownerKey, "Preflight must not open the fixture's actual signing key");
    return open(...args);
  });
  t.mock.method(http, "request", () => assert.fail("Preflight must not contact control"));
  t.mock.method(https, "request", () => assert.fail("Preflight must not contact a peer"));
  process.getuid = () => 0;
  const result = await preflightViewerServiceHome({ home: f.home, user: f.user, expectedInstanceId: f.entry.instanceId, readConfiguration: true });
  assert.deepEqual(result, { home: f.home, instanceId: f.entry.instanceId, managed: true,
    configuration: { exposure: "loopback", port: 4567, host: "127.0.0.1" }, tailscaleExecutable: null });
  assert.deepEqual(await readFile(path.join(f.home, "sync", "ledger.json")), before);
  assert.equal((await fs.stat(path.join(f.home, "viewer-config.json"))).mode, saved.mode);
  assert.equal(f.launches(), 1);
});

test("owner preflight preserves named, raw, environment and default catalog selection under administrator orchestration", async (t) => {
  const f = await ownerFixture(t);
  const inspectHome = async (home: string) => {
    const checked = await preflightViewerServiceHome({ home, user: f.user });
    return { home: checked.home, ...(checked.instanceId ? { instanceId: checked.instanceId } : {}) };
  };
  const environment = { HTML_INBOX_CATALOG_HOME: f.catalog };
  for (const selection of [{ inbox: "fixture" }, { home: f.home }, {}]) {
    const resolved = await resolveInboxSelection(selection, environment, undefined, { inspectHome });
    assert.equal(resolved.instanceId, f.entry.instanceId);
    assert.equal(resolved.home, f.home);
  }

  const selected = await resolveInboxSelection({}, { ...environment, HTML_INBOX_NAME: "fixture" }, undefined, { inspectHome });
  assert.equal(selected.source, "environment");
  const copied = path.join(f.root, "copied");
  await cp(f.home, copied, { recursive: true });
  await assert.rejects(resolveInboxSelection({ home: copied }, environment, undefined, { inspectHome }), /Copied or moved/);
});

test("copied, mismatched and incomplete managed homes fail the owner bridge before legacy status or any endpoint", async (t) => {
  const f = await ownerFixture(t);
  const ledgerPath = path.join(f.home, "sync", "ledger.json");
  const ledger = await readFile(ledgerPath);
  for (const defect of ["copy", "reader", "missing-ledger", "corrupt-ledger", "barrier"]) {
    const home = defect === "copy" ? path.join(f.root, "copied") : f.home;
    if (defect === "copy") await cp(f.home, home, { recursive: true });
    if (defect === "reader") await writeFile(path.join(home, "instance-id"), "27f18cd1-eeda-4bc9-a940-0a5f3dc74e5b\n");
    if (defect === "missing-ledger") await rm(ledgerPath);
    if (defect === "corrupt-ledger") await writeFile(ledgerPath, "{}");
    if (defect === "barrier") await writeFile(path.join(home, "documents"), "invalid barrier");
    const launches = f.launches();
    await assert.rejects(queryViewerServiceProcess({ platform: "linux", home, port: 4567, exposure: "loopback", user: f.user,
      nodePath: "/legacy/node", cliPath: "/legacy/cli", environment: { NODE_OPTIONS: "--require=never-load" } }, async () => f.user), /preflight failed/);
    assert.equal(f.launches(), launches + 1, "a failed preflight never invokes legacy status or its fallback");
    await writeFile(ledgerPath, ledger);
    await writeFile(path.join(f.home, "instance-id"), `${f.entry.instanceId}\n`);
  }
});

test("malformed, timed-out, wrong-owner or stale-account preflight never becomes status success", async (t) => {
  const f = await ownerFixture(t);
  const definition = { platform: "linux" as const, home: f.home, port: 4567, exposure: "loopback" as const, user: f.user,
    nodePath: "/legacy/node", cliPath: "/legacy/cli", environment: {} };
  for (const mode of ["timeout", "malformed"]) {
    f.mode(mode);
    const launches = f.launches();
    await assert.rejects(queryViewerServiceProcess(definition, async () => f.user));
    assert.equal(f.launches(), launches + 1);
  }

  const launches = f.launches();
  await assert.rejects(queryViewerServiceProcess(definition, async () => ({ ...f.user, uid: f.user.uid + 1 })), /account binding/);
  assert.equal(f.launches(), launches);
  process.getuid = () => f.user.uid + 1;
  await assert.rejects(preflightViewerServiceHome({ home: f.home, user: f.user }), /selected owner or administrator/);
});
