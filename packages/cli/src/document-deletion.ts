import { fork } from "node:child_process";
import path from "node:path";
import { type DeleteResult, isSafeDocumentId } from "./documents";
import { type LocalDocumentLocation, parseLocalDocumentLocation } from "./local-document-source";
import { DocumentIdentityError, parseDocumentDeletionResponse, type DocumentDeletionRequest } from "./document-deletion-protocol";
import { captureStorageIdentity, checkStorageIdentity, type DocumentDeleter, type StorageIdentity } from "./document-deletion-worker";

export { DocumentCleanupError, DocumentIdentityError } from "./document-deletion-protocol";
export type { DocumentDeleter } from "./document-deletion-worker";

export async function createDocumentDeleter(location: LocalDocumentLocation): Promise<DocumentDeleter> {
  const { home, instanceId } = parseLocalDocumentLocation(location);
  const storage = await captureStorageIdentity(home, instanceId);

  return (id) => deleteInWorker(storage, id);
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
