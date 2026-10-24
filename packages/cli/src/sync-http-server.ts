import https from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type SyncCredentialResolver } from "./sync-client";
import { type RouteAuthorization, type SyncRoute, type OriginState, type CompleteInventory, parseInteger, parseUuid, parseDigest, parseSafeId, stateFingerprint, SYNC_DEFAULTS, SYNC_LIMITS, IncompleteSyncHistoryError, SYNC_HISTORY_UNAVAILABLE } from "./sync-model";
import { ManagedSyncStore, type InventoryReadiness } from "./sync-store";
import { routeOriginGrant } from "./sync-ledger-policy";
import { BINDING_HEADER, credentialsMatch, createEvidence, decodeJson, opaqueToken, parseBinding, parseIdentities, parseIdentityRequest, parseManifestRequest,
  parseOffer, parseToken, scopeDigest, SyncProtocolError, validatePageProgress, WIRE_LIMITS, type ManifestPage, type RequestBinding } from "./sync-wire";

export interface SyncServerOptions {
  store: ManagedSyncStore;
  peerId: string;
  key: string | Buffer;
  cert: string | Buffer;
  credentials: SyncCredentialResolver;
  host?: string;
  port?: number;
  requestMs?: number;
  leaseMs?: number;
  runtimeRevision?: number;
}

interface Session {
  id: string;
  auth: RouteAuthorization;
  binding: RequestBinding;
  localIncarnation: string;
  requestNonce: string;
  challengeNonce: string;
  expiresAt: number;
  direction: SyncRoute["direction"];
  states: OriginState[];
  evidence?: CompleteInventory;
  cursor: string | null;
  pageNumber: number;
  bytes: number;
  ready: boolean;
  activated: boolean;
  busy: boolean;
}

interface Transfer {
  auth: RouteAuthorization;
  binding: RequestBinding;
  localIncarnation: string;
  state: OriginState;
  expiresAt: number;
}

/** Dedicated TLS ingestion. The caller owns lifecycle; this module never starts a worker or configures routes. */
export function createSyncIngestionServer(options: SyncServerOptions) {
  const peerId = parseUuid(options.peerId);
  const requestMs = parseInteger(options.requestMs ?? SYNC_DEFAULTS.attemptMs, 1, 60_000);
  const leaseMs = parseInteger(options.leaseMs ?? SYNC_LIMITS.manifestLeaseMs, 1, SYNC_LIMITS.manifestLeaseMs);
  const host = validateSyncListenHost(options.host ?? "127.0.0.1");

  const port = parseInteger(options.port ?? 0, 0, 65535);
  const sessions = new Map<string, Session>();
  const transfers = new Map<string, Transfer>();
  const sockets = new Set<Duplex>();
  const handlers = new Set<Promise<void>>();
  const handlerFailures: unknown[] = [];
  const counters = { requests: 0, rejected: 0, requestBytes: 0, responseBytes: 0, activeRequests: 0, activeTransfers: 0 };
  let closed = false;
  let closing: Promise<void> | undefined;
  let binding: Promise<void> | undefined;
  let origin: string | null = null;
  const server = https.createServer({ key: options.key, cert: options.cert, minVersion: "TLSv1.2", maxHeaderSize: WIRE_LIMITS.headers,
    handshakeTimeout: requestMs, requestTimeout: requestMs, headersTimeout: requestMs, keepAliveTimeout: 1 }, (request, response) => {
    if (closed) {
      response.destroy();
      return;
    }

    const handling = Promise.resolve().then(() => handle(request, response));
    handlers.add(handling);
    void handling.then(() => { handlers.delete(handling); }, (error: unknown) => {
      handlers.delete(handling);
      handlerFailures.push(error);
      response.destroy();
    });
  });
  server.maxHeadersCount = 32;
  server.maxConnections = WIRE_LIMITS.concurrent;
  server.setTimeout(requestMs, (socket) => socket.destroy());
  server.on("connection", (socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), requestMs);
    socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", () => {});

  function purgeExpired() {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= Date.now() && !session.busy) {
        sessions.delete(id);
      }
    }

    for (const [id, transfer] of transfers) {
      if (transfer.expiresAt <= Date.now()) {
        transfers.delete(id);
      }
    }
  }

  function checkCache(additional: number) {
    const bytes = [...sessions.values()].reduce((sum, session) => sum + session.bytes, 0);
    if (additional > WIRE_LIMITS.cachedBytes) {
      throw new SyncProtocolError(413, "inventory-limit");
    }

    if (bytes + additional > WIRE_LIMITS.cachedBytes) {
      throw new SyncProtocolError(503, "session-capacity");
    }
  }

  function json(response: ServerResponse, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length, "cache-control": "no-store", connection: "close" });
    counters.responseBytes += bytes.length;
    response.end(bytes);
  }

  async function envelope(request: IncomingMessage, maximum: number) {
    if (request.headers["content-type"] !== "application/json") {
      throw new SyncProtocolError(409, "invalid-envelope");
    }

    const declared = contentLength(request, maximum);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      if (!(chunk instanceof Uint8Array)) {
        throw new SyncProtocolError(409, "invalid-bytes");
      }

      const owned = Buffer.from(chunk);
      length += owned.length;
      counters.requestBytes += owned.length;
      if (length > maximum || length > declared) {
        throw new SyncProtocolError(413, "envelope-limit");
      }

      chunks.push(owned);
    }

    if (length !== declared) {
      throw new SyncProtocolError(409, "truncated-envelope");
    }

    return decodeJson(Buffer.concat(chunks, length));
  }

  function contentLength(request: IncomingMessage, maximum: number) {
    const header = request.headers["content-length"];
    if (typeof header !== "string" || !/^(0|[1-9][0-9]*)$/.test(header)) {
      throw new SyncProtocolError(409, "content-length-required");
    }

    return parseInteger(Number(header), 0, maximum);
  }

  async function authenticate(request: IncomingMessage, endpoint: string) {
    try {
      const binding = parseBinding(request.headers[BINDING_HEADER]);
      const credential = request.headers.authorization;
      if (typeof credential !== "string" || !credential.startsWith("Bearer ")) {
        throw new Error("Invalid credential");
      }

      const token = parseToken(credential.slice(7));
      const auth = { routeId: binding.routeId, revision: binding.revision, peerId: binding.callerPeerId,
        sourceInboxId: binding.sourceInboxId, destinationInboxId: binding.destinationInboxId };
      const checked = await options.store.startCommunication(auth, (route, local) => {
        if (options.runtimeRevision !== undefined && local.runtimeRevision !== options.runtimeRevision) {
          throw new Error("Runtime configuration changed");
        }

        if (request.destroyed) {
          throw new Error("Request closed before authorization");
        }

        if (binding.targetPeerId !== peerId || !credentialsMatch(token, parseToken(options.credentials(route).token))) {
          throw new Error("Invalid credential binding");
        }

        const allowed = endpoint === "identity" || endpoint === "manifest" || route.direction === "inbound" &&
          (endpoint === "offer" || endpoint === "holdings" || endpoint === "body" && request.method === "PUT") ||
          route.direction === "outbound" && endpoint === "body" && request.method === "GET";
        if (!allowed) {
          throw new Error("Invalid operation direction");
        }

        return { auth, binding, route, local };
      }, undefined, Date.now() + requestMs);
      return checked.value;
    } catch {
      throw new SyncProtocolError(403, "unauthorized");
    }
  }

  function sessionFor(id: string, auth: RouteAuthorization, binding: RequestBinding, localIncarnation: string) {
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      throw new SyncProtocolError(410, "session-expired");
    }

    if (session.auth.routeId !== auth.routeId || session.auth.revision !== auth.revision || session.auth.peerId !== auth.peerId ||
        session.binding.callerStorageIncarnation !== binding.callerStorageIncarnation || session.localIncarnation !== localIncarnation || session.busy) {
      throw new SyncProtocolError(403, "unauthorized");
    }

    return session;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    counters.requests += 1;
    counters.activeRequests += 1;
    let attempt: Awaited<ReturnType<ManagedSyncStore["openRouteAttempt"]>> | undefined;
    const abortResponse = () => response.destroy();
    let authorized = false;
    try {
      if (closed || counters.activeRequests > WIRE_LIMITS.concurrent) {
        throw new SyncProtocolError(503, "request-capacity");
      }

      if (!request.url || request.url.length > WIRE_LIMITS.url) {
        throw new SyncProtocolError(403, "unauthorized");
      }

      const url = new URL(request.url, "https://localhost");
      const match = /^\/sync\/v1\/(identity|manifest|holdings|offer|body)$/.exec(url.pathname);
      const endpoint = match?.[1];
      if (!endpoint || url.hash || endpoint !== "body" && url.search) {
        throw new SyncProtocolError(403, "unauthorized");
      }

      if (endpoint === "body" ? !["PUT", "GET"].includes(request.method ?? "") : request.method !== "POST") {
        throw new SyncProtocolError(403, "unauthorized");
      }

      const verified = await authenticate(request, endpoint);
      authorized = true;
      if (request.headers["content-encoding"] || request.headers["transfer-encoding"] || request.headers.expect) {
        throw new SyncProtocolError(409, "compression-or-transfer-encoding-rejected");
      }

      attempt = await options.store.openRouteAttempt(verified.auth);
      attempt.signal.addEventListener("abort", abortResponse, { once: true });
      if (attempt.signal.aborted) {
        abortResponse();
      }

      purgeExpired();
      if (endpoint === "identity") {
        const challenge = parseIdentityRequest(await envelope(request, WIRE_LIMITS.identity));
        if (sessions.size >= WIRE_LIMITS.sessions) {
          throw new SyncProtocolError(503, "session-capacity");
        }

        const session: Session = { id: opaqueToken(), auth: verified.auth, binding: verified.binding, localIncarnation: verified.local.storageIncarnation,
          requestNonce: challenge.nonce, challengeNonce: opaqueToken(), expiresAt: Date.now() + leaseMs, direction: verified.route.direction,
          states: [], cursor: null, pageNumber: 0, bytes: 0, ready: false, activated: false, busy: true };
        // Reserve admission before inventory awaits the store lock. Concurrent pull
        // identities otherwise all observe the same free slot.
        sessions.set(session.id, session);
        try {
          if (verified.route.direction === "outbound") {
            const cut = await options.store.inventory(verified.auth);
            const bytes = Buffer.byteLength(JSON.stringify(cut.states));
            checkCache(bytes);
            session.states = cut.states;
            session.evidence = createEvidence(verified.route, peerId, challenge.nonce, cut);
            session.bytes = bytes;
          }
        } catch (error) {
          sessions.delete(session.id);
          throw error;
        } finally {
          session.busy = false;
        }

        json(response, { sessionId: session.id, requestNonce: session.requestNonce, challengeNonce: session.challengeNonce, peerId,
          inboxId: verified.local.inboxId, storageIncarnation: session.localIncarnation, scopeDigest: scopeDigest(verified.route), expiresAt: session.expiresAt });
        return;
      }

      if (endpoint === "manifest") {
        const message = parseManifestRequest(await envelope(request, verified.route.direction === "inbound" ? WIRE_LIMITS.page : WIRE_LIMITS.readiness));
        const session = sessionFor(message.sessionId, verified.auth, verified.binding, verified.local.storageIncarnation);
        if (message.op === "complete") {
          sessions.delete(session.id);
          json(response, { kind: "complete" });
          return;
        }

        session.busy = true;
        try {
          if (message.op === "pull" && session.direction === "outbound" && session.evidence && !session.ready) {
            if (message.cursor !== session.cursor) {
              throw new SyncProtocolError(409, "invalid-cursor");
            }

            const offset = session.pageNumber * SYNC_LIMITS.manifestPage;
            const descriptors = session.states.slice(offset, offset + SYNC_LIMITS.manifestPage);
            const nextCursor = offset + descriptors.length < session.states.length ? opaqueToken() : null;
            const page: ManifestPage = { evidence: session.evidence, pageNumber: session.pageNumber, descriptors, nextCursor };
            session.pageNumber += 1;
            session.cursor = nextCursor;
            if (nextCursor === null) {
              session.ready = true;
            }

            json(response, page);
            return;
          }

          if (message.op === "push" && session.direction === "inbound" && !session.ready) {
            validatePageProgress(message.page, session.states, session.pageNumber, session.evidence);
            if (message.page.evidence.nonce !== session.challengeNonce || message.page.evidence.peerId !== verified.auth.peerId ||
                message.page.evidence.routeId !== verified.auth.routeId || message.page.evidence.revision !== verified.auth.revision) {
              throw new SyncProtocolError(409, "challenge-conflict");
            }

            const additional = Buffer.byteLength(JSON.stringify(message.page.descriptors));
            checkCache(additional);
            if (session.bytes + additional > SYNC_LIMITS.ledgerBytes) {
              throw new SyncProtocolError(413, "inventory-limit");
            }

            session.bytes += additional;
            for (const state of message.page.descriptors) {
              checkOrigin(verified.route, state);
              if (state.state === "deleted") {
                await options.store.apply(verified.auth, state);
              }
            }

            session.evidence = message.page.evidence;
            session.states.push(...message.page.descriptors);
            session.pageNumber += 1;
            if (message.page.nextCursor !== null) {
              json(response, { kind: "continue" });
              return;
            }

            await options.store.completeInventory(verified.auth, session.evidence, session.states, session.challengeNonce);
            session.ready = true;
            const ready: InventoryReadiness = { kind: "terminal-inventory-ready", evidence: session.evidence, ackNonce: session.requestNonce,
              receiverPeerId: peerId, destinationInboxId: verified.route.destinationInboxId, storageIncarnation: session.localIncarnation };
            json(response, ready);
            return;
          }

          if (message.op === "ready" && session.direction === "outbound" && session.ready && !session.activated && session.evidence) {
            await options.store.activateOutbound(verified.auth, message.ready, session.evidence, session.challengeNonce, verified.auth.peerId);
            session.activated = true;
            json(response, { kind: "active" });
            return;
          }

          throw new SyncProtocolError(409, "invalid-history-transition");
        } finally {
          session.busy = false;
        }
      }

      if (endpoint === "holdings") {
        const identities = parseIdentities(await envelope(request, WIRE_LIMITS.offer));
        for (const identity of identities) {
          if (!routeOriginGrant(verified.route, identity.originInboxId)) {
            throw new SyncProtocolError(403, "unauthorized");
          }
        }

        json(response, await options.store.holdingsCut(verified.auth, identities));
        return;
      }

      if (endpoint === "offer") {
        const descriptor = parseOffer(await envelope(request, WIRE_LIMITS.offer));
        checkOrigin(verified.route, descriptor);
        const result = await options.store.apply(verified.auth, descriptor);
        if (result.status !== "needs-body") {
          json(response, result);
          return;
        }

        if (transfers.size >= WIRE_LIMITS.transfers) {
          throw new SyncProtocolError(503, "transfer-capacity");
        }

        const transferId = opaqueToken();
        const expiresAt = Date.now() + leaseMs;
        transfers.set(transferId, { auth: verified.auth, binding: verified.binding, localIncarnation: verified.local.storageIncarnation, state: descriptor, expiresAt });
        json(response, { status: "needs-body", transferId, expiresAt });
        return;
      }

      if (request.method === "PUT") {
        exactQuery(url, ["transferId"]);
        const transferId = parseToken(url.searchParams.get("transferId"));
        const transfer = transfers.get(transferId);
        if (!transfer || transfer.expiresAt <= Date.now()) {
          throw new SyncProtocolError(410, "transfer-expired");
        }

        if (transfer.auth.routeId !== verified.auth.routeId || transfer.auth.revision !== verified.auth.revision || transfer.auth.peerId !== verified.auth.peerId ||
            transfer.binding.callerStorageIncarnation !== verified.binding.callerStorageIncarnation || transfer.localIncarnation !== verified.local.storageIncarnation) {
          throw new SyncProtocolError(403, "unauthorized");
        }

        transfers.delete(transferId);
        if (request.headers["content-type"] !== "application/octet-stream" || contentLength(request, SYNC_LIMITS.htmlBytes) !== transfer.state.byteLength) {
          throw new SyncProtocolError(409, "body-length-conflict");
        }

        if (counters.activeTransfers >= WIRE_LIMITS.bodyTransfers) {
          throw new SyncProtocolError(503, "transfer-capacity");
        }

        counters.activeTransfers += 1;
        async function* chunks() {
          for await (const chunk of request) {
            attempt?.signal.throwIfAborted();
            if (!(chunk instanceof Uint8Array)) {
              throw new SyncProtocolError(409, "invalid-bytes");
            }

            counters.requestBytes += chunk.length;
            yield chunk;
          }
        }

        try {
          json(response, await options.store.applyStream(verified.auth, transfer.state, chunks()));
        } finally {
          counters.activeTransfers -= 1;
        }

        return;
      }

      exactQuery(url, ["sessionId", "originInboxId", "originDocumentId", "fingerprint"]);
      const session = sessionFor(parseToken(url.searchParams.get("sessionId")), verified.auth, verified.binding, verified.local.storageIncarnation);
      const originInboxId = parseUuid(url.searchParams.get("originInboxId"));
      const originDocumentId = parseSafeId(url.searchParams.get("originDocumentId"));
      const fingerprint = parseDigest(url.searchParams.get("fingerprint"));
      if (session.direction !== "outbound" || !session.activated || !session.states.some((state) => state.originInboxId === originInboxId &&
          state.originDocumentId === originDocumentId && stateFingerprint(state) === fingerprint)) {
        throw new SyncProtocolError(403, "unauthorized");
      }

      session.busy = true;
      let finishResponse = () => {};
      const responseClosed = new Promise<null>((resolve) => { finishResponse = () => resolve(null); });
      const destroyResponse = () => response.destroy();
      response.once("close", finishResponse);
      response.once("error", destroyResponse);
      if (response.closed || response.destroyed) {
        finishResponse();
      }

      try {
        attempt.signal.throwIfAborted();
        if (response.closed || response.destroyed) {
          return;
        }

        // Pinning can wait for the store lock. A closed peer must release its HTTP
        // attempt without waiting for that bounded, read-only operation to finish.
        const pin = options.store.pinOutgoing(verified.auth, originInboxId, originDocumentId, fingerprint);
        const document = await Promise.race([pin, responseClosed]);
        if (response.closed || response.destroyed) {
          return;
        }

        if (!document) {
          throw new SyncProtocolError(503, "body-unavailable");
        }

        attempt.signal.throwIfAborted();
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": document.originalBytes.length, "cache-control": "no-store", connection: "close" });
        counters.responseBytes += document.originalBytes.length;
        response.end(document.originalBytes);
        await responseClosed;
      } finally {
        response.removeListener("close", finishResponse);
        response.removeListener("error", destroyResponse);
        session.busy = false;
        if (!response.writableFinished || attempt.signal.aborted || closed) {
          sessions.delete(session.id);
        }
      }
    } catch (error) {
      counters.rejected += 1;
      const failure = protocolFailure(error, authorized);
      if (!response.headersSent && !response.destroyed) {
        const body = Buffer.from(JSON.stringify({ error: failure.code }));
        response.writeHead(failure.status, { "content-type": "application/json", "content-length": body.length, connection: "close", "cache-control": "no-store" });
        response.end(body);
      } else {
        response.destroy();
      }
    } finally {
      try {
        attempt?.signal.removeEventListener("abort", abortResponse);
        attempt?.close();
      } finally {
        counters.activeRequests -= 1;
      }
    }
  }

  function close(): Promise<void> {
    return closing ??= (async () => {
      closed = true;
      sessions.clear();
      transfers.clear();
      const listener = (async () => {
        // Await native binding, rather than public start, which rejects when close wins.
        // A failed bind stays the start caller's error and leaves no bound listener.
        await binding?.catch(() => {});
        for (const socket of sockets) {
          socket.destroy();
        }

        if (server.listening) {
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      })();
      const settled = Promise.allSettled([listener, ...handlers]).then((results) => {
        const failures = [...handlerFailures];
        for (const result of results) {
          if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
        }

        if (failures.length > 1) throw new AggregateError(failures, "Sync ingestion shutdown failed");
        if (failures.length === 1) throw failures[0];
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Sockets can close before admitted store mutations finish. The existing
        // request bound limits shutdown without abandoning those handler promises.
        await Promise.race([settled, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Sync ingestion shutdown did not drain admitted handlers")), requestMs);
        })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
  }

  return {
    async start(): Promise<{ url: string }> {
      if (closed || binding || origin) {
        throw new Error("Sync ingestion server is already started or closed");
      }

      binding = new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
      });
      await binding;
      if (closed) {
        throw new Error("Sync ingestion server is already started or closed");
      }

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Sync ingestion did not obtain a loopback port");
      }

      origin = `https://${isIP(host) === 6 ? `[${host}]` : host}:${address.port}`;
      return { url: origin };
    },
    close,
    invalidateRoute(routeId: string) {
      parseUuid(routeId);
      for (const [id, session] of sessions) {
        if (session.auth.routeId === routeId) sessions.delete(id);
      }

      for (const [id, transfer] of transfers) {
        if (transfer.auth.routeId === routeId) transfers.delete(id);
      }
    },
    status() {
      purgeExpired();
      return { listening: server.listening, url: origin, sessions: sessions.size, transfers: transfers.size, sockets: sockets.size,
        cachedBytes: [...sessions.values()].reduce((sum, session) => sum + session.bytes, 0), counters: { ...counters } };
    },
  };
}

function exactQuery(url: URL, keys: string[]): void {
  const entries = [...url.searchParams.keys()];
  if (entries.length !== keys.length || keys.some((key) => !url.searchParams.has(key))) {
    throw new SyncProtocolError(403, "unauthorized");
  }
}

function checkOrigin(route: SyncRoute, state: OriginState): void {
  if (!routeOriginGrant(route, state.originInboxId, state.historyEpoch)) {
    throw new SyncProtocolError(403, "unauthorized");
  }
}

function protocolFailure(error: unknown, authorized: boolean): SyncProtocolError {
  // Admission happens before identity lookup. Its one public result conveys no
  // route, credential or document information and must remain transient.
  if (error instanceof SyncProtocolError && error.status === 503 && error.code === "request-capacity") {
    return error;
  }

  if (!authorized) {
    return new SyncProtocolError(403, "unauthorized");
  }

  if (error instanceof SyncProtocolError) {
    return error;
  }

  if (error instanceof IncompleteSyncHistoryError) {
    return new SyncProtocolError(409, SYNC_HISTORY_UNAVAILABLE);
  }

  const message = error instanceof Error ? error.message : "";
  if (/Revoked|route authorization|Origin or redistribution|signature/.test(message)) {
    return new SyncProtocolError(403, "unauthorized");
  }

  if (/quota|capacity|exceeds|bounded (array|integer)/.test(message)) {
    return new SyncProtocolError(413, "resource-limit");
  }

  if (/fsync|uncertain|recovery|EIO|ENOSPC|lock deadline/.test(message)) {
    return new SyncProtocolError(503, "storage-unavailable");
  }

  return new SyncProtocolError(409, "state-or-envelope-conflict");
}

/** Configuration validation performs no bind, lookup, interface discovery or fallback. */
export function validateSyncListenHost(host: string): string {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    if (octets[0] === 0 || octets[0] >= 224 || host === "255.255.255.255") {
      throw new Error("Sync ingestion requires an explicit literal unicast IP address");
    }

    return host;
  }

  if (family === 6 && !host.includes("%")) {
    const normalized = new URL(`https://[${host}]`).hostname.slice(1, -1);
    if (normalized !== "::" && !normalized.startsWith("ff") && !normalized.startsWith("::ffff:")) {
      return normalized;
    }

    if (normalized.startsWith("::ffff:")) {
      const words = normalized.slice(7).split(":").map((word) => Number.parseInt(word, 16));
      if (words.length === 2) {
        validateSyncListenHost(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
        return normalized;
      }
    }
  }

  throw new Error("Sync ingestion requires an explicit literal unicast IP address");
}
