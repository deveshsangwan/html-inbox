import { performance } from "node:perf_hooks";
import { type SyncCredentialResolver, SyncClient, type SyncRequestOptions } from "./sync-client";
import { outboxKey, type DurableReceipt } from "./sync-ledger";
import { canonicalKey, parseInteger, parseObject, assertExactKeys, parseChoice, parseUuid, stateFingerprint, sameImmutableDescriptor, verifyOriginState, SYNC_DEFAULTS, SYNC_LIMITS,
  type CompleteInventory, type OriginState, type RouteAuthorization, type SyncRoute } from "./sync-model";
import { ManagedSyncStore, type InventoryReadiness } from "./sync-store";
import { classifySyncFailure, isBlockedRouteFailure } from "./sync-failure";
import { routeOriginGrant } from "./sync-ledger-policy";
import { createEvidence, opaqueToken, parseHoldingsResponse, parseIdentityResponse, parseManifestPage, parseOfferResponse, parseReadiness, scopeDigest,
  SyncProtocolError, validatePageProgress, WIRE_LIMITS, type IdentityResponse, type ManifestPage } from "./sync-wire";

export interface ReconcileOptions {
  store: ManagedSyncStore;
  peerId: string;
  credentials: SyncCredentialResolver;
  routeIds: string[];
  signal?: AbortSignal;
  requestMs?: number;
  deadlineMs?: number;
  deadlineAt?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  random?: () => number;
}

export interface RouteReconciliation {
  routeId: string;
  direction: SyncRoute["direction"];
  status: "confirmed" | "pending" | "blocked" | "detached" | "aborted";
  historyReady: boolean;
  fullyReconciled: boolean;
  transferred: number;
  confirmed: number;
  pending: number;
  blocked: number;
  lastError: string | null;
}

interface ReconciliationSession extends IdentityResponse {
  localLeaseDeadline: number;
}

/** One finite catch-up pass. Calling this does not enable, schedule or own a background worker. */
export async function reconcileSyncRoutes(options: ReconcileOptions) {
  const peerId = parseUuid(options.peerId);
  if (!Array.isArray(options.routeIds) || !options.routeIds.length || options.routeIds.length > 128 || new Set(options.routeIds).size !== options.routeIds.length) {
    throw new Error("Reconciliation requires 1 to 128 distinct explicit route IDs");
  }

  const routeIds = options.routeIds.map(parseUuid);
  const requestMs = parseInteger(options.requestMs ?? SYNC_DEFAULTS.attemptMs, 1, 60_000);
  const deadlineMs = parseInteger(options.deadlineMs ?? SYNC_DEFAULTS.foregroundMs, 1, 300_000);
  const deadlineAt = Math.min(options.deadlineAt === undefined ? Date.now() + deadlineMs : parseInteger(options.deadlineAt, 1), Date.now() + deadlineMs);
  const retryMinMs = parseInteger(options.retryMinMs ?? SYNC_DEFAULTS.retryMinMs, 1, 300_000);
  const retryMaxMs = parseInteger(options.retryMaxMs ?? SYNC_DEFAULTS.retryMaxMs, retryMinMs, 300_000);
  const maxAttempts = parseInteger(options.maxAttempts ?? SYNC_DEFAULTS.maxAttempts, 1, 1000);
  const client = new SyncClient(options.store, peerId, options.credentials);
  const sessions = new Map<string, ReconciliationSession>();
  const results: RouteReconciliation[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Reconciliation aborted"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }

  const timer = setTimeout(abort, Math.max(1, deadlineAt - Date.now()));
  try {
    for (const routeId of routeIds) {
      const ledger = await options.store.snapshot();
      const route = ledger.routes[routeId];
      if (!route) {
        throw new Error("Unknown explicit sync route");
      }

      const result: RouteReconciliation = { routeId, direction: route.direction, status: "pending", historyReady: false, fullyReconciled: false,
        transferred: 0, confirmed: 0, pending: 0, blocked: 0, lastError: null };
      results.push(result);
      if (route.state === "detached" || route.state === "blocked" || isBlockedRouteFailure(route.lastError)) {
        result.status = route.state === "detached" ? "detached" : "blocked";
        result.lastError = route.lastError;
        continue;
      }

      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        result.status = "aborted";
        continue;
      }

      const auth = routeAuthorization(route);
      const attempt = await options.store.openRouteAttempt(auth, controller.signal, deadlineAt, true);
      const requestOptions = { requestMs, deadlineAt, signal: attempt.signal };
      try {
        if (route.direction === "outbound") {
          await push(route, auth, requestOptions, result);
        } else {
          await pull(route, auth, requestOptions, result);
        }

        await options.store.setRouteError(auth, null);
      } catch (error) {
        result.status = attempt.signal.aborted ? "aborted" : isHistoryUnavailable(error) || isPermanent(error) ? "blocked" : "pending";
        result.lastError = safeError(error);
        // Revocation may have invalidated this authorization. It must never be revived to record an error.
        if (!attempt.signal.aborted && Date.now() < deadlineAt) {
          await options.store.setRouteError(auth, result.lastError).catch(() => {});
        }

        if (route.direction === "outbound" && !attempt.signal.aborted && !isHistoryUnavailable(error)) {
          const current = await options.store.snapshot();
          for (const [key, entry] of Object.entries(current.outbox)) {
            if (attempt.signal.aborted || Date.now() >= deadlineAt) {
              break;
            }

            if (entry.routeId === route.id && entry.revision === route.revision && entry.disposition === "pending" && entry.nextAttemptAt <= Date.now()) {
              await recordFailure(auth, key, entry.canonicalKey, entry.attempts, error);
            }
          }
        }
      } finally {
        const session = sessions.get(route.id);
        if (session && !attempt.signal.aborted && Date.now() < deadlineAt && session.localLeaseDeadline > performance.now()) {
          // Completion releases cached inventory. A lost completion is still bounded
          // by its lease and must not erase an already persisted receipt.
          await client.json(auth, "manifest", { op: "complete", sessionId: session.sessionId }, parseComplete, WIRE_LIMITS.identity, requestOptions).catch(() => {});
        }

        // Awaited bookkeeping or completion can be the first observer of cancellation.
        if (attempt.signal.aborted) {
          result.status = "aborted";
        }

        attempt.close();
      }

      const current = await options.store.snapshot();
      const entries = Object.values(current.outbox).filter((entry) => entry.routeId === route.id && entry.revision === route.revision);
      result.pending = entries.filter((entry) => entry.disposition === "pending").length;
      result.blocked = entries.filter((entry) => entry.disposition === "blocked").length;
      if (route.direction === "outbound" && result.status !== "aborted" && !result.lastError) {
        result.status = result.blocked ? "blocked" : result.pending ? "pending" : "confirmed";
      }
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }

  return { routes: results, counters: { ...client.counters } };

  async function identity(route: SyncRoute, auth: RouteAuthorization, requestOptions: SyncRequestOptions) {
    const nonce = opaqueToken();

    // Remote expiresAt belongs to the receiver's wall clock. Bound our use by
    // elapsed local time from before the request; the receiver enforces its own expiry.
    const localLeaseDeadline = performance.now() + SYNC_LIMITS.manifestLeaseMs;
    const response = await client.json(auth, "identity", { nonce }, parseIdentityResponse, WIRE_LIMITS.identity, requestOptions);
    const expectedInbox = route.direction === "outbound" ? route.destinationInboxId : route.sourceInboxId;
    if (response.requestNonce !== nonce || response.peerId !== route.peerId || response.inboxId !== expectedInbox || response.scopeDigest !== scopeDigest(route)) {
      throw new SyncProtocolError(409, "peer-identity-conflict");
    }

    const session = { ...response, localLeaseDeadline };
    checkSession(session);
    sessions.set(route.id, session);
    return { response: session, nonce };
  }

  async function push(route: SyncRoute, auth: RouteAuthorization, requestOptions: SyncRequestOptions, result: RouteReconciliation) {
    const { response: session, nonce } = await identity(route, auth, requestOptions);
    for (const terminal of await options.store.pendingTerminalStates(auth)) {
      requestOptions.signal?.throwIfAborted();
      if (Date.now() >= deadlineAt) {
        throw new SyncProtocolError(503, "pass-deadline");
      }

      try {
        const response = await client.json(auth, "offer", { descriptor: terminal }, parseOfferResponse, WIRE_LIMITS.offer, requestOptions);
        if (response.status === "needs-body") {
          throw new SyncProtocolError(409, "terminal-body-requested");
        }

        validateReceipt(route, response.receipt, session.storageIncarnation);
        if (response.receipt.fingerprint !== stateFingerprint(terminal)) {
          await options.store.observeOutboundState(auth, response.receipt.originState);
        } else {
          await options.store.acknowledge(auth, response.receipt);
          result.confirmed += 1;
        }
      } catch (error) {
        if (requestOptions.signal?.aborted) {
          throw error;
        }

        const key = canonicalKey(terminal.originInboxId, terminal.originDocumentId);
        const entry = (await options.store.snapshot()).outbox[outboxKey(route.id, route.revision, key)];
        await recordFailure(auth, outboxKey(route.id, route.revision, key), key, entry?.attempts ?? 0, error);
        // Transport/authorization failures remain distinct from a local history-only fence.
        throw error;
      }
    }

    const cut = await options.store.inventory(auth);
    const evidence = createEvidence(route, peerId, session.challengeNonce, cut);
    for (let offset = 0; offset < Math.max(1, cut.states.length); offset += SYNC_LIMITS.manifestPage) {
      checkSession(session);
      const page = { evidence, pageNumber: offset / SYNC_LIMITS.manifestPage, descriptors: cut.states.slice(offset, offset + SYNC_LIMITS.manifestPage),
        nextCursor: offset + SYNC_LIMITS.manifestPage < cut.states.length ? opaqueToken() : null };
      if (page.nextCursor) {
        await client.json(auth, "manifest", { op: "push", sessionId: session.sessionId, page }, parseContinue, WIRE_LIMITS.readiness, requestOptions);
      } else {
        const ready = await client.json(auth, "manifest", { op: "push", sessionId: session.sessionId, page }, parseReadiness, WIRE_LIMITS.readiness, requestOptions);
        if (ready.storageIncarnation !== session.storageIncarnation) {
          throw new SyncProtocolError(409, "receiver-incarnation-changed");
        }

        await options.store.activateOutbound(auth, ready, evidence, nonce, route.peerId);
      }
    }

    result.historyReady = true;
    // Scan the authorized inventory even when completed entries were physically removed from the outbox.
    const current = await options.store.inventory(auth);
    for (let offset = 0; offset < current.states.length; offset += SYNC_LIMITS.manifestPage) {
      const states = current.states.slice(offset, offset + SYNC_LIMITS.manifestPage);
      const identities = states.map((state) => ({ originInboxId: state.originInboxId, originDocumentId: state.originDocumentId }));
      const holdings = await client.json(auth, "holdings", { identities }, parseHoldingsResponse, WIRE_LIMITS.holdings, requestOptions);
      if (holdings.holdings.length !== states.length) {
        throw new SyncProtocolError(409, "incomplete-holdings");
      }

      for (const [index, holding] of holdings.holdings.entries()) {
        const state = states[index];
        if (holding.state) {
          verifyRemoteState(route, holding.state, state);
          if (holding.state.state === "deleted" && stateFingerprint(holding.state) !== stateFingerprint(state)) {
            await options.store.observeOutboundState(auth, holding.state);
          }
        }
      }

      await options.store.reconcileHoldings(auth, holdings.holdings.map((holding, index) => ({ ...identities[index],
        fingerprint: holding.state ? stateFingerprint(holding.state) : null, available: holding.available, suppressed: holding.suppressed, storageIncarnation: holdings.storageIncarnation })));
      for (const [index, holding] of holdings.holdings.entries()) {
        for (const receipt of holding.receipts) {
          validateReceipt(route, receipt, holdings.storageIncarnation);
          if (receipt.fingerprint === stateFingerprint(states[index]) && (receipt.disposition !== "committed" || holding.available)) {
            await options.store.acknowledge(auth, receipt);
          }
        }
      }
    }

    const ledger = await options.store.snapshot();
    const entries = Object.values(ledger.outbox).filter((entry) => entry.routeId === route.id && entry.revision === route.revision &&
      entry.disposition === "pending" && entry.nextAttemptAt <= Date.now());
    for (const entry of entries) {
      requestOptions.signal?.throwIfAborted();
      const record = ledger.records[entry.canonicalKey];
      if (!record || stateFingerprint(record) !== entry.fingerprint) {
        continue;
      }

      const state = (await options.store.inventory(auth)).states.find((state) => canonicalKey(state.originInboxId, state.originDocumentId) === entry.canonicalKey);
      if (!state || stateFingerprint(state) !== entry.fingerprint) {
        continue;
      }

      try {
        let response = await client.json(auth, "offer", { descriptor: state }, parseOfferResponse, WIRE_LIMITS.offer, requestOptions);
        if (response.status === "needs-body") {
          const document = await options.store.pinOutgoing(auth, state.originInboxId, state.originDocumentId, stateFingerprint(state));
          if (!document) {
            throw new SyncProtocolError(409, "source-body-unavailable");
          }

          response = parseOfferResponse(await client.putBody(auth, response.transferId, state, document.originalBytes, requestOptions));
          result.transferred += 1;
        }

        if (response.status === "needs-body") {
          throw new SyncProtocolError(409, "body-not-committed");
        }

        validateReceipt(route, response.receipt, session.storageIncarnation);
        if (response.receipt.fingerprint !== stateFingerprint(state)) {
          await options.store.observeOutboundState(auth, response.receipt.originState);
          continue;
        }

        await options.store.acknowledge(auth, response.receipt);
        result.confirmed += 1;
      } catch (error) {
        if (requestOptions.signal?.aborted) {
          throw error;
        }

        await recordFailure(auth, outboxKey(route.id, route.revision, entry.canonicalKey), entry.canonicalKey, entry.attempts, error);
        result.lastError = safeError(error);
      }
    }
  }

  async function pull(route: SyncRoute, auth: RouteAuthorization, requestOptions: SyncRequestOptions, result: RouteReconciliation) {
    const { response: session, nonce } = await identity(route, auth, requestOptions);
    const states: OriginState[] = [];
    let evidence: CompleteInventory | undefined;
    let cursor: string | null = null;
    let bytes = 0;
    let pageNumber = 0;
    do {
      checkSession(session);
      const page: ManifestPage = await client.json<ManifestPage>(auth, "manifest", { op: "pull", sessionId: session.sessionId, cursor }, parseManifestPage, WIRE_LIMITS.page, requestOptions);
      validatePageProgress(page, states, pageNumber, evidence);
      if (page.evidence.nonce !== nonce || page.evidence.peerId !== route.peerId || page.evidence.routeId !== route.id || page.evidence.revision !== route.revision) {
        throw new SyncProtocolError(409, "challenge-conflict");
      }

      bytes += Buffer.byteLength(JSON.stringify(page.descriptors));
      if (bytes > SYNC_LIMITS.ledgerBytes) {
        throw new SyncProtocolError(413, "inventory-limit");
      }

      for (const state of page.descriptors) {
        verifyRemoteState(route, state);
        if (state.state === "deleted") {
          await options.store.apply(auth, state);
        }
      }

      evidence = page.evidence;
      states.push(...page.descriptors);
      cursor = page.nextCursor;
      pageNumber += 1;
    } while (cursor !== null);
    if (!evidence) {
      throw new SyncProtocolError(409, "incomplete-history");
    }

    await options.store.completeInventory(auth, evidence, states, nonce);
    result.historyReady = true;
    const local = await options.store.snapshot();
    const ready: InventoryReadiness = { kind: "terminal-inventory-ready", evidence, ackNonce: session.challengeNonce, receiverPeerId: peerId,
      destinationInboxId: route.destinationInboxId, storageIncarnation: local.storageIncarnation };
    await client.json(auth, "manifest", { op: "ready", sessionId: session.sessionId, ready }, parseActive, WIRE_LIMITS.identity, requestOptions);
    for (const state of states) {
      requestOptions.signal?.throwIfAborted();
      if (state.state === "deleted") {
        continue;
      }

      let applied = await options.store.apply(auth, state);
      if (applied.status === "needs-body") {
        checkSession(session);
        applied = await client.pullBody(auth, session.sessionId, state, requestOptions);
        result.transferred += 1;
      }

      if (applied.status === "needs-body") {
        throw new SyncProtocolError(409, "body-not-committed");
      }

      result.confirmed += 1;
    }

    result.fullyReconciled = await options.store.completeReconciliation(auth, evidence, states);
    result.status = result.fullyReconciled ? "confirmed" : "pending";
  }

  async function recordFailure(auth: RouteAuthorization, entryKey: string, key: string, attempts: number, error: unknown) {
    if (controller.signal.aborted || Date.now() >= deadlineAt || isHistoryUnavailable(error)) {
      return;
    }

    const current = (await options.store.snapshot()).outbox[entryKey];
    if (!current || current.disposition !== "pending") {
      return;
    }

    const random = options.random?.() ?? Math.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new Error("Retry jitter must be between zero and one");
    }

    const delay = Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(attempts, 30));
    if (controller.signal.aborted || Date.now() >= deadlineAt) {
      return;
    }

    await options.store.updateAttempt(auth, key, { nextAttemptAt: Date.now() + Math.max(1, Math.round(delay * (0.5 + random * 0.5))),
      lastError: safeError(error), blocked: isPermanent(error) || attempts + 1 >= maxAttempts, maxAttempts });
  }
}

export function routeAuthorization(route: SyncRoute): RouteAuthorization {
  return { routeId: route.id, revision: route.revision, peerId: route.peerId, sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId };
}

function verifyRemoteState(route: SyncRoute, state: OriginState, expected?: OriginState): void {
  const grant = routeOriginGrant(route, state.originInboxId, state.historyEpoch);
  if (!grant || expected && (state.originInboxId !== expected.originInboxId || state.originDocumentId !== expected.originDocumentId || !sameImmutableDescriptor(state, expected))) {
    throw new SyncProtocolError(403, "origin-scope-conflict");
  }

  verifyOriginState(state, grant.publicKey);
}

function validateReceipt(route: SyncRoute, receipt: DurableReceipt, storageIncarnation: string): void {
  verifyRemoteState(route, receipt.originState);
  if (receipt.receiverInboxId !== route.destinationInboxId || receipt.destinationInboxId !== route.destinationInboxId || receipt.routeId !== route.id ||
      receipt.revision !== route.revision || receipt.storageIncarnation !== storageIncarnation) {
    throw new SyncProtocolError(409, "receipt-binding-conflict");
  }
}

function checkSession(session: ReconciliationSession): void {
  if (session.localLeaseDeadline <= performance.now()) {
    throw new SyncProtocolError(410, "session-expired");
  }
}

function parseContinue(value: unknown) {
  const record = parseObject(value, "manifest continuation");
  assertExactKeys(record, ["kind"]);
  return { kind: parseChoice(record.kind, ["continue"]) };
}

function parseActive(value: unknown) {
  const record = parseObject(value, "manifest activation");
  assertExactKeys(record, ["kind"]);
  return { kind: parseChoice(record.kind, ["active"]) };
}

function parseComplete(value: unknown) {
  const record = parseObject(value, "session completion");
  assertExactKeys(record, ["kind"]);
  return { kind: parseChoice(record.kind, ["complete"]) };
}

function isPermanent(error: unknown): boolean {
  return classifySyncFailure(error).kind === "blocked";
}

function safeError(error: unknown): string {
  return classifySyncFailure(error).code;
}

function isHistoryUnavailable(error: unknown): boolean {
  return classifySyncFailure(error).kind === "history";
}
