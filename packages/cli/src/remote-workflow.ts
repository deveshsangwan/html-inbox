import { randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DocumentBackend } from "@html-inbox/shared";
import {
  CloudflareDeployMetadata,
  CloudflareDeployReceipt,
  CloudflareDeploymentSummary,
  CloudflarePagesAdapter,
  CloudflareProjectSummary,
  CloudflareSnapshotRef,
  receiptFromDeployment,
} from "./cloudflare-pages";
import {
  assertInboxCapability,
  assertUuidV4,
  isRecord,
  normalizeCloudflareBranch,
  normalizeCloudflareProjectRef,
  sameCloudflareProject,
  type CloudflareProjectRef,
} from "./validation";
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  writePrivateFile,
} from "./private-storage";
import {
  exportStaticSnapshot,
  generateInboxCapability,
} from "./static-export";

const REMOTE_SCHEMA_VERSION = 1;

export interface RemoteDeploymentPort {
  listProjects(accountId: string, cwd: string): Promise<CloudflareProjectSummary[]>;
  createProject(
    target: CloudflareProjectRef,
    cwd: string,
    productionBranch?: string,
  ): Promise<void>;
  deploySnapshot(
    snapshot: CloudflareSnapshotRef,
    target: CloudflareProjectRef,
    branch?: string,
    metadata?: CloudflareDeployMetadata,
  ): Promise<CloudflareDeployReceipt>;
  listDeployments(
    target: CloudflareProjectRef,
    cwd: string,
  ): Promise<CloudflareDeploymentSummary[]>;
}

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

export interface RemoteOperation {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION;
  id: string;
  kind: "init" | "publish" | "revoke";
  phase: "prepared" | "remote-succeeded";
  target: CloudflareProjectRef;
  branch: string;
  ownerId: string;
  capability: string;
  previousCapability?: string;
  adopt?: boolean;
  snapshotHash?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  receipt?: CloudflareDeployReceipt;
}

export interface RemoteStatus {
  configured: boolean;
  state: RemoteState | null;
  operation: RemoteOperation | null;
}

export interface RemoteInitOptions extends CloudflareProjectRef {
  adopt?: boolean;
  branch?: string;
}

export interface RemoteReconcileOptions {
  adopt?: boolean;
}

export interface RemoteRevokeResult {
  state: RemoteState;
  revokedUrl: string;
  warning: string;
}

const EMPTY_SOURCE: Pick<DocumentBackend, "listDocuments" | "getDocument"> = {
  async listDocuments() {
    return [];
  },
  async getDocument() {
    return null;
  },
};

export class RemoteWorkflow {
  private readonly remoteDir: string;
  private readonly statePath: string;
  private readonly operationPath: string;
  private readonly workRoot: string;
  private readonly lockPath: string;

  constructor(
    private readonly backend: DocumentBackend,
    private readonly home: string,
    private readonly deployment: RemoteDeploymentPort = new CloudflarePagesAdapter(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.remoteDir = path.join(home, "remote");
    this.statePath = path.join(this.remoteDir, "state.json");
    this.operationPath = path.join(this.remoteDir, "operation.json");
    this.workRoot = path.join(this.remoteDir, "work");
    this.lockPath = path.join(this.remoteDir, "mutation.lock");
  }

  async init(options: RemoteInitOptions): Promise<RemoteState> {
    return this.withMutationLock(() => this.initUnlocked(options));
  }

  private async initUnlocked(options: RemoteInitOptions): Promise<RemoteState> {
    await this.assertNoOperation();
    const target = normalizeCloudflareProjectRef(options);
    const branch = normalizeCloudflareBranch(options.branch ?? "main");
    const current = await this.readState();
    if (current) {
      if (sameCloudflareProject(current.target, target) && current.branch === branch) return current;
      throw new Error("Remote publishing is already configured for another target");
    }

    const projects = await this.deployment.listProjects(target.accountId, this.remoteDir);
    const existing = projects.find((project) => projectMatchesTarget(project, target));
    if (existing && !options.adopt) {
      throw new Error(
        `Cloudflare Pages project ${target.projectName} already exists; rerun with --adopt to replace its contents`,
      );
    }
    if (existing) assertProductionBranch(existing, branch);

    const timestamp = this.now();
    const operation: RemoteOperation = {
      schemaVersion: REMOTE_SCHEMA_VERSION,
      id: randomUUID(),
      kind: "init",
      phase: "prepared",
      target,
      branch,
      ownerId: randomUUID(),
      capability: generateInboxCapability(),
      adopt: Boolean(options.adopt),
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.writeOperation(operation);
    try {
      await this.ensureProjectExists(operation, projects);
      return await this.finalizeOperation(operation);
    } catch (error) {
      throw withRecoveryHint(error);
    }
  }

  async publish(): Promise<RemoteState> {
    return this.withMutationLock(() => this.publishUnlocked());
  }

  private async publishUnlocked(): Promise<RemoteState> {
    await this.assertNoOperation();
    const state = await this.requireState();
    const operation = await this.prepareSnapshotOperation("publish", state);
    try {
      const receipt = await this.deployOperation(operation);
      return await this.checkpointAndFinalize(operation, receipt);
    } catch (error) {
      throw withRecoveryHint(error);
    }
  }

  async revoke(): Promise<RemoteRevokeResult> {
    return this.withMutationLock(() => this.revokeUnlocked());
  }

  private async revokeUnlocked(): Promise<RemoteRevokeResult> {
    await this.assertNoOperation();
    const state = await this.requireState();
    const revokedUrl = state.lastDeployment?.receipt.projectInboxUrl ?? "";
    const operation = await this.prepareSnapshotOperation("revoke", state);
    try {
      const receipt = await this.deployOperation(operation);
      const nextState = await this.checkpointAndFinalize(operation, receipt);
      return {
        state: nextState,
        revokedUrl,
        warning:
          "The production capability route was replaced, but older immutable Cloudflare deployment URLs may still work until their deployment history is pruned.",
      };
    } catch (error) {
      throw withRecoveryHint(error);
    }
  }

  async status(): Promise<RemoteStatus> {
    await this.prepareRemoteStorage();
    const state = await this.readState();
    return {
      configured: state !== null,
      state,
      operation: await this.readOperation(),
    };
  }

  async reconcile(options: RemoteReconcileOptions = {}): Promise<RemoteState> {
    return this.withMutationLock(() => this.reconcileUnlocked(options));
  }

  private async reconcileUnlocked(options: RemoteReconcileOptions): Promise<RemoteState> {
    const operation = await this.readOperation();
    if (!operation) {
      return this.requireState();
    }
    if (operation.phase === "remote-succeeded") {
      return this.finalizeOperation(operation);
    }
    if (operation.kind === "init") {
      await this.ensureProjectExists(operation, undefined, options.adopt);
      return this.finalizeOperation(operation);
    }

    const state = await this.requireState();
    assertOperationMatchesState(operation, state);
    await this.assertProductionTarget(operation.target, operation.branch);
    const deployments = await this.deployment.listDeployments(operation.target, this.remoteDir);
    const expectedCommitMessage = `html-inbox:${operation.id}:${operation.kind}:${operation.snapshotHash}`;
    const existing = deployments
      .filter(
        (deployment) =>
          deployment.commitHash === operation.snapshotHash?.slice(0, 40) &&
          deployment.commitMessage === expectedCommitMessage &&
          deployment.branch === operation.branch &&
          deployment.environment.toLowerCase() === "production" &&
          deployment.status.toLowerCase() === "success" &&
          !deployment.isSkipped,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const receipt = existing
      ? receiptFromDeployment(
          existing,
          operation.target,
          operation.branch,
          `/i/${operation.capability}`,
        )
      : await this.deployOperation(operation);
    return this.checkpointAndFinalize(operation, receipt);
  }

  private async ensureProjectExists(
    operation: RemoteOperation,
    knownProjects?: CloudflareProjectSummary[],
    adopt = false,
  ): Promise<void> {
    const projects =
      knownProjects ??
      (await this.deployment.listProjects(operation.target.accountId, this.remoteDir));
    const existing = projects.find((project) => projectMatchesTarget(project, operation.target));
    if (existing) {
      assertProductionBranch(existing, operation.branch);
      if (!operation.adopt && !adopt) {
        throw new Error(
          `Cloudflare Pages project ${operation.target.projectName} now exists; rerun remote reconcile with --adopt to confirm ownership`,
        );
      }
      if (!operation.adopt) {
        operation.adopt = true;
        operation.updatedAt = this.now();
        await this.writeOperation(operation);
      }
    } else {
      operation.attempts += 1;
      operation.updatedAt = this.now();
      await this.writeOperation(operation);
      await this.deployment.createProject(operation.target, this.remoteDir, operation.branch);
    }
    operation.phase = "remote-succeeded";
    operation.updatedAt = this.now();
    await this.writeOperation(operation);
  }

  private async prepareSnapshotOperation(
    kind: "publish" | "revoke",
    state: RemoteState,
  ): Promise<RemoteOperation> {
    await this.assertProductionTarget(state.target, state.branch);
    const id = randomUUID();
    const capability = kind === "revoke" ? generateInboxCapability() : state.capability;
    const snapshot = await exportStaticSnapshot(
      kind === "revoke" ? EMPTY_SOURCE : this.backend,
      {
        outputDir: this.snapshotDir(id),
        capability,
        ownerId: state.ownerId,
        generatedAt: this.now(),
      },
    );
    const timestamp = this.now();
    const operation: RemoteOperation = {
      schemaVersion: REMOTE_SCHEMA_VERSION,
      id,
      kind,
      phase: "prepared",
      target: state.target,
      branch: state.branch,
      ownerId: state.ownerId,
      capability,
      previousCapability: kind === "revoke" ? state.capability : undefined,
      snapshotHash: snapshot.manifest.snapshotHash,
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.writeOperation(operation);
    return operation;
  }

  private async deployOperation(operation: RemoteOperation): Promise<CloudflareDeployReceipt> {
    if (!operation.snapshotHash) throw new Error("Remote operation has no snapshot hash");
    operation.attempts += 1;
    operation.updatedAt = this.now();
    await this.writeOperation(operation);
    const snapshot: CloudflareSnapshotRef = {
      outputDir: this.snapshotDir(operation.id),
      capability: operation.capability,
      inboxPath: `/i/${operation.capability}`,
    };
    return this.deployment.deploySnapshot(snapshot, operation.target, operation.branch, {
      commitHash: operation.snapshotHash.slice(0, 40),
      commitMessage: `html-inbox:${operation.id}:${operation.kind}:${operation.snapshotHash}`,
    });
  }

  private async checkpointAndFinalize(
    operation: RemoteOperation,
    receipt: CloudflareDeployReceipt,
  ): Promise<RemoteState> {
    operation.phase = "remote-succeeded";
    operation.receipt = receipt;
    operation.updatedAt = this.now();
    await this.writeOperation(operation);
    return this.finalizeOperation(operation);
  }

  private async finalizeOperation(operation: RemoteOperation): Promise<RemoteState> {
    const timestamp = this.now();
    let state: RemoteState;
    if (operation.kind === "init") {
      state = {
        schemaVersion: REMOTE_SCHEMA_VERSION,
        ownerId: operation.ownerId,
        target: operation.target,
        branch: operation.branch,
        capability: operation.capability,
        revoked: false,
        configuredAt: operation.createdAt,
        updatedAt: timestamp,
      };
    } else {
      const current = await this.requireState();
      if (
        current.lastDeployment?.operationId === operation.id
      ) {
        await rm(this.operationPath, { force: true });
        await rm(this.workDir(operation.id), { recursive: true, force: true });
        return current;
      }
      assertOperationMatchesState(operation, current);
      if (!operation.receipt || !operation.snapshotHash) {
        throw new Error("Remote operation succeeded without a deployment receipt");
      }
      state = {
        ...current,
        capability: operation.capability,
        revoked: operation.kind === "revoke",
        updatedAt: timestamp,
        lastDeployment: {
          operationId: operation.id,
          kind: operation.kind,
          snapshotHash: operation.snapshotHash,
          completedAt: timestamp,
          receipt: operation.receipt,
        },
      };
    }
    await writeAtomicPrivateJson(this.statePath, state);
    await rm(this.operationPath, { force: true });
    await rm(this.workDir(operation.id), { recursive: true, force: true });
    return state;
  }

  private async prepareRemoteStorage(): Promise<void> {
    await ensurePrivateDirectory(this.remoteDir);
    await ensurePrivateDirectory(this.workRoot);
  }

  private async cleanupOrphanWork(): Promise<void> {
    const active = await this.readOperation();
    for (const entry of await readdir(this.workRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== active?.id) {
        await rm(path.join(this.workRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    await this.prepareRemoteStorage();
    const release = await acquireRemoteLock(this.lockPath);
    try {
      await this.cleanupOrphanWork();
      return await action();
    } finally {
      await release();
    }
  }

  private async assertNoOperation(): Promise<void> {
    const operation = await this.readOperation();
    if (operation) {
      throw new Error(
        `Remote ${operation.kind} operation ${operation.id} is incomplete; run remote reconcile`,
      );
    }
  }

  private async requireState(): Promise<RemoteState> {
    const state = await this.readState();
    if (!state) throw new Error("Remote publishing is not configured; run remote init first");
    return state;
  }

  private async assertProductionTarget(
    target: CloudflareProjectRef,
    branch: string,
  ): Promise<void> {
    const projects = await this.deployment.listProjects(target.accountId, this.remoteDir);
    const project = projects.find((candidate) => projectMatchesTarget(candidate, target));
    if (!project) {
      throw new Error(`Cloudflare Pages project ${target.projectName} no longer exists`);
    }
    assertProductionBranch(project, branch);
  }

  private async readState(): Promise<RemoteState | null> {
    return readPrivateJson(this.statePath, parseRemoteState);
  }

  private async readOperation(): Promise<RemoteOperation | null> {
    return readPrivateJson(this.operationPath, parseRemoteOperation);
  }

  private async writeOperation(operation: RemoteOperation): Promise<void> {
    await writeAtomicPrivateJson(this.operationPath, operation);
  }

  private workDir(id: string): string {
    assertUuidV4(id, "operation ID");
    return path.join(this.workRoot, id);
  }

  private snapshotDir(id: string): string {
    return path.join(this.workDir(id), "snapshot");
  }
}

async function writeAtomicPrivateJson(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writePrivateFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporaryPath, filePath);
    await hardenPrivateFile(filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function acquireRemoteLock(lockPath: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  try {
    const handle = await open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
    } catch (error) {
      await handle.close();
      await rm(lockPath, { force: true });
      throw error;
    }
    return async () => {
      await handle.close();
      try {
        const record = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
        if (record.token === token) await rm(lockPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          process.emitWarning(`Could not release remote mutation lock: ${(error as Error).message}`);
        }
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await hardenPrivateFile(lockPath);
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      if (!isRecord(parsed)) throw new Error("invalid lock record");
      record = parsed;
    } catch {
      throw staleLockError(lockPath);
    }
    if (typeof record.pid === "number" && isProcessAlive(record.pid)) {
      throw new Error(`Another HTML Inbox remote command is running (pid ${record.pid})`);
    }
    // ponytail: stale lock removal is manual; add an OS-level lock if automatic recovery is needed.
    throw staleLockError(lockPath);
  }
}

function staleLockError(lockPath: string): Error {
  return new Error(
    `Stale HTML Inbox remote lock found at ${lockPath}; remove it after confirming no command is running`,
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
    if (error instanceof SyntaxError) throw new Error(`Remote state is corrupt: ${filePath}`);
    throw error;
  }
}

function parseRemoteState(value: unknown): RemoteState {
  if (!isRecord(value) || value.schemaVersion !== REMOTE_SCHEMA_VERSION) {
    throw new Error("Remote state schema is unsupported");
  }
  const state = value as unknown as RemoteState;
  assertUuidV4(state.ownerId, "remote owner ID");
  assertInboxCapability(state.capability);
  const target = normalizeCloudflareProjectRef(state.target);
  const branch = normalizeCloudflareBranch(state.branch);
  if (typeof state.revoked !== "boolean") throw new Error("Remote state is invalid");
  if (state.lastDeployment) {
    assertUuidV4(state.lastDeployment.operationId, "remote deployment operation ID");
  }
  return { ...state, target, branch };
}

function parseRemoteOperation(value: unknown): RemoteOperation {
  if (!isRecord(value) || value.schemaVersion !== REMOTE_SCHEMA_VERSION) {
    throw new Error("Remote operation schema is unsupported");
  }
  const operation = value as unknown as RemoteOperation;
  assertUuidV4(operation.id, "operation ID");
  assertUuidV4(operation.ownerId, "remote owner ID");
  assertInboxCapability(operation.capability);
  const target = normalizeCloudflareProjectRef(operation.target);
  const branch = normalizeCloudflareBranch(operation.branch);
  if (!(["init", "publish", "revoke"] as unknown[]).includes(operation.kind)) {
    throw new Error("Remote operation kind is invalid");
  }
  if (!(["prepared", "remote-succeeded"] as unknown[]).includes(operation.phase)) {
    throw new Error("Remote operation phase is invalid");
  }
  if (!Number.isInteger(operation.attempts) || operation.attempts < 0) {
    throw new Error("Remote operation attempts are invalid");
  }
  if (
    operation.kind !== "init" &&
    !/^[0-9a-f]{64}$/.test(operation.snapshotHash ?? "")
  ) {
    throw new Error("Remote operation snapshot hash is invalid");
  }
  if (operation.kind === "init" && typeof operation.adopt !== "boolean") {
    throw new Error("Remote init adoption decision is invalid");
  }
  if (operation.kind === "revoke") {
    assertInboxCapability(operation.previousCapability ?? "");
  }
  return { ...operation, target, branch };
}

function assertOperationMatchesState(operation: RemoteOperation, state: RemoteState): void {
  if (
    !sameCloudflareProject(operation.target, state.target) ||
    operation.ownerId !== state.ownerId
  ) {
    throw new Error("Remote operation does not match configured target ownership");
  }
  if (operation.kind === "publish" && operation.capability !== state.capability) {
    throw new Error("Remote publish operation capability does not match current state");
  }
  if (
    operation.kind === "revoke" &&
    operation.previousCapability !== state.capability
  ) {
    throw new Error("Remote revoke operation does not match current capability");
  }
}

function assertProductionBranch(project: CloudflareProjectSummary, branch: string): void {
  if (project.productionBranch !== branch) {
    throw new Error(
      `Cloudflare Pages project ${project.name} uses production branch ${project.productionBranch || "(unknown)"}, not ${branch}`,
    );
  }
}

function projectMatchesTarget(
  project: CloudflareProjectSummary,
  target: CloudflareProjectRef,
): boolean {
  return (
    project.name === target.projectName &&
    (!project.accountId || project.accountId.toLowerCase() === target.accountId)
  );
}

function withRecoveryHint(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message} Remote intent was preserved; run html-inbox remote reconcile.`);
}
