import { fork } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { type DeleteResult, isSafeDocumentId } from "./documents";
import { type LocalDocumentLocation, parseLocalDocumentLocation } from "./local-document-source";
import { DocumentIdentityError, parseDocumentDeletionResponse, type DocumentDeletionRequest } from "./document-deletion-protocol";
import { captureStorageIdentity, checkStorageIdentity, type DocumentDeleter, type StorageIdentity } from "./document-deletion-worker";
import { isOwnedDirectory, isOwnedRegularFile } from "./local-storage-checks";
import { optionalStat, readPrivateFile } from "./sync-files";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { ManagedDeletionIdentityError, ManagedSyncStore, type ManagedDeletionIdentity } from "./sync-store";

export { DocumentCleanupError, DocumentIdentityError } from "./document-deletion-protocol";
export type { DocumentDeleter } from "./document-deletion-worker";

export async function createDocumentDeleter(location: LocalDocumentLocation): Promise<DocumentDeleter> {
  const { home, instanceId } = parseLocalDocumentLocation(location);
  const root = await optionalStat(home);
  if (!root || !isOwnedDirectory(root) || await realpath(home) !== home) {
    throw new DocumentIdentityError("Deletion requires the selected canonical inbox root owned by the current account");
  }

  const identity: ManagedDeletionIdentity = { home, dev: root.dev, ino: root.ino, inboxId: instanceId };
  let hasObservedManaged = false;
  let legacy: StorageIdentity | undefined;
  const currentManagedStore = async () => {
    await assertCapturedDeletionIdentity(identity);
    const sync = await optionalStat(path.join(home, "sync"));
    const documents = await optionalStat(path.join(home, "documents"));
    if (sync && (!sync.isDirectory() || sync.isSymbolicLink() || (await readdir(path.join(home, "sync"))).length > 0) ||
        documents && !documents.isDirectory()) {
      hasObservedManaged = true;
    }

    const ledger = await assertManagedLifecycle(home);
    if (ledger) {
      hasObservedManaged = true;
      if (ledger.inboxId !== identity.inboxId) {
        throw new DocumentIdentityError("Managed inbox identity does not match the captured deletion target");
      }

      await assertCapturedDeletionIdentity(identity);
      return new ManagedSyncStore(home);
    }

    if (hasObservedManaged) {
      throw new DocumentIdentityError("Managed deletion storage is missing or incomplete; legacy deletion cannot resume");
    }

    return null;
  };

  if (!await currentManagedStore()) {
    try {
      legacy = await captureStorageIdentity(home, instanceId);
    } catch (error) {
      // Enrollment can complete between the format check and read-only legacy capture.
      if (!(error instanceof DocumentIdentityError) || !await currentManagedStore()) {
        throw error;
      }
    }
  }

  await assertCapturedDeletionIdentity(identity);
  return async (id) => {
    if (!isSafeDocumentId(id)) {
      return null;
    }

    const managed = await currentManagedStore();
    if (managed) {
      try {
        return await managed.deleteDocument(id, identity);
      } catch (error) {
        if (error instanceof ManagedDeletionIdentityError) {
          throw new DocumentIdentityError("Managed deletion target no longer matches the captured inbox", { cause: error });
        }

        throw error;
      }
    }

    if (!legacy) {
      throw new DocumentIdentityError("Captured legacy deletion storage is unavailable");
    }

    return deleteInWorker(legacy, id);
  };
}

async function assertCapturedDeletionIdentity(identity: ManagedDeletionIdentity) {
  const root = await optionalStat(identity.home);
  if (!root || !isOwnedDirectory(root) || root.dev !== identity.dev || root.ino !== identity.ino || await realpath(identity.home) !== identity.home) {
    throw new DocumentIdentityError("Inbox root no longer matches the captured deletion target");
  }

  const identityPath = path.join(identity.home, "instance-id");
  const info = await optionalStat(identityPath);
  if (!info || !isOwnedRegularFile(info)) {
    throw new DocumentIdentityError("Captured inbox identity is missing or unsafe");
  }

  const instanceId = (await readPrivateFile(identityPath, 128)).toString("utf8").trim().toLowerCase();
  if (instanceId !== identity.inboxId) {
    throw new DocumentIdentityError("Inbox identity does not match the captured deletion target");
  }
}

// CLI storage preparation predates inbox identities. Both callers use the same worker.
export async function deleteStoredDocument(home: string, id: string): Promise<DeleteResult | null> {
  if (!isSafeDocumentId(id)) {
    return null;
  }

  const storage = await captureStorageIdentity(home);
  return deleteInWorker(storage, id);
}

async function deleteInWorker(storage: StorageIdentity, id: string): Promise<DeleteResult | null> {
  if (!isSafeDocumentId(id)) {
    return null;
  }

  await checkStorageIdentity(storage);
  const { directory, ...identity } = storage;
  const request: DocumentDeletionRequest = { protocolVersion: 1, id, storage: identity };

  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "index.js"), ["__delete-document"], {
      cwd: storage.home,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let response: ReturnType<typeof parseDocumentDeletionResponse> | undefined;
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error("Document deletion worker timed out; deletion outcome is unconfirmed");
      child.kill();
    }, 30_000);
    timeout.unref();
    child.once("spawn", () => {
      child.send(request, (error) => {
        if (error) {
          failure = new Error("Document deletion worker transport failed; deletion outcome is unconfirmed", { cause: error });
          child.kill();
        }
      });
    });
    child.on("message", (value: unknown) => {
      try {
        if (response) {
          throw new Error("Document deletion worker sent multiple responses");
        }

        response = parseDocumentDeletionResponse(value, id);
      } catch (error) {
        failure = new Error("Document deletion worker response is invalid; deletion outcome is unconfirmed", { cause: error });
        child.kill();
      }
    });
    child.once("error", (error) => {
      failure = "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
        ? new DocumentIdentityError("Cannot enter the captured inbox root", { cause: error })
        : new Error("Document deletion worker transport failed; deletion outcome is unconfirmed", { cause: error });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);

      if (failure) {
        reject(failure);
      } else if (code !== 0 || !response) {
        reject(new Error("Document deletion worker exited without a confirmed result; deletion outcome is unconfirmed"));
      } else if (response.ok) {
        resolve(response.result);
      } else {
        reject(response.error);
      }
    });
  });
}
