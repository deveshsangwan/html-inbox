import { parseRuntimeConfig, parseSyncTarget, defaultRuntimeConfig, type SyncTarget } from "./sync-runtime-config";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { readBoundedFile } from "./bounded-file";
import { parseDocumentMetadata, type DocumentMetadata, type PublishInput, type StoredDocument, type DeleteResult } from "./documents";
import { validateHtml } from "./html-validation";
import { readInboxIdentity } from "./inbox-home";
import { DurableFiles, checkDirectory, createStorageCounters, hasCode, openPrivateFile, optionalStat, readPrivateFile, withStoreLock, type StorageTestHooks } from "./sync-files";
import { type SyncLedger, type ManagedRecord, type DurableReceipt, type OwnerAnchor, parseLedger, parseReceipt, outboxKey, receiptKey } from "./sync-ledger";
import { readManagedLedgerBytes } from "./sync-ledger-reader";
import { type OriginState, type OriginGrant, type SyncRoute, type RouteAuthorization, type CompleteInventory, SYNC_LIMITS, SYNC_DEFAULTS, IncompleteSyncHistoryError, canonicalKey, metadataEncoding, metadataProjection,
  parseOriginState, parseOriginalMetadata, parseAuthorization, parseRoute, parseCompleteInventory, sha256, signOriginState, stateFingerprint, sameImmutableDescriptor, verifyOriginState,
  inventoryDigest, parseInteger, parseObject, parseSafeId, parseUuid } from "./sync-model";

import { SyncStaging } from "./sync-staging";
import { canForwardRecord, currentCustodyReceipt, detachLedgerRoute, fenceLedgerRoute, hasTrustedOriginHistory, nextRouteRetry, pinnedOriginGrant, pinnedStateGrant, queueLedgerState } from "./sync-ledger-policy";

export const MANAGED_FORMAT_BARRIER = "HTML Inbox managed store v2\nUse an upgraded HTML Inbox client.\n";

export interface ManagedStoreOptions {
  lockDeadlineMs?: number;
  testHooks?: StorageTestHooks;
}

export type ApplyResult = { status: "needs-body" } | { status: "committed" | "deleted" | "suppressed" | "superseded"; receipt: DurableReceipt };

export interface Holding {
  state: OriginState | null;
  available: boolean;
  suppressed: boolean;
  receipts: DurableReceipt[];
}

export interface HoldingsCut {
  storageIncarnation: string;
  holdings: Holding[];
}

export interface InventoryReadiness {
  kind: "terminal-inventory-ready";
  evidence: CompleteInventory;
  ackNonce: string;
  receiverPeerId: string;
  destinationInboxId: string;
  storageIncarnation: string;
}

const activeAttempts = new Map<string, Set<{ routeId: string; revision: number; controller: AbortController }>>();

/** One inbox, one mutation lock. HTTP push and pull must both use apply/applyStream. */
export class ManagedSyncStore {
  readonly counters = createStorageCounters();
  private readonly files: DurableFiles;
  private readonly staging: SyncStaging;
  private readonly home: string;
  private readonly directory: string;
  private readonly lockDeadlineMs: number;
  private recovered = false;

  constructor(home: string, options: ManagedStoreOptions = {}) {
    if (!path.isAbsolute(home) || path.resolve(home) !== home || home.includes("\0")) {
      throw new Error("Managed store home must be an absolute canonical path");
    }

    this.home = home;
    this.directory = path.join(home, "sync");
    this.lockDeadlineMs = parseInteger(options.lockDeadlineMs ?? SYNC_DEFAULTS.lockDeadlineMs, 1, 60_000);
    this.files = new DurableFiles(this.counters, options.testHooks ?? {}, home);
    this.staging = new SyncStaging(this.stageDirectory(), this.files);
  }

  static async isEnrolled(home: string): Promise<boolean> {
    const directory = await optionalStat(path.join(home, "sync"));
    if (!directory || !directory.isDirectory() || directory.isSymbolicLink() || !await optionalStat(path.join(home, "sync", "ledger.json"))) {
      return false;
    }

    await checkDirectory(path.join(home, "sync"));
    return true;
  }

  async enroll(): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("Managed enrollment requires local POSIX file/directory fsync and atomic rename support");
    }

    await this.files.directory(this.home);
    await this.files.flushDirectory(path.dirname(this.home));
    await this.files.directory(this.directory);
    await chmod(this.directory, 0o700);
    await withStoreLock(this.directory, this.lockDeadlineMs, async () => {
      await this.prepareManagedDirectories();
      if (!await optionalStat(this.ledgerPath())) {
        const documents = await optionalStat(path.join(this.home, "documents"));
        if (documents && !documents.isDirectory() || await optionalStat(path.join(this.directory, "legacy-documents")) || (await readdir(this.bodyDirectory())).length) {
          throw new Error("Managed artifacts exist without their authoritative ledger; enrollment cannot invent replacement history");
        }

        const inboxId = await readInboxIdentity(this.home) ?? randomUUID();
        if (!await readInboxIdentity(this.home)) {
          await this.files.exclusiveFile(path.join(this.home, "instance-id"), `${inboxId}\n`);
        }

        await this.files.flushFile(path.join(this.home, "instance-id"), 128);

        const historyEpoch = randomUUID();
        const owner = await this.createOwnerKey(inboxId, historyEpoch);
        const ledger: SyncLedger = { schemaVersion: 1, routeRetries: {}, runtime: null, publicationIntents: {}, inboxId, historyEpoch, storageIncarnation: randomUUID(), ownerAnchor: await this.currentAnchor(),
          generation: 0, nextOriginVersion: 1, originKeys: [owner], records: {}, routes: {}, outbox: {}, receipts: {}, checkpoints: {}, historyCheckpoints: {},
          migration: { phase: "intent", enrolledIds: [] },
          worker: { enabled: false, retryPaused: false, ownerQuarantined: false, bootSupervised: false, lastRunAt: null, lastError: null } };
        await this.commit(ledger);
        await this.files.event("migration-intent");
      }

      await this.recoverLocked();
    });
  }

  async recover(): Promise<void> {
    await checkDirectory(this.directory);
    await withStoreLock(this.directory, this.lockDeadlineMs, () => this.recoverLocked());
  }

  async snapshot(): Promise<SyncLedger> {
    await checkDirectory(this.home);
    const directory = await checkDirectory(this.directory);
    if ((directory.mode & 0o077) !== 0) {
      throw new Error("Managed store directory must be private; mutable recovery can harden it");
    }

    const ledger = await this.readLedger();
    await this.assertAnchor(ledger);
    await this.assertBarrier(ledger);
    await this.assertReaderIdentity(ledger);
    await checkDirectory(this.bodyDirectory());
    await checkDirectory(this.stageDirectory());
    return ledger;
  }

  async publish(input: PublishInput, documentId: string = randomUUID()): Promise<DocumentMetadata> {
    return (await this.publishWithIntent(input, undefined, documentId)).metadata;
  }

  async publishWithIntent(input: PublishInput, targetOverride?: SyncTarget | null, documentId: string = randomUUID()) {
    const explicitTarget = targetOverride === undefined || targetOverride === null ? targetOverride : parseSyncTarget(targetOverride);
    const bytes = Buffer.from(input.originalBytes);
    const metadata = parseOriginalMetadata({ schemaVersion: 1, id: documentId, title: input.title, type: input.type,
      createdAt: new Date().toISOString(), sourceFileName: input.sourceFileName });
    validateBody(bytes);
    const bodyHash = this.hashBody(bytes);

    return this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      const key = canonicalKey(ledger.inboxId, metadata.id);
      if (ledger.records[key]) {
        throw new Error("Original document identity already exists, including terminal history");
      }

      this.assertCapacity(ledger);
      const state = signOriginState({ originInboxId: ledger.inboxId, originDocumentId: metadata.id, historyEpoch: ledger.historyEpoch,
        version: this.allocateVersion(ledger), state: "live", metadata, sha256: bodyHash, byteLength: bytes.length, metadataSha256: sha256(metadataEncoding(metadata)) }, await this.ownerKey(ledger));
      const staged = await this.stageBuffer(bytes);
      const bodyFile = await this.installBody(staged);
      const record: ManagedRecord = { ...state, localId: this.allocateLocalId(ledger, metadata.id), bodyFile, contributions: [], suppressed: false, provenance: [] };
      ledger.records[key] = record;
      const target = explicitTarget === undefined ? ledger.runtime?.config.intendedTarget ?? null : explicitTarget;
      ledger.publicationIntents[key] = target;
      queueLedgerState(ledger, key);
      await this.commit(ledger);
      return { metadata: readerMetadata(record, ledger.inboxId), origin: toOriginState(record), fingerprint: stateFingerprint(record), target, timings: ledger.runtime?.config.timings ?? defaultRuntimeConfig().timings,
        queued: Object.values(ledger.outbox).some((entry) => entry.canonicalKey === key && entry.disposition !== "retired"), committedAt: Date.now() };
    });
  }

  async deleteDocument(localId: string): Promise<DeleteResult | null> {
    parseSafeId(localId);
    return this.mutate(async (ledger) => {
      const record = Object.values(ledger.records).find((record) => record.localId === localId);
      if (!record || record.state === "deleted" || record.suppressed) {
        return null;
      }

      const metadata = readerMetadata(record, ledger.inboxId);
      if (record.originInboxId !== ledger.inboxId) {
        record.suppressed = true;
      } else {
        this.assertOwnerWritable(ledger);
        Object.assign(record, signOriginState({ ...toOriginState(record), version: this.allocateVersion(ledger), state: "deleted" }, await this.ownerKey(ledger)));
        queueLedgerState(ledger, canonicalKey(record.originInboxId, record.originDocumentId));
      }

      await this.commit(ledger);
      // Bodies remain pinned. General reclamation is deliberately deferred.
      return { metadata, reclaimedBytes: 0 };
    });
  }

  async setSuppressed(localId: string, suppressed: boolean): Promise<void> {
    parseSafeId(localId);
    if (typeof suppressed !== "boolean") {
      throw new Error("Suppression must be boolean");
    }

    await this.mutate(async (ledger) => {
      const record = Object.values(ledger.records).find((record) => record.localId === localId);
      if (!record || record.originInboxId === ledger.inboxId) {
        throw new Error("Local suppression requires an imported record");
      }

      record.suppressed = suppressed;
      queueLedgerState(ledger, canonicalKey(record.originInboxId, record.originDocumentId));
      await this.commit(ledger);
    });
  }

  async configureRoute(value: unknown): Promise<SyncRoute> {
    const route = parseRoute(value);
    return this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      if ((route.direction === "inbound" ? route.destinationInboxId : route.sourceInboxId) !== ledger.inboxId) {
        throw new Error("Route targets a different local inbox identity");
      }

      const previous = ledger.routes[route.id];
      if (previous && route.revision !== previous.revision + 1 || !previous && route.revision !== 1) {
        throw new Error("Route revisions must advance exactly once");
      }

      if (previous && (route.peerId !== previous.peerId || route.direction !== previous.direction ||
          route.sourceInboxId !== previous.sourceInboxId || route.destinationInboxId !== previous.destinationInboxId)) {
        throw new Error("Route identity cannot be rebound; create a new route");
      }

      if (previous) {
        detachLedgerRoute(ledger, previous.id);
      }

      route.state = route.state === "detached" ? "detached" : "reconnecting";

      for (const grant of route.allowedOrigins) {
        const known = ledger.originKeys.find((key) => key.inboxId === grant.inboxId);
        if (known && (known.historyEpoch !== grant.historyEpoch || known.publicKey !== grant.publicKey)) {
          throw new Error("Origin key or history epoch transition requires trusted owner recovery");
        }

        if (!known) {
          ledger.originKeys.push({ ...grant, completeHistory: false, redistribute: false });
        }
      }

      ledger.routes[route.id] = route;
      delete ledger.routeRetries[route.id];
      for (const key of Object.keys(ledger.records)) {
        queueLedgerState(ledger, key);
      }

      await this.commit(ledger);
      return route;
    });
  }

  async revokeRoute(routeId: string, revision: number): Promise<void> {
    parseUuid(routeId);
    parseInteger(revision, 1);
    await this.mutate(async (ledger) => {
      const route = ledger.routes[routeId];
      if (!route || route.revision !== revision) {
        throw new Error("Stale route revision");
      }

      fenceLedgerRoute(ledger, route, "detached", null);
      for (const key of Object.keys(ledger.records)) {
        queueLedgerState(ledger, key);
      }

      await this.commit(ledger);
    });
  }

  async apply(authorization: unknown, descriptor: unknown, body?: Buffer): Promise<ApplyResult> {
    const owned = body === undefined ? undefined : Buffer.from(body);
    const auth = parseAuthorization(authorization);
    const state = parseOriginState(descriptor);
    if (owned) {
      validateBody(owned);
      if (owned.length !== state.byteLength || this.hashBody(owned) !== state.sha256) {
        throw new Error("Incoming body digest or length conflict");
      }
    }

    if (!owned) {
      return this.applyStaged(auth, state);
    }

    const staged = await this.mutate(async (ledger) => {
      this.authorize(ledger, auth, state, "inbound");
      return this.staging.reserve(state.byteLength);
    });
    try {
      await this.stageBuffer(owned, true, staged);
      return await this.applyStaged(auth, state, staged);
    } finally {
      await this.releaseStage(staged);
    }
  }

  async applyStream(authorization: unknown, descriptor: unknown, chunks: AsyncIterable<Uint8Array>): Promise<ApplyResult> {
    const auth = parseAuthorization(authorization);
    const state = parseOriginState(descriptor);
    const staged = await this.mutate(async (ledger) => {
      this.authorize(ledger, auth, state, "inbound");
      return this.staging.reserve(state.byteLength);
    });
    try {
      await this.stageStream(chunks, state, staged);
      return await this.applyStaged(auth, state, staged);
    } finally {
      await this.releaseStage(staged);
    }
  }

  async holdings(authorization: unknown, identities: { originInboxId: string; originDocumentId: string }[]): Promise<Holding[]> {
    return (await this.holdingsCut(authorization, identities)).holdings;
  }

  async holdingsCut(authorization: unknown, identities: { originInboxId: string; originDocumentId: string }[]): Promise<HoldingsCut> {
    const auth = parseAuthorization(authorization);
    if (!Array.isArray(identities) || identities.length > SYNC_LIMITS.manifestPage) {
      throw new Error("Holding query exceeds page limit");
    }

    const checked = identities.map((identity) => ({ originInboxId: parseUuid(identity.originInboxId), originDocumentId: parseSafeId(identity.originDocumentId) }));
    return this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "inbound");
      // Another process may have renamed a ledger and then failed its directory fsync.
      await this.baseline();
      const holdings = await Promise.all(checked.map(async (identity) => {
        if (!pinnedOriginGrant(ledger, route, identity.originInboxId)) {
          throw new Error("Origin or redistribution outside authorized route scope");
        }

        const key = canonicalKey(identity.originInboxId, identity.originDocumentId);
        const record = ledger.records[key];
        if (record) {
          this.authorize(ledger, auth, record, "inbound");
        }

        const receipt = record ? currentCustodyReceipt(ledger, route, record) : undefined;
        return { state: record ? toOriginState(record) : null, available: record ? await this.bodyAvailable(record) : false,
          suppressed: record?.suppressed ?? false, receipts: receipt ? [receipt] : [] };
      }));
      return { storageIncarnation: ledger.storageIncarnation, holdings };
    });
  }

  /** Caller authenticates immediate-peer completion evidence and supplies its fresh request nonce. */
  async completeInventory(authorization: unknown, completion: unknown, descriptors: unknown[], expectedNonce: string): Promise<void> {
    const auth = parseAuthorization(authorization);
    const evidence = parseCompleteInventory(completion);
    if (!Array.isArray(descriptors) || descriptors.length > SYNC_LIMITS.records) {
      throw new Error("Inventory exceeds record limit");
    }

    const states = descriptors.map(parseOriginState);
    if (evidence.nonce !== expectedNonce || evidence.count !== states.length || evidence.descriptorDigest !== inventoryDigest(states) ||
        new Set(states.map((state) => canonicalKey(state.originInboxId, state.originDocumentId))).size !== states.length) {
      throw new Error("Incomplete, replayed, or conflicting inventory evidence");
    }

    await this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "inbound");
      if (evidence.peerId !== auth.peerId || evidence.routeId !== route.id || evidence.revision !== route.revision ||
          evidence.scope.length !== route.allowedOrigins.length || route.allowedOrigins.some((grant) => !evidence.scope.some((scope) => scope.inboxId === grant.inboxId && scope.historyEpoch === grant.historyEpoch))) {
        throw new Error("Inventory completion scope conflict");
      }

      for (const grant of route.allowedOrigins) {
        if (route.sourceInboxId !== grant.inboxId && !grant.completeHistory) {
          throw new Error("Relay lacks explicit complete-history delegation");
        }
      }

      for (const state of states) {
        this.authorize(ledger, auth, state, route.direction);
      }

      const key = outboxKey(route.id, route.revision, "inventory");
      const previous = ledger.historyCheckpoints[key];
      if (previous && (evidence.generation < previous.generation || evidence.generation === previous.generation && evidence.descriptorDigest !== previous.descriptorDigest)) {
        throw new Error("Inventory generation rollback or conflict");
      }

      // Terminal history commits before any retained live contribution is reattached.
      for (const state of states.filter((state) => state.state === "deleted")) {
        await this.applyLocked(ledger, route, state);
      }

      if (ledger.worker.ownerQuarantined) {
        await this.commit(ledger);
        throw new Error("Unexpected remote state ahead of local owner history; owner quarantined");
      }

      route.state = "active";
      ledger.historyCheckpoints[key] = evidence;
      if (route.direction === "inbound") {
        for (const state of states.filter((state) => state.state === "live")) {
          const record = ledger.records[canonicalKey(state.originInboxId, state.originDocumentId)];
          if (record && record.state === "live" && sameImmutableDescriptor(record, state) && state.version >= record.version && await this.bodyAvailable(record)) {
            await this.applyLocked(ledger, route, state);
          }
        }
      }

      for (const key of Object.keys(ledger.records)) {
        queueLedgerState(ledger, key);
      }

      await this.commit(ledger);
    });
  }

  async completeReconciliation(authorization: unknown, completion: unknown, descriptors: unknown[]): Promise<boolean> {
    const auth = parseAuthorization(authorization);
    const evidence = parseCompleteInventory(completion);
    const states = descriptors.map(parseOriginState);
    if (states.length !== evidence.count || inventoryDigest(states) !== evidence.descriptorDigest) {
      throw new Error("Incomplete reconciled inventory");
    }

    return this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "inbound");
      const key = outboxKey(route.id, route.revision, "inventory");
      const history = ledger.historyCheckpoints[key];
      if (!history || history.generation < evidence.generation || history.generation === evidence.generation && history.descriptorDigest !== evidence.descriptorDigest ||
          history.peerId !== evidence.peerId || history.routeId !== evidence.routeId || history.revision !== evidence.revision ||
          JSON.stringify(history.scope) !== JSON.stringify(evidence.scope)) {
        throw new Error("Reconciliation requires the established terminal-history cut");
      }

      for (const state of states) {
        this.authorize(ledger, auth, state, "inbound");
        const record = ledger.records[canonicalKey(state.originInboxId, state.originDocumentId)];
        if (!record || !sameImmutableDescriptor(record, state)) {
          return false;
        }

        const hasMembership = record.contributions.some((item) => item.routeId === route.id && item.revision === route.revision && item.state === "attached");
        if (record.state !== "deleted" && (!hasMembership || record.version < state.version || !record.suppressed && !await this.bodyAvailable(record))) {
          return false;
        }
      }

      const previous = ledger.checkpoints[key];
      if (previous && evidence.generation < previous.generation) {
        return false;
      }

      ledger.checkpoints[key] = evidence;
      await this.commit(ledger);
      return true;
    });
  }

  async activateOutbound(authorization: unknown, readiness: InventoryReadiness, issued: CompleteInventory, expectedAckNonce: string, expectedPeerId: string): Promise<void> {
    const auth = parseAuthorization(authorization);
    const evidence = parseCompleteInventory(readiness.evidence);
    parseUuid(readiness.storageIncarnation);
    await this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "outbound");
      if (readiness.kind !== "terminal-inventory-ready" || readiness.ackNonce !== expectedAckNonce || readiness.receiverPeerId !== expectedPeerId ||
          route.peerId !== expectedPeerId || readiness.destinationInboxId !== route.destinationInboxId || evidence.routeId !== route.id ||
          evidence.revision !== route.revision || JSON.stringify(evidence) !== JSON.stringify(issued)) {
        throw new Error("Outbound readiness does not match the locally issued cut and challenge");
      }

      route.state = "active";
      route.lastError = null;
      for (const key of Object.keys(ledger.records)) {
        queueLedgerState(ledger, key, route.id);
      }

      await this.commit(ledger);
    });
  }

  async observeOutboundState(authorization: unknown, descriptor: unknown): Promise<void> {
    const auth = parseAuthorization(authorization);
    const state = parseOriginState(descriptor);
    const fenced = await this.mutate(async (ledger) => {
      this.authorize(ledger, auth, state, "outbound");
      const key = canonicalKey(state.originInboxId, state.originDocumentId);
      const record = ledger.records[key];
      if (!record || !sameImmutableDescriptor(record, state) || state.state !== "deleted") {
        throw new Error("Outbound observation requires an existing immutable record and signed terminal state");
      }

      if (record.state === "deleted" && record.version >= state.version) {
        return false;
      }

      if (record.originInboxId === ledger.inboxId && state.version >= ledger.nextOriginVersion) {
        Object.assign(record, state);
        this.fenceOwnerHistory(ledger);

        await this.commit(ledger);
        return true;
      }

      Object.assign(record, state);
      queueLedgerState(ledger, key);
      await this.commit(ledger);
      return false;
    });
    if (fenced) {
      throw new Error("Unexpected remote state ahead of local owner history; owner quarantined");
    }
  }

  /** The callback must synchronously construct/start its request; network waiting happens after lock release. */
  async startCommunication<T>(authorization: unknown, start: (route: SyncRoute, identity: { inboxId: string; storageIncarnation: string; runtimeRevision: number }) => T, expectedState?: OriginState, deadlineAt?: number, locallyInitiated = false): Promise<{ value: T }> {
    const auth = parseAuthorization(authorization);
    const remainingMs = deadlineAt === undefined ? this.lockDeadlineMs : Math.min(this.lockDeadlineMs, parseInteger(deadlineAt, 1) - Date.now());
    if (remainingMs <= 0) {
      throw new Error("Communication authorization deadline exceeded");
    }

    return this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth);
      if (locallyInitiated && ledger.worker.retryPaused) {
        throw new Error("Locally initiated sync is persistently paused");
      }

      await this.baseline();
      if (expectedState) {
        this.authorize(ledger, auth, expectedState, "outbound");
        const record = ledger.records[canonicalKey(expectedState.originInboxId, expectedState.originDocumentId)];
        if (!record || stateFingerprint(record) !== stateFingerprint(expectedState) || !canForwardRecord(ledger, route, record)) {
          throw new Error("Outgoing record fingerprint changed or history is blocked");
        }
      }

      return { value: start(route, { inboxId: ledger.inboxId, storageIncarnation: ledger.storageIncarnation, runtimeRevision: ledger.runtime?.revision ?? 0 }) };
    }, remainingMs);
  }

  async openRouteAttempt(authorization: unknown, parentSignal?: AbortSignal, deadlineAt?: number, locallyInitiated = false): Promise<{ signal: AbortSignal; close: () => void }> {
    const auth = parseAuthorization(authorization);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Sync attempt aborted"));
    const entry = { routeId: auth.routeId, revision: auth.revision, controller };
    try {
      await this.startCommunication(auth, () => {
        parentSignal?.throwIfAborted();
        const attempts = activeAttempts.get(this.home) ?? new Set();
        attempts.add(entry);
        activeAttempts.set(this.home, attempts);
        parentSignal?.addEventListener("abort", abort, { once: true });
      }, undefined, deadlineAt, locallyInitiated);
    } catch (error) {
      activeAttempts.get(this.home)?.delete(entry);
      if (!activeAttempts.get(this.home)?.size) {
        activeAttempts.delete(this.home);
      }

      parentSignal?.removeEventListener("abort", abort);
      throw error;
    }

    let checking = false;
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) {
        return;
      }

      checking = true;
      this.mutate(async (ledger) => {
        this.authorizeRoute(ledger, auth);
        if (locallyInitiated && ledger.worker.retryPaused) {
          throw new Error("Locally initiated sync is paused");
        }
      }).catch(abort).finally(() => { checking = false; });
    }, 50);
    timer.unref();
    return { signal: controller.signal, close: () => {
      clearInterval(timer);
      parentSignal?.removeEventListener("abort", abort);
      activeAttempts.get(this.home)?.delete(entry);
      if (!activeAttempts.get(this.home)?.size) {
        activeAttempts.delete(this.home);
      }
    } };
  }

  async quiesceRoute(routeId: string, deadlineAt = Date.now() + 6000): Promise<void> {
    parseUuid(routeId);
    this.invalidateAttempts(routeId);
    while ([...(activeAttempts.get(this.home) ?? [])].some((entry) => entry.routeId === routeId)) {
      if (Date.now() >= deadlineAt) throw new Error("Route quiescence deadline exceeded");
      await delay(10);
    }
  }

  private invalidateAttempts(routeId: string, currentRevision?: number): void {
    for (const entry of activeAttempts.get(this.home) ?? []) {
      if (entry.routeId === routeId && entry.revision !== currentRevision) {
        entry.controller.abort(new Error("Sync route revoked"));
      }
    }
  }

  async pendingTerminalStates(authorization: unknown): Promise<OriginState[]> {
    const auth = parseAuthorization(authorization);
    return this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "outbound");
      const states: OriginState[] = [];
      for (const entry of Object.values(ledger.outbox)) {
        if (entry.routeId !== route.id || entry.revision !== route.revision || entry.disposition !== "pending" || entry.nextAttemptAt > Date.now()) {
          continue;
        }

        const record = ledger.records[entry.canonicalKey];
        if (record?.state === "deleted" && entry.fingerprint === stateFingerprint(record) && canForwardRecord(ledger, route, record)) {
          this.authorize(ledger, auth, record, "outbound");
          states.push(toOriginState(record));
        }
      }

      return states;
    });
  }

  async inventory(authorization: unknown): Promise<{ generation: number; states: OriginState[]; scope: OriginGrant[] }> {
    const auth = parseAuthorization(authorization);
    return this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "outbound");
      await this.baseline();
      if (ledger.migration.phase !== "complete" || ledger.worker.ownerQuarantined || (route.state !== "active" && route.state !== "reconnecting")) {
        throw new Error("Complete inventory is unavailable during migration, quarantine, or reconnection");
      }

      const states: OriginState[] = [];
      for (const grant of route.allowedOrigins) {
        if (grant.inboxId !== ledger.inboxId && !hasTrustedOriginHistory(ledger, grant.inboxId, grant.historyEpoch)) {
          throw new IncompleteSyncHistoryError("Complete inventory lacks trusted origin history, including empty scopes");
        }
      }

      for (const record of Object.values(ledger.records)) {
        const grant = route.allowedOrigins.find((grant) => grant.inboxId === record.originInboxId && grant.historyEpoch === record.historyEpoch);
        if (grant && canForwardRecord(ledger, route, record, true)) {
          states.push(toOriginState(record));
        } else if (grant) {
          throw new IncompleteSyncHistoryError("Complete inventory has a detached or unverified origin-history gap");
        }
      }

      states.sort((a, b) => canonicalKey(a.originInboxId, a.originDocumentId) < canonicalKey(b.originInboxId, b.originDocumentId) ? -1 : 1);
      return { generation: ledger.generation, states, scope: route.allowedOrigins };
    });
  }

  async acknowledge(authorization: unknown, value: unknown): Promise<void> {
    const auth = parseAuthorization(authorization);
    const receipt = parseReceipt(value);
    await this.mutate(async (ledger) => {
      const route = this.authorize(ledger, auth, receipt.originState, "outbound");
      if (receipt.receiverInboxId !== route.destinationInboxId || receipt.destinationInboxId !== route.destinationInboxId || receipt.routeId !== route.id || receipt.revision !== route.revision) {
        throw new Error("Receipt receiver or route binding conflict");
      }

      if (receipt.disposition === "superseded" && receipt.originState.state !== "deleted") {
        throw new Error("Superseded live state does not prove custody");
      }

      const key = canonicalKey(receipt.originState.originInboxId, receipt.originState.originDocumentId);
      const entry = ledger.outbox[outboxKey(route.id, route.revision, key)];
      if (!entry || entry.fingerprint !== receipt.fingerprint) {
        throw new Error("Receipt does not acknowledge the current queued state");
      }

      if (entry.receiverStorageIncarnation !== null && entry.receiverStorageIncarnation !== receipt.storageIncarnation) {
        throw new Error("Historical receipt belongs to a replaced receiver storage incarnation");
      }

      entry.receiverStorageIncarnation = receipt.storageIncarnation;
      ledger.receipts[receiptKey(receipt)] = receipt;
      await this.commit(ledger);
      await this.files.event("receipt-before-retirement");
      entry.disposition = "confirmed";
      entry.receiptDisposition = receipt.disposition;
      entry.lastError = null;
      await this.commit(ledger);
    });
  }

  async deliveryStatus(routeId: string, originInboxId: string, originDocumentId: string, deadlineAt?: number) {
    parseUuid(routeId);
    const key = canonicalKey(parseUuid(originInboxId), parseSafeId(originDocumentId));
    const remainingMs = deadlineAt === undefined ? this.lockDeadlineMs : Math.min(this.lockDeadlineMs, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new Error("Delivery status deadline exceeded");
    return this.mutate(async (ledger) => {
      await this.baseline();
      const route = ledger.routes[routeId];
      if (!route || route.direction !== "outbound") {
        throw new Error("Delivery status requires a configured outbound route");
      }

      const entry = ledger.outbox[outboxKey(route.id, route.revision, key)];
      const record = ledger.records[key];
      const receipt = entry && record ? currentCustodyReceipt(ledger, route, record, entry) : undefined;
      const isDetached = route.state === "detached" || !entry || entry.disposition === "retired";
      return { routeId, revision: route.revision, destinationInboxId: route.destinationInboxId,
        status: isDetached ? "detached" : receipt?.disposition ?? entry.disposition,
        isCommitted: !isDetached && receipt?.disposition === "committed", receipt: receipt ?? null,
        attempts: entry?.attempts ?? 0, nextAttemptAt: entry?.nextAttemptAt ?? 0, lastError: entry?.lastError ?? route.lastError };
    }, remainingMs);
  }

  async reconcileHoldings(authorization: unknown, values: { originInboxId: string; originDocumentId: string; fingerprint: string | null; available: boolean; suppressed?: boolean; storageIncarnation: string }[]): Promise<void> {
    const auth = parseAuthorization(authorization);
    if (values.length > SYNC_LIMITS.manifestPage) {
      throw new Error("Holding query exceeds page limit");
    }

    const checked = values.map((value) => {
      if (typeof value.available !== "boolean" || value.suppressed !== undefined && typeof value.suppressed !== "boolean" || value.fingerprint !== null && !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
        throw new Error("Invalid current holding");
      }

      return { ...value, originInboxId: parseUuid(value.originInboxId), originDocumentId: parseSafeId(value.originDocumentId), storageIncarnation: parseUuid(value.storageIncarnation) };
    });
    await this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "outbound");
      for (const holding of checked) {
        const key = canonicalKey(holding.originInboxId, holding.originDocumentId);
        const record = ledger.records[key];
        if (!record || !canForwardRecord(ledger, route, record, true)) {
          throw new Error("Holding identity outside authorized outgoing inventory");
        }

        const entryKey = outboxKey(route.id, route.revision, key);
        const existing = ledger.outbox[entryKey];
        const changedIncarnation = existing?.receiverStorageIncarnation !== undefined && existing.receiverStorageIncarnation !== null && existing.receiverStorageIncarnation !== holding.storageIncarnation;
        const hasSuppressionReceipt = Object.values(ledger.receipts).some((receipt) => receipt.routeId === route.id && receipt.revision === route.revision &&
          receipt.fingerprint === stateFingerprint(record) && receipt.storageIncarnation === holding.storageIncarnation && receipt.disposition === "suppressed");
        const missing = holding.fingerprint !== stateFingerprint(record) || record.state === "live" && (!holding.available && !holding.suppressed || holding.suppressed && !hasSuppressionReceipt);
        if (missing || changedIncarnation || !existing) {
          queueLedgerState(ledger, key, route.id, true);
          const repair = ledger.outbox[entryKey];
          if (repair) {
            repair.receiverStorageIncarnation = holding.storageIncarnation;
          }
        }
      }

      await this.commit(ledger);
    });
  }

  async updateAttempt(authorization: unknown, key: string, update: { nextAttemptAt: number; lastError: string | null; blocked: boolean; maxAttempts?: number }): Promise<void> {
    const auth = parseAuthorization(authorization);
    parseInteger(update.nextAttemptAt);
    const maxAttempts = parseInteger(update.maxAttempts ?? SYNC_DEFAULTS.maxAttempts, 1, 1000);
    if (update.lastError !== null && (typeof update.lastError !== "string" || update.lastError.length > 2048) || typeof update.blocked !== "boolean") {
      throw new Error("Invalid retry update");
    }

    await this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "outbound");
      const entry = ledger.outbox[outboxKey(route.id, route.revision, key)];
      if (!entry || entry.disposition === "retired" || entry.disposition === "confirmed") {
        throw new Error("No current pending obligation");
      }

      entry.attempts += 1;
      entry.nextAttemptAt = update.nextAttemptAt;
      entry.lastError = update.lastError;
      entry.disposition = update.blocked || entry.attempts >= maxAttempts ? "blocked" : "pending";
      await this.commit(ledger);
    });
  }

  async pinOutgoing(authorization: unknown, originInboxId: string, originDocumentId: string, expectedFingerprint?: string): Promise<StoredDocument | null> {
    const auth = parseAuthorization(authorization);
    const key = canonicalKey(parseUuid(originInboxId), parseSafeId(originDocumentId));
    return this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth, "outbound");
      const record = ledger.records[key];
      if (!record || !canForwardRecord(ledger, route, record)) {
        throw new Error("Outgoing record outside route scope");
      }

      if (expectedFingerprint !== undefined && stateFingerprint(record) !== expectedFingerprint) {
        throw new Error("Outgoing record fingerprint changed");
      }

      const originalBytes = await this.readBody(record, true);
      return originalBytes ? { metadata: readerMetadata(record, ledger.inboxId), originalBytes } : null;
    });
  }

  async retry(authorization: unknown): Promise<void> {
    const auth = parseAuthorization(authorization);
    await this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth);
      route.lastError = null;
      delete ledger.routeRetries[route.id];
      for (const entry of Object.values(ledger.outbox)) {
        if (entry.routeId === route.id && entry.revision === route.revision && (entry.disposition === "blocked" || entry.disposition === "pending")) {
          entry.attempts = 0;
          entry.nextAttemptAt = 0;
          entry.lastError = null;
          entry.disposition = "pending";
        }
      }

      for (const key of Object.keys(ledger.records)) {
        queueLedgerState(ledger, key, route.id);
      }

      await this.commit(ledger);
    });
  }

  async recordRouteRun(authorization: unknown, error: string | null, blocked = false, random = Math.random()): Promise<void> {
    const auth = parseAuthorization(authorization);
    if (error !== null && (typeof error !== "string" || !error || error.length > 2048) || !Number.isFinite(random) || random < 0 || random > 1) {
      throw new Error("Invalid route run result");
    }

    await this.mutate(async (ledger) => {
      const route = this.authorizeRoute(ledger, auth);
      const previous = ledger.routeRetries[route.id];
      if (previous?.blocked && error !== null) {
        return;
      }

      ledger.routeRetries[route.id] = nextRouteRetry(route, previous, error, blocked, Date.now(),
        ledger.runtime?.config.timings.reconcileMs ?? SYNC_DEFAULTS.reconcileMs, random);
      await this.commit(ledger);
    });
  }

  async setRouteError(authorization: unknown, lastError: string | null): Promise<void> {
    const auth = parseAuthorization(authorization);
    if (lastError !== null && (lastError.length > 2048 || !lastError)) {
      throw new Error("Invalid route error");
    }

    await this.mutate(async (ledger) => {
      this.authorizeRoute(ledger, auth).lastError = lastError;
      await this.commit(ledger);
    });
  }

  async configureRuntime(value: unknown): Promise<void> {
    const config = parseRuntimeConfig(value);
    await this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      ledger.runtime = { revision: (ledger.runtime?.revision ?? 0) + 1, config };
      await this.commit(ledger);
    });
  }

  async setIntendedTarget(value: SyncTarget | null): Promise<void> {
    const target = value === null ? null : parseSyncTarget(value);
    await this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      const config = ledger.runtime?.config ?? defaultRuntimeConfig();
      ledger.runtime = { revision: (ledger.runtime?.revision ?? 0) + 1, config: { ...config, intendedTarget: target } };
      await this.commit(ledger);
    });
  }

  async setWorkerEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") {
      throw new Error("Worker enabled must be boolean");
    }

    await this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      ledger.worker.enabled = enabled;
      await this.commit(ledger);
    });
  }

  async setRetryPaused(paused: boolean): Promise<void> {
    if (typeof paused !== "boolean") {
      throw new Error("Retry pause must be boolean");
    }

    await this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      ledger.worker.retryPaused = paused;
      await this.commit(ledger);
    });
  }

  async recordWorkerError(lastError: string): Promise<void> {
    if (!lastError || lastError.length > 2048) {
      throw new Error("Invalid worker error");
    }

    await this.mutate(async (ledger) => {
      if (ledger.worker.ownerQuarantined) {
        return;
      }

      ledger.worker.lastError = lastError;
      await this.commit(ledger);
    });
  }

  async recordWorkerRun(lastRunAt: number, lastError: string | null): Promise<void> {
    parseInteger(lastRunAt);
    if (lastError !== null && (typeof lastError !== "string" || lastError.length > 2048)) {
      throw new Error("Invalid worker run error");
    }

    await this.mutate(async (ledger) => {
      ledger.worker.lastRunAt = lastRunAt;
      ledger.worker.lastError = lastError;
      await this.commit(ledger);
    });
  }

  async setWorkerState(value: { enabled: boolean; retryPaused: boolean; bootSupervised: boolean; lastRunAt: number | null; lastError: string | null }): Promise<void> {
    if (typeof value.enabled !== "boolean" || typeof value.retryPaused !== "boolean" || typeof value.bootSupervised !== "boolean" ||
        value.lastError !== null && (typeof value.lastError !== "string" || value.lastError.length > 2048)) {
      throw new Error("Invalid persistent worker state");
    }

    if (value.lastRunAt !== null) {
      parseInteger(value.lastRunAt);
    }

    await this.mutate(async (ledger) => {
      this.assertOwnerWritable(ledger);
      Object.assign(ledger.worker, value);
      await this.commit(ledger);
    });
  }

  async audit(): Promise<{ missing: string[]; conflicts: string[] }> {
    return this.mutate(async (ledger) => {
      const missing: string[] = [];
      const conflicts: string[] = [];
      for (const [key, record] of Object.entries(ledger.records)) {
        if (record.state !== "live" || !record.bodyFile) {
          continue;
        }

        if (!await optionalStat(this.bodyPath(record.bodyFile))) {
          missing.push(key);
          continue;
        }

        try {
          const bytes = await this.readHtml(this.bodyPath(record.bodyFile));
          if (bytes.length !== record.byteLength || this.hashBody(bytes) !== record.sha256) {
            conflicts.push(key);
          }
        } catch {
          conflicts.push(key);
        }
      }

      if (conflicts.length) {
        ledger.worker.ownerQuarantined = true;
        ledger.worker.enabled = false;
        ledger.worker.lastError = "Immutable body drift detected; origin descriptors retained in quarantine";
        for (const route of Object.values(ledger.routes)) {
          fenceLedgerRoute(ledger, route, "blocked", ledger.worker.lastError);
        }

        await this.commit(ledger);
      }

      return { missing, conflicts };
    });
  }

  async listDocuments(maximumDocumentBytes = SYNC_LIMITS.htmlBytes): Promise<DocumentMetadata[]> {
    const ledger = await this.snapshot();
    const documents: DocumentMetadata[] = [];
    for (const record of Object.values(ledger.records)) {
      if (isVisible(record)) {
        this.assertReadLimit(record, maximumDocumentBytes);
      }

      if (isVisible(record) && await this.bodyAvailable(record)) {
        documents.push(readerMetadata(record, ledger.inboxId));
      }
    }

    return documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async getDocumentMetadata(localId: string, maximumDocumentBytes = SYNC_LIMITS.htmlBytes): Promise<DocumentMetadata | null> {
    parseSafeId(localId);
    const ledger = await this.snapshot();
    const record = Object.values(ledger.records).find((record) => record.localId === localId);
    if (record && isVisible(record)) {
      this.assertReadLimit(record, maximumDocumentBytes);
    }

    return record && isVisible(record) && await this.bodyAvailable(record) ? readerMetadata(record, ledger.inboxId) : null;
  }

  async getDocument(localId: string, maximumDocumentBytes = SYNC_LIMITS.htmlBytes): Promise<StoredDocument | null> {
    parseSafeId(localId);
    const ledger = await this.snapshot();
    const record = Object.values(ledger.records).find((record) => record.localId === localId);
    if (!record || !isVisible(record)) {
      return null;
    }

    this.assertReadLimit(record, maximumDocumentBytes);
    const originalBytes = await this.readBody(record);
    return originalBytes ? { metadata: readerMetadata(record, ledger.inboxId), originalBytes } : null;
  }

  /** Receiver custody resets; owner recovery remains quarantined until a fresh fork. */
  async quarantineRestore(): Promise<void> {
    await withStoreLock(this.directory, this.lockDeadlineMs, async () => {
      await this.prepareManagedDirectories();
      const ledger = await this.readLedger();
      ledger.ownerAnchor = await this.currentAnchor();
      ledger.storageIncarnation = randomUUID();
      ledger.receipts = {};
      ledger.checkpoints = {};
      ledger.historyCheckpoints = {};
      ledger.worker.ownerQuarantined = true;
      ledger.worker.enabled = false;
      ledger.runtime = null;
      ledger.publicationIntents = {};
      ledger.routeRetries = {};
      for (const route of Object.values(ledger.routes)) {
        fenceLedgerRoute(ledger, route, "blocked", "Restore quarantine requires trusted terminal history and fenced owner recovery, or an explicit fresh fork");
      }

      await this.commit(ledger);
      await this.retireCopiedOwnerKeys(ledger);
      this.recovered = false;
    });
  }

  async fork(expected?: { oldInboxId: string; newInboxId: string }): Promise<{ inboxId: string; historyEpoch: string }> {
    await withStoreLock(this.directory, this.lockDeadlineMs, async () => {
      await this.prepareManagedDirectories();
      const ledger = await this.readLedger();
      if (!ledger.worker.ownerQuarantined) {
        throw new Error("Explicit restore quarantine is required before a fresh fork");
      }

      if (expected && ledger.inboxId !== parseUuid(expected.oldInboxId)) {
        throw new Error("Fork source identity differs from the recorded transition");
      }

      const inboxId = expected ? parseUuid(expected.newInboxId) : randomUUID();
      const historyEpoch = randomUUID();
      const grant = await this.createOwnerKey(inboxId, historyEpoch);
      for (const record of Object.values(ledger.records)) {
        if (record.originInboxId === ledger.inboxId && record.contributions.length === 0) {
          // A retained former original is visible as a detached inherited copy.
          record.suppressed = false;
        }
      }

      ledger.inboxId = inboxId;
      ledger.historyEpoch = historyEpoch;
      ledger.nextOriginVersion = 1;
      ledger.storageIncarnation = randomUUID();
      ledger.ownerAnchor = await this.currentAnchor();
      ledger.originKeys.push(grant);
      ledger.routes = {};
      ledger.runtime = null;
      ledger.publicationIntents = {};
      ledger.routeRetries = {};
      for (const record of Object.values(ledger.records)) {
        record.contributions = [];
      }

      ledger.outbox = {};
      ledger.receipts = {};
      ledger.checkpoints = {};
      ledger.historyCheckpoints = {};
      ledger.worker.ownerQuarantined = false;
      ledger.migration.phase = "forking";
      // instance-id is finalized by recovery if the process stops between these replacements.
      await this.commit(ledger);
      await this.retireCopiedOwnerKeys(ledger);
      await this.replaceIdentity(inboxId);
      ledger.migration.phase = "complete";
      await this.commit(ledger);
      this.recovered = false;
    });

    const ledger = await this.snapshot();
    return { inboxId: ledger.inboxId, historyEpoch: ledger.historyEpoch };
  }

  private async applyStaged(auth: RouteAuthorization, state: OriginState, staged?: string): Promise<ApplyResult> {
    return this.mutate(async (ledger) => {
      const route = this.authorize(ledger, auth, state, "inbound");
      const result = await this.applyLocked(ledger, route, state, staged);
      if (ledger.worker.ownerQuarantined) {
        await this.commit(ledger);
        throw new Error("Unexpected remote state ahead of local owner history; owner quarantined");
      }

      if (result.status === "needs-body") {
        return result;
      }

      await this.commit(ledger);
      await this.files.event("committed-before-receipt");
      return result;
    });
  }

  private async applyLocked(ledger: SyncLedger, route: SyncRoute, state: OriginState, staged?: string): Promise<ApplyResult> {
    const key = canonicalKey(state.originInboxId, state.originDocumentId);
    let record = ledger.records[key];
    if (record && !sameImmutableDescriptor(record, state)) {
      throw new Error("Immutable origin descriptor conflict");
    }

    if (record && record.state === "deleted" && state.state === "live") {
      return this.recordReceipt(ledger, route, record, "superseded");
    }

    if (record && state.version === record.version && (state.state !== record.state || state.signature !== record.signature)) {
      throw new Error("Conflicting origin state at the same version");
    }

    if (record && state.version < record.version && (record.state === "deleted" || state.state !== "deleted")) {
      return this.recordReceipt(ledger, route, record, "superseded");
    }

    if (state.originInboxId === ledger.inboxId && state.version >= ledger.nextOriginVersion) {
      if (state.state === "deleted") {
        if (record) {
          Object.assign(record, state);
        } else {
          this.assertCapacity(ledger);
          ledger.records[key] = { ...state, localId: this.allocateLocalId(ledger), bodyFile: null, contributions: [], suppressed: false, provenance: [] };
        }
      }

      this.fenceOwnerHistory(ledger);
      return { status: "needs-body" };
    }

    if (state.state === "live" && route.state !== "active") {
      throw new Error("Trusted terminal inventory must complete before live reconnection");
    }

    if (!record) {
      this.assertCapacity(ledger);
    }

    if (state.state === "live" && !record?.suppressed && !(record && await this.bodyAvailable(record)) && !staged) {
      return { status: "needs-body" };
    }

    if (!record) {
      record = { ...state, localId: this.allocateLocalId(ledger), bodyFile: null, contributions: [], suppressed: false, provenance: [] };
      ledger.records[key] = record;
    } else {
      Object.assign(record, state);
    }

    if (staged && state.state === "live" && !record.suppressed && !await this.bodyAvailable(record)) {
      record.bodyFile = await this.installBody(staged);
    }

    const contribution = record.contributions.find((contribution) => contribution.routeId === route.id);
    const attached: "attached" | "detached" = route.state === "active" ? "attached" : "detached";
    if (contribution) {
      contribution.revision = route.revision;
      contribution.state = attached;
    } else {
      record.contributions.push({ routeId: route.id, revision: route.revision, state: attached });
      record.provenance.push({ peerId: route.peerId, routeId: route.id, receivedAt: new Date().toISOString() });
    }

    queueLedgerState(ledger, key);
    return this.recordReceipt(ledger, route, record, state.state === "deleted" ? "deleted" : record.suppressed ? "suppressed" : "committed");
  }

  private recordReceipt(ledger: SyncLedger, route: SyncRoute, record: ManagedRecord, disposition: DurableReceipt["disposition"]): Exclude<ApplyResult, { status: "needs-body" }> {
    const receipt: DurableReceipt = { schemaVersion: 1, receiverInboxId: ledger.inboxId, storageIncarnation: ledger.storageIncarnation, destinationInboxId: ledger.inboxId,
      routeId: route.id, revision: route.revision, originState: toOriginState(record), fingerprint: stateFingerprint(record), disposition };
    ledger.receipts[receiptKey(receipt)] = receipt;
    return { status: disposition, receipt };
  }

  private fenceOwnerHistory(ledger: SyncLedger): void {
    ledger.worker.ownerQuarantined = true;
    ledger.worker.enabled = false;
    ledger.worker.lastError = "Unexpected remote state ahead of local owner history; trusted owner recovery is required";
    for (const route of Object.values(ledger.routes)) {
      fenceLedgerRoute(ledger, route, "blocked", ledger.worker.lastError);
    }
  }

  private authorizeRoute(ledger: SyncLedger, auth: RouteAuthorization, direction?: SyncRoute["direction"]): SyncRoute {
    if (ledger.worker.ownerQuarantined || ledger.migration.phase !== "complete") {
      throw new Error("Communication blocked during migration or restore quarantine");
    }

    const route = ledger.routes[auth.routeId];
    if (!route || route.revision !== auth.revision || route.state === "detached" || route.state === "blocked") {
      // A different process can persist the fence before either local watcher runs.
      // Observing it must cancel every stale attempt, including its enclosing pass.
      this.invalidateAttempts(auth.routeId, route && route.state !== "detached" && route.state !== "blocked" ? route.revision : undefined);
      throw new Error("Revoked, stale, or incorrectly bound route authorization");
    }

    if (route.peerId !== auth.peerId || route.sourceInboxId !== auth.sourceInboxId || route.destinationInboxId !== auth.destinationInboxId ||
        direction && route.direction !== direction) {
      throw new Error("Revoked, stale, or incorrectly bound route authorization");
    }

    return route;
  }

  private authorize(ledger: SyncLedger, auth: RouteAuthorization, state: OriginState, direction: SyncRoute["direction"]): SyncRoute {
    const route = this.authorizeRoute(ledger, auth, direction);
    const grant = pinnedStateGrant(ledger, route, state);
    if (!grant) {
      throw new Error("Origin or redistribution outside authorized route scope");
    }

    verifyOriginState(state, grant.publicKey);
    return route;
  }

  private async mutate<T>(operation: (ledger: SyncLedger) => Promise<T>, lockDeadlineMs = this.lockDeadlineMs): Promise<T> {
    await checkDirectory(this.directory);
    return withStoreLock(this.directory, lockDeadlineMs, async () => {
      if (this.files.uncertain) {
        throw new Error("Storage outcome is uncertain; explicit recovery is required before further mutation");
      }

      if (!this.recovered) {
        await this.recoverLocked();
      }

      const ledger = await this.readLedger();
      await this.assertAnchor(ledger);
      await this.assertBarrier(ledger);
      await this.assertReaderIdentity(ledger);
      return operation(ledger);
    });
  }

  private async recoverLocked(): Promise<void> {
    await this.prepareManagedDirectories();
    let ledger = await this.readLedger();
    await this.assertAnchor(ledger);
    await this.baseline();
    this.files.uncertain = false;
    if (ledger.migration.phase === "forking") {
      if (Object.keys(ledger.routes).length || ledger.worker.ownerQuarantined) {
        throw new Error("Invalid interrupted fork state");
      }

      await this.replaceIdentity(ledger.inboxId);
      ledger.migration.phase = "complete";
      await this.commit(ledger);
    } else if (ledger.migration.phase !== "complete") {
      await this.finishEnrollment(ledger);
      ledger = await this.readLedger();
    }

    await this.assertBarrier(ledger);
    const identity = await readInboxIdentity(this.home);
    if (identity !== ledger.inboxId) {
      throw new Error("Reader identity differs from managed store identity");
    }

    await this.retireCopiedOwnerKeys(ledger);
    await this.staging.cleanDead();
    this.recovered = true;
  }

  private async finishEnrollment(ledger: SyncLedger): Promise<void> {
    const documents = path.join(this.home, "documents");
    const evacuated = path.join(this.directory, "legacy-documents");
    const existing = await optionalStat(documents);
    const legacy = await optionalStat(evacuated);
    if (existing?.isDirectory()) {
      if (legacy || ledger.migration.phase !== "intent") {
        throw new Error("Legacy writer recreated documents during enrollment; recovery blocked");
      }

      await checkDirectory(documents);
      await rename(documents, evacuated);
      this.files.uncertain = true;
      await this.files.event("migration-evacuated");
      await this.files.flushDirectory(this.home);
      await this.files.flushDirectory(this.directory);
      this.files.uncertain = false;
    } else if (!legacy) {
      if (existing || ledger.migration.phase !== "intent") {
        throw new Error("Missing evacuated legacy directory; recovery blocked");
      }

      await this.files.directory(evacuated);
    }

    if (!await optionalStat(documents)) {
      await this.files.exclusiveFile(documents, MANAGED_FORMAT_BARRIER);
    }

    await this.assertBarrier({ ...ledger, migration: { ...ledger.migration, phase: "complete" } });
    await this.files.flushFile(documents, 1024);
    await this.files.flushDirectory(this.home);
    await this.files.flushDirectory(this.directory);
    await this.files.event("migration-barrier");
    ledger.migration.phase = "barrier";
    await this.commit(ledger);
    await checkDirectory(evacuated);
    await this.files.event("migration-enumeration");
    const entries = (await readdir(evacuated)).sort();
    let batch = 0;
    for (const id of entries) {
      if (id === ".staging" || id === ".trash") {
        await checkDirectory(path.join(evacuated, id));
        continue;
      }

      parseSafeId(id);
      if (ledger.migration.enrolledIds.includes(id)) {
        continue;
      }

      this.assertCapacity(ledger);
      const candidate = path.join(evacuated, id);
      await checkDirectory(candidate);
      const raw = parseObject(JSON.parse((await readPrivateFile(path.join(candidate, "metadata.json"), SYNC_LIMITS.descriptorBytes)).toString("utf8")), "legacy metadata");
      if (Object.keys(raw).some((key) => !["schemaVersion", "id", "title", "type", "createdAt", "sourceFileName"].includes(key))) {
        throw new Error("Legacy metadata contains unsupported fields; explicit projection is required");
      }

      const metadata = metadataProjection(parseDocumentMetadata(raw));
      if (metadata.id !== id) {
        throw new Error("Legacy metadata ID differs from case-sensitive directory ID");
      }

      const bytes = await this.readHtml(path.join(candidate, "index.html"));
      validateBody(bytes);
      const state = signOriginState({ originInboxId: ledger.inboxId, originDocumentId: id, historyEpoch: ledger.historyEpoch, version: this.allocateVersion(ledger), state: "live",
        metadata, sha256: this.hashBody(bytes), byteLength: bytes.length, metadataSha256: sha256(metadataEncoding(metadata)) }, await this.ownerKey(ledger));
      const bodyFile = await this.installBody(await this.stageBuffer(bytes));
      ledger.records[canonicalKey(ledger.inboxId, id)] = { ...state, localId: this.allocateLocalId(ledger, id), bodyFile, contributions: [], suppressed: false, provenance: [] };
      ledger.migration.enrolledIds.push(id);
      ledger.migration.phase = "enrolling";
      batch += 1;
      if (batch >= 32) {
        await this.commit(ledger);
        batch = 0;
      }
    }

    ledger.migration.phase = "complete";
    await this.commit(ledger);
  }

  private async baseline(): Promise<void> {
    this.files.uncertain = true;
    const snapshot = await openPrivateFile(this.ledgerPath(), SYNC_LIMITS.ledgerBytes);
    try {
      await snapshot.sync();
    } finally {
      await snapshot.close();
    }

    for (const directory of [this.bodyDirectory(), this.stageDirectory(), this.directory, this.home, path.dirname(this.home)]) {
      await this.files.flushDirectory(directory);
    }

    this.files.uncertain = false;
  }

  private async prepareManagedDirectories(): Promise<void> {
    for (const directory of [this.directory, this.bodyDirectory(), this.stageDirectory()]) {
      await this.files.directory(directory);
      await chmod(directory, 0o700);
      await this.files.flushDirectory(directory);
    }
  }

  private async commit(ledger: SyncLedger): Promise<void> {
    ledger.generation += 1;
    parseLedger(ledger);
    if (Buffer.byteLength(JSON.stringify(ledger)) + this.reserveTerminalSpace(ledger) > SYNC_LIMITS.ledgerBytes) {
      throw new Error("Managed ledger exceeds 64 MiB capacity including reserved terminal-state space");
    }

    await this.files.replaceLedger(this.ledgerPath(), ledger);
    for (const route of Object.values(ledger.routes)) {
      this.invalidateAttempts(route.id, route.state === "blocked" || route.state === "detached" ? undefined : route.revision);
    }
  }

  private reserveTerminalSpace(ledger: SyncLedger): number {
    const inboundCounts = new Map<string, number>();
    for (const route of Object.values(ledger.routes)) {
      if (route.direction !== "inbound" || (route.state !== "active" && route.state !== "reconnecting")) {
        continue;
      }

      for (const grant of route.allowedOrigins) {
        inboundCounts.set(grant.inboxId, (inboundCounts.get(grant.inboxId) ?? 0) + 1);
      }
    }

    let reservedBytes = 64;
    for (const record of Object.values(ledger.records)) {
      if (record.state !== "live") {
        continue;
      }

      // Counter/state growth plus each possible inbound terminal receipt and contribution.
      reservedBytes += 64 + (inboundCounts.get(record.originInboxId) ?? 0) * (Buffer.byteLength(JSON.stringify(toOriginState(record))) + 2048);
    }

    return reservedBytes;
  }

  private async readLedger(): Promise<SyncLedger> {
    const bytes = await readManagedLedgerBytes(this.ledgerPath());
    const ledger = parseLedger(JSON.parse(bytes.toString("utf8")));
    for (const record of Object.values(ledger.records)) {
      const grant = ledger.originKeys.find((grant) => grant.inboxId === record.originInboxId && grant.historyEpoch === record.historyEpoch);
      if (!grant) {
        throw new Error("Ledger origin key missing");
      }

      verifyOriginState(record, grant.publicKey);
    }

    return ledger;
  }

  private async currentAnchor(): Promise<OwnerAnchor> {
    const info = await checkDirectory(this.home);
    return { home: await realpath(this.home), dev: info.dev, ino: info.ino };
  }

  private async assertAnchor(ledger: SyncLedger): Promise<void> {
    const anchor = await this.currentAnchor();
    if (anchor.home !== ledger.ownerAnchor.home || anchor.dev !== ledger.ownerAnchor.dev || anchor.ino !== ledger.ownerAnchor.ino) {
      throw new Error("Copied or moved managed store requires explicit restore quarantine and fork");
    }
  }

  private async assertBarrier(ledger: SyncLedger): Promise<void> {
    if (ledger.migration.phase !== "complete") {
      throw new Error("Managed enrollment is incomplete; explicit recovery is required");
    }

    const bytes = await readPrivateFile(path.join(this.home, "documents"), 1024);
    if (bytes.toString("utf8") !== MANAGED_FORMAT_BARRIER) {
      throw new Error("Managed format barrier is missing or invalid");
    }
  }

  private async assertReaderIdentity(ledger: SyncLedger): Promise<void> {
    if (await readInboxIdentity(this.home) !== ledger.inboxId) {
      throw new Error("Reader identity differs from managed store identity");
    }
  }

  private assertOwnerWritable(ledger: SyncLedger): void {
    if (ledger.worker.ownerQuarantined || ledger.migration.phase !== "complete") {
      throw new Error("Owner mutation blocked by incomplete migration or restore quarantine");
    }
  }

  private assertCapacity(ledger: SyncLedger): void {
    if (Object.keys(ledger.records).length >= SYNC_LIMITS.records) {
      throw new Error("Managed canonical record capacity exceeded; terminal history is retained");
    }
  }

  private allocateVersion(ledger: SyncLedger): number {
    const version = parseInteger(ledger.nextOriginVersion, 1, Number.MAX_SAFE_INTEGER - 1);
    ledger.nextOriginVersion += 1;
    return version;
  }

  private allocateLocalId(ledger: SyncLedger, preferred?: string): string {
    const used = new Set(Object.values(ledger.records).map((record) => record.localId));
    if (preferred && !used.has(preferred)) {
      return preferred;
    }

    let id = randomUUID();
    while (used.has(id)) {
      id = randomUUID();
    }

    return id;
  }

  private async createOwnerKey(inboxId: string, historyEpoch: string): Promise<OriginGrant> {
    const keyPath = path.join(this.directory, `owner-${inboxId}.pem`);
    const existing = await optionalStat(keyPath);
    if (existing) {
      if ((existing.mode & 0o077) !== 0) {
        throw new Error("Preexisting owner signing key must be private");
      }

      const key = createPublicKey((await readPrivateFile(keyPath, 4096)).toString("utf8"));
      if (key.asymmetricKeyType !== "ed25519") {
        throw new Error("Preexisting owner signing key must be Ed25519");
      }

      await this.files.flushFile(keyPath, 4096);

      return { inboxId, historyEpoch, publicKey: key.export({ type: "spki", format: "pem" }).toString(), completeHistory: true, redistribute: true };
    }

    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    await this.files.exclusiveFile(path.join(this.directory, `owner-${inboxId}.pem`), pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    return { inboxId, historyEpoch, publicKey, completeHistory: true, redistribute: true };
  }

  private async retireCopiedOwnerKeys(ledger: SyncLedger): Promise<void> {
    let changed = false;
    for (const grant of ledger.originKeys) {
      if (grant.inboxId === ledger.inboxId && !ledger.worker.ownerQuarantined) {
        continue;
      }

      const keyPath = path.join(this.directory, `owner-${grant.inboxId}.pem`);
      if (await optionalStat(keyPath)) {
        await openPrivateFile(keyPath, 4096).then((file) => file.close());
        await rm(keyPath);
        changed = true;
      }
    }

    if (changed) {
      await this.files.flushDirectory(this.directory);
    }
  }

  private async ownerKey(ledger: SyncLedger): Promise<string> {
    const keyPath = path.join(this.directory, `owner-${ledger.inboxId}.pem`);
    const info = await optionalStat(keyPath);
    if (!info || (info.mode & 0o077) !== 0) {
      throw new Error("Owner signing key must be private");
    }

    return (await readPrivateFile(keyPath, 4096)).toString("utf8");
  }

  private hashBody(bytes: Buffer): string {
    this.counters.hashPasses += 1;
    return sha256(bytes);
  }

  private async stageBuffer(bytes: Buffer, transfer = false, reserved?: string): Promise<string> {
    await checkDirectory(this.stageDirectory());
    const staged = reserved ?? await this.staging.reserve(bytes.length);
    const file = await open(staged, "r+");
    let complete = false;
    try {
      await file.writeFile(bytes);
      if (transfer) {
        this.counters.bodyTransfers += 1;
      }

      await this.files.event("body-staged");
      await file.sync();
      await this.files.event("body-flushed");
      complete = true;
    } finally {
      await file.close();
      if (!complete && !reserved) {
        await this.staging.release(staged);
      }
    }

    return staged;
  }

  private async stageStream(chunks: AsyncIterable<Uint8Array>, state: OriginState, staged: string): Promise<string> {
    await checkDirectory(this.stageDirectory());
    // A bounded owned buffer also preserves the current whole-document HTML policy.
    const hash = createHash("sha256");
    this.counters.hashPasses += 1;
    const file = await open(staged, "r+");
    let length = 0;
    let transferred = false;
    const ownedChunks: Buffer[] = [];
    try {
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Incoming body chunks must be bytes");
        }

        const owned = Buffer.from(chunk);
        length += owned.length;
        if (length > SYNC_LIMITS.htmlBytes || length > state.byteLength) {
          throw new Error("Incoming body exceeds authenticated byte limit");
        }

        hash.update(owned);
        ownedChunks.push(owned);
        await file.writeFile(owned);
        if (!transferred && owned.length) {
          this.counters.bodyTransfers += 1;
          transferred = true;
        }
      }

      if (length !== state.byteLength || hash.digest("hex") !== state.sha256) {
        throw new Error("Incoming stream digest or length conflict");
      }

      validateBody(Buffer.concat(ownedChunks, length));
      await this.files.event("body-staged");
      await file.sync();
      await this.files.event("body-flushed");
    } finally {
      await file.close();
    }

    return staged;
  }

  private async releaseStage(staged: string): Promise<void> {
    await withStoreLock(this.directory, this.lockDeadlineMs, () => this.staging.release(staged));
  }

  private async installBody(staged: string): Promise<string> {
    let filename = `${randomUUID()}.html`;
    while (await optionalStat(this.bodyPath(filename))) {
      filename = `${randomUUID()}.html`;
    }

    this.files.uncertain = true;
    try {
      await rename(staged, this.bodyPath(filename));
      await this.files.event("body-installed");
      await this.files.flushDirectory(this.bodyDirectory());
      await this.files.flushDirectory(this.stageDirectory());
      await this.files.event("body-directory-flushed");
      this.files.uncertain = false;
      return filename;
    } finally {
      await this.staging.release(staged);
    }
  }

  private assertReadLimit(record: ManagedRecord, maximumBytes: number): void {
    parseInteger(maximumBytes, 1);
    if (record.byteLength > maximumBytes) {
      throw new Error("Source file exceeds its byte limit");
    }
  }

  private async bodyAvailable(record: ManagedRecord, includeSuppressed = false): Promise<boolean> {
    if (record.state !== "live" || record.suppressed && !includeSuppressed || !record.bodyFile) {
      return false;
    }

    const info = await optionalStat(this.bodyPath(record.bodyFile));
    return !!info && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === record.byteLength && (!process.getuid || info.uid === process.getuid());
  }

  private async readHtml(filePath: string): Promise<Buffer> {
    const file = await openPrivateFile(filePath, SYNC_LIMITS.htmlBytes);
    this.counters.htmlOpens += 1;
    try {
      return await readBoundedFile(file, SYNC_LIMITS.htmlBytes, "HTML body exceeds byte limit", (bytesRead) => {
        this.counters.htmlBytes += bytesRead;
      });
    } finally {
      await file.close();
    }
  }

  private async readBody(record: ManagedRecord, includeSuppressed = false): Promise<Buffer | null> {
    if (!await this.bodyAvailable(record, includeSuppressed) || !record.bodyFile) {
      return null;
    }

    try {
      const bytes = await this.readHtml(this.bodyPath(record.bodyFile));
      if (bytes.length !== record.byteLength) {
        return null;
      }

      return bytes;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    }
  }

  private async replaceIdentity(inboxId: string): Promise<void> {
    const temporary = path.join(this.home, `instance-id.tmp-${randomUUID()}`);
    await this.files.exclusiveFile(temporary, `${inboxId}\n`);
    this.files.uncertain = true;
    await rename(temporary, path.join(this.home, "instance-id"));
    await this.files.flushDirectory(this.home);
    this.files.uncertain = false;
  }

  private ledgerPath(): string { return path.join(this.directory, "ledger.json"); }
  private bodyDirectory(): string { return path.join(this.directory, "bodies"); }
  private stageDirectory(): string { return path.join(this.directory, "staging"); }
  private bodyPath(filename: string): string { return path.join(this.bodyDirectory(), filename); }
}

export function toOriginState(record: OriginState): OriginState {
  return { originInboxId: record.originInboxId, originDocumentId: record.originDocumentId, historyEpoch: record.historyEpoch, version: record.version,
    state: record.state, metadata: metadataProjection(record.metadata), sha256: record.sha256, byteLength: record.byteLength, metadataSha256: record.metadataSha256, signature: record.signature };
}

function readerMetadata(record: ManagedRecord, localInboxId: string): DocumentMetadata {
  const metadata = { ...metadataProjection(record.metadata), id: record.localId };
  if (record.originInboxId === localInboxId) {
    return metadata;
  }

  return { ...metadata, origin: { schemaVersion: 1, inboxId: record.originInboxId, documentId: record.originDocumentId, historyEpoch: record.historyEpoch, version: record.version,
    sha256: record.sha256, byteLength: record.byteLength, metadataSha256: record.metadataSha256, signature: record.signature,
    detached: !record.contributions.some((contribution) => contribution.state === "attached"), originalMetadata: metadataProjection(record.metadata) } };
}

function isVisible(record: ManagedRecord): boolean {
  return record.state === "live" && !record.suppressed;
}

function validateBody(bytes: Buffer): void {
  if (bytes.length > SYNC_LIMITS.htmlBytes) {
    throw new Error("HTML body exceeds 10 MiB");
  }

  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const validation = validateHtml(html);
  if (!validation.ok) {
    throw new Error(`HTML validation failed: ${validation.errors.join("; ")}`);
  }
}
