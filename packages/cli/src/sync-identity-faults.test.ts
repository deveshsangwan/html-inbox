import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as platformTest, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createInbox, readCatalogIdentityTransition, readInboxCatalog, readNamedInbox, setDefaultInbox } from "./inbox-catalog";
import { readInboxIdentity } from "./inbox-home";
import type { IdentityCrashCut } from "./sync-identity-fault-child";
import { hasCode } from "./sync-files";
import { parseLedger } from "./sync-ledger";
import { canonicalKey, verifyOriginState } from "./sync-model";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore, toOriginState } from "./sync-store";
import { isRecord } from "./validation";

// Managed enrollment requires POSIX file/directory fsync. Windows rejection is tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;
const html = Buffer.from("<!doctype html><html><body>private identity crash fixture</body></html>");
const input = { originalBytes: html, title: "Synthetic identity record", type: "report", sourceFileName: "identity.html" };

interface OwnedChild {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => { stdout: string; stderr: string };
  messages: unknown[];
}

async function within<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function isPidGone(child: ChildProcess) {
  assert.ok(child.pid);
  try {
    process.kill(child.pid, 0);
    return false;
  } catch (error) {
    if (hasCode(error, "ESRCH")) {
      return true;
    }

    throw error;
  }
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-identity-")));
  const catalog = path.join(root, "catalog");
  const home = path.join(root, "subject");
  const environment: NodeJS.ProcessEnv = { PATH: path.dirname(process.execPath), LANG: "C.UTF-8", CI: "1", HOME: path.join(root, "home"),
    HTML_INBOX_CATALOG_HOME: catalog, TMPDIR: path.join(root, "tmp"), ZDOTDIR: path.join(root, "zsh"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"), XDG_RUNTIME_DIR: path.join(root, "runtime") };
  const children: OwnedChild[] = [];
  t.after(async () => {
    try {
      for (const owned of children) {
        if (owned.child.exitCode === null && owned.child.signalCode === null) {
          owned.child.kill("SIGKILL");
        }

        await within(owned.closed, 5000, "Reaping identity child");
        assert.equal(isPidGone(owned.child), true);
      }

      t.diagnostic(`reaped ${children.length} directly owned children; all PIDs absent: ${children.map((owned) => owned.child.pid).join(",")}`);
    } finally {
      await rm(root, { recursive: true, force: true });
      await assert.rejects(lstat(root), { code: "ENOENT" });
    }
  });

  for (const directory of Object.values(environment).filter((value) => value?.startsWith(root))) {
    assert.ok(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  function launch(args: string[], ipc = false) {
    const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const messages: unknown[] = [];
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("message", (message: unknown) => { messages.push(message); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const owned = { child, closed, output: () => ({ stdout, stderr }), messages };
    children.push(owned);
    return owned;
  }

  async function cli(args: string[], expectedCode = 0) {
    const owned = launch([path.join(__dirname, "index.js"), ...args]);
    const result = await within(owned.closed, 12_000, `CLI ${args.join(" ")}`);
    assert.equal(result.signal, null, JSON.stringify(owned.output()));
    assert.equal(result.code, expectedCode, JSON.stringify(owned.output()));
    return owned.output();
  }

  const subject = await createInbox("subject", home, catalog);
  const unrelated = await createInbox("unrelated", path.join(root, "unrelated"), catalog);
  await setDefaultInbox("subject", catalog);
  const store = new ManagedSyncStore(home);
  await store.enroll();
  await store.publish(input, "Retained_Live");
  await store.publish(input, "Known_Deleted");
  await store.deleteDocument("Known_Deleted");
  const original = await store.snapshot();
  const owner = original.originKeys.find((grant) => grant.inboxId === subject.instanceId);
  assert.ok(owner);
  const peerId = randomUUID();
  await store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId, peerUrl: "https://127.0.0.1:1/",
    sourceInboxId: subject.instanceId, destinationInboxId: peerId, localInboxName: "subject", readerAudience: "synthetic", allowedOrigins: [owner],
    credentialRef: "synthetic", tlsTrustRef: "synthetic", state: "reconnecting", lastError: null });
  await store.configureRuntime(defaultRuntimeConfig());
  await store.setIntendedTarget({ peerId, destinationInboxId: peerId });
  await store.setWorkerEnabled(true);
  const before = await store.snapshot();
  const unrelatedBytes = await readFile(path.join(catalog, "inboxes", "unrelated.json"));
  const defaultBytes = await readFile(path.join(catalog, "default.json"));

  return { root, home, catalog, store, subject, unrelated, before, unrelatedBytes, defaultBytes, launch, cli };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function waitMessage(owned: ReturnType<Fixture["launch"]>, type: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const index = owned.messages.findIndex((message) => isRecord(message) && message.type === type);
    const found = owned.messages[index];
    if (isRecord(found)) {
      owned.messages.splice(index, 1);
      return found;
    }

    assert.equal(owned.child.exitCode, null, JSON.stringify(owned.output()));
    assert.equal(owned.child.signalCode, null, JSON.stringify(owned.output()));
    await delay(10);
  }

  throw new Error(`No ${type} proof: ${JSON.stringify(owned.output())}`);
}

function forkArgs(f: Fixture, expectedInboxId = f.subject.instanceId) {
  return ["sync", "fork", "--home", f.home, "--expect-inbox", expectedInboxId, "--yes", "--json"];
}

async function killAtCut(f: Fixture, cut: IdentityCrashCut, t: TestContext) {
  const owned = f.launch([path.join(__dirname, "sync-identity-fault-child.js"), "crash", f.home, f.subject.instanceId, cut], true);
  const proof = await waitMessage(owned, "cut");
  assert.equal(proof.cut, cut);
  assert.equal(proof.hits, 1);
  const destination = cut === "intent" ? path.join(f.catalog, "identity-transition.json") : cut === "fork-ledger" ? path.join(f.home, "sync", "ledger.json") :
    cut === "reader-identity" ? path.join(f.home, "instance-id") : path.join(f.catalog, "inboxes", "subject.json");
  assert.equal(proof.renamed, destination);
  assert.equal(proof.fileSyncedBeforeRename, true);
  assert.equal(proof.flushed, path.dirname(destination));
  t.diagnostic(`fault ${cut}: ${JSON.stringify(proof)}`);
  assert.equal(owned.child.kill("SIGKILL"), true);
  assert.deepEqual(await within(owned.closed, 5000, "Crash child exit"), { code: null, signal: "SIGKILL" });
  assert.equal(isPidGone(owned.child), true);
  assert.equal(owned.messages.filter((message) => isRecord(message) && message.type === "cut").length, 0);
  const transition = await readCatalogIdentityTransition(f.home, f.subject.instanceId, f.catalog);
  assert.ok(transition);
  assert.equal(transition.name, "subject");
  assert.equal(transition.home, f.home);
  assert.notEqual(transition.newInboxId, f.subject.instanceId);
  return transition;
}

async function assertUnrelatedCatalog(f: Fixture) {
  assert.deepEqual(await readFile(path.join(f.catalog, "inboxes", "unrelated.json")), f.unrelatedBytes);
  assert.deepEqual(await readFile(path.join(f.catalog, "default.json")), f.defaultBytes);
}

async function assertRecoveredFork(f: Fixture, newInboxId: string) {
  const fresh = new ManagedSyncStore(f.home);
  const ledger = await fresh.snapshot();
  assert.equal(ledger.inboxId, newInboxId);
  assert.notEqual(ledger.historyEpoch, f.before.historyEpoch);
  assert.notEqual(ledger.storageIncarnation, f.before.storageIncarnation);
  assert.equal(ledger.migration.phase, "complete");
  assert.equal(await readInboxIdentity(f.home), newInboxId);
  assert.deepEqual(await readNamedInbox("subject", f.catalog), { ...f.subject, instanceId: newInboxId });
  assert.deepEqual(await readInboxCatalog(f.catalog, { readOnly: true }), { inboxes: [{ ...f.subject, instanceId: newInboxId }, f.unrelated], defaultName: "subject" });
  await assertUnrelatedCatalog(f);
  await assert.rejects(lstat(path.join(f.catalog, "identity-transition.json")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.home, "sync", `owner-${f.subject.instanceId}.pem`)), { code: "ENOENT" });
  assert.equal((await lstat(path.join(f.home, "sync", `owner-${newInboxId}.pem`))).mode & 0o077, 0);
  assert.equal(ledger.runtime, null);
  assert.equal(ledger.worker.enabled, false);
  assert.equal(ledger.worker.ownerQuarantined, false);
  for (const entries of [ledger.routes, ledger.outbox, ledger.receipts, ledger.checkpoints, ledger.historyCheckpoints, ledger.publicationIntents, ledger.routeRetries]) {
    assert.deepEqual(entries, {});
  }

  const oldOwner = f.before.originKeys.find((grant) => grant.inboxId === f.subject.instanceId);
  assert.ok(oldOwner);
  for (const id of ["Retained_Live", "Known_Deleted"]) {
    const key = canonicalKey(f.subject.instanceId, id);
    const record = ledger.records[key];
    assert.ok(record);
    assert.deepEqual(toOriginState(record), toOriginState(f.before.records[key]));
    assert.deepEqual(record.contributions, []);
    verifyOriginState(record, oldOwner.publicKey);
  }

  const live = await fresh.getDocumentMetadata("Retained_Live");
  assert.equal(live?.origin?.inboxId, f.subject.instanceId);
  assert.equal(live?.origin?.detached, true);
  assert.deepEqual((await fresh.getDocument("Retained_Live"))?.originalBytes, html);
  assert.equal(await fresh.getDocument("Known_Deleted"), null);
  assert.equal(ledger.records[canonicalKey(f.subject.instanceId, "Known_Deleted")].state, "deleted");
  await fresh.deleteDocument("Retained_Live");
  const hidden = (await fresh.snapshot()).records[canonicalKey(f.subject.instanceId, "Retained_Live")];
  assert.equal(hidden.suppressed, true);
  assert.deepEqual(toOriginState(hidden), toOriginState(f.before.records[canonicalKey(f.subject.instanceId, "Retained_Live")]));
  await fresh.setSuppressed("Retained_Live", false);
  await fresh.publish(input, "Future_Original");
  const after = await fresh.snapshot();
  const future = after.records[canonicalKey(newInboxId, "Future_Original")];
  assert.ok(future);
  assert.equal(future.historyEpoch, ledger.historyEpoch);
  const newOwner = after.originKeys.find((grant) => grant.inboxId === newInboxId);
  assert.ok(newOwner);
  verifyOriginState(future, newOwner.publicKey);
  assert.equal(after.records[canonicalKey(f.subject.instanceId, "Known_Deleted")].state, "deleted");
}

for (const cut of ["intent", "fork-ledger", "reader-identity", "catalog-entry"] satisfies IdentityCrashCut[]) {
  test(`actual CLI fork recovers one recorded identity after SIGKILL at durable ${cut}`, { timeout: 25_000 }, async (t) => {
    const f = await fixture(t);
    const transition = await killAtCut(f, cut, t);
    const interrupted = parseLedger(JSON.parse(await readFile(path.join(f.home, "sync", "ledger.json"), "utf8")));
    assert.equal(interrupted.inboxId, cut === "intent" ? f.subject.instanceId : transition.newInboxId);
    assert.equal(interrupted.migration.phase, cut === "intent" || cut === "catalog-entry" ? "complete" : "forking");
    assert.equal(await readInboxIdentity(f.home), cut === "intent" || cut === "fork-ledger" ? f.subject.instanceId : transition.newInboxId);
    assert.equal((await readNamedInbox("subject", f.catalog))?.instanceId, cut === "catalog-entry" ? transition.newInboxId : f.subject.instanceId);
    if (cut === "intent") {
      assert.deepEqual(interrupted, f.before);
    }

    await f.cli(forkArgs(f));
    if (cut !== "intent") {
      const recovered = await new ManagedSyncStore(f.home).snapshot();
      assert.equal(recovered.historyEpoch, interrupted.historyEpoch);
      assert.equal(recovered.storageIncarnation, interrupted.storageIncarnation);
    }

    await assertRecoveredFork(f, transition.newInboxId);
    const settled = await treeBytes(f.root, ["subject", "catalog"]);
    const repeated = await f.cli(forkArgs(f), 1);
    assert.match(repeated.stderr, /expected inbox identity differs/i);
    assert.deepEqual(await treeBytes(f.root, ["subject", "catalog"]), settled);
  });
}

async function treeBytes(root: string, directories: string[]) {
  const files: Record<string, string> = {};
  async function visit(relative: string) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      files[`${relative}/`] = String(info.mode);
      for (const name of (await readdir(absolute)).sort()) {
        await visit(path.join(relative, name));
      }
      return;
    }

    assert.equal(info.isFile(), true);
    files[relative] = `${info.mode}:${(await readFile(absolute)).toString("base64")}`;
  }

  for (const directory of directories) {
    await visit(directory);
  }
  return files;
}

test("actual CLI blocks corrupt/unrelated journals and catalog compare conflicts without guessing", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const journal = path.join(f.catalog, "identity-transition.json");
  const transition = { schemaVersion: 1, name: "subject", home: f.home, oldInboxId: f.subject.instanceId, newInboxId: randomUUID() };
  for (const invalid of ["{", JSON.stringify({ ...transition, extra: true }), JSON.stringify({ ...transition, home: f.unrelated.home }), JSON.stringify({ ...transition, oldInboxId: randomUUID() })]) {
    await writeFile(journal, invalid, { mode: 0o600 });
    const before = await treeBytes(f.root, ["subject", "catalog"]);
    const result = await f.cli(forkArgs(f), 1);
    assert.match(result.stderr, /journal|transition|JSON|property/i);
    assert.deepEqual(await treeBytes(f.root, ["subject", "catalog"]), before);
  }

  await rm(journal);
  const recorded = await killAtCut(f, "reader-identity", t);
  const catalogPath = path.join(f.catalog, "inboxes", "subject.json");
  const conflict = { schemaVersion: 1, ...f.subject, instanceId: randomUUID() };
  await writeFile(catalogPath, JSON.stringify(conflict), { mode: 0o600 });
  const conflictBytes = await readFile(catalogPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await f.cli(forkArgs(f), 1);
    assert.match(result.stderr, /compare-and-replace failed/);
    assert.deepEqual(await readFile(catalogPath), conflictBytes);
    assert.deepEqual(await readCatalogIdentityTransition(f.home, f.subject.instanceId, f.catalog), recorded);
    assert.equal((await new ManagedSyncStore(f.home).snapshot()).inboxId, recorded.newInboxId);
    await assertUnrelatedCatalog(f);
  }

  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, ...f.subject }), { mode: 0o600 });
  await f.cli(forkArgs(f));
  await assertRecoveredFork(f, recorded.newInboxId);
});

test("actual CLI rejects wrong expected identity before mutations or contact with an owned live worker", { timeout: 25_000 }, async (t) => {
  const f = await fixture(t);
  const original = await treeBytes(f.root, ["subject", "catalog"]);
  await f.cli(forkArgs(f, randomUUID()), 1);
  assert.deepEqual(await treeBytes(f.root, ["subject", "catalog"]), original);

  // No routes are present while this real worker owns its loopback control listener.
  await f.store.quarantineRestore();
  await f.cli(forkArgs(f));
  const current = await new ManagedSyncStore(f.home).snapshot();
  const owned = f.launch([path.join(__dirname, "sync-identity-fault-child.js"), "worker", f.home], true);
  const ready = await waitMessage(owned, "ready");
  assert.ok(typeof ready.port === "number");
  const controlPort = ready.port;
  assert.equal(typeof ready.processId, "string");
  const before = await treeBytes(f.root, ["subject", "catalog"]);
  for (const command of [["sync", "fork"], ["sync", "restore", "quarantine"]]) {
    const result = await f.cli([...command, "--home", f.home, "--expect-inbox", randomUUID(), "--yes", "--json"], 1);
    assert.match(result.stderr, /expected inbox identity differs/i);
    assert.deepEqual(await treeBytes(f.root, ["subject", "catalog"]), before);
    assert.equal(isPidGone(owned.child), false);
  }

  owned.child.send({ type: "probe" });
  const proof = await waitMessage(owned, "probe");
  assert.equal(proof.controlAttempts, 0);
  assert.equal(proof.processId, ready.processId);
  assert.equal((await new ManagedSyncStore(f.home).snapshot()).inboxId, current.inboxId);
  await f.cli(["sync", "worker", "status", "--home", f.home, "--json"]);
  owned.child.send({ type: "probe" });
  const calibrated = await waitMessage(owned, "probe");
  assert.ok(typeof calibrated.controlAttempts === "number" && calibrated.controlAttempts > 0, "Actual CLI status must calibrate the HTTP counter");

  owned.child.send({ type: "close" });
  const closed = await waitMessage(owned, "closed");
  assert.equal(closed.controlAttempts, calibrated.controlAttempts);
  assert.deepEqual(await within(owned.closed, 5000, "Owned worker close"), { code: 0, signal: null });
  assert.equal(isPidGone(owned.child), true);
  const listener = net.createServer();
  try {
    await within(new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(controlPort, "127.0.0.1", resolve); }), 2000, "Rebinding worker control port");
  } finally {
    if (listener.listening) {
      await within(new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())), 2000, "Closing rebound control port");
    }
  }

  t.diagnostic(`worker ${ready.processId}: zero HTTP attempts during wrong-identity commands, ${calibrated.controlAttempts} during counter calibration; exact loopback port ${ready.port} released`);
});
