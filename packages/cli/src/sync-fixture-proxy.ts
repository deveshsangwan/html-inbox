import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";

export type SyncFixtureFaultKind =
  | "drop-response"
  | "pause-response"
  | "stall-request"
  | "truncate-request"
  | "stall-response"
  | "truncate-response";

export interface SyncFixtureRoute {
  label: string;
  pathname: string;
  method?: string;
  requestHeader?: { name: string; value: string };
}

export interface SyncFixtureFault {
  id: string;
  route: string;
  kind: SyncFixtureFaultKind;
  times?: number;
  afterBytes?: number;
}

export interface SyncFixtureProxyConfig {
  host: "127.0.0.1" | "::1";
  profile: "lan" | "tailscale";
  upstreamUrl: string;
  upstreamCaPath: string;
  keyPath: string;
  certPath: string;
  routes: SyncFixtureRoute[];
  faults: SyncFixtureFault[];
  requestTimeoutMs: number;
  maxLifetimeMs: number;
  maxBodyBytes: number;
}

// Counts cover application body streams and submitted writes, not packet bytes or remote durability.
export interface SyncFixtureRouteCounts {
  starts: number;
  requestBytes: number;
  upstreamRequestBytes: number;
  responseBytes: number;
  clientResponseBytes: number;
}

export interface SyncFixtureProxyStats {
  routes: Record<string, SyncFixtureRouteCounts>;
  faultHits: Record<string, number>;
  activeRequests: number;
  incomingSockets: number;
  upstreamSockets: number;
}

type RequestMetadata = { requestId: number; route: string };
type ProxyEventPayload =
  | { type: "ready"; url: string; pid: number; profile: "lan" | "tailscale" }
  | ({ type: "request-start"; method: string } & RequestMetadata)
  | ({ type: "request-end"; requestBytes: number } & RequestMetadata)
  | ({ type: "upstream-response"; statusCode: number } & RequestMetadata)
  | ({ type: "upstream-end"; statusCode: number; responseBytes: number } & RequestMetadata)
  | ({ type: "fault-hit"; faultId: string; kind: SyncFixtureFaultKind; hitCount: number } & RequestMetadata)
  | ({ type: "response-released" } & RequestMetadata)
  | ({ type: "request-finished"; outcome: string } & RequestMetadata)
  | { type: "stats"; commandId: number; stats: SyncFixtureProxyStats }
  | { type: "fatal" };
export type SyncFixtureProxyEvent = { sequence: number } & ProxyEventPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error("Fixture labels must be short opaque names");
  }

  return value;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("Fixture bounds must be finite positive integers");
  }

  return value;
}

function filePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("Fixture credentials require file paths");
  }

  return value;
}

export function loopbackHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Fixture upstream must be a loopback HTTPS origin");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Fixture upstream must be a loopback HTTPS origin");
  }

  if (url.protocol !== "https:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Fixture upstream must be a loopback HTTPS origin");
  }

  return url.origin;
}

export function parseSyncFixtureProxyConfig(value: unknown): SyncFixtureProxyConfig {
  if (!isRecord(value) || (value.host !== "127.0.0.1" && value.host !== "::1")
    || (value.profile !== "lan" && value.profile !== "tailscale")
    || !Array.isArray(value.routes) || value.routes.length > 128
    || !Array.isArray(value.faults) || value.faults.length > 128) {
    throw new Error("Invalid fixture proxy configuration");
  }

  const routes = value.routes.map((route: unknown): SyncFixtureRoute => {
    if (!isRecord(route) || typeof route.pathname !== "string" || !route.pathname.startsWith("/")
      || route.pathname.includes("?") || route.pathname.includes("#") || route.pathname.length > 2048
      || (route.method !== undefined && (typeof route.method !== "string" || !/^[A-Z]{1,16}$/.test(route.method)))) {
      throw new Error("Invalid fixture route selector");
    }

    let requestHeader: SyncFixtureRoute["requestHeader"];
    if (route.requestHeader !== undefined) {
      const header = route.requestHeader;
      if (!isRecord(header) || typeof header.name !== "string" || !/^[a-z0-9-]{1,64}$/.test(header.name)
        || typeof header.value !== "string" || header.value.length > 1024 || /[\r\n]/.test(header.value)) {
        throw new Error("Invalid fixture route header selector");
      }

      requestHeader = { name: header.name, value: header.value };
    }

    return { label: label(route.label), pathname: route.pathname, method: route.method, requestHeader };
  });
  const routeLabels = new Set(routes.map((route) => route.label));
  if (routeLabels.size !== routes.length || routeLabels.has("unmatched")) {
    throw new Error("Fixture route labels must be unique and cannot be unmatched");
  }

  const maxBodyBytes = integer(value.maxBodyBytes, 64 * 1024 * 1024);
  const faults = value.faults.map((fault: unknown): SyncFixtureFault => {
    if (!isRecord(fault) || typeof fault.route !== "string" || !routeLabels.has(fault.route)) {
      throw new Error("Invalid fixture fault");
    }

    const kind = fault.kind;
    if (kind !== "drop-response" && kind !== "pause-response" && kind !== "stall-request"
      && kind !== "truncate-request" && kind !== "stall-response" && kind !== "truncate-response") {
      throw new Error("Invalid fixture fault kind");
    }

    return {
      id: label(fault.id), route: label(fault.route), kind,
      times: integer(fault.times ?? 1, 10_000),
      afterBytes: fault.afterBytes === undefined ? 1 : integer(fault.afterBytes, maxBodyBytes),
    };
  });
  if (new Set(faults.map((fault) => fault.id)).size !== faults.length) {
    throw new Error("Fixture fault IDs must be unique");
  }

  return {
    host: value.host === "::1" ? "::1" : "127.0.0.1", profile: value.profile,
    upstreamUrl: loopbackHttpsOrigin(value.upstreamUrl), upstreamCaPath: filePath(value.upstreamCaPath),
    keyPath: filePath(value.keyPath), certPath: filePath(value.certPath), routes, faults,
    requestTimeoutMs: integer(value.requestTimeoutMs, 60_000),
    maxLifetimeMs: integer(value.maxLifetimeMs, 3_600_000), maxBodyBytes,
  };
}

function emptyCounts(): SyncFixtureRouteCounts {
  return { starts: 0, requestBytes: 0, upstreamRequestBytes: 0, responseBytes: 0, clientResponseBytes: 0 };
}

async function runProxy(config: SyncFixtureProxyConfig) {
  const [key, cert, ca] = await Promise.all([
    readFile(config.keyPath), readFile(config.certPath), readFile(config.upstreamCaPath),
  ]);
  if (!process.connected) return;

  const upstream = new URL(config.upstreamUrl);
  // Pin localhost to a literal loopback address instead of consulting DNS or host overrides.
  const hostname = upstream.hostname === "localhost" ? "127.0.0.1" : upstream.hostname.replace(/^\[|\]$/g, "");
  const incomingSockets = new Set<Duplex>();
  const upstreamSockets = new Set<Duplex>();
  const active = new Set<() => void>();
  const releases = new Map<number, () => void>();
  const reservations = new Map<string, number>();
  const stats: SyncFixtureProxyStats = {
    routes: Object.fromEntries([...config.routes.map((route) => route.label), "unmatched"].map((name) => [name, emptyCounts()])),
    faultHits: Object.fromEntries(config.faults.map((fault) => [fault.id, 0])),
    activeRequests: 0, incomingSockets: 0, upstreamSockets: 0,
  };
  let sequence = 0;
  let requestId = 0;
  let isClosing = false;
  const emit = (event: ProxyEventPayload) => {
    if (process.connected) {
      process.send?.({ ...event, sequence: ++sequence }, (error) => {
        if (error) shutdown();
      });
    }
  };
  const server = https.createServer({
    key, cert, minVersion: "TLSv1.2", maxHeaderSize: 16 * 1024, handshakeTimeout: config.requestTimeoutMs,
  }, forward);
  server.headersTimeout = Math.min(config.requestTimeoutMs, 5000);
  server.requestTimeout = config.requestTimeoutMs;
  server.setTimeout(config.requestTimeoutMs, (socket) => socket.destroy());
  server.on("connection", (socket) => {
    incomingSockets.add(socket);
    socket.once("close", () => incomingSockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  function forward(request: IncomingMessage, response: ServerResponse) {
    const pathname = (request.url ?? "/").split("?", 1)[0];
    const matched = config.routes.find((route) => route.pathname === pathname
      && (route.method === undefined || route.method === request.method)
      && (route.requestHeader === undefined || request.headers[route.requestHeader.name] === route.requestHeader.value));
    const metadata = { requestId: ++requestId, route: matched?.label ?? "unmatched" };
    const counts = stats.routes[metadata.route];
    counts.starts++;
    emit({ type: "request-start", ...metadata, method: request.method ?? "GET" });

    if (active.size >= 32 || !request.url?.startsWith("/")) {
      response.destroy();
      emit({ type: "request-finished", ...metadata, outcome: "rejected" });
      return;
    }

    const fault = config.faults.find((rule) => rule.route === metadata.route
      && stats.faultHits[rule.id] + (reservations.get(rule.id) ?? 0) < (rule.times ?? 1));
    if (fault) reservations.set(fault.id, (reservations.get(fault.id) ?? 0) + 1);

    let isFinished = false;
    let hasHit = false;
    let isRequestBodyPaused = false;
    let requestBytes = 0;
    let responseBytes = 0;
    let upstreamResponse: IncomingMessage | undefined;
    const timer = setTimeout(() => finish("timeout"), config.requestTimeoutMs);
    const outgoing = https.request({
      hostname, port: upstream.port || 443, path: request.url, method: request.method,
      headers: { ...request.headers, host: upstream.host, connection: "close" },
      ca, rejectUnauthorized: true, servername: upstream.hostname === "localhost" ? "localhost" : undefined,
      agent: false, maxHeaderSize: 16 * 1024,
    });
    const cancel = () => finish("shutdown");
    active.add(cancel);
    outgoing.once("socket", (socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
    });
    outgoing.once("error", () => finish("upstream-error"));
    request.once("error", () => finish("aborted"));
    response.once("error", () => finish("aborted"));
    response.once("close", () => finish(response.writableFinished ? "complete" : "aborted"));
    response.once("finish", () => finish("complete"));

    function hit() {
      if (!fault || hasHit) return;

      hasHit = true;
      reservations.set(fault.id, (reservations.get(fault.id) ?? 1) - 1);
      stats.faultHits[fault.id]++;
      emit({ type: "fault-hit", ...metadata, faultId: fault.id, kind: fault.kind, hitCount: stats.faultHits[fault.id] });
    }

    function finish(outcome: string) {
      if (isFinished) return;

      isFinished = true;
      clearTimeout(timer);
      releases.delete(metadata.requestId);
      active.delete(cancel);
      if (fault && !hasHit) reservations.set(fault.id, (reservations.get(fault.id) ?? 1) - 1);

      request.unpipe();
      outgoing.destroy();
      upstreamResponse?.destroy();
      response.destroy();
      request.destroy();
      emit({ type: "request-finished", ...metadata, outcome });
    }

    request.on("data", (chunk: Buffer) => {
      const previous = requestBytes;
      requestBytes += chunk.length;
      counts.requestBytes += chunk.length;
      if (requestBytes > config.maxBodyBytes) {
        finish("request-limit");
        return;
      }

      const isBodyFault = fault?.kind === "stall-request" || fault?.kind === "truncate-request";
      const limit = fault?.afterBytes ?? 1;
      const bytes = isBodyFault ? chunk.subarray(0, Math.max(0, limit - previous)) : chunk;
      const shouldPause = isBodyFault && requestBytes >= limit;
      if (shouldPause) {
        isRequestBodyPaused = true;
        request.pause();
      }

      counts.upstreamRequestBytes += bytes.length;
      const canWrite = outgoing.write(bytes, (error) => {
        if (error || isFinished) return;

        if (shouldPause) {
          hit();
          if (fault?.kind === "truncate-request") finish("fault");
        }
      });
      if (!canWrite) {
        request.pause();
        outgoing.once("drain", () => { if (!isRequestBodyPaused) request.resume(); });
      }
    });
    request.once("end", () => {
      emit({ type: "request-end", ...metadata, requestBytes });
      if (!isRequestBodyPaused) outgoing.end();
    });

    outgoing.once("response", (received) => {
      upstreamResponse = received;
      const statusCode = received.statusCode ?? 502;
      emit({ type: "upstream-response", ...metadata, statusCode });
      received.once("error", () => finish("upstream-error"));
      received.once("aborted", () => finish("upstream-error"));

      const pipeResponse = () => {
        if (isFinished) return;

        if (fault?.kind !== "drop-response") response.writeHead(statusCode, received.headers);
        received.on("data", (chunk: Buffer) => {
          const previous = responseBytes;
          responseBytes += chunk.length;
          counts.responseBytes += chunk.length;
          if (responseBytes > config.maxBodyBytes) {
            finish("response-limit");
            return;
          }

          if (fault?.kind === "drop-response") return;

          const isBodyFault = fault?.kind === "stall-response" || fault?.kind === "truncate-response";
          const limit = fault?.afterBytes ?? 1;
          const bytes = isBodyFault ? chunk.subarray(0, Math.max(0, limit - previous)) : chunk;
          counts.clientResponseBytes += bytes.length;
          const canWrite = response.write(bytes, () => {
            if (hasHit && fault?.kind === "truncate-response") finish("fault");
          });
          if (!canWrite) {
            received.pause();
            response.once("drain", () => { if (!hasHit || fault?.kind === "pause-response") received.resume(); });
          }

          if (isBodyFault && responseBytes >= limit) {
            hit();
            received.pause();
          }
        });
        received.once("end", () => {
          if (!received.complete) {
            finish("upstream-error");
            return;
          }

          // Completion is transport evidence only. Tests must inspect the real worker's durable state.
          emit({ type: "upstream-end", ...metadata, statusCode, responseBytes });
          if (fault?.kind === "drop-response") {
            hit();
            finish("fault");
            return;
          }

          if (!hasHit || fault?.kind === "pause-response") response.end();
        });
        received.resume();
      };

      if (fault?.kind === "pause-response") {
        received.pause();
        releases.set(metadata.requestId, () => {
          releases.delete(metadata.requestId);
          emit({ type: "response-released", ...metadata });
          pipeResponse();
        });
        hit();
        return;
      }

      pipeResponse();
    });
  }

  const lifetime = setTimeout(() => shutdown(), config.maxLifetimeMs);
  function shutdown() {
    if (isClosing) return;

    isClosing = true;
    clearTimeout(lifetime);
    for (const cancel of active) cancel();
    for (const socket of incomingSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    server.close(() => { if (process.connected) process.disconnect(); });
  }

  process.on("disconnect", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("message", (value: unknown) => {
    if (!isRecord(value)) return;

    if (value.type === "stop") shutdown();
    if (value.type === "release" && Number.isSafeInteger(value.requestId)) {
      releases.get(Number(value.requestId))?.();
    }

    if (value.type === "stats" && Number.isSafeInteger(value.commandId)) {
      emit({ type: "stats", commandId: Number(value.commandId), stats: {
        ...stats, activeRequests: active.size, incomingSockets: incomingSockets.size, upstreamSockets: upstreamSockets.size,
      } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener has no TCP address");

  emit({ type: "ready", pid: process.pid, profile: config.profile,
    url: `https://${config.host === "::1" ? "[::1]" : config.host}:${address.port}` });
}

if (require.main === module) {
  if (!process.send) throw new Error("The HTTPS fixture requires an owned IPC child");

  const startup = setTimeout(() => process.exit(1), 5000);
  process.once("message", (value: unknown) => {
    clearTimeout(startup);
    Promise.resolve().then(() => runProxy(parseSyncFixtureProxyConfig(value))).catch(() => {
      // Never print configuration, request headers, response bodies or credentials.
      process.send?.({ type: "fatal", sequence: 0 }, () => process.exit(1));
    });
  });
}
