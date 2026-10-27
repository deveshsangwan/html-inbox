import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import {
  loopbackHttpsOrigin,
  parseSyncFixtureProxyConfig,
  type SyncFixtureFault,
  type SyncFixtureProxyConfig,
  type SyncFixtureProxyEvent,
  type SyncFixtureProxyStats,
  type SyncFixtureRoute,
  type SyncFixtureRouteCounts,
} from "./sync-fixture-proxy";

export type { SyncFixtureFault, SyncFixtureProxyEvent, SyncFixtureRoute } from "./sync-fixture-proxy";

export interface SyncFixtureServerCredentials {
  keyPath: string;
  certPath: string;
}

export interface SyncHttpsCredentials {
  directory: string;
  caPath: string;
  rogueCaPath: string;
  trusted: SyncFixtureServerCredentials;
  rogue: SyncFixtureServerCredentials;
  wrongHost: SyncFixtureServerCredentials;
  expired: SyncFixtureServerCredentials;
}

export interface SyncHttpsProxyOptions {
  upstreamUrl: string;
  upstreamCaPath: string;
  server: SyncFixtureServerCredentials;
  directory: string;
  routes: SyncFixtureRoute[];
  faults?: SyncFixtureFault[];
  host?: "127.0.0.1" | "::1";
  profile?: "lan" | "tailscale";
  requestTimeoutMs?: number;
  maxLifetimeMs?: number;
  maxBodyBytes?: number;
}

const runFile = promisify(execFile);

// Intentionally exclude inherited NODE_OPTIONS, proxy settings, cloud tokens and installed inbox configuration.
function fixtureEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
    XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory, XDG_DATA_HOME: directory,
    HTML_INBOX_HOME: directory,
  };
}

export async function createSyncHttpsCredentials(t: Pick<TestContext, "after">): Promise<SyncHttpsCredentials> {
  const directory = await mkdtemp(path.join(tmpdir(), "html-inbox-sync-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const opensslConfig = path.join(directory, "openssl.cnf");
  await writeFile(opensslConfig, "[req]\ndistinguished_name = dn\n[dn]\n", { mode: 0o600 });

  async function openssl(args: string[]) {
    try {
      await runFile("openssl", args, {
        cwd: directory, env: { ...fixtureEnvironment(directory), OPENSSL_CONF: opensslConfig },
        timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      });
    } catch {
      throw new Error("Synthetic TLS credential generation failed; local openssl is required");
    }
  }

  async function authority(name: string) {
    const keyPath = path.join(directory, `${name}.key`);
    const certPath = path.join(directory, `${name}.pem`);
    await openssl([
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2", "-sha256", "-subj", `/CN=synthetic-${name}`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    await chmod(keyPath, 0o600);

    return { keyPath, certPath };
  }

  const trustedCa = await authority("trusted-ca");
  const rogueCa = await authority("rogue-ca");
  const validSan = "DNS:localhost,IP:127.0.0.1,IP:::1";

  async function server(name: string, ca: SyncFixtureServerCredentials, san: string, isExpired = false) {
    const keyPath = path.join(directory, `${name}.key`);
    const certPath = path.join(directory, `${name}.pem`);
    const csrPath = path.join(directory, `${name}.csr`);
    const extensions = path.join(directory, `${name}.cnf`);
    await writeFile(extensions,
      `[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,
      { mode: 0o600 });
    await openssl([
      "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", keyPath, "-out", csrPath, "-subj", `/CN=synthetic-${name}`,
    ]);
    await chmod(keyPath, 0o600);

    if (isExpired) {
      const database = path.join(directory, "ca-index");
      const serial = path.join(directory, "ca-serial");
      const config = path.join(directory, "expired-ca.cnf");
      await writeFile(database, "", { mode: 0o600 });
      await writeFile(serial, "1000\n", { mode: 0o600 });
      await writeFile(config, "[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=ca-index\nserial=ca-serial\nnew_certs_dir=.\ndefault_md=sha256\npolicy=names\n[names]\ncommonName=supplied\n", { mode: 0o600 });
      await openssl([
        "ca", "-batch", "-notext", "-config", config, "-keyfile", ca.keyPath, "-cert", ca.certPath,
        "-in", csrPath, "-out", certPath, "-startdate", "20000101000000Z", "-enddate", "20000102000000Z",
        "-extfile", extensions, "-extensions", "server",
      ]);
    } else {
      await openssl([
        "x509", "-req", "-in", csrPath, "-CA", ca.certPath, "-CAkey", ca.keyPath,
        "-set_serial", name === "trusted" ? "1" : name === "rogue" ? "2" : "3",
        "-out", certPath, "-days", "2", "-sha256", "-extfile", extensions, "-extensions", "server",
      ]);
    }

    return { keyPath, certPath };
  }

  try {
    const trusted = await server("trusted", trustedCa, validSan);
    const rogue = await server("rogue", rogueCa, validSan);
    const wrongHost = await server("wrong-host", trustedCa, "DNS:wrong-host.invalid");
    const expired = await server("expired", trustedCa, validSan, true);

    return { directory, caPath: trustedCa.certPath, rogueCaPath: rogueCa.certPath, trusted, rogue, wrongHost, expired };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function natural(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid fixture IPC counter");
  }

  return value;
}

function counts(value: unknown): SyncFixtureRouteCounts {
  if (!isRecord(value)) throw new Error("Invalid fixture IPC route counts");

  return {
    starts: natural(value.starts), requestBytes: natural(value.requestBytes),
    upstreamRequestBytes: natural(value.upstreamRequestBytes), responseBytes: natural(value.responseBytes),
    clientResponseBytes: natural(value.clientResponseBytes),
  };
}

function parseEvent(value: unknown, config: SyncFixtureProxyConfig): SyncFixtureProxyEvent {
  if (!isRecord(value)) throw new Error("Invalid fixture IPC event");

  const sequence = natural(value.sequence);
  if (value.type === "fatal") return { sequence, type: "fatal" };

  if (value.type === "ready" && value.profile === config.profile) {
    return { sequence, type: "ready", profile: config.profile, pid: natural(value.pid), url: loopbackHttpsOrigin(value.url) };
  }

  if (value.type === "stats" && isRecord(value.stats) && isRecord(value.stats.routes) && isRecord(value.stats.faultHits)) {
    const routes = Object.fromEntries(Object.entries(value.stats.routes).map(([name, entry]) => [name, counts(entry)]));
    const faultHits = Object.fromEntries(Object.entries(value.stats.faultHits).map(([name, count]) => [name, natural(count)]));
    return { sequence, type: "stats", commandId: natural(value.commandId), stats: {
      routes, faultHits, activeRequests: natural(value.stats.activeRequests),
      incomingSockets: natural(value.stats.incomingSockets), upstreamSockets: natural(value.stats.upstreamSockets),
    } };
  }

  if (typeof value.route !== "string" || (value.route !== "unmatched" && !config.routes.some((route) => route.label === value.route))) {
    throw new Error("Invalid fixture IPC route label");
  }

  const metadata = { sequence, route: value.route, requestId: natural(value.requestId) };
  if (value.type === "request-start" && typeof value.method === "string" && /^[A-Z]{1,16}$/.test(value.method)) {
    return { ...metadata, type: value.type, method: value.method };
  }

  if (value.type === "request-end") return { ...metadata, type: value.type, requestBytes: natural(value.requestBytes) };
  if (value.type === "upstream-response") return { ...metadata, type: value.type, statusCode: natural(value.statusCode) };
  if (value.type === "upstream-end") {
    return { ...metadata, type: value.type, statusCode: natural(value.statusCode), responseBytes: natural(value.responseBytes) };
  }

  if (value.type === "response-released") return { ...metadata, type: value.type };
  if (value.type === "request-finished" && typeof value.outcome === "string" && /^[a-z-]{1,32}$/.test(value.outcome)) {
    return { ...metadata, type: value.type, outcome: value.outcome };
  }

  if (value.type === "fault-hit") {
    const fault = config.faults.find((rule) => rule.id === value.faultId && rule.kind === value.kind);
    if (fault) return { ...metadata, type: value.type, faultId: fault.id, kind: fault.kind, hitCount: natural(value.hitCount) };
  }

  throw new Error("Invalid fixture IPC event fields");
}

export async function startSyncHttpsProxy(t: Pick<TestContext, "after">, options: SyncHttpsProxyOptions) {
  const config = parseSyncFixtureProxyConfig({
    ...options, keyPath: options.server.keyPath, certPath: options.server.certPath,
    host: options.host ?? "127.0.0.1", profile: options.profile ?? "lan", faults: options.faults ?? [],
    requestTimeoutMs: options.requestTimeoutMs ?? 5000, maxLifetimeMs: options.maxLifetimeMs ?? 120_000,
    maxBodyBytes: options.maxBodyBytes ?? 16 * 1024 * 1024,
  });
  const child = spawn(process.execPath, [path.join(__dirname, "sync-fixture-proxy.js")], {
    cwd: options.directory, env: fixtureEnvironment(options.directory), stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const events: SyncFixtureProxyEvent[] = [];
  const listeners = new Set<(event: SyncFixtureProxyEvent) => void>();
  const failures = new Set<(error: Error) => void>();
  let failure: Error | undefined;
  let hasClosed = false;
  let commandId = 0;
  let stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      hasClosed = true;
      fail(new Error("HTTPS fixture child closed"));
      resolve({ code, signal });
    });
  });

  function fail(error: Error) {
    failure ??= error;
    for (const reject of failures) reject(error);
  }

  child.on("error", () => fail(new Error("HTTPS fixture child failed")));
  child.on("message", (value: unknown) => {
    try {
      const event = parseEvent(value, config);
      if (event.type === "fatal") throw new Error("HTTPS fixture child rejected startup or configuration");

      events.push(event);
      if (events.length > 4096) events.shift();
      for (const listener of listeners) listener(event);
    } catch {
      fail(new Error("HTTPS fixture child sent invalid IPC metadata"));
      child.kill("SIGKILL");
    }
  });

  function waitForEvent(predicate: (event: SyncFixtureProxyEvent) => boolean, settings: { after?: number; timeoutMs?: number } = {}) {
    const timeoutMs = settings.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      return Promise.reject(new Error("Fixture event wait requires a bounded deadline"));
    }

    const matches = (event: SyncFixtureProxyEvent) => event.sequence > (settings.after ?? -1) && predicate(event);
    const existing = events.find(matches);
    if (existing) return Promise.resolve(existing);
    if (failure) return Promise.reject(failure);

    return new Promise<SyncFixtureProxyEvent>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(observe);
        failures.delete(rejectWait);
      };
      const observe = (event: SyncFixtureProxyEvent) => {
        if (matches(event)) {
          cleanup();
          resolve(event);
        }
      };
      const rejectWait = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => rejectWait(new Error("HTTPS fixture metadata wait timed out")), timeoutMs);
      listeners.add(observe);
      failures.add(rejectWait);
    });
  }

  function send(message: object) {
    if (!child.connected) {
      fail(new Error("HTTPS fixture IPC is disconnected"));
      return;
    }

    child.send(message, (error) => { if (error) fail(new Error("HTTPS fixture IPC send failed")); });
  }

  async function closeWithin(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stop() {
    stopped ??= (async () => {
      if (hasClosed) return closed;

      send({ type: "stop" });
      const graceful = await closeWithin(1000);
      if (graceful) return graceful;

      child.kill("SIGTERM");
      const terminated = await closeWithin(1000);
      if (terminated) return terminated;

      child.kill("SIGKILL");
      const killed = await closeWithin(2000);
      if (killed) return killed;

      throw new Error("Owned HTTPS fixture child did not close after SIGKILL");
    })();

    return stopped;
  }

  t.after(stop);
  try {
    const readyWait = waitForEvent((event) => event.type === "ready");
    send(config);
    const ready = await readyWait;
    if (ready.type !== "ready" || ready.pid !== child.pid) throw new Error("Fixture readiness identity mismatch");

    return {
      url: ready.url, pid: ready.pid, profile: ready.profile, events, waitForEvent, stop,
      get isRunning() { return !hasClosed; },
      release(requestId: number) {
        if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error("Invalid fixture request ID");

        send({ type: "release", requestId });
      },
      async stats(): Promise<SyncFixtureProxyStats> {
        const id = ++commandId;
        const pending = waitForEvent((event) => event.type === "stats" && event.commandId === id);
        send({ type: "stats", commandId: id });
        const event = await pending;
        if (event.type !== "stats") throw new Error("Fixture stats response mismatch");

        return event.stats;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
