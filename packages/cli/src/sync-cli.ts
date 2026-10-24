import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { inspectRegisteredInbox, type NamedInbox } from "./inbox-catalog";
import type { InboxSelection, ResolvedInboxSelection } from "./inbox-selection";
import { enrollRegisteredInbox } from "./sync-enrollment";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { inspectSyncRestore, maintainSyncIdentity } from "./sync-maintenance";
import { outboxKey } from "./sync-ledger";
import { assertExactKeys, canonicalKey, parseInteger, parseObject, parseRoute, stateFingerprint, type SyncRoute } from "./sync-model";
import { routeAuthorization } from "./sync-reconciliation";
import { defaultRuntimeConfig, parseRuntimeConfig, readSyncJson } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import type { SyncCommand } from "./sync-cli-args";
import { createSyncSupervisorDefinition, inspectSyncSupervisor, renderSyncSupervisor } from "./sync-supervisor";
import { startOwnedSyncWorker } from "./sync-worker";
import { contactWorker, ensureOwnedSyncWorker, getOwnedWorkerStatus, stopOwnedSyncWorker, submitWorkerRun } from "./sync-worker-client";
import { inspectWorkerOwner } from "./sync-worker-records";

export function isSyncCommand(command: { command: string }): command is SyncCommand & InboxSelection {
  return command.command.startsWith("sync ");
}

export function isOfflineSyncCommand(command: SyncCommand): boolean {
  return command.command === "sync restore inspect" || command.command === "sync restore quarantine" || command.command === "sync fork";
}

export async function runOfflineSyncCommand(command: SyncCommand & InboxSelection) {
  if (!command.home || command.inbox) {
    throw new Error("Offline identity maintenance requires only explicit --home <canonical-home>");
  }

  if (command.command === "sync restore inspect") {
    return { command: command.command, ...await inspectSyncRestore(command.home) };
  }

  if (command.command !== "sync fork" && command.command !== "sync restore quarantine") {
    throw new Error("Not an offline identity maintenance command");
  }

  if (!command.yes) {
    throw new Error("Offline quarantine/fork requires --yes and --expect-inbox");
  }

  return { command: command.command, ...await maintainSyncIdentity(command.home, command.expectedInboxId, command.command === "sync fork" ? "fork" : "quarantine") };
}

export async function getSyncStatus(selection: ResolvedInboxSelection, documentId?: string) {
  const ledger = await assertManagedLifecycle(selection.home);
  if (!ledger) {
    throw new Error("Inbox is not enrolled; use sync enroll on an existing registered inbox");
  }

  const store = new ManagedSyncStore(selection.home);
  const routes = Object.values(ledger.routes).map((route) => {
    const entries = Object.values(ledger.outbox).filter((entry) => entry.routeId === route.id && entry.revision === route.revision);
    const checkpointKey = outboxKey(route.id, route.revision, "inventory");
    return { ...route, historyReady: route.direction === "outbound" ? route.state === "active" : Boolean(ledger.historyCheckpoints[checkpointKey]),
      fullyReconciled: Boolean(ledger.checkpoints[checkpointKey]), pending: entries.filter((entry) => entry.disposition === "pending").length,
      blocked: entries.filter((entry) => entry.disposition === "blocked").length, detached: Object.values(ledger.records).filter((record) => record.contributions.some((entry) => entry.routeId === route.id && entry.state === "detached")).length,
      attempts: entries.reduce((maximum, entry) => Math.max(maximum, entry.attempts), 0), nextAttemptAt: entries.filter((entry) => entry.disposition === "pending").reduce((minimum, entry) => Math.min(minimum, entry.nextAttemptAt), Infinity) === Infinity ? null :
        Math.min(...entries.filter((entry) => entry.disposition === "pending").map((entry) => entry.nextAttemptAt)),
      retry: ledger.routeRetries[route.id] ?? { revision: route.revision, attempts: 0, nextAttemptAt: 0, blocked: false, lastError: null } };
  });
  const record = documentId === undefined ? null : Object.values(ledger.records).find((entry) => entry.localId === documentId);
  if (documentId !== undefined && !record) {
    throw new Error("Document is not present in the managed ledger");
  }

  const document = record ? { localId: record.localId, originInboxId: record.originInboxId, originDocumentId: record.originDocumentId,
    state: record.state, fingerprint: stateFingerprint(record), target: ledger.publicationIntents[canonicalKey(record.originInboxId, record.originDocumentId)] ?? null,
    deliveries: await Promise.all(Object.values(ledger.routes).filter((route) => route.direction === "outbound").map((route) => store.deliveryStatus(route.id, record.originInboxId, record.originDocumentId))) } : null;
  return { schemaVersion: 1, command: "sync status", inbox: { id: ledger.inboxId, name: selection.name ?? null, home: selection.home }, peerId: ledger.inboxId,
    target: ledger.runtime?.config.intendedTarget ?? null, worker: await getOwnedWorkerStatus(selection.home), routes, document,
    origin: ledger.originKeys.find((entry) => entry.inboxId === ledger.inboxId) ?? null, trustedOwnerRecoveryAvailable: false };
}

export async function runSyncCommand(command: SyncCommand, selection: ResolvedInboxSelection) {
  const home = selection.home;
  if (command.command === "sync enroll") {
    if (!command.yes) {
      throw new Error("Managed format enrollment requires --yes; stop or upgrade undiscoverable old readers/mutators first");
    }

    if (!selection.name || !selection.instanceId) {
      throw new Error("Enrollment requires a registered named inbox");
    }

    await enrollRegisteredInbox({ name: selection.name, home: selection.home, instanceId: selection.instanceId });
    return { ...await getSyncStatus(selection), command: command.command, enrolled: true };
  }

  const ledger = await assertManagedLifecycle(home);
  if (!ledger) {
    throw new Error("Sync command requires an enrolled inbox");
  }

  const store = new ManagedSyncStore(home);
  if (command.command === "sync configure") {
    await requireRegisteredSelection(selection);
    const config = parseRuntimeConfig(await readSyncJson(command.config));
    const restart = await stopForReconfiguration(home);
    await store.configureRuntime(config);

    if (restart && ledger.worker.enabled) {
      await ensureOwnedSyncWorker(home);
    }

    return { ...await getSyncStatus(selection), command: command.command, configured: true };
  }

  if (command.command === "sync status") {
    return getSyncStatus(selection, command.document);
  }

  if (command.command === "sync mapping add" || command.command === "sync mapping reconnect") {
    const entry = await requireRegisteredSelection(selection);
    const route = parseMappingInput(await readSyncJson(command.config));
    if (route.localInboxName !== entry.name || (route.direction === "inbound" ? route.destinationInboxId : route.sourceInboxId) !== entry.instanceId) {
      throw new Error("Mapping local named inbox/UUID does not match the selected registered inbox");
    }

    if (command.command === "sync mapping add" && route.revision !== 1 || command.command === "sync mapping reconnect" && (route.id !== command.routeId || route.revision !== command.revision + 1)) {
      throw new Error("Mapping expected revision differs from the explicit command; configure matching fresh revisions at both endpoints");
    }

    const restart = await stopForReconfiguration(home);
    const installed = await store.configureRoute(route);

    if (restart && ledger.worker.enabled) {
      await ensureOwnedSyncWorker(home);
    }

    console.error(`html-inbox: Mapping ${installed.sourceInboxId} to ${installed.destinationInboxId}; local inbox ${entry.name}; reader audience ${installed.readerAudience}. Remote audience unknown.`);
    return { schemaVersion: 1, command: command.command, inbox: entry, route: installed };
  }

  if (command.command === "sync mapping remove") {
    await store.revokeRoute(command.routeId, command.revision);
    let quiesced = true;
    try {
      const owner = await inspectWorkerOwner(home);
      if (owner.state === "owned") {
        await contactWorker(home, "quiesce", command.routeId, Date.now() + 7000);
      }
    } catch {
      quiesced = false;
      process.exitCode = 3;
    }

    return { schemaVersion: 1, command: command.command, removed: true, quiesced, routeId: command.routeId, revision: command.revision + 1 };
  }

  if (command.command === "sync target set" || command.command === "sync target clear") {
    const restart = await stopForReconfiguration(home);
    await store.setIntendedTarget(command.command === "sync target set" ? { peerId: command.peerId, destinationInboxId: command.destinationInboxId } : null);

    if (restart && ledger.worker.enabled) {
      await ensureOwnedSyncWorker(home);
    }

    return { ...await getSyncStatus(selection), command: command.command };
  }

  if (command.command === "sync pause" || command.command === "sync resume") {
    const paused = command.command === "sync pause";
    await store.setRetryPaused(paused);
    const owner = await inspectWorkerOwner(home);

    if (paused && owner.state === "owned") {
      await contactWorker(home, "quiesce");
    }

    if (!paused && ledger.worker.enabled) {
      await ensureOwnedSyncWorker(home);
      await contactWorker(home, "wake");
    }

    return { ...await getSyncStatus(selection), command: command.command, incomingPushesMayContinue: true };
  }

  if (command.command === "sync retry") {
    const route = ledger.routes[command.routeId];

    if (!route) {
      throw new Error("Unknown route");
    }

    await store.retry(routeAuthorization(route));
    if (ledger.worker.enabled && !ledger.worker.retryPaused) {
      await ensureOwnedSyncWorker(home);
      await contactWorker(home, "wake");
    }

    return { ...await getSyncStatus(selection), command: command.command };
  }

  if (command.command === "sync run") {
    const routeIds = command.routeId ? [command.routeId] : undefined;

    if (routeIds?.some((id) => !ledger.routes[id])) {
      throw new Error("Unknown route");
    }

    const timing = ledger.runtime?.config.timings ?? defaultRuntimeConfig().timings;
    const request = { ticketId: randomUUID(), ...(routeIds ? { routeIds } : {}), deadlineAt: Date.now() + timing.passMs, requestMs: timing.requestMs };
    const owner = await inspectWorkerOwner(home);
    if (owner.state === "owned") {
      const result = await submitWorkerRun(home, request);
      return { schemaVersion: 1, command: command.command, ...result };
    }

    const runtime = await startOwnedSyncWorker(home, { temporary: true });
    try {
      runtime.requestRun(request);
      while (Date.now() < request.deadlineAt) {
        const ticket = runtime.status().tickets.find((entry) => entry.ticketId === request.ticketId);
        if (ticket?.state === "complete" || ticket?.state === "cancelled") {
          return { schemaVersion: 1, command: command.command, ...ticket };
        }

        await delay(20);
      }

      runtime.cancel(request.ticketId);
      process.exitCode = 2;
      return { schemaVersion: 1, command: command.command, state: "pending", reason: "pass-deadline" };
    } finally {
      await runtime.close();
    }
  }

  if (command.command === "sync worker supervisor render") {
    const definition = await createSyncSupervisorDefinition(home, command.platform, command.user);
    const text = renderSyncSupervisor(definition);
    return command.json ? { schemaVersion: 1, command: command.command, definition: text, bootSupervised: false } : text;
  }

  if (command.command === "sync worker supervisor status") {
    return { schemaVersion: 1, command: command.command, ...await inspectSyncSupervisor(home, command.definition) };
  }

  if (command.command === "sync worker") {
    if (command.action === "status") {
      return { ...await getSyncStatus(selection), command: "sync worker status" };
    }

    if (command.action === "disable") {
      await store.setWorkerEnabled(false);
    }

    if (command.action === "stop" || command.action === "disable") {
      await stopOwnedSyncWorker(home);
      return { ...await getSyncStatus(selection), command: `sync worker ${command.action}` };
    }

    if (command.action === "enable") {
      await store.setWorkerEnabled(true);
    }

    if (command.action === "startup" && !ledger.worker.enabled) {
      return { schemaVersion: 1, command: "sync worker startup", skipped: true, enabled: false };
    }

    if (command.action === "start" && command.foreground) {
      const runtime = await startOwnedSyncWorker(home);
      const record = runtime.record;
      process.send?.({ type: "sync-worker-ready", pid: record.pid, processId: record.processId, inboxId: record.inboxId, storageIncarnation: record.storageIncarnation });
      return { schemaVersion: 1, command: "sync worker start", ready: true, peerId: record.inboxId,
        worker: { ...await getOwnedWorkerStatus(home), pid: record.pid, processId: record.processId } };
    }

    try {
      await ensureOwnedSyncWorker(home);

      if (command.action === "wake") {
        await contactWorker(home, "wake");
      }

      return { ...await getSyncStatus(selection), command: `sync worker ${command.action}` };
    } catch {
      await store.recordWorkerError("worker-startup-failed");
      process.exitCode = 1;
      return { ...await getSyncStatus(selection), command: `sync worker ${command.action}`, error: "worker-startup-failed" };
    }
  }

  throw new Error("Offline commands require explicit offline selection");
}

export function parseMappingInput(value: unknown): SyncRoute {
  const mapping = parseObject(value, "mapping configuration");
  assertExactKeys(mapping, ["schemaVersion", "expectedRevision", "route"]);

  if (mapping.schemaVersion !== 1) {
    throw new Error("Unsupported mapping configuration schema");
  }

  const route = parseObject(mapping.route, "mapping route");
  assertExactKeys(route, ["id", "direction", "peerId", "peerUrl", "sourceInboxId", "destinationInboxId", "localInboxName", "readerAudience", "allowedOrigins", "credentialRef", "tlsTrustRef"]);
  return parseRoute({ ...route, revision: parseInteger(mapping.expectedRevision) + 1, state: "reconnecting", lastError: null });
}

async function requireRegisteredSelection(selection: ResolvedInboxSelection): Promise<NamedInbox> {
  if (!selection.name || !selection.instanceId) {
    throw new Error("Enrollment/configuration requires an existing registered named inbox");
  }

  return inspectRegisteredInbox({ name: selection.name, home: selection.home, instanceId: selection.instanceId });
}

async function stopForReconfiguration(home: string): Promise<boolean> {
  const owner = await inspectWorkerOwner(home);
  if (owner.state === "owned") {
    await stopOwnedSyncWorker(home);
    return true;
  }

  return false;
}
