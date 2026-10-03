import { readFile } from "node:fs/promises";
import {
  parseWranglerDeployUrls,
  type CloudflareDeployReceipt,
} from "./cloudflare-pages";
import { hardenPrivateFile } from "./private-storage";
import {
  assertInboxCapability,
  assertUuidV4,
  isRecord,
  normalizeCloudflareBranch,
  normalizeCloudflareProjectRef,
  sameCloudflareProject,
  type CloudflareProjectRef,
} from "./validation";

export const REMOTE_SCHEMA_VERSION = 1;

export interface RemoteDeploymentRecord {
  operationId: string;
  kind: "publish" | "revoke";
  snapshotHash: string;
  completedAt: string;
  receipt: CloudflareDeployReceipt;
}

export interface RemoteState {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION;
  ownerId: string;
  target: CloudflareProjectRef;
  branch: string;
  capability: string;
  revoked: boolean;
  configuredAt: string;
  updatedAt: string;
  lastDeployment?: RemoteDeploymentRecord;
}

interface OperationBase {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION;
  id: string;
  target: CloudflareProjectRef;
  branch: string;
  ownerId: string;
  capability: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type InitOperation = OperationBase & {
  kind: "init";
  phase: "prepared" | "remote-succeeded";
  adopt: boolean;
};

type SnapshotIntent = OperationBase & { snapshotHash: string } & (
    | { kind: "publish" }
    | { kind: "revoke"; previousCapability: string }
  );

export type PreparedSnapshotOperation = SnapshotIntent & { phase: "prepared" };
export type CompletedSnapshotOperation = SnapshotIntent & {
  phase: "remote-succeeded";
  receipt: CloudflareDeployReceipt;
};
export type RemoteOperation =
  | InitOperation
  | PreparedSnapshotOperation
  | CompletedSnapshotOperation;

export async function readRemoteState(
  filePath: string,
): Promise<RemoteState | null> {
  return readPrivateJson(filePath, parseRemoteState);
}

export async function readRemoteOperation(
  filePath: string,
): Promise<RemoteOperation | null> {
  return readPrivateJson(filePath, parseRemoteOperation);
}

async function readPrivateJson<T>(
  filePath: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    await hardenPrivateFile(filePath);
    return parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;

    if (error instanceof SyntaxError)
      throw new Error(`Remote state is corrupt: ${filePath}`);

    throw error;
  }
}

export function parseRemoteState(value: unknown): RemoteState {
  const record = parseSchema(value, "state");
  const ownerId = parseUuid(record.ownerId, "remote owner ID");
  const capability = parseCapability(record.capability);
  const target = normalizeCloudflareProjectRef(record.target);
  const branch = normalizeCloudflareBranch(parseString(record.branch));
  if (typeof record.revoked !== "boolean")
    throw new Error("Remote revoked flag is invalid");

  const state: RemoteState = {
    schemaVersion: REMOTE_SCHEMA_VERSION,
    ownerId,
    capability,
    target,
    branch,
    revoked: record.revoked,
    configuredAt: parseTimestamp(record.configuredAt),
    updatedAt: parseTimestamp(record.updatedAt),
  };

  if (record.lastDeployment !== undefined) {
    const deployment = record.lastDeployment;
    if (
      !isRecord(deployment) ||
      (deployment.kind !== "publish" && deployment.kind !== "revoke")
    ) {
      throw new Error("Remote deployment record is invalid");
    }

    if (state.revoked !== (deployment.kind === "revoke"))
      throw new Error("Remote deployment kind conflicts with state");

    state.lastDeployment = {
      operationId: parseUuid(
        deployment.operationId,
        "remote deployment operation ID",
      ),
      kind: deployment.kind,
      snapshotHash: parseDigest(deployment.snapshotHash),
      completedAt: parseTimestamp(deployment.completedAt),
      receipt: parseRemoteReceipt(deployment.receipt, state),
    };
  } else if (state.revoked) {
    throw new Error("Revoked remote state has no deployment");
  }

  return state;
}

export function parseRemoteOperation(value: unknown): RemoteOperation {
  const record = parseSchema(value, "operation");
  if (record.phase !== "prepared" && record.phase !== "remote-succeeded")
    throw new Error("Remote operation phase is invalid");

  if (
    typeof record.attempts !== "number" ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 0
  )
    throw new Error("Remote operation attempts are invalid");

  const base: OperationBase = {
    schemaVersion: REMOTE_SCHEMA_VERSION,
    id: parseUuid(record.id, "operation ID"),
    ownerId: parseUuid(record.ownerId, "remote owner ID"),
    capability: parseCapability(record.capability),
    target: normalizeCloudflareProjectRef(record.target),
    branch: normalizeCloudflareBranch(parseString(record.branch)),
    attempts: record.attempts,
    createdAt: parseTimestamp(record.createdAt),
    updatedAt: parseTimestamp(record.updatedAt),
  };

  if (record.kind === "init") {
    if (
      typeof record.adopt !== "boolean" ||
      record.snapshotHash !== undefined ||
      record.receipt !== undefined ||
      record.previousCapability !== undefined
    )
      throw new Error("Remote init intent is invalid");

    return { ...base, kind: "init", phase: record.phase, adopt: record.adopt };
  }

  if (record.adopt !== undefined)
    throw new Error("Remote deployment has an adoption decision");

  const snapshotHash = parseDigest(record.snapshotHash);
  let intent: SnapshotIntent;
  if (record.kind === "revoke") {
    const previousCapability = parseCapability(record.previousCapability);
    if (previousCapability === base.capability)
      throw new Error("Remote revoke must replace its capability");

    intent = { ...base, snapshotHash, kind: "revoke", previousCapability };
  } else if (
    record.kind === "publish" &&
    record.previousCapability === undefined
  ) {
    intent = { ...base, snapshotHash, kind: "publish" };
  } else {
    throw new Error("Remote operation kind is invalid");
  }

  if (record.phase === "remote-succeeded") {
    return {
      ...intent,
      phase: record.phase,
      receipt: parseRemoteReceipt(record.receipt, base),
    };
  }

  if (record.receipt !== undefined)
    throw new Error("Prepared remote operation contains a receipt");

  return { ...intent, phase: "prepared" };
}

function parseSchema(value: unknown, label: string) {
  if (!isRecord(value) || value.schemaVersion !== REMOTE_SCHEMA_VERSION)
    throw new Error(`Remote ${label} schema is unsupported`);

  return value;
}

function parseString(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Remote field must be a string");

  return value;
}

function parseUuid(value: unknown, label: string): string {
  const result = parseString(value);
  assertUuidV4(result, label);

  return result;
}

function parseCapability(value: unknown): string {
  const result = parseString(value);
  assertInboxCapability(result);

  return result;
}

function parseTimestamp(value: unknown): string {
  const result = parseString(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error("Remote timestamp is invalid");

  return result;
}

function parseDigest(value: unknown): string {
  const result = parseString(value);
  if (!/^[0-9a-f]{64}$/.test(result))
    throw new Error("Remote snapshot hash is invalid");

  return result;
}

export function parseRemoteReceipt(
  value: unknown,
  intent: { target: CloudflareProjectRef; branch: string; capability: string },
): CloudflareDeployReceipt {
  if (!isRecord(value)) throw new Error("Remote deployment receipt is invalid");

  const target = normalizeCloudflareProjectRef(value.target);
  const branch = normalizeCloudflareBranch(parseString(value.branch));
  const urls = parseWranglerDeployUrls(parseString(value.deploymentUrl));
  const inboxPath = `/i/${intent.capability}/`;
  if (
    !sameCloudflareProject(target, intent.target) ||
    branch !== intent.branch ||
    new URL(urls.deploymentUrl).origin !== urls.deploymentUrl ||
    value.deploymentUrl !== urls.deploymentUrl ||
    value.projectUrl !== urls.projectUrl ||
    value.deploymentInboxUrl !== `${urls.deploymentUrl}${inboxPath}` ||
    value.projectInboxUrl !== `${urls.projectUrl}${inboxPath}`
  ) {
    throw new Error("Remote deployment receipt does not match its intent");
  }

  return {
    target,
    branch,
    ...urls,
    deploymentInboxUrl: `${urls.deploymentUrl}${inboxPath}`,
    projectInboxUrl: `${urls.projectUrl}${inboxPath}`,
  };
}
