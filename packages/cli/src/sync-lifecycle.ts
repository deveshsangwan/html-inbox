import path from "node:path";
import { readdir } from "node:fs/promises";
import { checkDirectory, optionalStat } from "./sync-files";
import { ManagedSyncStore } from "./sync-store";

/** Local identity must be established before reading runtime authority or contacting endpoints. */
export async function assertManagedLifecycle(home: string) {
  if (!await ManagedSyncStore.isEnrolled(home)) {
    const documents = await optionalStat(path.join(home, "documents"));
    const sync = await optionalStat(path.join(home, "sync"));
    if (documents && !documents.isDirectory() || sync && (!sync.isDirectory() || sync.isSymbolicLink())) {
      throw new Error("Managed format barrier or invalid sync area has no authoritative ledger; offline inspection is required");
    }

    if (sync) {
      await checkDirectory(path.join(home, "sync"));
      if ((await readdir(path.join(home, "sync"))).length) {
        throw new Error("Managed artifacts have no authoritative ledger; offline inspection is required");
      }
    }

    return null;
  }

  return new ManagedSyncStore(home).snapshot();
}
