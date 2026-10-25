import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import * as locks from "./sync-files";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { createSyncIngestionServer } from "./sync-http-server";
import type { SyncRoute } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { ManagedSyncStore } from "./sync-store";
import { opaqueToken } from "./sync-wire";

export function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export async function reached<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Missed attempt lifetime predicate: ${label}`)), 3000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function lifetimeFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-attempt-lifetime-"));
  const cleanup: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }

    if (failures.length) throw new AggregateError(failures, "Attempt lifetime fixture did not drain");

    await rm(root, { recursive: true, force: true });
  });
  const sourceHome = path.join(root, "source");
  const receiverHome = path.join(root, "receiver");
  const source = new ManagedSyncStore(sourceHome);
  const receiver = new ManagedSyncStore(receiverHome);
  await source.enroll();
  await receiver.enroll();
  const a = await source.snapshot();
  const b = await receiver.snapshot();
  const token = opaqueToken();
  let credentials: Awaited<ReturnType<typeof createSyncHttpsCredentials>> | undefined;

  async function listen(store: ManagedSyncStore, requestMs = 1000) {
    credentials ??= await createSyncHttpsCredentials({ after(close) {
      if (close) cleanup.push(async () => { await close(t, () => {}); });
    } });
    const ca = await readFile(credentials.caPath);
    const server = createSyncIngestionServer({ store, peerId: (await store.snapshot()).inboxId,
      credentials: () => ({ token }), host: "127.0.0.1", requestMs,
      key: await readFile(credentials.trusted.keyPath), cert: await readFile(credentials.trusted.certPath) });
    const { url } = await server.start();
    cleanup.push(async () => { await server.close(); await assertLoopbackClosed(url); });
    return { server, url, ca };
  }

  async function connect(receiverUrl = "https://127.0.0.1:1", sourceUrl = "https://127.0.0.1:1") {
    const route: SyncRoute = { id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId,
      peerUrl: receiverUrl, sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: "fixture",
      readerAudience: "synthetic", allowedOrigins: a.originKeys, credentialRef: "fixture", tlsTrustRef: "fixture",
      state: "reconnecting", lastError: null };
    const outbound = await source.configureRoute(route);
    const inbound = await receiver.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId, peerUrl: sourceUrl });
    return { outbound, inbound };
  }

  return { root, sourceHome, receiverHome, source, receiver, a, b, token, cleanup, listen, connect };
}

export interface WatcherCheck {
  id: number;
  store: ManagedSyncStore;
  attempt: number;
  signal?: AbortSignal;
  acquired: boolean;
  settled: boolean;
  error?: unknown;
}

export function observeWatchers(t: TestContext, f: Awaited<ReturnType<typeof lifetimeFixture>>) {
  const attemptScope = new AsyncLocalStorage<{ id: number; store: ManagedSyncStore }>();
  const checkScope = new AsyncLocalStorage<WatcherCheck>();
  const checks: WatcherCheck[] = [];
  const pending = new Set<Promise<unknown>>();
  const attempts: Array<{ id: number; store: ManagedSyncStore; value: Awaited<ReturnType<ManagedSyncStore["openRouteAttempt"]>> }> = [];
  const hooks: {
    beforeEnqueue?: (check: WatcherCheck) => void | Promise<void>;
    enqueued?: (check: WatcherCheck) => void;
    protected?: (check: WatcherCheck) => void | Promise<void>;
    timer?: (store: ManagedSyncStore, deliver: () => void) => void;
    closing?: (id: number, store: ManagedSyncStore, result: ReturnType<Awaited<ReturnType<ManagedSyncStore["openRouteAttempt"]>>["close"]>) => void;
  } = {};
  let sequence = 0;
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: () => void, milliseconds?: number) => {
    const attempt = attemptScope.getStore();
    if (milliseconds !== 50 || !attempt) return nativeInterval(callback, milliseconds);

    return nativeInterval(() => {
      const check: WatcherCheck = { id: ++sequence, store: attempt.store, attempt: attempt.id, acquired: false, settled: false };
      const deliver = () => checkScope.run(check, callback);
      if (hooks.timer) hooks.timer(attempt.store, deliver);
      else deliver();
    }, milliseconds);
  });
  for (const store of [f.source, f.receiver]) {
    const open = store.openRouteAttempt.bind(store);
    t.mock.method(store, "openRouteAttempt", async (...args: Parameters<typeof open>) => {
      const id = ++sequence;
      const value = await attemptScope.run({ id, store }, () => open(...args));
      const close = value.close;
      value.close = () => { const result = close(); hooks.closing?.(id, store, result); return result; };
      attempts.push({ id, store, value });
      return value;
    });
  }

  const withLock = locks.withStoreLock;
  t.mock.method(locks, "withStoreLock", async <T>(directory: string, deadlineMs: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const check = checkScope.getStore();
    if (!check) return withLock(directory, deadlineMs, operation, signal);

    check.signal = signal;
    checks.push(check);
    const running = (async () => {
      await hooks.beforeEnqueue?.(check);
      const locked = withLock(directory, deadlineMs, async () => {
        check.acquired = true;
        await hooks.protected?.(check);
        return operation();
      }, signal);
      hooks.enqueued?.(check);
      return locked;
    })();
    pending.add(running);
    void running.then(() => { check.settled = true; pending.delete(running); }, (error: unknown) => {
      check.settled = true;
      check.error = error;
      pending.delete(running);
    });
    return running;
  });
  f.cleanup.push(async () => {
    const results = await Promise.allSettled(attempts.map((attempt) => attempt.value.close()));
    await Promise.allSettled([...pending]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Attempt cleanup rejected");
  });

  return { hooks, checks, attempts, current: () => checkScope.getStore(), pending };
}

export function holdWatcherRelease(t: TestContext, f: Awaited<ReturnType<typeof lifetimeFixture>>,
  observer: ReturnType<typeof observeWatchers>, store: ManagedSyncStore) {
  const entered = latch();
  const release = latch();
  const events: string[] = [];
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  let selected: WatcherCheck | undefined;
  let unlinked = false;
  let hits = 0;
  const directory = path.join(store === f.source ? f.sourceHome : f.receiverHome, "sync");
  const nativeOpen = fs.open;
  const nativeUnlink = fs.unlink;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    await nativeUnlink(...args);
    if (selected && observer.current() === selected && String(args[0]) === path.join(directory, "mutation.lock")) {
      unlinked = true;
      events.push("canonical-unlinked");
    }
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await nativeOpen(...args);
    const check = observer.current();
    if (check?.store !== store) return file;

    selected ??= check;
    if (check !== selected) return file;

    handles.push(file);
    const sync = file.sync.bind(file);
    const close = file.close.bind(file);
    t.mock.method(file, "sync", async () => {
      if (String(args[0]) === directory && unlinked && hits === 0) {
        hits += 1;
        events.push("release-flush-enter");
        entered.release();
        await reached(release.promise, "release native flush");
      }

      await sync();
      if (unlinked) events.push("release-flush-return");
    });
    t.mock.method(file, "close", async () => { await close(); events.push("handle-closed"); });
    return file;
  });
  f.cleanup.push(release.release);
  return { entered: entered.promise, release: release.release, events, handles,
    selected: () => selected, hits: () => hits };
}

export async function ownershipHolder(f: Awaited<ReturnType<typeof lifetimeFixture>>, lockPath: string, mode: "managed" | "portable" = "managed") {
  const script = `const {acquireSyncOwnership}=require(process.argv[1]);
let release;const stop=new Promise(resolve=>{release=resolve});
process.on('message',message=>{if(message==='release')release()});
(async()=>{const owner=await acquireSyncOwnership(process.argv[2],Date.now()+1000,undefined,{mode:process.argv[3]});
process.send({type:'held'});await stop;await owner.release();process.send({type:'released'});process.disconnect();})()
.catch(error=>{process.stderr.write(String(error));process.exitCode=1;process.disconnect?.()});`;
  const child = spawn(process.execPath, ["-e", script, require.resolve("./sync-files"), lockPath, mode], {
    cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root, TMP: f.root, TEMP: f.root,
      XDG_CONFIG_HOME: f.root, XDG_DATA_HOME: f.root, XDG_STATE_HOME: f.root }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const held = latch();
  let released = false;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object" && "type" in message) {
      if (message.type === "held") held.release();
      if (message.type === "released") released = true;
    }
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null && released) resolve();
      else reject(new Error(`Retained ownership child close failed: ${code}/${signal}: ${stderr}`));
    });
  });
  void closed.catch(() => {});
  let stopping: Promise<void> | undefined;
  function stop() {
    if (stopping) return stopping;

    if (child.connected) child.send("release");
    return stopping = reached(closed, "actual ownership child close");
  }
  f.cleanup.push(stop);
  await reached(Promise.race([held.promise, closed.then(() => { throw new Error("Ownership child exited before held"); })]), "actual ownership child acquired");
  assert.ok(child.pid);
  return { child, stop };
}

export function errorCauses(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(errorCauses)] : [error];
}
