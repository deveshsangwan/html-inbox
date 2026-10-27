import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import { mock, type TestContext } from "node:test";
import { parseChoice, parseInteger, parseObject, parseString, parseUuid } from "./sync-model";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { reconcileSyncRoutes } from "./sync-reconciliation";
import { ManagedSyncStore } from "./sync-store";
import { decodeJson, opaqueToken } from "./sync-wire";

type ChildOptions = { mode: "runner"; home: string; peerId: string; token: string; caPath: string } |
  { mode: "proxy"; home: string; upstreamUrl: string; caPath: string; keyPath: string; certPath: string };

/** Owns only disposable processes. Application requests still use the production client and handlers. */
export async function startProtocolFaultChild(t: Pick<TestContext, "after" | "diagnostic">, options: ChildOptions) {
  const child = spawn(process.execPath, [__filename, "--protocol-fault-child"], {
    cwd: options.home,
    env: { PATH: process.env.PATH, HOME: options.home, ZDOTDIR: options.home, XDG_CONFIG_HOME: options.home },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Record<string, unknown>[] = [];
  let diagnostic = "";
  let hasClosed = false;
  let sequence = 0;
  let url: string | undefined;
  let stopped: Promise<void> | undefined;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => {
    hasClosed = true;
    resolve({ code, signal });
  }));
  child.on("error", (error) => { diagnostic += error.message; });
  child.stderr?.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  child.on("message", (value: unknown) => { messages.push(parseObject(value, "fault child IPC")); });

  async function waitFor(type: string, id?: number, waitMs = 8000) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const message = messages.find((message) => message.type === type && (id === undefined || message.id === id));
      if (message) {
        return message;
      }

      const fatal = messages.find((message) => message.type === "fatal");
      if (fatal || hasClosed) {
        throw new Error(`Fault child stopped at ${type}: ${JSON.stringify(fatal)} ${diagnostic}`);
      }

      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }

    throw new Error(`Fault child timed out at ${type}: ${diagnostic}`);
  }

  async function command(value: Record<string, unknown>, waitMs = 8000) {
    const boundedWait = parseInteger(waitMs, 1, 300_000);
    const id = ++sequence;
    if (!child.connected) {
      throw new Error("Fault child IPC is closed");
    }

    await new Promise<void>((resolve, reject) => child.send({ ...value, id }, (error) => error ? reject(error) : resolve()));
    return waitFor("reply", id, boundedWait);
  }

  function stop(kill = false) {
    stopped ??= (async () => {
      if (!hasClosed) {
        if (kill) {
          child.kill("SIGKILL");
        } else {
          await command({ type: "stop" }).catch(() => child.kill("SIGKILL"));
        }
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Fault child failed to reap")), 5000);
        })]);
        assert.equal(result.code, kill ? null : 0, diagnostic);
        assert.equal(result.signal, kill ? "SIGKILL" : null, diagnostic);
      } finally {
        clearTimeout(timer);
      }

      assert.equal(child.connected, false);
      const pid = child.pid;
      assert.ok(pid);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      if (url) {
        await assertLoopbackClosed(url);
      }
    })();

    return stopped;
  }

  t.after(async () => {
    await stop();
    t.diagnostic(`fault ${options.mode} child ${child.pid}: reaped; ${url ? "loopback port rebound" : "no listener"}`);
  });
  child.send(options);
  const ready = await waitFor("ready");
  if (ready.url !== undefined) {
    url = loopbackUrl(ready.url);
  }

  return { url, pid: child.pid, messages, waitFor, command, stop };
}

function loopbackUrl(value: unknown): string {
  const url = new URL(parseString(value));
  if (url.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Fault fixture permits only literal loopback HTTPS");
  }

  return url.origin;
}

async function runChild() {
  const [value] = await once(process, "message");
  const config = parseObject(value, "fault child configuration");
  const home = parseString(config.home);
  const mode = parseChoice(config.mode, ["runner", "proxy"]);
  const lifetime = setTimeout(() => process.exit(90), 120_000);
  lifetime.unref();

  if (mode === "runner") {
    await runReconciler(config, home);
  } else {
    await runProxy(config);
  }
}

async function runReconciler(config: Record<string, unknown>, home: string) {
  const peerId = parseUuid(config.peerId);
  const token = parseString(config.token);
  const ca = await readFile(parseString(config.caPath));
  let armed = false;
  let release: (() => void) | undefined;
  let htmlReadOpens = 0;
  const originalOpen = fs.open;
  mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const filename = String(args[0]);
    const flags = args[1];
    if (filename.startsWith(path.join(home, "sync", "bodies") + path.sep) && (flags === "r" || typeof flags === "number" && (flags & 3) === 0)) {
      htmlReadOpens += 1;
    }

    return originalOpen(...args);
  });
  const store = new ManagedSyncStore(home, { testHooks: { async onEvent(event) {
    if (event !== "receipt-before-retirement" || !armed) {
      return;
    }

    armed = false;
    process.send?.({ type: "fault", event, hits: 1 });
    await new Promise<void>((resolve) => { release = resolve; });
  } } });
  await store.recover();
  process.on("disconnect", () => process.exit(0));
  process.on("message", (value: unknown) => {
    const message = parseObject(value, "runner command");
    void (async () => {
      let result: unknown;
      if (message.type === "arm") {
        armed = true;
      } else if (message.type === "release") {
        release?.();
      } else if (message.type === "run") {
        if (!Array.isArray(message.routeIds)) {
          throw new Error("Expected route IDs");
        }

        const routeIds = message.routeIds.map(parseUuid);
        const ledger = await store.snapshot();
        for (const id of routeIds) {
          const route = ledger.routes[id];
          if (route) {
            loopbackUrl(route.peerUrl);
          }
        }

        const requestMs = message.requestMs === undefined ? 2000 : parseInteger(message.requestMs, 1, 60_000);
        const deadlineMs = message.deadlineMs === undefined ? 8000 : parseInteger(message.deadlineMs, 1, 300_000);
        result = await reconcileSyncRoutes({ store, peerId, routeIds, credentials: () => ({ token, ca }), requestMs, deadlineMs });
      } else if (message.type === "read") {
        const document = await store.getDocument(parseString(message.localId));
        result = document?.originalBytes.length ?? null;
      } else if (message.type === "stop") {
        process.send?.({ type: "reply", id: message.id }, () => process.disconnect?.());
        return;
      }

      process.send?.({ type: "reply", id: message.id, result, htmlReadOpens, counters: store.counters });
    })().catch((error: unknown) => {
      process.send?.({ type: "reply", id: message.id, error: error instanceof Error ? error.message : "runner failure" });
    });
  });
  process.send?.({ type: "ready" });
}

async function runProxy(config: Record<string, unknown>) {
  const upstreamUrl = loopbackUrl(config.upstreamUrl);
  const ca = await readFile(parseString(config.caPath));
  const key = await readFile(parseString(config.keyPath));
  const cert = await readFile(parseString(config.certPath));
  const sockets = new Set<Duplex>();
  const starts: Record<string, number> = {};
  let armed: { pathname: string; method: string; kind: string } | undefined;
  let release: (() => void) | undefined;
  let hits = 0;
  const kinds = ["accepted", "redirect", "compressed", "json", "utf8", "extra", "exists", "oversized", "headers", "length", "receipt", "ack", "pause"];
  const server = https.createServer({ key, cert, maxHeaderSize: 16 * 1024 }, (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", upstreamUrl);
    if (url.origin !== upstreamUrl) {
      outgoing.destroy();
      return;
    }

    const route = `${incoming.method} ${url.pathname}`;
    starts[route] = (starts[route] ?? 0) + 1;
    const mutation = armed?.pathname === url.pathname && armed.method === incoming.method ? armed : undefined;
    if (mutation) {
      armed = undefined;
      hits += 1;
      process.send?.({ type: "fault", kind: mutation.kind, hits });
    }

    const upstream = https.request(url, { method: incoming.method, headers: { ...incoming.headers, host: url.host }, ca, agent: false }, (response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("Expected proxy bytes");
          }

          length += chunk.length;
          if (length > 32 * 1024 * 1024) {
            throw new Error("Bounded proxy response exceeded");
          }

          chunks.push(Buffer.from(chunk));
        }

        let body = Buffer.concat(chunks);
        if (mutation?.kind === "pause") {
          await new Promise<void>((resolve) => {
            release = resolve;
            process.send?.({ type: "paused" });
          });
        }

        let status = response.statusCode ?? 503;
        const headers: Record<string, string> = { "content-type": String(response.headers["content-type"] ?? "application/json"), connection: "close" };
        if (mutation) {
          if (mutation.kind === "accepted") status = 202;
          if (mutation.kind === "redirect") {
            status = 307;
            headers.location = `${upstreamUrl}/sync/v1/identity`;
          }
          if (mutation.kind === "compressed") headers["content-encoding"] = "gzip";
          if (mutation.kind === "json") body = Buffer.from("{invalid");
          if (mutation.kind === "utf8") body = Buffer.from([0xff, 0xfe]);
          if (mutation.kind === "extra") body = Buffer.from(JSON.stringify({ ...parseObject(decodeJson(body), "proxy response"), unexpected: true }));
          if (mutation.kind === "exists") body = Buffer.from(JSON.stringify({ status: "committed", bodyExists: true }));
          if (mutation.kind === "oversized") body = Buffer.alloc(4097, 32);
          if (mutation.kind === "headers") headers["x-synthetic-oversized"] = "x".repeat(17 * 1024);
          if (mutation.kind === "receipt") {
            const envelope = parseObject(decodeJson(body), "proxy response");
            body = Buffer.from(JSON.stringify({ ...envelope, receipt: { ...parseObject(envelope.receipt, "receipt"), destinationInboxId: randomUUID() } }));
          }
          if (mutation.kind === "ack") body = Buffer.from(JSON.stringify({ ...parseObject(decodeJson(body), "proxy response"), ackNonce: opaqueToken() }));
        }

        headers["content-length"] = String(body.length + (mutation?.kind === "length" ? 1 : 0));
        outgoing.writeHead(status, headers);
        outgoing.end(body);
      })().catch(() => outgoing.destroy());
    });
    upstream.on("socket", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    upstream.setTimeout(4000, () => upstream.destroy());
    upstream.on("error", () => outgoing.destroy());
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.setTimeout(4000, (socket) => socket.destroy());
  server.on("tlsClientError", () => {});

  async function close() {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  process.on("disconnect", () => { void close().finally(() => process.exit(0)); });
  process.on("message", (value: unknown) => {
    const message = parseObject(value, "proxy command");
    void (async () => {
      if (message.type === "arm") {
        assert.equal(armed, undefined, "A fault must fire before another is armed");
        hits = 0;
        armed = { pathname: parseString(message.pathname), method: parseChoice(message.method, ["POST", "PUT", "GET"]), kind: parseChoice(message.kind, kinds) };
      } else if (message.type === "release") {
        release?.();
      } else if (message.type === "stop") {
        await close();
        process.send?.({ type: "reply", id: message.id }, () => process.disconnect?.());
        return;
      }

      process.send?.({ type: "reply", id: message.id, starts, hits, armed: Boolean(armed), sockets: sockets.size });
    })().catch((error: unknown) => process.send?.({ type: "fatal", error: error instanceof Error ? error.message : "proxy failure" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.send?.({ type: "ready", url: `https://127.0.0.1:${parseInteger(address.port, 1, 65535)}` });
}

if (process.argv.includes("--protocol-fault-child")) {
  void runChild().catch((error: unknown) => {
    process.send?.({ type: "fatal", error: error instanceof Error ? error.message : "fault child startup failure" });
    process.exitCode = 1;
    process.disconnect?.();
  });
}
