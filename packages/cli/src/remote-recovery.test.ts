import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { promisify } from "node:util";
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
import { parseRemoteState, RemoteDeploymentPort, RemoteWorkflow } from "./remote-workflow";
import { SnapshotManifest } from "./static-export";
import { temporaryHome } from "./test-fixtures";

test("reconciliation deliberately recovers a killed lock owner and its journaled publish", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const deployment = new RecordingRemoteDeploymentPort();
  const workflow = new RemoteWorkflow(backend, home, deployment);
  const state = await workflow.init({
    accountId: "c".repeat(32),
    projectName: "terminated-owner",
  });
  const lockPath = path.join(home, "remote", "mutation.lock");
  const operationPath = path.join(home, "remote", "operation.json");
  const recoverOptions = { adopt: false, recoverLock: true };
  const owner = spawn(process.execPath, ["--eval", `
    const { LocalDocumentBackend } = require("./backend.js");
    const { RemoteWorkflow } = require("./remote-workflow.js");
    const home = process.env.HTML_INBOX_HOME;
    const target = JSON.parse(process.env.HTML_INBOX_TEST_TARGET);
    const deployment = {
      async listProjects() {
        return [{ name: target.projectName, accountId: target.accountId, productionBranch: "main" }];
      },
      async deploySnapshot() {
        process.send("intent-ready");
        await new Promise(() => setInterval(() => {}, 1000));
      },
    };
    new RemoteWorkflow(new LocalDocumentBackend(home), home, deployment)
      .publish().catch((error) => { console.error(error); process.exit(1); });
  `], {
    cwd: __dirname,
    env: { ...process.env, HTML_INBOX_HOME: home, HTML_INBOX_TEST_TARGET: JSON.stringify(state.target) },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ownerExit = once(owner, "exit");
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
    }

    await ownerExit;
  });
  const ready = await Promise.race([
    once(owner, "message"),
    ownerExit.then(() => { throw new Error("Lock owner exited before preserving publish intent"); }),
  ]);
  assert.equal(ready[0], "intent-ready");
  const pending = (await workflow.status()).operation;
  assert(pending?.kind === "publish");
  const lockBeforeRecovery = await readFile(lockPath, "utf8");
  const intentBeforeRecovery = await readFile(operationPath, "utf8");

  await assert.rejects(workflow.reconcile(recoverOptions), /Another HTML Inbox remote command is running/);
  assert.equal(await readFile(lockPath, "utf8"), lockBeforeRecovery);
  assert.equal(await readFile(operationPath, "utf8"), intentBeforeRecovery);

  assert.equal(owner.kill("SIGKILL"), true);
  const [exitCode, signal] = await ownerExit;
  assert.equal(exitCode, null);
  assert.equal(signal, "SIGKILL");
  await assert.rejects(workflow.reconcile(), /remote reconcile --recover-lock/);
  assert.equal(await readFile(operationPath, "utf8"), intentBeforeRecovery);

  deployment.deployments.push({
    id: "terminated-owner-deployment",
    url: "https://abc123.terminated-owner.pages.dev",
    environment: "production",
    status: "success",
    isSkipped: false,
    branch: pending.branch,
    createdAt: new Date().toISOString(),
    commitHash: pending.snapshotHash.slice(0, 40),
    commitMessage: `html-inbox:${pending.id}:${pending.kind}:${pending.snapshotHash}`,
  });
  const recovered = await workflow.reconcile(recoverOptions);
  assert.equal(recovered.lastDeployment?.operationId, pending.id);
  assert.equal(recovered.lastDeployment?.snapshotHash, pending.snapshotHash);
  assert.equal(deployment.deployCalls.length, 0);
  assert.equal((await workflow.status()).operation, null);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
  await assert.rejects(stat(`${lockPath}.recovery`), { code: "ENOENT" });
});

test("concurrent lock recoveries allow one mutation and preserve its live lock", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const historyReached = new AbortController();
  const resumeHistory = new AbortController();
  class PausedDeploymentPort extends RecordingRemoteDeploymentPort {
    async listDeployments(): Promise<CloudflareDeploymentSummary[]> {
      const resumed = once(resumeHistory.signal, "abort");
      historyReached.abort();
      await resumed;

      return super.listDeployments();
    }
  }
  const deployment = new PausedDeploymentPort();
  const workflow = new RemoteWorkflow(backend, home, deployment);
  await workflow.init({ accountId: "c".repeat(32), projectName: "concurrent-recovery" });
  deployment.failNextDeploy = true;
  await assert.rejects(workflow.publish(), /simulated ambiguous deploy failure/);
  const intent = (await workflow.status()).operation;
  assert(intent?.kind === "publish");
  const lockPath = path.join(home, "remote", "mutation.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, token: randomUUID(), createdAt: new Date().toISOString() }));
  const recoverOptions = { adopt: false, recoverLock: true };
  const ready = once(historyReached.signal, "abort");
  const contenders = Array.from({ length: 8 }, () => workflow.reconcile(recoverOptions));
  const results = Promise.allSettled(contenders);
  await Promise.race([
    ready,
    results.then(() => { throw new Error("No recovery reached deployment history"); }),
  ]);
  const liveLock = await readFile(lockPath, "utf8");

  try {
    await assert.rejects(workflow.reconcile(recoverOptions), /Another HTML Inbox remote command is running/);
    await assert.rejects(workflow.publish(), /Another HTML Inbox remote command is running/);
    assert.equal(await readFile(lockPath, "utf8"), liveLock);
    assert.equal((await workflow.status()).operation?.id, intent.id);
  } finally {
    resumeHistory.abort();
  }

  const outcomes = await results;
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 7);
  assert.equal(deployment.deployCalls.length, 2);
  assert.equal((await workflow.status()).operation, null);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
});

test("lock recovery preserves malformed locks and abandoned recovery guards", async (t) => {
  const home = await temporaryHome(t);
  const workflow = new RemoteWorkflow(new LocalDocumentBackend(home), home, new RecordingRemoteDeploymentPort());
  await workflow.init({ accountId: "c".repeat(32), projectName: "unverified-locks" });
  const lockPath = path.join(home, "remote", "mutation.lock");
  const recoverOptions = { adopt: false, recoverLock: true };
  const validRecord = { pid: 99_999_999, token: randomUUID(), createdAt: new Date().toISOString() };

  for (const contents of [
    "", "null\n", "{", "{}",
    JSON.stringify({ ...validRecord, pid: -1 }),
    JSON.stringify({ ...validRecord, pid: 1.5 }),
    JSON.stringify({ ...validRecord, pid: "99999999" }),
    JSON.stringify({ ...validRecord, token: "invalid" }),
    JSON.stringify({ ...validRecord, createdAt: "invalid" }),
    JSON.stringify({ pid: validRecord.pid }),
  ]) {
    await writeFile(lockPath, contents);
    await assert.rejects(workflow.reconcile(recoverOptions), /Cannot verify.*remote lock/);
    assert.equal(await readFile(lockPath, "utf8"), contents);
    await assert.rejects(stat(`${lockPath}.recovery`), { code: "ENOENT" });
  }

  const validContents = JSON.stringify(validRecord);
  await writeFile(lockPath, validContents);
  await writeFile(`${lockPath}.recovery`, validContents);
  await assert.rejects(workflow.reconcile(recoverOptions), /Remote lock recovery is already in progress or was interrupted/);
  assert.equal(await readFile(lockPath, "utf8"), validContents);
  assert.equal(await readFile(`${lockPath}.recovery`, "utf8"), validContents);
});

test("a normal writer winning the replacement gap keeps its lock and preserved intent", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const lockRemoved = new AbortController();
  const resumeRecovery = new AbortController();
  const historyReached = new AbortController();
  const resumeWriter = new AbortController();
  class PausedDeploymentPort extends RecordingRemoteDeploymentPort {
    async listDeployments(): Promise<CloudflareDeploymentSummary[]> {
      const resumed = once(resumeWriter.signal, "abort");
      historyReached.abort();
      await resumed;

      return super.listDeployments();
    }
  }
  const deployment = new PausedDeploymentPort();
  const workflow = new RemoteWorkflow(backend, home, deployment);
  await workflow.init({ accountId: "c".repeat(32), projectName: "replacement-race" });
  deployment.failNextDeploy = true;
  await assert.rejects(workflow.publish(), /simulated ambiguous deploy failure/);
  const operationPath = path.join(home, "remote", "operation.json");
  const intentBeforeRecovery = await readFile(operationPath, "utf8");
  const lockPath = path.join(home, "remote", "mutation.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, token: randomUUID(), createdAt: new Date().toISOString() }));
  const removeFile = fs.rm;
  let hasPausedRecovery = false;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof removeFile>) => {
    await removeFile(...args);

    if (args[0] === lockPath && !hasPausedRecovery) {
      hasPausedRecovery = true;
      const resumed = once(resumeRecovery.signal, "abort");
      lockRemoved.abort();
      await resumed;
    }
  });
  const removed = once(lockRemoved.signal, "abort");
  const recovery = workflow.reconcile({ recoverLock: true });
  const rejectedRecovery = assert.rejects(recovery, /Another HTML Inbox remote command is running/);
  await Promise.race([
    removed,
    recovery.then(() => { throw new Error("Recovery finished before the replacement gap"); }),
  ]);
  const writerReady = once(historyReached.signal, "abort");
  const writer = workflow.reconcile();
  await Promise.race([
    writerReady,
    writer.then(() => { throw new Error("Writer finished before reaching deployment history"); }),
  ]);
  const liveLock = await readFile(lockPath, "utf8");

  try {
    resumeRecovery.abort();
    await rejectedRecovery;
    assert.equal(await readFile(lockPath, "utf8"), liveLock);
    assert.equal(await readFile(operationPath, "utf8"), intentBeforeRecovery);
  } finally {
    resumeRecovery.abort();
    resumeWriter.abort();
    await writer;
  }

  assert.equal(deployment.deployCalls.length, 2);
  assert.equal((await workflow.status()).operation, null);
});

test("lock age and inconclusive process probes never authorize recovery", async (t) => {
  const home = await temporaryHome(t);
  const workflow = new RemoteWorkflow(new LocalDocumentBackend(home), home, new RecordingRemoteDeploymentPort());
  await workflow.init({ accountId: "c".repeat(32), projectName: "ambiguous-owner" });
  const lockPath = path.join(home, "remote", "mutation.lock");
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: "2000-01-01T00:00:00.000Z" });
  await writeFile(lockPath, contents);
  await assert.rejects(workflow.reconcile({ recoverLock: true }), /Another HTML Inbox remote command is running/);
  assert.equal(await readFile(lockPath, "utf8"), contents);

  for (const code of ["EPERM", "EACCES", "EINVAL"]) {
    const probe = t.mock.method(process, "kill", () => {
      throw Object.assign(new Error("inconclusive process probe"), { code });
    });
    await assert.rejects(workflow.reconcile({ recoverLock: true }), /Another HTML Inbox remote command is running/);
    assert.equal(await readFile(lockPath, "utf8"), contents);
    probe.mock.restore();
  }
});

test("the CLI exposes lock recovery and keeps remote state backward compatible", async (t) => {
  const home = await temporaryHome(t);
  const workflow = new RemoteWorkflow(new LocalDocumentBackend(home), home, new RecordingRemoteDeploymentPort());
  const state = await workflow.init({ accountId: "c".repeat(32), projectName: "cli-recovery" });
  const lockPath = path.join(home, "remote", "mutation.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, token: randomUUID(), createdAt: new Date().toISOString() }));
  const execute = promisify(execFile);
  const { stdout, stderr } = await execute(process.execPath, [
    path.join(__dirname, "index.js"), "remote", "reconcile", "--recover-lock", "--json",
  ], { env: { ...process.env, HTML_INBOX_HOME: home } });
  assert.deepEqual(parseRemoteState(JSON.parse(stdout)), state);
  assert.equal(stderr, "");
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
  const help = await execute(process.execPath, [path.join(__dirname, "index.js"), "--help"]);
  assert.match(help.stdout, /remote reconcile \[--adopt\] \[--recover-lock\] \[--json\]/);
});

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
    `${JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() })}\n`,
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
