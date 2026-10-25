import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { assertUuidV4 } from "./validation";
import { hasErrorCode } from "./viewer-records";

export type InboxInspectionState = "missing" | "conflict" | "incompatible";

export class InboxInspectionError extends Error {
  constructor(readonly state: InboxInspectionState, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export async function canonicalizeInboxHome(home: string, allowMissing = false): Promise<string> {
  if (typeof home !== "string" || !home || home.includes("\0") || !path.isAbsolute(home)) {
    throw new Error("Inbox home must be an absolute path");
  }

  const absoluteHome = path.resolve(home);
  const info = await lstat(absoluteHome).catch((error: unknown) => {
    if (allowMissing && hasErrorCode(error, "ENOENT") && path.dirname(absoluteHome) !== absoluteHome) {
      return null;
    }

    throw error;
  });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new InboxInspectionError("incompatible", `Inbox home must be a directory and cannot be a leaf symbolic link: ${absoluteHome}`);
    }

    return realpath(absoluteHome);
  }

  const parent = path.dirname(absoluteHome);
  const canonicalParent = await realpath(parent).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return canonicalizeInboxHome(parent, true);
    }

    throw error;
  });
  return path.join(canonicalParent, path.basename(absoluteHome));
}

export async function readInboxIdentity(home: string): Promise<string | undefined> {
  const identityPath = path.join(home, "instance-id");
  const checked = await lstat(identityPath).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  });
  if (!checked) {
    return undefined;
  }

  if (!checked.isFile() || checked.isSymbolicLink() || checked.nlink !== 1) {
    throw new InboxInspectionError("incompatible", `Inbox identity must be a regular private file: ${identityPath}`);
  }

  const file = await open(identityPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== checked.dev || info.ino !== checked.ino) {
      throw new InboxInspectionError("incompatible", `Inbox identity changed during inspection: ${identityPath}`);
    }

    const instanceId = (await readBoundedFile(file, 128, `Inbox identity is too large: ${identityPath}`)).toString("utf8").trim();
    assertUuidV4(instanceId, `Inbox identity at ${identityPath}`);
    return instanceId.toLowerCase();
  } finally {
    await file.close();
  }
}

export async function inspectInboxHome(home: string): Promise<{ home: string; instanceId?: string }> {
  try {
    const canonicalHome = await canonicalizeInboxHome(home);
    const instanceId = await readInboxIdentity(canonicalHome);
    const documentsPath = path.join(canonicalHome, "documents");
    const documents = await lstat(documentsPath).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    });
    if (documents && (!documents.isDirectory() || documents.isSymbolicLink())) {
      throw new InboxInspectionError("incompatible", `Inbox documents must be a regular directory: ${documentsPath}`);
    }

    if (!instanceId && !documents) {
      throw new InboxInspectionError("incompatible", `Not an existing HTML Inbox library: ${canonicalHome}`);
    }

    return { home: canonicalHome, ...(instanceId ? { instanceId } : {}) };
  } catch (error) {
    if (error instanceof InboxInspectionError) {
      throw error;
    }

    const state = hasErrorCode(error, "ENOENT") ? "missing" : "incompatible";
    throw new InboxInspectionError(state, `Cannot inspect inbox home ${home}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
