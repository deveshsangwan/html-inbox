import { rm, realpath } from "node:fs/promises";
import path from "node:path";
import { readInboxIdentity } from "./inbox-home";
import { readCatalogIdentityTransition, withCatalogIdentityTransition } from "./inbox-catalog";
import { parseLedger } from "./sync-ledger";
import { checkDirectory, createStorageCounters, DurableFiles, isDeadOwner, optionalStat, readPrivateFile, readSyncOwnership } from "./sync-files";
import { parseUuid } from "./sync-model";
import { ManagedSyncStore } from "./sync-store";
import { acquireViewerStartLock } from "./viewer-start-lock";
import { readViewerRecord } from "./viewer-records";
import { stopViewer } from "./viewer-server";
import { verifyViewerLocalOwner } from "./viewer-ownership";
import { acquireWorkerExclusion, readWorkerRecordOffline, workerPaths } from "./sync-worker-records";
import { stopOwnedSyncWorker } from "./sync-worker-client";

export async function inspectSyncRestore(home: string) {
  await assertCanonicalMaintenanceHome(home);
  const ledger = parseLedger(JSON.parse((await readPrivateFile(path.join(home, "sync", "ledger.json"), 64 * 1024 * 1024)).toString("utf8")));
  const info = await checkDirectory(home);
  const anchorMatches = ledger.ownerAnchor.home === home && ledger.ownerAnchor.dev === info.dev && ledger.ownerAnchor.ino === info.ino;
  const identity = await readInboxIdentity(home);
  return { schemaVersion: 1, inboxId: ledger.inboxId, peerId: ledger.inboxId, home, anchorMatches, readerIdentityMatches: identity === ledger.inboxId,
    migration: ledger.migration.phase, quarantined: ledger.worker.ownerQuarantined, trustedOwnerRecoveryAvailable: false };
}

export async function maintainSyncIdentity(home: string, expectedInboxId: string, action: "quarantine" | "fork") {
  await assertCanonicalMaintenanceHome(home);
  parseUuid(expectedInboxId);
  const inspected = await inspectSyncRestore(home);
  const transition = action === "fork" ? await readCatalogIdentityTransition(home, expectedInboxId) : null;
  if (inspected.inboxId !== expectedInboxId && !(transition && transition.newInboxId === inspected.inboxId)) {
    throw new Error("Offline expected inbox identity differs from the ledger or recorded fork transition");
  }

  const paths = workerPaths(home);
  const files = new DurableFiles(createStorageCounters(), {}, home);
  await files.directory(paths.directory);
  const worker = await readWorkerRecordOffline(home);
  if (worker) {
    if (worker.ownerAnchor.home === home) {
      if (!inspected.anchorMatches || worker.inboxId !== inspected.inboxId) {
        throw new Error("Same-home worker ownership is ambiguous; identity maintenance is blocked");
      }

      await stopOwnedSyncWorker(home);
    } else {
      const owner = await readSyncOwnership(paths.lifetime);
      if (owner && (owner.token !== worker.processId || owner.pid !== worker.pid || owner.start !== worker.start)) {
        throw new Error("Copied worker lock and record disagree; no control or signal was attempted");
      }

      if (owner) {
        await rm(paths.lifetime);
      }

    }
  }

  const viewer = await readViewerRecord(home, { readOnly: true });
  if (viewer) {
    if (!viewer.localOwner) {
      throw new Error("Unanchored viewer runtime blocks offline maintenance; no endpoint was contacted");
    }

    if (viewer.localOwner.home === home) {
      if (!inspected.anchorMatches) {
        throw new Error("Same-home viewer ownership is ambiguous; no endpoint was contacted");
      }

      if (await verifyViewerLocalOwner(home, viewer) === "live") {
        await stopViewer(home);
      }
    }
  }

  const viewerExclusion = await acquireViewerStartLock(home);
  const workerExclusion = await acquireWorkerExclusion(home);
  try {
    const remainingWorker = await readWorkerRecordOffline(home);
    if (remainingWorker?.ownerAnchor.home === home && !await isDeadOwner({ token: remainingWorker.processId, pid: remainingWorker.pid, start: remainingWorker.start })) {
      throw new Error("A same-home worker started during quiescence; maintenance is blocked");
    }

    const remainingViewer = await readViewerRecord(home, { readOnly: true });
    if (remainingViewer?.localOwner?.home === home && await verifyViewerLocalOwner(home, remainingViewer) !== "dead") {
      throw new Error("A same-home viewer started during quiescence; maintenance is blocked");
    }

    const store = new ManagedSyncStore(home);
    const finish = async () => {
      for (const file of [paths.record, path.join(home, "viewer.json"), path.join(home, "viewer-config.json"), path.join(home, "tailscale-serve.json")]) {
        if (await optionalStat(file)) {
          await rm(file);
        }

      }

      await files.flushDirectory(paths.directory);
      await files.flushDirectory(home);
    };
    if (action === "quarantine") {
      if (inspected.inboxId !== expectedInboxId) {
        throw new Error("Offline expected inbox identity differs from the ledger");
      }

      await store.quarantineRestore();
      await finish();
      return inspectSyncRestore(home);
    }

    return withCatalogIdentityTransition(home, expectedInboxId, async (transition, complete) => {
      const current = await inspectSyncRestore(home);
      if (current.inboxId === transition.oldInboxId) {
        if (!current.quarantined) {
          await store.quarantineRestore();
        }

        await store.fork({ oldInboxId: transition.oldInboxId, newInboxId: transition.newInboxId });
      } else if (current.inboxId === transition.newInboxId) {
        await store.recover();
      } else {
        throw new Error("Fork state differs from the recorded catalog transition");
      }

      await finish();
      await complete();
      return inspectSyncRestore(home);
    });
  } finally {
    await workerExclusion.release();
    await viewerExclusion.release();
  }
}

async function assertCanonicalMaintenanceHome(home: string) {
  if (!path.isAbsolute(home) || path.resolve(home) !== home || await realpath(home) !== home) {
    throw new Error("Offline maintenance requires an explicit canonical absolute home");
  }

  await checkDirectory(home);
}
