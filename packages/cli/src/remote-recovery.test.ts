import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import {
  CloudflareDeployMetadata,
  CloudflareDeployReceipt,
  CloudflareDeploymentSummary,
  CloudflareProjectRef,
  CloudflareProjectSummary,
  CloudflareSnapshotRef,
} from "./cloudflare-pages";
import { formatRemoteState, formatRemoteStatus } from "./index";
import { RemoteDeploymentPort, RemoteWorkflow } from "./remote-workflow";
import { SnapshotManifest } from "./static-export";
import { temporaryHome } from "./test-fixtures";

test("remote workflow recovers publish and revoke", async (t) => {
  const html = "<!doctype html><html><body>Report</body></html>";
  const remoteHome = await temporaryHome(t);
  const remoteBackend = new LocalDocumentBackend(remoteHome);
  await remoteBackend.publish({
    originalBytes: Buffer.from(html),
    title: "Remote report",
    type: "report",
    sourceFileName: "remote-report.html",
  });
  const remotePort = new RecordingRemoteDeploymentPort();
  let clockTick = 0;
  const remoteWorkflow = new RemoteWorkflow(
    remoteBackend,
    remoteHome,
    remotePort,
    () => new Date(Date.UTC(2026, 6, 16, 2, 0, clockTick++)).toISOString(),
  );
  const remoteAccountId = "c".repeat(32);
  const initializedRemote = await remoteWorkflow.init({
    accountId: remoteAccountId,
    projectName: "html-inbox-test",
  });
  assert.equal(remotePort.createdProjects.length, 1);
  assert.equal(initializedRemote.target.projectName, "html-inbox-test");
  assert.match(formatRemoteState(initializedRemote), /State: configured/);
  assert.equal((await remoteWorkflow.status()).operation, null);

  const remoteStatePath = path.join(remoteHome, "remote", "state.json");
  const paddedState = JSON.parse(await readFile(remoteStatePath, "utf8")) as {
    target: CloudflareProjectRef;
    branch: string;
  };
  paddedState.target.accountId = ` ${paddedState.target.accountId.toUpperCase()} `;
  paddedState.target.projectName = ` ${paddedState.target.projectName.toUpperCase()} `;
  paddedState.branch = ` ${paddedState.branch} `;
  await writeFile(remoteStatePath, `${JSON.stringify(paddedState, null, 2)}\n`);
  const normalizedState = (await remoteWorkflow.status()).state;
  assert.equal(normalizedState?.target.accountId, remoteAccountId);
  assert.equal(normalizedState?.target.projectName, "html-inbox-test");
  assert.equal(normalizedState?.branch, "main");
  await writeFile(
    remoteStatePath,
    `${JSON.stringify(initializedRemote, null, 2)}\n`,
  );

  const remoteLockPath = path.join(remoteHome, "remote", "mutation.lock");
  await writeFile(
    remoteLockPath,
    `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    remoteWorkflow.publish(),
    /Another HTML Inbox remote command is running/,
  );
  await rm(remoteLockPath, { force: true });
  await writeFile(
    remoteLockPath,
    `${JSON.stringify({
      pid: 99_999_999,
      token: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    remoteWorkflow.publish(),
    /Stale HTML Inbox remote lock/,
  );
  assert.equal((await stat(remoteLockPath)).isFile(), true);
  await rm(remoteLockPath, { force: true });
  await writeFile(remoteLockPath, "", { mode: 0o600 });
  await assert.rejects(
    remoteWorkflow.publish(),
    /Stale HTML Inbox remote lock/,
  );
  assert.equal((await stat(remoteLockPath)).size, 0);
  await rm(remoteLockPath, { force: true });
  await writeFile(remoteLockPath, "null\n", { mode: 0o600 });
  await assert.rejects(
    remoteWorkflow.publish(),
    /Stale HTML Inbox remote lock/,
  );
  assert.equal(await readFile(remoteLockPath, "utf8"), "null\n");
  await rm(remoteLockPath, { force: true });

  remotePort.projects[0].productionBranch = "release";
  await assert.rejects(
    remoteWorkflow.publish(),
    /uses production branch release, not main/,
  );
  remotePort.projects[0].productionBranch = "main";
  const publishedRemote = await remoteWorkflow.publish();
  assert.equal(publishedRemote.revoked, false);
  assert.equal(publishedRemote.lastDeployment?.kind, "publish");
  assert.match(
    publishedRemote.lastDeployment?.receipt.projectInboxUrl ?? "",
    /^https:\/\/html-inbox-test\.pages\.dev\/i\//,
  );
  assert.match(
    formatRemoteStatus(await remoteWorkflow.status()),
    /State: published/,
  );
  assert.equal(remotePort.deployCalls.at(-1)?.manifest.documentCount, 1);
  const repeatedRemote = await remoteWorkflow.publish();
  assert.notEqual(
    repeatedRemote.lastDeployment?.operationId,
    publishedRemote.lastDeployment?.operationId,
  );
  assert.notEqual(
    repeatedRemote.lastDeployment?.receipt.deploymentUrl,
    publishedRemote.lastDeployment?.receipt.deploymentUrl,
  );
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(path.join(remoteHome, "remote", "state.json"))).mode & 0o777,
      0o600,
    );
  }

  await remoteBackend.publish({
    originalBytes: Buffer.from(
      "<!doctype html><html><body>new remote state</body></html>",
    ),
    title: "Recovery report",
    type: "report",
    sourceFileName: "recovery.html",
  });
  remotePort.failNextDeploy = true;
  await assert.rejects(remoteWorkflow.publish(), /remote reconcile/);
  const interruptedStatus = await remoteWorkflow.status();
  assert(interruptedStatus.operation?.kind === "publish");
  assert(interruptedStatus.operation.snapshotHash);
  assert.equal(interruptedStatus.operation.phase, "prepared");
  assert.equal(interruptedStatus.operation.attempts, 1);
  const remoteOperationPath = path.join(remoteHome, "remote", "operation.json");
  const paddedOperation = JSON.parse(
    await readFile(remoteOperationPath, "utf8"),
  ) as {
    target: CloudflareProjectRef;
    branch: string;
  };
  paddedOperation.target.accountId = ` ${paddedOperation.target.accountId.toUpperCase()} `;
  paddedOperation.target.projectName = ` ${paddedOperation.target.projectName.toUpperCase()} `;
  paddedOperation.branch = ` ${paddedOperation.branch} `;
  await writeFile(
    remoteOperationPath,
    `${JSON.stringify(paddedOperation, null, 2)}\n`,
  );
  const normalizedOperation = (await remoteWorkflow.status()).operation;
  assert.equal(normalizedOperation?.target.accountId, remoteAccountId);
  assert.equal(normalizedOperation?.target.projectName, "html-inbox-test");
  assert.equal(normalizedOperation?.branch, "main");
  await writeFile(
    remoteOperationPath,
    `${JSON.stringify(interruptedStatus.operation, null, 2)}\n`,
  );
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(path.join(remoteHome, "remote", "operation.json"))).mode &
        0o777,
      0o600,
    );
  }
  const callsBeforeReconcile = remotePort.deployCalls.length;
  remotePort.deployments.push({
    id: "stale-identical-deployment",
    url: "https://stale.html-inbox-test.pages.dev",
    environment: "production",
    status: "success",
    isSkipped: false,
    branch: "main",
    createdAt: "2026-07-16T03:00:00.000Z",
    commitHash: interruptedStatus.operation.snapshotHash.slice(0, 40),
    commitMessage: `html-inbox:00000000-0000-4000-8000-000000000000:publish:${interruptedStatus.operation.snapshotHash}`,
  });
  remotePort.deployments.push({
    id: "preview-deployment",
    url: "https://def456.html-inbox-test.pages.dev",
    environment: "preview",
    status: "success",
    isSkipped: false,
    branch: "main",
    createdAt: "2026-07-16T02:30:00.000Z",
    commitHash: interruptedStatus.operation.snapshotHash.slice(0, 40),
    commitMessage: `html-inbox:${interruptedStatus.operation.id}:publish:${interruptedStatus.operation.snapshotHash}`,
  });
  remotePort.projects[0].productionBranch = "release";
  await assert.rejects(
    remoteWorkflow.reconcile(),
    /uses production branch release, not main/,
  );
  remotePort.projects[0].productionBranch = "main";
  remotePort.failNextDeploy = true;
  await assert.rejects(
    remoteWorkflow.reconcile(),
    /simulated ambiguous deploy failure/,
  );
  remotePort.deployments.push({
    id: "recovered-deployment",
    url: "https://fed456.html-inbox-test.pages.dev",
    environment: "production",
    status: "success",
    isSkipped: false,
    branch: "main",
    createdAt: "2026-07-16T02:45:00.000Z",
    commitHash: interruptedStatus.operation.snapshotHash.slice(0, 40),
    commitMessage: `html-inbox:${interruptedStatus.operation.id}:publish:${interruptedStatus.operation.snapshotHash}`,
  });
  const reconciled = await remoteWorkflow.reconcile();
  assert.equal(remotePort.deployCalls.length, callsBeforeReconcile + 1);
  assert.equal(
    reconciled.lastDeployment?.snapshotHash,
    interruptedStatus.operation.snapshotHash,
  );
  assert.equal((await remoteWorkflow.status()).operation, null);

  const capabilityBeforeRevoke = reconciled.capability;
  const productionUrlBeforeRevoke =
    reconciled.lastDeployment?.receipt.projectInboxUrl ?? "";
  const revokeResult = await remoteWorkflow.revoke();
  assert.equal(revokeResult.state.revoked, true);
  assert.notEqual(revokeResult.state.capability, capabilityBeforeRevoke);
  assert.equal(revokeResult.revokedUrl, productionUrlBeforeRevoke);
  assert.match(
    revokeResult.warning,
    /immutable Cloudflare deployment URLs may still work/,
  );
  const revokeCall = remotePort.deployCalls.at(-1);
  assert.equal(revokeCall?.manifest.documentCount, 0);
  assert.equal(
    revokeCall?.manifest.files.some((file) =>
      file.path.includes(capabilityBeforeRevoke),
    ),
    false,
  );
  for (const document of await remoteBackend.listDocuments()) {
    await remoteBackend.deleteDocument(document.id);
  }
  const republishedEmpty = await remoteWorkflow.publish();
  assert.equal(republishedEmpty.revoked, false);
  assert.equal(republishedEmpty.lastDeployment?.kind, "publish");
  assert.notEqual(
    republishedEmpty.lastDeployment?.operationId,
    revokeResult.state.lastDeployment?.operationId,
  );
});

test("remote initialization adopts existing projects and recovers interrupted creation", async (t) => {
  const remoteAccountId = "c".repeat(32);
  const remoteHome = await temporaryHome(t);
  const remoteBackend = new LocalDocumentBackend(remoteHome);
  const adoptionHome = await temporaryHome(t);
  const adoptionPort = new RecordingRemoteDeploymentPort();
  adoptionPort.projects.push({
    name: "existing-inbox",
    accountId: remoteAccountId,
    productionBranch: "main",
  });
  const adoptionWorkflow = new RemoteWorkflow(
    remoteBackend,
    adoptionHome,
    adoptionPort,
  );
  await assert.rejects(
    adoptionWorkflow.init({
      accountId: remoteAccountId,
      projectName: "existing-inbox",
    }),
    /--adopt/,
  );
  adoptionPort.projects[0].productionBranch = "release";
  await assert.rejects(
    adoptionWorkflow.init({
      accountId: remoteAccountId,
      projectName: "existing-inbox",
      adopt: true,
    }),
    /uses production branch release, not main/,
  );
  adoptionPort.projects[0].productionBranch = "main";
  const adopted = await adoptionWorkflow.init({
    accountId: remoteAccountId,
    projectName: "existing-inbox",
    adopt: true,
  });
  assert.equal(adopted.target.projectName, "existing-inbox");
  assert.equal(adoptionPort.createdProjects.length, 0);

  const initRecoveryHome = await temporaryHome(t);
  const initRecoveryPort = new RecordingRemoteDeploymentPort();
  initRecoveryPort.failNextCreate = true;
  const initRecoveryWorkflow = new RemoteWorkflow(
    remoteBackend,
    initRecoveryHome,
    initRecoveryPort,
  );
  await assert.rejects(
    initRecoveryWorkflow.init({
      accountId: remoteAccountId,
      projectName: "recover-init",
    }),
    /remote reconcile/,
  );
  assert.equal((await initRecoveryWorkflow.status()).operation?.kind, "init");
  initRecoveryPort.projects.push({
    name: "recover-init",
    accountId: remoteAccountId,
    productionBranch: "release",
  });
  await assert.rejects(
    initRecoveryWorkflow.reconcile({ adopt: true }),
    /uses production branch release, not main/,
  );
  initRecoveryPort.projects[0].productionBranch = "main";
  await assert.rejects(initRecoveryWorkflow.reconcile(), /--adopt/);
  const recoveredInit = await initRecoveryWorkflow.reconcile({ adopt: true });
  assert.equal(recoveredInit.target.projectName, "recover-init");
  assert.equal((await initRecoveryWorkflow.status()).operation, null);
});
class RecordingRemoteDeploymentPort implements RemoteDeploymentPort {
  readonly projects: CloudflareProjectSummary[] = [];
  readonly deployments: CloudflareDeploymentSummary[] = [];
  readonly createdProjects: CloudflareProjectRef[] = [];
  readonly deployCalls: Array<{
    snapshot: CloudflareSnapshotRef;
    manifest: SnapshotManifest;
    target: CloudflareProjectRef;
    branch: string;
    metadata: CloudflareDeployMetadata;
  }> = [];
  failNextDeploy = false;
  failNextCreate = false;

  async listProjects(): Promise<CloudflareProjectSummary[]> {
    return structuredClone(this.projects);
  }

  async createProject(target: CloudflareProjectRef): Promise<void> {
    this.createdProjects.push(structuredClone(target));
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("simulated ambiguous project creation failure");
    }
    this.projects.push({
      name: target.projectName,
      accountId: target.accountId,
      productionBranch: "main",
    });
  }

  async deploySnapshot(
    snapshot: CloudflareSnapshotRef,
    target: CloudflareProjectRef,
    branch = "main",
    metadata?: CloudflareDeployMetadata,
  ): Promise<CloudflareDeployReceipt> {
    assert(metadata);
    const manifestPath = path.join(
      snapshot.outputDir,
      `i/${snapshot.capability}`,
      "snapshot-manifest.json",
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as SnapshotManifest;
    this.deployCalls.push({
      snapshot: structuredClone(snapshot),
      manifest,
      target: structuredClone(target),
      branch,
      metadata: structuredClone(metadata),
    });
    if (this.failNextDeploy) {
      this.failNextDeploy = false;
      throw new Error("simulated ambiguous deploy failure");
    }
    const prefix = this.deployCalls.length
      .toString(16)
      .padStart(6, "0")
      .slice(-6);
    const deploymentUrl = `https://${prefix}.${target.projectName}.pages.dev`;
    const projectUrl = `https://${target.projectName}.pages.dev`;
    this.deployments.push({
      id: `deployment-${this.deployCalls.length}`,
      url: deploymentUrl,
      environment: "production",
      status: "success",
      isSkipped: false,
      branch,
      createdAt: new Date(
        Date.UTC(2026, 6, 16, 3, 0, this.deployCalls.length),
      ).toISOString(),
      commitHash: metadata.commitHash,
      commitMessage: metadata.commitMessage,
    });
    return {
      target: structuredClone(target),
      branch,
      deploymentUrl,
      projectUrl,
      deploymentInboxUrl: `${deploymentUrl}/i/${snapshot.capability}/`,
      projectInboxUrl: `${projectUrl}/i/${snapshot.capability}/`,
    };
  }

  async listDeployments(): Promise<CloudflareDeploymentSummary[]> {
    return structuredClone(this.deployments);
  }
}
