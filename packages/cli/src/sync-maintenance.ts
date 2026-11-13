import { rm, realpath } from "node:fs/promises";
import path from "node:path";
import { readInboxIdentity } from "./inbox-home";
import { readCatalogIdentityTransition, withCatalogIdentityTransition } from "./inbox-catalog";
import { parseLedger } from "./sync-ledger";
import { checkDirectory, createStorageCounters, DurableFiles, acquireSyncOwnership, isDeadOwner, optionalStat, readPrivateFile, readSyncOwnership } from "./sync-files";
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
  return {
    schemaVersion: 1, inboxId: ledger.inboxId, peerId: ledger.inboxId, storageIncarnation: ledger.storageIncarnation,
    home, ownerAnchor: ledger.ownerAnchor, currentAnchor: { home, dev: info.dev, ino: info.ino }, anchorMatches,
    readerIdentity: identity, readerIdentityMatches: identity === ledger.inboxId,
    migration: ledger.migration.phase, quarantined: ledger.worker.ownerQuarantined, trustedOwnerRecoveryAvailable: false,
  };
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
  if (worker?.ownerAnchor.home === home && !await isDeadOwner({ token: worker.processId, pid: worker.pid, start: worker.start })) {
    if (!inspected.anchorMatches || worker.inboxId !== inspected.inboxId) {
      throw new Error("Same-home worker ownership is ambiguous; identity maintenance is blocked");
    }

    await stopOwnedSyncWorker(home);
  }

  const viewer = await readViewerRecord(home, { readOnly: true });
  if (viewer) {
    if (!viewer.localOwner) {
      throw new Error("Unanchored viewer runtime blocks offline maintenance; no endpoint was contacted");
    }

    if (viewer.localOwner.home === home && !await isDeadOwner({ token: viewer.processId, pid: viewer.pid, start: viewer.localOwner.start })) {
      if (!inspected.anchorMatches) {
        throw new Error("Same-home viewer ownership is ambiguous; no endpoint was contacted");
      }

      if (await verifyViewerLocalOwner(home, viewer) === "live") {
        await stopViewer(home);
      }
    }
  }

  const viewerExclusion = await acquireViewerStartLock(home);
  try {
    const workerExclusion = await acquireWorkerExclusion(home);
    try {
      // Startup exclusion does not settle a worker that already owns its lifetime lock.
      const remainingWorker = await readWorkerRecordOffline(home);
      const remainingViewer = await readViewerRecord(home, { readOnly: true });
      await assertOfflineRuntimes(home, remainingWorker, remainingViewer);
      const owner = await readSyncOwnership(paths.lifetime);
      if (await optionalStat(paths.lifetime)) {
        if (!owner || !await isDeadOwner(owner)) {
          throw new Error("Worker lifetime ownership is live or unknown; identity maintenance is blocked");
        }

        if (remainingWorker && (owner.token !== remainingWorker.processId || owner.pid !== remainingWorker.pid || owner.start !== remainingWorker.start)) {
          throw new Error("Worker lifetime lock and record disagree; identity maintenance is blocked");
        }
      }

      // Acquisition uses the checked dead-lock reaper, never an unchecked unlink.
      const lifetime = await acquireSyncOwnership(paths.lifetime, Date.now() + 1000);
      try {
        let baseline = await inspectSyncRestore(home);
        if (JSON.stringify(baseline) !== JSON.stringify(inspected)) {
          throw new Error("Restore identity changed during quiescence; identity maintenance is blocked");
        }

        const validateOwnership = async () => {
          await assertCanonicalMaintenanceHome(home);
          if (JSON.stringify(await inspectSyncRestore(home)) !== JSON.stringify(baseline)) {
            throw new Error("Restore identity changed during maintenance; identity maintenance is blocked");
          }

          if (JSON.stringify(await readWorkerRecordOffline(home)) !== JSON.stringify(remainingWorker) ||
              JSON.stringify(await readViewerRecord(home, { readOnly: true })) !== JSON.stringify(remainingViewer) ||
              JSON.stringify(await readSyncOwnership(paths.lifetime)) !== JSON.stringify(lifetime.owner)) {
            throw new Error("Runtime ownership changed during maintenance; identity maintenance is blocked");
          }

          await assertOfflineRuntimes(home, remainingWorker, remainingViewer);
        };
        await validateOwnership();

        const store = new ManagedSyncStore(home);
        const finish = async () => {
          await validateOwnership();
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

          await store.quarantineRestore(validateOwnership, expectedInboxId);
          baseline = await inspectSyncRestore(home);
          await finish();
          return await inspectSyncRestore(home);
        }

        return await withCatalogIdentityTransition(home, expectedInboxId, async (transition, complete) => {
          const current = await inspectSyncRestore(home);
          if (current.inboxId === transition.oldInboxId) {
            if (!current.quarantined) {
              await store.quarantineRestore(validateOwnership, expectedInboxId);
              baseline = await inspectSyncRestore(home);
            }

            await store.fork({ oldInboxId: transition.oldInboxId, newInboxId: transition.newInboxId }, validateOwnership);
          } else if (current.inboxId === transition.newInboxId) {
            await store.recover();
          } else {
            throw new Error("Fork state differs from the recorded catalog transition");
          }

          baseline = await inspectSyncRestore(home);
          await finish();
          await complete();
          return await inspectSyncRestore(home);
        });
      } finally {
        await lifetime.release();
      }
    } finally {
      await workerExclusion.release();
    }
  } finally {
    await viewerExclusion.release();
  }
}

async function assertOfflineRuntimes(home: string, worker: Awaited<ReturnType<typeof readWorkerRecordOffline>>, viewer: Awaited<ReturnType<typeof readViewerRecord>>) {
  if (worker?.ownerAnchor.home === home && !await isDeadOwner({ token: worker.processId, pid: worker.pid, start: worker.start })) {
    throw new Error("Same-home worker ownership is live or ambiguous; identity maintenance is blocked");
  }

  if (viewer && !viewer.localOwner) {
    throw new Error("Unanchored viewer runtime blocks offline maintenance; no endpoint was contacted");
  }

  if (viewer?.localOwner?.home === home && !await isDeadOwner({ token: viewer.processId, pid: viewer.pid, start: viewer.localOwner.start })) {
    throw new Error("Same-home viewer ownership is live or ambiguous; no endpoint was contacted");
  }
}

async function assertCanonicalMaintenanceHome(home: string) {
  if (!path.isAbsolute(home) || path.resolve(home) !== home || await realpath(home) !== home) {
    throw new Error("Offline maintenance requires an explicit canonical absolute home");
  }

  await checkDirectory(home);
}
