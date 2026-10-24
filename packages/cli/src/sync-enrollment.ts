import path from "node:path";
import { lstat } from "node:fs/promises";
import { readInboxCatalog, getInboxCatalogHome, type NamedInbox } from "./inbox-catalog";
import { canonicalizeInboxHome, readInboxIdentity } from "./inbox-home";
import { acquireViewerStartLock } from "./viewer-start-lock";
import { readViewerRecord, hasErrorCode } from "./viewer-records";
import { verifyViewerLocalOwner } from "./viewer-ownership";
import { getControlHealth } from "./viewer-status";
import { ManagedSyncStore } from "./sync-store";
import { readPublicSyncDefinition } from "./sync-public-definition";
import { parseLedger } from "./sync-ledger";
import { checkDirectory, optionalStat, readPrivateFile } from "./sync-files";
import { assertManagedLifecycle } from "./sync-lifecycle";
import type { InboxSelection, ResolvedInboxSelection } from "./inbox-selection";
import { parseViewerServiceDefinition } from "./viewer-service-definition";

export interface EnrollmentOptions {
  serviceDefinitionPaths?: string[];
}

export async function enrollRegisteredInbox(entry: NamedInbox, options: EnrollmentOptions = {}): Promise<void> {
  await assertEnrollmentBinding(entry);
  const exclusion = await acquireViewerStartLock(entry.home);
  try {
    if (await readInboxIdentity(entry.home) !== entry.instanceId) {
      throw new Error("Inbox identity changed before enrollment");
    }

    const servicePaths = options.serviceDefinitionPaths ?? (process.platform === "darwin" ? ["/Library/LaunchDaemons/com.html-inbox.viewer.plist"] :
      process.platform === "linux" ? ["/etc/systemd/system/html-inbox-viewer.service"] : []);
    for (const file of servicePaths) {
      const info = await lstat(file).catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) {
          return null;
        }

        throw error;
      });

      if (!info) {
        continue;
      }

      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024) {
        throw new Error("Viewer supervision is locally ambiguous; inspect it before enrollment");
      }

      const definition = parseViewerServiceDefinition(await readPublicSyncDefinition(file));
      if (path.resolve(definition.home) === entry.home) {
        throw new Error("Existing viewer supervision must be explicitly stopped and upgraded before enrollment");
      }
    }

    const record = await readViewerRecord(entry.home, { readOnly: true });
    if (record) {
      if (await verifyViewerLocalOwner(entry.home, record) !== "live") {
        throw new Error("A stale viewer runtime record must be inspected before enrollment");
      }

      const health = await getControlHealth(record.controlUrl);
      if (health.state !== "ready" || !health.managedCompatible || health.instanceId.toLowerCase() !== entry.instanceId || health.processId !== record.processId || health.pid !== record.pid) {
        throw new Error("Running viewer lacks verified managed-schema-1 dynamic switching capability; stop and upgrade it before enrollment");
      }
    }

    await new ManagedSyncStore(entry.home).enroll();
  } finally {
    await exclusion.release();
  }
}

export async function resolveEnrollmentSelection(selection: InboxSelection, env = process.env): Promise<ResolvedInboxSelection> {
  const catalog = await readInboxCatalog(getInboxCatalogHome(env), { readOnly: true });
  const isExplicit = selection.inbox !== undefined || selection.home !== undefined;
  const name = isExplicit ? selection.inbox : env.HTML_INBOX_NAME || undefined;
  const requestedHome = isExplicit ? selection.home : env.HTML_INBOX_HOME ? path.resolve(env.HTML_INBOX_HOME) : undefined;
  const home = requestedHome === undefined ? undefined : await canonicalizeInboxHome(requestedHome);
  const entry = name ? catalog.inboxes.find((candidate) => candidate.name === name) : home ? catalog.inboxes.find((candidate) => candidate.home === home) :
    catalog.inboxes.find((candidate) => candidate.name === catalog.defaultName);
  if (!entry || home !== undefined && entry.home !== home) {
    throw new Error("Enrollment requires an existing registered named inbox with matching selection");
  }

  await assertEnrollmentBinding(entry);
  return { ...entry, source: isExplicit ? "explicit" : name || home ? "environment" : "default" };
}

async function assertEnrollmentBinding(entry: NamedInbox): Promise<void> {
  if (await canonicalizeInboxHome(entry.home) !== entry.home || await readInboxIdentity(entry.home) !== entry.instanceId) {
    throw new Error("Enrollment registered home or identity changed");
  }

  if (!await optionalStat(path.join(entry.home, "sync", "ledger.json"))) {
    await assertManagedLifecycle(entry.home);
    return;
  }

  const ledger = parseLedger(JSON.parse((await readPrivateFile(path.join(entry.home, "sync", "ledger.json"), 64 * 1024 * 1024)).toString("utf8")));
  const info = await checkDirectory(entry.home);
  if (ledger.inboxId !== entry.instanceId || ledger.ownerAnchor.home !== entry.home || ledger.ownerAnchor.dev !== info.dev || ledger.ownerAnchor.ino !== info.ino ||
      ledger.worker.ownerQuarantined || ledger.migration.phase === "forking") {
    throw new Error("Enrollment identity/anchor is unsafe or requires offline fork recovery; no endpoint was contacted");
  }
}
