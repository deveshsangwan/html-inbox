import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { readFile } from "node:fs/promises";
import { mock } from "node:test";
import net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { createSyncIngestionServer } from "./sync-http-server";
import { parseChoice, parseInteger, parseObject, parseString, parseUuid } from "./sync-model";
import { ManagedSyncStore } from "./sync-store";
import type { StorageEvent } from "./sync-files";

export interface ApplicationFixtureOptions {
  home: string;
  peerId: string;
  keyPath: string;
  certPath: string;
  token: string;
  port?: number;
  requestMs?: number;
  leaseMs?: number;
}

export async function assertLoopbackClosed(url: string): Promise<void> {
  const port = Number(new URL(url).port);
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
}

export async function startSyncApplication(t: Pick<TestContext, "after" | "diagnostic">, options: ApplicationFixtureOptions) {
  const child = spawn(process.execPath, [__filename, "--sync-server-fixture"], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: process.env.PATH, HOME: options.home, XDG_CONFIG_HOME: options.home, ZDOTDIR: options.home } });
  let diagnostic = "";
  child.on("error", (error) => { diagnostic += error.message; });
  child.stderr?.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  const messages: Record<string, unknown>[] = [];
  let exited = false;
  const closed = new Promise<void>((resolve) => child.once("close", () => { exited = true; resolve(); }));
  child.on("message", (value: unknown) => messages.push(parseObject(value, "application fixture IPC")));
  let sequence = 0;
  let url: string | undefined;
  let cleanupVerified = false;

  async function waitFor(type: string, id?: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const message = messages.find((message) => message.type === type && (id === undefined || message.id === id));
      if (message) return message;
      const error = messages.find((message) => message.type === "error");
      if (error || exited) throw new Error(`Application fixture stopped: ${JSON.stringify(error)} ${diagnostic}`);
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }

    throw new Error(`Application fixture timed out at ${type}: ${diagnostic}`);
  }

  async function command(value: Record<string, unknown>) {
    const id = ++sequence;
    if (!child.connected) throw new Error("Application fixture IPC is closed");
    await new Promise<void>((resolve, reject) => child.send({ ...value, id }, (error) => error ? reject(error) : resolve()));
    return waitFor("reply", id);
  }

  async function stop(kill = false) {
    if (!exited) {
      if (kill) child.kill("SIGKILL");
      else await command({ type: "stop" }).catch(() => child.kill("SIGKILL"));
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Application fixture failed to reap")), 5000); })]);
    } finally {
      clearTimeout(timer);
    }

    assert.equal(child.connected, false);
    if (child.pid) assert.throws(() => process.kill(child.pid ?? 0, 0), { code: "ESRCH" });
    if (url && !cleanupVerified) await assertLoopbackClosed(url);
    cleanupVerified = true;
  }

  t.after(async () => {
    await stop();
    t.diagnostic(`application child ${child.pid}: reaped; loopback port rebound`);
  });
  child.send({ type: "start", ...options });
  const ready = await waitFor("ready");
  url = parseString(ready.url);
  return { url, pid: child.pid, messages, waitFor, command, stop };
}

async function runApplicationFixture() {
  const [message] = await once(process, "message");
  const configuration = parseObject(message, "application fixture configuration");
  const home = parseString(configuration.home);
  const peerId = parseUuid(configuration.peerId);
  const key = await readFile(parseString(configuration.keyPath));
  const cert = await readFile(parseString(configuration.certPath));
  const token = parseString(configuration.token);
  let armed: StorageEvent | undefined;
  let stageLeaseGap = false;
  let release: (() => void) | undefined;
  let failSyncAtRename = false;
  let failSync = false;
  const originalOpen = fs.open;
  mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === path.join(home, "sync")) {
      const sync = handle.sync;
      mock.method(handle, "sync", async () => {
        if (failSync) {
          failSync = false;
          process.send?.({ type: "fsync-failed", hits: 1 });
          throw Object.assign(new Error("Synthetic directory fsync EIO"), { code: "EIO" });
        }

        return sync.call(handle);
      });
    }

    return handle;
  });
  const store = new ManagedSyncStore(home, { testHooks: { async onEvent(event) {
    if (event === "ledger-renamed" && failSyncAtRename) {
      failSyncAtRename = false;
      failSync = true;
    }

    if (event !== armed) return;
    if (stageLeaseGap) {
      const names = await fs.readdir(path.join(home, "sync", "staging"));
      if (!names.some((name) => name.endsWith(".stage.lease") && !names.includes(name.slice(0, -6)))) {
        return;
      }
    }

    armed = undefined;
    stageLeaseGap = false;
    process.send?.({ type: "fault", event, hits: 1 });
    await new Promise<void>((resolve) => { release = resolve; });
  } } });
  await store.recover();
  const server = createSyncIngestionServer({ store, peerId, key, cert, host: "127.0.0.1", credentials: () => ({ token }),
    port: configuration.port === undefined ? 0 : parseInteger(configuration.port, 0, 65535),
    requestMs: configuration.requestMs === undefined ? 5000 : parseInteger(configuration.requestMs, 1, 60_000),
    leaseMs: configuration.leaseMs === undefined ? 60_000 : parseInteger(configuration.leaseMs, 1, 60_000) });
  const lifetime = setTimeout(() => process.exit(90), 180_000);
  lifetime.unref();
  process.on("disconnect", () => { void server.close().finally(() => process.exit(0)); });
  process.on("message", (value: unknown) => {
    const message = parseObject(value, "fixture command");
    void (async () => {
      if (message.type === "arm") {
        armed = parseChoice<StorageEvent>(message.event, ["directory-created", "directory-flushed", "migration-intent", "migration-evacuated", "migration-barrier", "migration-enumeration", "body-staged", "body-flushed", "body-installed", "body-directory-flushed", "ledger-temp-written", "ledger-temp-fsynced", "ledger-renamed", "ledger-dir-fsynced", "committed-before-receipt", "receipt-before-retirement"]);
        stageLeaseGap = false;
      }

      if (message.type === "arm-stage-lease-gap") {
        armed = "directory-flushed";
        stageLeaseGap = true;
      }
      if (message.type === "release") release?.();
      if (message.type === "fail-directory-sync") failSyncAtRename = true;
      if (message.type === "revoke") await store.revokeRoute(parseUuid(message.routeId), parseInteger(message.revision, 1));
      if (message.type === "status") {
        process.send?.({ type: "reply", id: message.id, status: server.status(), counters: store.counters });
        return;
      }

      if (message.type === "stop") {
        await server.close();
        process.send?.({ type: "reply", id: message.id }, () => { process.disconnect?.(); });
        return;
      }

      process.send?.({ type: "reply", id: message.id });
    })().catch((error: unknown) => { process.send?.({ type: "error", message: error instanceof Error ? error.message : "fixture error" }); });
  });
  process.send?.({ type: "ready", ...(await server.start()) });
}

if (process.argv.includes("--sync-server-fixture")) {
  void runApplicationFixture().catch((error: unknown) => { process.send?.({ type: "error", message: error instanceof Error ? error.message : "fixture startup error" }); process.exitCode = 1; process.disconnect?.(); });
}
