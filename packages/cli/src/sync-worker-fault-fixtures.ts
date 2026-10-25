import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { canonicalKey, parseBoolean, parseInteger, parseObject, parseString, parseUuid } from "./sync-model";
import type { SyncRoute } from "./sync-model";
import { parseReceipt } from "./sync-ledger";
import { createSyncHttpsCredentials, startSyncHttpsProxy } from "./sync-https-fixtures";
import type { SyncFixtureFault } from "./sync-https-fixtures";
import { assertLoopbackClosed, startSyncApplication } from "./sync-protocol-fixture";
import { ManagedSyncStore } from "./sync-store";
import type { SyncRuntimeConfig } from "./sync-runtime-config";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { availablePort } from "./test-fixtures";
import { startOwnedSyncWorker } from "./sync-worker";
import { readPrivateFile } from "./sync-files";

export const syntheticBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>worker fixture π</body></html>\r\n");

export async function waitUntil<T>(description: string, observe: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await observe();
    if (ready(value)) {
      return value;
    }

    await delay(20);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

export function objectField(value: Record<string, unknown>, name: string) {
  return parseObject(value[name], `CLI ${name}`);
}

export function parsePublication(value: unknown) {
  const result = parseObject(value, "managed publication");
  const document = objectField(result, "document");
  const local = objectField(result, "local");
  const viewer = objectField(result, "viewer");
  const delivery = objectField(result, "delivery");
  const onward = objectField(result, "onward");
  assert.equal(result.command, "publish");
  assert.equal(result.schemaVersion, 1);
  assert.equal(onward.awaited, false);

  return {
    document: { localId: parseString(document.localId), originInboxId: parseUuid(document.originInboxId),
      originDocumentId: parseString(document.originDocumentId), fingerprint: parseString(document.fingerprint) },
    local: { durable: parseBoolean(local.durable), queued: parseBoolean(local.queued) },
    viewer: { url: viewer.url, state: parseString(viewer.state), error: viewer.error },
    delivery: { state: parseString(delivery.state), target: delivery.target, reason: delivery.reason,
      receipt: delivery.receipt === null ? null : parseReceipt(delivery.receipt),
      cancelled: parseBoolean(delivery.cancelled), retriesEnabled: parseBoolean(delivery.retriesEnabled) },
    worker: objectField(result, "worker"), onward: { awaited: false },
  };
}

export async function writePrivateJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

export async function createWorkerFixture(t: TestContext, options: { observeViewerStop?: boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-worker-fault-")));
  const catalog = path.join(root, "catalog");
  const viewerPorts = new Set<number>();
  const workerPorts = new Set<number>();
  const runtimePids = new Set<number>();
  const resources: (() => Promise<unknown>)[] = [];
  const selectedViewerPorts = new Map<string, number>();
  const ownedCli = new Set<ReturnType<typeof launch>>();
  let launchedCli = 0;
  let reapedCli = 0;
  const inboxes: { name: string; home: string; store: ManagedSyncStore }[] = [];
  const observesViewerStop = options.observeViewerStop === true ||
    t.name === "receiver worker independently pulls periodically while source push is paused and both viewers are stopped";
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C.UTF-8",
    HOME: root, USERPROFILE: root, HTML_INBOX_CATALOG_HOME: catalog,
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: root, TMP: root, TEMP: root, ZDOTDIR: root,
  };

  t.after(async () => {
    const failures: unknown[] = [];
    for (const cli of ownedCli) {
      try { await cli.stop(); } catch (error) { failures.push(error); }
    }

    for (const inbox of inboxes) {
      try {
        const stopped = await run(["sync", "worker", "disable", "--inbox", inbox.name, "--json"]);
        if (stopped.code !== 0 && await exists(path.join(inbox.home, "sync", "worker", "runtime.json"))) {
          throw new Error(`Worker cleanup blocked: ${stopped.stderr} ${stopped.stdout}`);
        }
      } catch (error) { failures.push(error); }

      try { await run(["viewer", "stop", "--inbox", inbox.name, "--json"]); } catch (error) { failures.push(error); }
    }

    for (const close of resources.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }

    for (const pid of runtimePids) {
      try { await waitUntil(`owned runtime ${pid} exit`, async () => isPidGone(pid), Boolean); } catch (error) { failures.push(error); }
    }

    for (const port of [...viewerPorts, ...workerPorts]) {
      try { await assertLoopbackClosed(`http://127.0.0.1:${port}`); } catch (error) { failures.push(error); }
    }

    await rm(root, { recursive: true, force: true });
    assert.equal(await exists(root), false, "fixture homes, catalog and credentials removed");
    assert.equal(reapedCli, launchedCli, "every directly owned CLI process closed and was reaped");
    t.diagnostic(`${reapedCli} owned CLI children reaped; ${runtimePids.size} runtime PIDs absent; ${viewerPorts.size + workerPorts.size} ports rebound; synthetic root removed`);
    if (failures.length) throw new AggregateError(failures, "Worker fixture cleanup failed");
  });

  function launch(args: string[], options: { entry?: string; timeoutMs?: number } = {}) {
    const selectedName = args[args.indexOf("--inbox") + 1];
    const viewerPort = selectedName ? selectedViewerPorts.get(selectedName) : undefined;
    const binding = args.filter((arg) => arg === "--inbox").length === 1
      ? inboxes.find((entry) => entry.name === selectedName && entry.home === path.join(root, selectedName)) : undefined;
    const preload = options.entry === undefined && args[0] === "viewer" && args[1] === "stop" && binding && observesViewerStop
      ? ["--require", path.join(__dirname, "viewer-record-observation-child.js")]
      : [];
    const child = spawn(process.execPath, [...preload, options.entry ?? path.join(__dirname, "index.js"), ...args], {
      cwd: root, env: { ...env, HTML_INBOX_PORT: String(viewerPort ?? 1) }, stdio: ["ignore", "pipe", "pipe"],
    });
    launchedCli += 1;
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let closed = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { spawnError = error; });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("close", (code, signal) => {
        closed = true;
        reapedCli += 1;
        clearTimeout(timer);
        if (spawnError) reject(spawnError);
        else resolve({ code, signal, stdout, stderr });
      });
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, options.timeoutMs ?? 20_000);
    const managed = {
      child, completion,
      async stop() {
        if (!closed) child.kill("SIGTERM");

        await completion;
        assert.equal(child.exitCode !== null || child.signalCode !== null, true);
        if (child.pid) assert.equal(isPidGone(child.pid), true, "owned CLI child was reaped");
      },
    };
    ownedCli.add(managed);
    void completion.then(() => ownedCli.delete(managed), () => ownedCli.delete(managed));
    return managed;
  }

  async function run(args: string[], expectedCode?: number) {
    const result = await launch(args).completion;
    if (expectedCode !== undefined && result.code !== expectedCode && args[0] === "sync" && args[1] === "worker" && args.filter((arg) => arg === "--inbox").length === 1) {
      const selected = inboxes.find((inbox) => inbox.name === args[args.indexOf("--inbox") + 1]);
      if (selected) {
        try {
          const log = await readPrivateFile(path.join(selected.home, "sync", "worker", "worker.log"), 16 * 1024);
          const messages = log.toString("utf8").split("\n").filter((line) =>
            (line.startsWith("html-inbox: ") && !line.startsWith("html-inbox: Inbox ")) || line.startsWith('{"type":"credential-startup-failure",'));

          // Worker logs can contain private paths and error text. Emit only fingerprints and fixed errno hints.
          const failures = messages.slice(-4).map((line) => ({
            messageSHA256: createHash("sha256").update(line.replace(/^html-inbox: /, "")).digest("hex"),
            errnoHints: ["EADDRINUSE", "EADDRNOTAVAIL", "EACCES", "EPERM", "ENOENT", "EIO", "ENOSPC", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ABORT_ERR"].filter((code) => line.includes(code)),
          }));
          t.diagnostic(JSON.stringify({ workerCommandFailure: selected.name, logBytes: log.length, failures }));
        } catch {
          t.diagnostic(JSON.stringify({ workerCommandFailure: selected.name, logAvailable: false }));
        }
      }
    }

    if (expectedCode !== undefined) assert.equal(result.code, expectedCode, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  async function json(args: string[], expectedCode = 0) {
    const result = await run([...args, "--json"], expectedCode);
    const parsed = parseObject(JSON.parse(result.stdout), "CLI result");
    if (args[0] === "sync") {
      const name = args[args.indexOf("--inbox") + 1];
      const selected = inboxes.find((entry) => entry.name === name);
      if (selected && await exists(path.join(selected.home, "sync", "worker", "runtime.json"))) await rememberWorker(selected);
    }

    return parsed;
  }

  async function inbox(name: string, enroll = true) {
    const home = path.join(root, name);
    selectedViewerPorts.set(name, await availablePort());
    await run(["inbox", "create", name, "--home", home], 0);
    const store = new ManagedSyncStore(home);
    const selected = { name, home, store };
    inboxes.push(selected);
    if (enroll) await json(["sync", "enroll", "--inbox", name, "--yes"]);
    return selected;
  }

  async function configure(selected: { name: string }, config: SyncRuntimeConfig) {
    const file = await writePrivateJson(path.join(root, `${randomUUID()}.json`), config);
    return json(["sync", "configure", "--inbox", selected.name, "--config", file]);
  }

  async function rememberWorker(selected: { home: string }) {
    const record = parseObject(JSON.parse(await readFile(path.join(selected.home, "sync", "worker", "runtime.json"), "utf8")), "owned worker record");
    assert.equal(typeof record.pid, "number");
    if (typeof record.pid !== "number") throw new Error("Missing owned worker PID");

    runtimePids.add(record.pid);
    workerPorts.add(Number(new URL(parseString(record.controlOrigin)).port));
    return { ...record, pid: record.pid, processId: parseUuid(record.processId), controlOrigin: parseString(record.controlOrigin) };
  }

  async function publish(selected: { name: string }, extra: string[] = [], expectedCode = 0) {
    const args = await publicationArgs(selected, extra);
    const result = await json(args, expectedCode);
    await rememberViewer(selected);
    return parsePublication(result);
  }

  async function publicationArgs(selected: { name: string }, extra: string[] = []) {
    const file = path.join(root, `${randomUUID()}.html`);
    await writeFile(file, syntheticBytes, { mode: 0o600 });
    return ["publish", file, "--title", "Worker fixture", "--type", "report", "--inbox", selected.name, ...extra];
  }

  async function rememberViewer(selected: { name: string }) {
    const status = await json(["viewer", "status", "--inbox", selected.name]);
    if (typeof status.pid === "number") runtimePids.add(status.pid);
    if (typeof status.port === "number") viewerPorts.add(status.port);
    return status;
  }

  return { root, env, inboxes, resources, run, json, launch, inbox, configure, rememberWorker, rememberViewer, publicationArgs, publish };
}

export type WorkerFixture = Awaited<ReturnType<typeof createWorkerFixture>>;
export type FixtureInbox = Awaited<ReturnType<WorkerFixture["inbox"]>>;

export async function exists(file: string) {
  try { await lstat(file); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function isPidGone(pid: number) {
  try { process.kill(pid, 0); return false; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}

export async function createCliPair(t: TestContext, faults: SyncFixtureFault[] = []) {
  const f = await createWorkerFixture(t);
  const tls = await createSyncHttpsCredentials(t);
  const source = await f.inbox("source");
  const destination = await f.inbox("destination");
  const a = await source.store.snapshot();
  const b = await destination.store.snapshot();
  const token = randomBytes(48).toString("base64url");
  const tokenPath = path.join(f.root, "token");
  await writeFile(tokenPath, token, { mode: 0o600 });
  const server = await startSyncApplication(t, { home: destination.home, peerId: b.inboxId, ...tls.trusted, token });
  f.resources.push(() => server.stop());
  const proxy = await startSyncHttpsProxy(t, {
    upstreamUrl: server.url, upstreamCaPath: tls.caPath, server: tls.trusted, directory: tls.directory,
    requestTimeoutMs: 15_000, maxLifetimeMs: 180_000,
    routes: ["identity", "manifest", "holdings", "offer", "body"].map((name) => ({ label: name, pathname: `/sync/v1/${name}` })), faults,
  });
  f.resources.push(async () => {
    await proxy.stop();
    assert.equal(isPidGone(proxy.pid), true);
    await assertLoopbackClosed(proxy.url);
    t.diagnostic(`proxy child ${proxy.pid}: reaped; loopback port rebound`);
  });
  const sourceConfig: SyncRuntimeConfig = {
    schemaVersion: 1, intendedTarget: { peerId: b.inboxId, destinationInboxId: b.inboxId }, listener: null,
    timings: { foregroundMs: 10_000, requestMs: 5000, reconcileMs: 1000, passMs: 15_000 },
    credentials: { token: tokenPath }, trust: { ca: tls.caPath }, tls: {},
  };
  await f.configure(source, sourceConfig);
  await f.configure(destination, { ...sourceConfig, intendedTarget: null });
  const grant = a.originKeys.find((entry) => entry.inboxId === a.inboxId);
  assert.ok(grant);
  const route: SyncRoute = {
    id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: proxy.url,
    sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: source.name,
    readerAudience: "synthetic private fixture", allowedOrigins: [grant], credentialRef: "token", tlsTrustRef: "ca", state: "reconnecting", lastError: null,
  };

  async function mappingFile(value: SyncRoute, expectedRevision = 0) {
    const { revision, state, lastError, ...fields } = value;
    return writePrivateJson(path.join(f.root, `${randomUUID()}.mapping.json`), { schemaVersion: 1, expectedRevision, route: fields });
  }

  async function addRoute(selected: FixtureInbox, value: SyncRoute) {
    const file = await mappingFile(value);
    return f.json(["sync", "mapping", "add", "--inbox", selected.name, "--config", file]);
  }

  await addRoute(source, route);
  await addRoute(destination, { ...route, direction: "inbound", peerId: a.inboxId, peerUrl: "https://127.0.0.1:1", localInboxName: destination.name });
  await f.json(["sync", "run", "--inbox", source.name]);
  return { ...f, source, destination, sourceId: a.inboxId, destinationId: b.inboxId, tls, server, proxy, route, sourceConfig, mappingFile, addRoute };
}

export async function createOwnedPullPair(t: TestContext) {
  const f = await createWorkerFixture(t);
  const tls = await createSyncHttpsCredentials(t);
  const source = await f.inbox("source");
  const destination = await f.inbox("destination");
  const a = await source.store.snapshot();
  const b = await destination.store.snapshot();
  const tokenPath = path.join(f.root, "token");
  await writeFile(tokenPath, randomBytes(48).toString("base64url"), { mode: 0o600 });
  const sourcePort = await availablePort();
  const destinationPort = await availablePort();
  const sourceUrl = `https://127.0.0.1:${sourcePort}`;
  const destinationUrl = `https://127.0.0.1:${destinationPort}`;
  const config: SyncRuntimeConfig = {
    ...defaultRuntimeConfig(),
    listener: { host: "127.0.0.1", port: sourcePort, tlsRef: "listener" },
    credentials: { token: tokenPath }, trust: { ca: tls.caPath }, tls: { listener: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } },
    timings: { foregroundMs: 1000, requestMs: 3000, reconcileMs: 1000, passMs: 10_000 },
  };
  const sourceConfig = { ...config, intendedTarget: { peerId: b.inboxId, destinationInboxId: b.inboxId } };
  const destinationConfig = { ...config, listener: { host: "127.0.0.1", port: destinationPort, tlsRef: "listener" } };
  await f.configure(source, sourceConfig);
  await f.configure(destination, destinationConfig);
  const grant = a.originKeys.find((origin) => origin.inboxId === a.inboxId);
  assert.ok(grant);
  const route = {
    id: randomUUID(), direction: "outbound", peerId: b.inboxId, peerUrl: destinationUrl, sourceInboxId: a.inboxId,
    destinationInboxId: b.inboxId, localInboxName: source.name, readerAudience: "synthetic private fixture",
    allowedOrigins: [grant], credentialRef: "token", tlsTrustRef: "ca",
  };
  const outboundFile = await writePrivateJson(path.join(f.root, "outbound.json"), { schemaVersion: 1, expectedRevision: 0, route });
  const inboundFile = await writePrivateJson(path.join(f.root, "inbound.json"), {
    schemaVersion: 1, expectedRevision: 0, route: { ...route, direction: "inbound", peerId: a.inboxId, peerUrl: sourceUrl, localInboxName: destination.name },
  });
  await f.json(["sync", "mapping", "add", "--inbox", source.name, "--config", outboundFile]);
  await f.json(["sync", "mapping", "add", "--inbox", destination.name, "--config", inboundFile]);
  f.resources.push(async () => { await assertLoopbackClosed(sourceUrl); await assertLoopbackClosed(destinationUrl); });
  return { ...f, source, destination, sourceId: a.inboxId, destinationId: b.inboxId, route, sourceUrl, destinationUrl, sourceConfig, destinationConfig };
}

export async function onlyOriginal(selected: FixtureInbox) {
  const ledger = await selected.store.snapshot();
  const records = Object.values(ledger.records).filter((record) => record.originInboxId === ledger.inboxId);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  return { ledger, record, key: canonicalKey(record.originInboxId, record.originDocumentId) };
}

export async function assertReceiverCommitted(destination: FixtureInbox, sourceId: string, documentId: string) {
  const ledger = await destination.store.snapshot();
  const record = ledger.records[canonicalKey(sourceId, documentId)];
  assert.ok(record);
  const stored = await destination.store.getDocument(record.localId);
  assert.ok(stored, "real receiver exposes a durably installed body");
  assert.deepEqual(stored.originalBytes, syntheticBytes);
  const receipts = Object.values(ledger.receipts).filter((receipt) => receipt.originState.originInboxId === sourceId && receipt.originState.originDocumentId === documentId);
  assert.ok(receipts.some((receipt) => receipt.disposition === "committed"), "custody comes from receiver durable commit");
  return { ledger, record, receipts };
}

export async function startRecordingEndpoint(f: WorkerFixture) {
  let requests = 0;
  const server = http.createServer((_request, response) => { requests += 1; response.writeHead(503); response.end(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  f.resources.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await assertLoopbackClosed(url);
  });
  return { url, get requests() { return requests; } };
}

export async function startOwnedSentinel(f: WorkerFixture) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.send({ready:true});"], {
    cwd: f.root, env: f.env, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  f.resources.push(async () => {
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Sentinel did not reap")), 3000); })]);
    } finally {
      clearTimeout(timer);
    }

    if (child.pid) assert.equal(isPidGone(child.pid), true);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Sentinel readiness timed out")), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.ok(child.pid);
  return { child, pid: child.pid };
}

export async function startClockWorker(f: WorkerFixture, home: string) {
  const child = spawn(process.execPath, [__filename, "--worker-clock-fixture", home], {
    cwd: f.root, env: f.env, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Record<string, unknown>[] = [];
  let stderr = "";
  let closed = false;
  assert.ok(child.stderr);
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("message", (value: unknown) => { messages.push(parseObject(value, "clock worker IPC")); });
  const exited = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
  f.resources.push(async () => {
    if (!closed && child.connected) child.send({ type: "stop" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Clock worker cleanup timed out: ${stderr}`)); }, 5000); })]);
    } finally {
      clearTimeout(timer);
    }

    if (child.pid) assert.equal(isPidGone(child.pid), true);
  });
  await waitUntil("actual clock worker readiness", async () => {
    if (closed) throw new Error(`Clock worker exited before readiness: ${stderr}`);
    return messages;
  }, (events) => events.some((event) => event.type === "ready"));
  await f.rememberWorker({ home });

  return {
    messages,
    async gap() {
      assert.equal(messages.filter((message) => message.type === "gap").length, 0);
      child.send({ type: "advance", milliseconds: 5000 });
      await waitUntil("one injected scheduling gap", async () => messages, (events) => events.some((event) => event.type === "gap"));
      assert.equal(messages.filter((message) => message.type === "gap").length, 1);
    },
  };
}

async function runClockWorker() {
  const home = parseString(process.argv[3], "synthetic clock worker home");
  assert.equal(await realpath(home), home);
  let wallOffset = 0;
  const worker = await startOwnedSyncWorker(home, { testHooks: {
    wallNow: () => Date.now() + wallOffset,
    onEvent: (event) => { process.send?.(event); },
  } });
  const lifetime = setTimeout(() => process.exit(90), 120_000);
  lifetime.unref();
  process.on("message", (value: unknown) => {
    const command = parseObject(value, "clock worker command");
    void (async () => {
      if (command.type === "advance") {
        wallOffset += parseInteger(command.milliseconds, 3000, 60_000);
        await worker.tick();
      }

      if (command.type === "stop") {
        await worker.close();
        process.disconnect?.();
      }
    })().catch((error: unknown) => { process.stderr.write(String(error)); process.exitCode = 1; void worker.close().finally(() => process.disconnect?.()); });
  });
  process.on("disconnect", () => { void worker.close(); });
}

if (process.argv[2] === "--worker-clock-fixture") {
  void runClockWorker().catch((error: unknown) => { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect?.(); });
}
