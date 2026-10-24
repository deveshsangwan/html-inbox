import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerFixture, isPidGone, waitUntil } from "./sync-worker-fault-fixtures";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { readWorkerRecordOffline } from "./sync-worker-records";
import { availablePort } from "./test-fixtures";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";
import { contactWorker, ensureOwnedSyncWorker } from "./sync-worker-client";
import childProcesses from "node:child_process";
import * as lifecycle from "./sync-lifecycle";
import * as ingestionModule from "./sync-http-server";
import * as workerRecords from "./sync-worker-records";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const diagnostic = "html-inbox: Sync worker stopped after an unrecoverable state or cleanup failure; inspect the inbox before restarting.";

async function libraryFixture(t: TestContext, listener = false) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-worker-fatal-"));
  const home = path.join(root, "inbox");
  const store = new ManagedSyncStore(home);
  const workers: Awaited<ReturnType<typeof startOwnedSyncWorker>>[] = [];
  const ports: string[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(async () => {
    t.mock.restoreAll();
    for (const close of cleanup.reverse()) await close();
    for (const worker of workers) await worker.close().catch(() => {});
    await delay(10);
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], "all internal shutdown and observer rejections are observed");
    for (const port of ports) await assertLoopbackClosed(port);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: "ENOENT" });
    t.diagnostic(`${workers.length} library runtimes settled; ${ports.length} exact ports rebound; synthetic root removed`);
  });
  await store.enroll();
  await store.setWorkerEnabled(true);
  if (listener) {
    const tls = await createSyncHttpsCredentials(t);
    const port = await availablePort();
    await store.configureRuntime({ ...defaultRuntimeConfig(), listener: { host: "127.0.0.1", port, tlsRef: "server" },
      tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } });
    ports.push(`https://127.0.0.1:${port}`);
  }

  async function start(options: Parameters<typeof startOwnedSyncWorker>[1] = { temporary: true }) {
    const worker = await startOwnedSyncWorker(home, options);
    workers.push(worker);
    ports.push(worker.record.controlOrigin);
    return worker;
  }

  return { root, home, store, start, ports, cleanup };
}

function launchCli(t: TestContext, f: Awaited<ReturnType<typeof libraryFixture>>, args: string[], mode?: string) {
  const { root, home } = f;
  const child = spawn(process.execPath, [...(mode ? ["--require", path.join(__dirname, "sync-worker-fatal-child.js")] : []),
    path.join(__dirname, "index.js"), ...args, "--home", home, "--json"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"),
      XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, TMP: root, TEMP: root, ZDOTDIR: root,
      HTML_INBOX_FATAL_FIXTURE: mode }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  child.stdout.on("data", (value: Buffer) => { stdout += value.toString(); });
  child.stderr.on("data", (value: Buffer) => { stderr += value.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => { clearTimeout(timer); closed = true; resolve({ code, signal }); });
  });
  f.cleanup.push(async () => {
    if (!closed) child.kill("SIGTERM");
    await completion;
    assert.ok(child.pid);
    assert.equal(isPidGone(child.pid), true);
    t.diagnostic("directly retained CLI child reaped");
  });

  return { child, completion, stdout: () => stdout, stderr: () => stderr, closed: () => closed };
}

for (const observer of ["throw", "reject", "absent"] as const) {
  test(`timer failure closes the library with ${observer} observer and no global exit effect`, { timeout: 6000 }, async (t) => {
    const f = await libraryFixture(t);
    const exitBefore = process.exitCode;
    let notified = 0;
    let closed = 0;
    const worker = await f.start({ temporary: true,
      ...(observer === "absent" ? {} : { onFatalStop: () => {
        notified += 1;
        if (observer === "throw") throw new Error("synthetic observer failure");
        return Promise.reject(new Error("synthetic async observer failure"));
      } }),
      testHooks: { onEvent: (event) => { if (event.type === "closed") closed += 1; } },
    });
    t.mock.method(ManagedSyncStore.prototype, "snapshot", async () => { throw new Error("synthetic timer state failure"); });
    await waitUntil("fatal shutdown completed", async () => closed, (value) => value === 1, 2000);
    await worker.close();
    assert.equal(notified, observer === "absent" ? 0 : 1);
    assert.equal(process.exitCode, exitBefore);
    assert.equal(await readWorkerRecordOffline(f.home), null);
  });
}

test("racing timer and cleanup failures notify once and retain every explicit close failure", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t, true);
  const ingestionError = new Error("synthetic ingestion cleanup failure");
  const controlError = new Error("synthetic control cleanup failure");
  const originalIngestion = ingestionModule.createSyncIngestionServer;
  let ingestionClosed = 0;
  t.mock.method(ingestionModule, "createSyncIngestionServer", (options: Parameters<typeof originalIngestion>[0]) => {
    const server = originalIngestion(options);
    return { ...server, async close() { await server.close(); ingestionClosed += 1; throw ingestionError; } };
  });
  const originalControl = http.createServer;
  let releaseControl: (() => void) | undefined;
  t.mock.method(http, "createServer", (...args: Parameters<typeof originalControl>) => {
    const server = originalControl(...args);
    const close = server.close.bind(server);
    t.mock.method(server, "close", (callback: (error?: Error) => void) => close(() => { releaseControl = () => callback(controlError); }));
    return server;
  });
  let notified = 0;
  const worker = await f.start({ temporary: true, onFatalStop: () => { notified += 1; } });
  t.mock.method(ManagedSyncStore.prototype, "snapshot", async () => { throw new Error("synthetic unsafe state"); });
  await waitUntil("timer initiates fatal close", async () => notified, (value) => value === 1, 2000);
  const closing = worker.close();
  assert.equal(worker.close(), closing, "the explicit close promise stays stable");
  try {
    await waitUntil("independent control cleanup held", async () => releaseControl !== undefined, Boolean);
    assert.equal(notified, 1, "notification does not wait for the other cleanup");
    assert.ok(await lstat(workerRecords.workerPaths(f.home).lifetime));
  } finally {
    releaseControl?.();
  }

  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [ingestionError, controlError]);
    return true;
  });
  assert.equal(ingestionClosed, 1);
  assert.equal(notified, 1);
  assert.ok(await lstat(workerRecords.workerPaths(f.home).lifetime));
  assert.ok(await readWorkerRecordOffline(f.home), "uncertain shutdown retains ownership evidence");
});

test("explicit cleanup rejection is fatal and still rejects the caller", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t);
  const error = new Error("synthetic record cleanup failure");
  let notified = 0;
  const worker = await f.start({ temporary: true, onFatalStop: () => { notified += 1; } });
  t.mock.method(workerRecords, "readWorkerRecordOffline", async () => { throw error; });
  await assert.rejects(worker.close(), (actual: unknown) => actual === error);
  assert.equal(notified, 1);
  assert.ok(await lstat(workerRecords.workerPaths(f.home).lifetime));
});

test("control connection cleanup failure still attempts both listener closes", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t, true);
  const failure = new Error("synthetic connection cleanup failure");
  const createControl = http.createServer;
  let controlClosed = 0;
  t.mock.method(http, "createServer", (...args: Parameters<typeof createControl>) => {
    const server = createControl(...args);
    t.mock.method(server, "closeAllConnections", () => { throw failure; });
    const close = server.close.bind(server);
    t.mock.method(server, "close", (callback: (error?: Error) => void) => { controlClosed += 1; return close(callback); });
    return server;
  });
  const createIngestion = ingestionModule.createSyncIngestionServer;
  let ingestionClosed = 0;
  t.mock.method(ingestionModule, "createSyncIngestionServer", (options: Parameters<typeof createIngestion>[0]) => {
    const server = createIngestion(options);
    return { ...server, async close() { await server.close(); ingestionClosed += 1; } };
  });
  let notified = 0;
  const worker = await f.start({ temporary: true, onFatalStop: () => { notified += 1; } });
  await assert.rejects(worker.close(), (error: unknown) => error === failure);
  assert.equal(notified, 1);
  assert.equal(controlClosed, 1);
  assert.equal(ingestionClosed, 1);
});

for (const trigger of ["authenticated-stop", "signal-without-observer"] as const) {
  test(`${trigger} observes internal cleanup rejection without changing library exit status`, { timeout: 6000 }, async (t) => {
    const f = await libraryFixture(t);
    const exitBefore = process.exitCode;
    let notified = 0;
    let closed = false;
    const failure = new Error("synthetic internal cleanup failure");
    const worker = await f.start({ temporary: true,
      ...(trigger === "authenticated-stop" ? { onFatalStop: () => { notified += 1; } } : {}),
      testHooks: { onEvent: (event) => { if (event.type === "closed") closed = true; } },
    });
    t.mock.method(workerRecords, "readWorkerRecordOffline", async () => { throw failure; });
    if (trigger === "authenticated-stop") await contactWorker(f.home, "stop");
    else process.emit("SIGTERM");
    await waitUntil("internal shutdown completed", async () => closed, Boolean, 2000);
    await assert.rejects(worker.close(), (error: unknown) => error === failure);
    assert.equal(notified, trigger === "authenticated-stop" ? 1 : 0);
    assert.equal(process.exitCode, exitBefore);
  });
}

for (const persistFailure of [false, true]) {
  test(`outer drain failure with ${persistFailure ? "failed" : "successful"} bookkeeping is ${persistFailure ? "fatal" : "recoverable"}`, { timeout: 6000 }, async (t) => {
    const f = await libraryFixture(t);
    let notified = 0;
    let closed = 0;
    const worker = await f.start({ temporary: true, onFatalStop: () => { notified += 1; },
      testHooks: { onEvent: (event) => { if (event.type === "closed") closed += 1; } } });
    t.mock.method(lifecycle, "assertManagedLifecycle", async () => { throw new Error("synthetic drain failure"); });
    const recordRun = ManagedSyncStore.prototype.recordWorkerRun;
    let persisted = 0;
    let hasPersistedFailure = false;
    t.mock.method(ManagedSyncStore.prototype, "recordWorkerRun", async function (this: ManagedSyncStore, ...args: Parameters<typeof recordRun>) {
      assert.equal(args[1], "worker-pass-failed");
      persisted += 1;
      if (persistFailure) throw new Error("synthetic error persistence failure");
      await recordRun.apply(this, args);
      hasPersistedFailure = true;
    });
    worker.requestRun({ ticketId: randomUUID(), deadlineAt: Date.now() + 2000, requestMs: 100 });
    await waitUntil("outer failure persistence attempted", async () => persisted, (value) => value === 1, 2000);
    if (persistFailure) {
      await waitUntil("drain shutdown settles without self-await", async () => closed, (value) => value === 1, 2000);
      assert.equal(notified, 1);
    } else {
      await waitUntil("recoverable pass failure durably persisted", async () => hasPersistedFailure, Boolean);
      await waitUntil("recoverable pass idle", async () => worker.status().processState, (value) => value === "idle");
      assert.equal((await f.store.snapshot()).worker.lastError, "worker-pass-failed");
      assert.equal(notified, 0);
      assert.ok(await readWorkerRecordOffline(f.home));
    }

    await worker.close();
    assert.equal(closed, 1);
  });
}

test("shutdown holds lifetime authority until a pending drain settles", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const worker = await f.start();
  const check = lifecycle.assertManagedLifecycle;
  let entered = false;
  t.mock.method(lifecycle, "assertManagedLifecycle", async (home: string) => {
    entered = true;
    await held;
    return check(home);
  });
  worker.requestRun({ ticketId: randomUUID(), deadlineAt: Date.now() + 2000, requestMs: 100 });
  await waitUntil("held drain entry", async () => entered, Boolean);
  const closing = worker.close();
  try {
    await delay(20);
    assert.ok(await lstat(workerRecords.workerPaths(f.home).lifetime));
    assert.ok(await readWorkerRecordOffline(f.home));
  } finally {
    release();
  }

  await closing;
  assert.equal(await readWorkerRecordOffline(f.home), null);
});

test("timer and failed drain persistence race without duplicate notification or self-await", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t);
  let notified = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const worker = await f.start({ temporary: true, onFatalStop: () => { notified += 1; } });
  let persisting = false;
  t.mock.method(lifecycle, "assertManagedLifecycle", async () => { throw new Error("synthetic drain failure"); });
  t.mock.method(ManagedSyncStore.prototype, "recordWorkerRun", async () => {
    persisting = true;
    await held;
    throw new Error("synthetic persistence failure");
  });
  worker.requestRun({ ticketId: randomUUID(), deadlineAt: Date.now() + 2000, requestMs: 100 });
  await waitUntil("drain error bookkeeping held", async () => persisting, Boolean);
  t.mock.method(ManagedSyncStore.prototype, "snapshot", async () => { throw new Error("synthetic timer failure"); });
  try {
    await waitUntil("fatal notification before drain settles", async () => notified, (value) => value === 1, 2000);
    assert.ok(await lstat(workerRecords.workerPaths(f.home).lifetime));
  } finally {
    release();
  }

  await worker.close();
  assert.equal(notified, 1);
});

test("startup exclusion cleanup runs even when listener cleanup rejects", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t, true);
  const create = ingestionModule.createSyncIngestionServer;
  let ingestionClosed = false;
  t.mock.method(ingestionModule, "createSyncIngestionServer", (options: Parameters<typeof create>[0]) => {
    const server = create(options);
    return { ...server, async close() { await server.close(); ingestionClosed = true; throw new Error("synthetic cleanup failure"); } };
  });
  const createControl = http.createServer;
  let control: http.Server | undefined;
  t.mock.method(http, "createServer", (...args: Parameters<typeof createControl>) => {
    control = createControl(...args);
    control.on("listening", () => {
      const address = control?.address();
      if (address && typeof address !== "string") f.ports.push(`http://127.0.0.1:${address.port}`);
    });
    return control;
  });
  let notified = 0;
  await assert.rejects(f.start({ temporary: true, onFatalStop: () => { notified += 1; }, testHooks: {
    onEvent: (event) => { if (event.type === "ready") throw new Error("synthetic startup fault"); },
  } }), AggregateError);
  assert.equal(notified, 1);
  assert.equal(ingestionClosed, true);
  assert.equal(control?.listening, false);
  await assert.rejects(lstat(workerRecords.workerPaths(f.home).startup), { code: "ENOENT" });
  assert.ok(await lstat(workerRecords.workerPaths(f.home).lifetime));
});

test("startup exclusion release failure is fatal even when its subsequent cleanup is idempotent", { timeout: 6000 }, async (t) => {
  const f = await libraryFixture(t);
  const acquire = workerRecords.acquireWorkerExclusion;
  const failure = new Error("synthetic startup exclusion release failure");
  let releases = 0;
  t.mock.method(workerRecords, "acquireWorkerExclusion", async (...args: Parameters<typeof acquire>) => {
    const exclusion = await acquire(...args);
    return { ...exclusion, async release() {
      releases += 1;
      await exclusion.release();
      if (releases === 1) throw failure;
    } };
  });
  const createControl = http.createServer;
  t.mock.method(http, "createServer", (...args: Parameters<typeof createControl>) => {
    const server = createControl(...args);
    server.on("listening", () => {
      const address = server.address();
      if (address && typeof address !== "string") f.ports.push(`http://127.0.0.1:${address.port}`);
    });
    return server;
  });
  let notified = 0;
  await assert.rejects(f.start({ temporary: true, onFatalStop: () => { notified += 1; } }), (error: unknown) => error === failure);
  assert.equal(releases, 2, "startup cleanup is attempted even after startup release failed");
  assert.equal(notified, 1);
  assert.equal(await readWorkerRecordOffline(f.home), null);
  await assert.rejects(lstat(workerRecords.workerPaths(f.home).lifetime), { code: "ENOENT" });
});

for (const change of ["configuration", "incarnation"] as const) {
  test(`${change} replacement closes normally without fatal notification`, { timeout: 6000 }, async (t) => {
    const f = await libraryFixture(t);
    let notified = 0;
    let closed = false;
    const worker = await f.start({ temporary: true, onFatalStop: () => { notified += 1; },
      testHooks: { onEvent: (event) => { if (event.type === "closed") closed = true; } } });
    if (change === "configuration") await f.store.configureRuntime(defaultRuntimeConfig());
    else await f.store.quarantineRestore();
    worker.requestWake();
    await waitUntil("normal replacement shutdown", async () => closed, Boolean, 2000);
    await worker.close();
    assert.equal(notified, 0);
  });
}

for (const mode of ["temp-persistence", "temp-cleanup"] as const) {
  test(`actual temporary sync run reports ${mode} as fatal, never success or pending`, { timeout: 10_000 }, async (t) => {
    const f = await libraryFixture(t);
    const cli = launchCli(t, f, ["sync", "run"], mode);
    assert.deepEqual(await cli.completion, { code: 1, signal: null });
    assert.equal(cli.stderr(), `${diagnostic}\n`);
    const result = JSON.parse(cli.stdout());
    assert.equal(result.state, "cancelled");
    assert.equal(result.error, "worker-pass-failed");
    assert.equal(result.reason, undefined);
    assert.equal(cli.stdout().includes("credential-sentinel"), false);
    // Failed cleanup intentionally retains this record; the actual port is closed.
    const record = await readWorkerRecordOffline(f.home);
    if (record) f.ports.push(record.controlOrigin);
  });
}

for (const action of ["stop", "disable", "SIGINT", "SIGTERM", "temporary"] as const) {
  test(`actual ${action} completion has no fatal diagnostic`, { timeout: 10_000 }, async (t) => {
    const f = await libraryFixture(t);
    const cli = launchCli(t, f, action === "temporary" ? ["sync", "run"] : ["sync", "worker", "start", "--foreground"]);
    if (action !== "temporary") {
      await waitUntil("foreground readiness", async () => cli.stdout(), (value) => value.includes('"ready":true'));
      const record = await readWorkerRecordOffline(f.home);
      assert.ok(record);
      f.ports.push(record.controlOrigin);
      if (action === "SIGINT" || action === "SIGTERM") cli.child.kill(action);
      else {
        const stop = launchCli(t, f, ["sync", "worker", action]);
        assert.deepEqual(await stop.completion, { code: 0, signal: null });
        assert.equal(stop.stderr(), "");
      }
    }

    assert.deepEqual(await cli.completion, { code: 0, signal: null });
    assert.equal(cli.stderr(), "");
    assert.equal(await readWorkerRecordOffline(f.home), null);
  });
}

test("actual detached worker captures the sanitized fatal diagnostic in its private log", { timeout: 10_000 }, async (t) => {
  const f = await libraryFixture(t, true);
  const originalSpawn = childProcesses.spawn;
  let retained: ReturnType<typeof childProcesses.spawn> | undefined;
  let completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  t.mock.method(childProcesses, "spawn", (...args: Parameters<typeof originalSpawn>) => {
    retained = originalSpawn(...args);
    const child = retained;
    completion = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    return child;
  });
  const paths = workerRecords.workerPaths(f.home);
  const ledgerPath = path.join(f.home, "sync", "ledger.json");
  let saved: Buffer | undefined;
  let closed = false;
  try {
    await ensureOwnedSyncWorker(f.home, { entryPath: path.join(__dirname, "index.js") });
    assert.ok(retained && completion);
    void completion.then(() => { closed = true; });
    const record = await readWorkerRecordOffline(f.home);
    assert.ok(record);
    f.ports.push(record.controlOrigin);
    await waitUntil("detached pass persisted", () => f.store.snapshot(), (value) => value.worker.lastRunAt !== null);
    saved = await readFile(ledgerPath);
    const target = path.join(f.root, "detached-sentinel");
    await writeFile(target, "synthetic sentinel", { mode: 0o600 });
    await rm(ledgerPath);
    await symlink(target, ledgerPath);
    await waitUntil("retained detached child exits", async () => closed, Boolean, 3000);
    assert.deepEqual(await completion, { code: 1, signal: null });
    const log = await readFile(paths.log, "utf8");
    assert.equal(log.split("\n").filter((line) => line === diagnostic).length, 1);
    assert.equal(log.includes(target), false);
    assert.equal(log.includes("Error:"), false);
    assert.equal(await readFile(target, "utf8"), "synthetic sentinel");
  } finally {
    if (retained && !closed) retained.kill("SIGTERM");
    await completion;
    if (saved) {
      await rm(ledgerPath, { force: true });
      await writeFile(ledgerPath, saved, { mode: 0o600 });
    }

    if (retained?.pid) assert.equal(isPidGone(retained.pid), true);
  }
});

test("disposable failure-sensitive supervisor restarts fatal exit 1 and leaves deliberate exit 0 stopped", { timeout: 10_000 }, async (t) => {
  const f = await libraryFixture(t);
  const ledgerPath = path.join(f.home, "sync", "ledger.json");
  const exits: number[] = [];
  let starts = 0;
  let saved: Buffer | undefined;
  async function supervise() {
    for (;;) {
      const cli = launchCli(t, f, ["sync", "worker", "start", "--foreground"]);
      starts += 1;
      await waitUntil("supervised worker readiness", async () => cli.stdout(), (value) => value.includes('"ready":true'));
      const record = await readWorkerRecordOffline(f.home);
      assert.ok(record);
      f.ports.push(record.controlOrigin);
      if (starts === 1) {
        await waitUntil("supervised initial pass persisted", () => f.store.snapshot(), (value) => value.worker.lastRunAt !== null);
        saved = await readFile(ledgerPath);
        const target = path.join(f.root, "supervisor-sentinel");
        await writeFile(target, "supervisor synthetic sentinel", { mode: 0o600 });
        await rm(ledgerPath);
        await symlink(target, ledgerPath);
      } else {
        await contactWorker(f.home, "stop");
      }

      const exit = await cli.completion;
      assert.equal(exit.signal, null);
      assert.ok(exit.code !== null);
      exits.push(exit.code);
      if (exit.code === 0) {
        assert.equal(cli.stderr(), "");
        return;
      }

      assert.equal(cli.stderr(), `${diagnostic}\n`);
      assert.equal(starts, 1, "supervisor restart count stays bounded");
      assert.ok(saved);
      await rm(ledgerPath);
      await writeFile(ledgerPath, saved, { mode: 0o600 });
    }
  }

  try {
    await supervise();
    assert.deepEqual(exits, [1, 0]);
    assert.equal(starts, 2);
    assert.equal(await readFile(path.join(f.root, "supervisor-sentinel"), "utf8"), "supervisor synthetic sentinel");
  } finally {
    if (saved) {
      await rm(ledgerPath, { force: true });
      await writeFile(ledgerPath, saved, { mode: 0o600 });
    }
  }
});

test("actual ready foreground worker exits unsuccessfully on an unsafe ledger without opening it", { timeout: 15_000 }, async (t) => {
  const f = await createWorkerFixture(t);
  const selected = await f.inbox("fatal");
  const tls = await createSyncHttpsCredentials(t);
  const ingestionPort = await availablePort();
  await f.configure(selected, { ...defaultRuntimeConfig(), listener: { host: "127.0.0.1", port: ingestionPort, tlsRef: "server" },
    tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } });
  await selected.store.setWorkerEnabled(true);

  const child = spawn(process.execPath, ["--require", path.join(__dirname, "sync-worker-fatal-child.js"), path.join(__dirname, "index.js"),
    "sync", "worker", "start", "--foreground", "--home", selected.home, "--json"], {
    cwd: f.root, env: { ...f.env, HTML_INBOX_FATAL_FIXTURE: "observe-ledger" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  let stdout = "";
  let stderr = "";
  let closed = false;
  assert.ok(child.stdout && child.stderr);
  child.stdout.on("data", (value: Buffer) => { stdout += value.toString(); });
  child.stderr.on("data", (value: Buffer) => { stderr += value.toString(); });
  child.on("message", (value: unknown) => messages.push(value));
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  const ledgerPath = path.join(selected.home, "sync", "ledger.json");
  let saved: Buffer | undefined;
  let controlOrigin: string | undefined;
  try {
    await waitUntil("foreground JSON readiness", async () => stdout, (value) => value.includes('"ready":true'));
    const record = await readWorkerRecordOffline(selected.home);
    assert.ok(record);
    controlOrigin = record.controlOrigin;
    await waitUntil("initial pass persistence", () => selected.store.snapshot(), (value) => value.worker.lastRunAt !== null);
    saved = await readFile(ledgerPath);
    const target = path.join(f.root, "synthetic-unsafe-target");
    const sentinel = "synthetic target must remain unchanged";
    await writeFile(target, sentinel, { mode: 0o600 });
    await rm(ledgerPath);
    await symlink(target, ledgerPath);

    await waitUntil("fatal child exit", async () => closed, Boolean, 3000);
    assert.deepEqual(await completion, { code: 1, signal: null });
    assert.equal(stderr.split("\n").filter((line) => line === diagnostic).length, 1);
    assert.equal(stderr.includes(target), false);
    assert.equal(stderr.includes("Error:"), false);
    assert.equal(messages.filter((value) => JSON.stringify(value).includes('"type":"unsafe-observed"')).length, 1);
    assert.equal(messages.filter((value) => JSON.stringify(value).includes('"type":"unsafe-open"')).length, 0);
    assert.equal(await readFile(target, "utf8"), sentinel);
  } finally {
    if (!closed) child.kill("SIGTERM");
    await completion;
    if (saved) {
      await rm(ledgerPath, { force: true });
      await writeFile(ledgerPath, saved, { mode: 0o600 });
    }

    assert.ok(child.pid);
    assert.equal(isPidGone(child.pid), true);
    if (controlOrigin) await assertLoopbackClosed(controlOrigin);
    await assertLoopbackClosed(`https://127.0.0.1:${ingestionPort}`);
    t.diagnostic("retained foreground child reaped; exact control and ingestion ports rebound; unsafe target unchanged");
  }
});
