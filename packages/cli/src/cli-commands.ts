import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { DeleteResult, DocumentMetadata } from "./documents";
import { getViewerPort, LocalDocumentBackend } from "./backend";
import { loadPublishInput, PublishRequest } from "./publish-input";
import { ensurePrivateDirectory } from "./private-storage";
import { RemoteState, RemoteStatus, RemoteWorkflow } from "./remote-workflow";
import { exportStaticSnapshot, StaticSnapshotResult } from "./static-export";
import { ensureViewer, getViewerStatus, resolveViewerConfiguration, startViewer, stopViewer } from "./viewer-server";
import type { CliCommand } from "./cli-args";
import { containsPath } from "./path-containment";
import { parseViewerNetworkConfig, resolveViewerNetworkConfig } from "./viewer-network";
import { getViewerServiceStatus, installViewerService, inspectViewerServiceSelection, resolveViewerServiceHome, uninstallViewerService } from "./viewer-service";
import { configureViewerServiceLogging } from "./viewer-service-log";
import { readPreferences, setAppearancePreference } from "./preferences";
import { resolveInboxSelection, type ResolvedInboxSelection } from "./inbox-selection";
import { runInboxCommand, runHubCommand } from "./inbox-commands";
import { formatDocumentTable, formatViewerServiceResult, formatViewerStatus, formatViewerStopResult } from "./cli-display";
import { resolveEnrollmentSelection } from "./sync-enrollment";
import { isSyncCommand, isOfflineSyncCommand, runOfflineSyncCommand, runSyncCommand } from "./sync-cli";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { formatManagedPublication, publishManagedDocument } from "./sync-publication";
import { promptForInbox } from "./inbox-picker";
import { USAGE } from "./cli-usage";

export async function runCommand(parsed: CliCommand): Promise<void> {
  const command = parsed.command;

  if (parsed.command === "inbox create" || parsed.command === "inbox register" || parsed.command === "inbox list" || parsed.command === "inbox default") {
    await runInboxCommand(parsed);
    return;
  }

  if (parsed.command === "hub" || parsed.command === "hub init") {
    await runHubCommand(parsed);
    return;
  }

  if (isSyncCommand(parsed) && isOfflineSyncCommand(parsed)) {
    const result = await runOfflineSyncCommand(parsed);
    console.log(parsed.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return;
  }

  const legacyHome = parsed.command === "viewer service"
    ? await resolveViewerServiceHome({ user: parsed.user })
    : undefined;
  const json = ("json" in parsed && parsed.json === true) ||
    ("options" in parsed && "json" in parsed.options && parsed.options.json === true);
  const canChooseInbox = stdin.isTTY && stdout.isTTY && stderr.isTTY && !json;
  const selection = parsed.command === "sync enroll" ? await resolveEnrollmentSelection(parsed) : await resolveInboxSelection(parsed, process.env, legacyHome, {
    requireSelection: true,
    ...(parsed.command === "viewer service" ? { inspectHome: async (selectedHome: string) => {
      const inspected = await inspectViewerServiceSelection(selectedHome, parsed.user);
      return { home: inspected.home, ...(inspected.instanceId ? { instanceId: inspected.instanceId } : {}) };
    } } : {}),
    ...(canChooseInbox ? { chooseInbox: promptForInbox } : {}),
  });
  const home = selection.home;
  if (selection.name) {
    console.error(`html-inbox: Inbox ${selection.name} (${home})`);
  }

  if (isSyncCommand(parsed)) {
    const result = await runSyncCommand(parsed, selection);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, parsed.json ? undefined : 2));
    return;
  }

  if (command === "publish") {
    if (await assertManagedLifecycle(home)) {
      const publication = await publishManagedDocument(parsed.options, selection);
      console.log(parsed.json ? JSON.stringify(publication.result) : formatManagedPublication(publication.result));
      process.exitCode = publication.exitCode;
      return;
    }

    if (parsed.options.target || parsed.options.waitMs !== undefined || parsed.options.requestTimeoutMs !== undefined) {
      throw new Error("Sync publication options require an enrolled inbox");
    }

    const url = await publishCommand(parsed.options, selection);
    console.log(parsed.json ? JSON.stringify({ url, inbox: selection.name ?? null, home }) : url);
    return;
  }

  if (command === "list") {
    const json = parsed.json;
    const documents = await new LocalDocumentBackend(home).listDocuments();
    console.log(formatDocumentList(documents, json));
    return;
  }

  if (command === "preferences") {
    const preferences = parsed.appearance === undefined
      ? await readPreferences(home)
      : await setAppearancePreference(home, parsed.appearance);
    console.log(parsed.json ? JSON.stringify(preferences, null, 2) : `Appearance: ${preferences.appearance}`);
    return;
  }

  if (command === "delete") {
    await deleteCommand(parsed, home);
    return;
  }

  if (command === "export") {
    const options = parsed.options;
    await ensurePrivateDirectory(home);
    assertExportOutsideHome(options.outputDir, home);
    const result = await exportStaticSnapshot(
      new LocalDocumentBackend(home),
      { ...options, appearance: (await readPreferences(home)).appearance },
    );
    console.log(formatStaticExportResult(result, options.json));
    return;
  }

  if (command === "remote init" || command === "remote publish" || command === "remote status" || command === "remote reconcile" || command === "remote revoke") {
    await remoteCommand(parsed, home);
    return;
  }

  if (command === "viewer service") {
    if (parsed.action === "status") {
      const status = await getViewerServiceStatus({ home, user: parsed.user });
      console.log(parsed.json ? JSON.stringify(status, null, 2) : formatViewerServiceResult("status", status, selection.name));
      return;
    }

    if (parsed.action === "uninstall") {
      const status = await uninstallViewerService({ home, user: parsed.user });
      console.log(parsed.json ? JSON.stringify(status, null, 2) : formatViewerServiceResult("uninstall", status, selection.name));
      return;
    }

    const inspected = await inspectViewerServiceSelection(home, parsed.user, undefined, true);
    const saved = inspected.configuration ?? resolveViewerNetworkConfig(getViewerPort());
    const exposure = parsed.exposure ?? saved.exposure;
    const config = resolveViewerNetworkConfig({
      port: parsed.port ?? (process.env.HTML_INBOX_PORT ? getViewerPort() : saved.port),
      exposure,
      host: parsed.host ?? (exposure === saved.exposure ? saved.host : undefined),
      tailscaleHostname: exposure === "tailscale" ? saved.tailscaleHostname : undefined,
    });
    const status = await installViewerService({ home, ...config, user: parsed.user });
    console.log(parsed.json ? JSON.stringify(status, null, 2) : formatViewerServiceResult("install", status, selection.name));
    return;
  }

  if (command === "viewer") {
    const environmentPort = process.env.HTML_INBOX_PORT ? getViewerPort() : undefined;
    if (parsed.action === "status") {
      const status = await getViewerStatus(home, environmentPort);
      console.log(parsed.json
        ? JSON.stringify({ ...status, ...(selection.name ? { inbox: selection.name } : {}) }, null, 2)
        : formatViewerStatus(status, selection.name));
      return;
    }

    if (parsed.action === "stop") {
      const status = await stopViewer(home, environmentPort);
      console.log(parsed.json
        ? JSON.stringify({ ...status, ...(selection.name ? { inbox: selection.name } : {}) }, null, 2)
        : formatViewerStopResult(status, selection.name));
      return;
    }

    const selectedPort = parsed.port ?? environmentPort;
    const input = parsed.exposure || parsed.host
      ? { port: selectedPort ?? (await resolveViewerConfiguration(home)).port, exposure: parsed.exposure, host: parsed.host }
      : selectedPort;
    if (parsed.foreground) {
      if (process.env.HTML_INBOX_VIEWER_SERVICE_LOG === "1") {
        await configureViewerServiceLogging(home);
      }

      const workerConfig: unknown = process.env.HTML_INBOX_VIEWER_CONFIG
        ? JSON.parse(process.env.HTML_INBOX_VIEWER_CONFIG)
        : await resolveViewerConfiguration(home, input);
      const config = parseViewerNetworkConfig(workerConfig);
      await startViewer(new LocalDocumentBackend(home), home, config, selection.name ?? process.env.HTML_INBOX_VIEWER_NAME);
      console.error(`html-inbox viewer listening on ${(await getViewerStatus(home)).url}`);
      return;
    }

    console.log((await ensureViewer(home, input, selection.name)).url);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}
export async function publishCommand(
  args: PublishRequest,
  selection?: ResolvedInboxSelection,
): Promise<string> {
  const destination = selection ?? await resolveInboxSelection();
  const home = destination.home;
  const port = process.env.HTML_INBOX_PORT ? getViewerPort() : undefined;
  const backend = new LocalDocumentBackend(home);
  const { input, warnings } = await loadPublishInput(args);

  for (const warning of warnings) {
    console.warn(`html-inbox: ${warning}`);
  }

  const viewer = await ensureViewer(home, port, destination.name);
  const metadata = await backend.publish(input);
  return `${viewer.url}/documents/${metadata.id}`;
}

export function formatDocumentList(documents: DocumentMetadata[], json: boolean): string {
  if (json) {
    return JSON.stringify(documents, null, 2);
  }
  return formatDocumentTable(documents);
}

export function formatDeleteResult(result: DeleteResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return `Deleted ${result.metadata.id} (${formatBytes(result.reclaimedBytes)} reclaimed).`;
}

export function formatStaticExportResult(
  result: StaticSnapshotResult,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return [
    `Exported ${result.manifest.documentCount} ${
      result.manifest.documentCount === 1 ? "document" : "documents"
    } to ${result.outputDir}.`,
    `Inbox path: ${result.inboxPath}/`,
    `Snapshot: ${result.manifest.snapshotHash}`,
  ].join("\n");
}

export function assertExportOutsideHome(outputDir: string, home: string): void {
  const output = normalizeComparisonPath(resolveExistingPath(outputDir));
  const inboxHome = normalizeComparisonPath(resolveExistingPath(home));

  if (containsPath(output, inboxHome) || containsPath(inboxHome, output)) {
    throw new Error("Static export output must not contain or be inside HTML_INBOX_HOME");
  }
}

function normalizeComparisonPath(value: string): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? value.toLowerCase()
    : value;
}

function resolveExistingPath(value: string): string {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function formatRemoteState(state: RemoteState): string {
  const lines = [
    `Target: ${state.target.accountId}/${state.target.projectName} (${state.branch})`,
    `State: ${state.revoked ? "revoked" : state.lastDeployment ? "published" : "configured"}`,
  ];
  if (state.lastDeployment && !state.revoked) {
    lines.push(`Inbox: ${state.lastDeployment.receipt.projectInboxUrl}`);
  }
  if (state.lastDeployment) {
    lines.push(`Snapshot: ${state.lastDeployment.snapshotHash}`);
  }
  return lines.join("\n");
}

export function formatRemoteStatus(status: RemoteStatus): string {
  if (!status.configured || !status.state) {
    return status.operation
      ? `Remote publishing is not configured. Incomplete ${status.operation.kind} operation: ${status.operation.id}`
      : "Remote publishing is not configured.";
  }
  const lines = [formatRemoteState(status.state)];
  if (status.operation) {
    lines.push(
      `Incomplete operation: ${status.operation.kind} ${status.operation.id} (${status.operation.phase}, ${status.operation.attempts} attempts)`,
    );
  }
  return lines.join("\n");
}

async function deleteCommand({ id, force, json }: Extract<CliCommand, { command: "delete" }>, home: string): Promise<void> {
  if (json && !force) {
    throw new Error("delete --json requires --force; JSON mode never prompts for confirmation");
  }

  const backend = new LocalDocumentBackend(home);
  const metadata = await backend.getDocumentMetadata(id);
  if (!metadata) {
    throw new Error(`Document not found: ${id}`);
  }

  if (!force && !(await confirmAction(
    `Delete "${metadata.title}"? [y/N] `,
    "delete requires --force when no interactive terminal is available",
  ))) {
    console.log("Delete cancelled.");
    return;
  }

  const result = await backend.deleteDocument(id);
  if (!result) {
    throw new Error(`Document disappeared before it could be deleted: ${id}`);
  }
  console.log(formatDeleteResult(result, json));
}

async function remoteCommand(parsed: Extract<CliCommand, { command: `remote ${string}` }>, home: string): Promise<void> {
  const action = parsed.command;
  const workflow = new RemoteWorkflow(new LocalDocumentBackend(home), home);

  if (action === "remote init") {
    const options = parsed.options;
    const state = await workflow.init(options);
    console.log(options.json ? JSON.stringify(state, null, 2) : formatRemoteState(state));
    return;
  }

  if (action === "remote publish") {
    const json = parsed.json;
    const state = await workflow.publish();
    console.log(json ? JSON.stringify(state, null, 2) : formatRemoteState(state));
    return;
  }

  if (action === "remote status") {
    const json = parsed.json;
    const status = await workflow.status();
    console.log(json ? JSON.stringify(status, null, 2) : formatRemoteStatus(status));
    return;
  }

  if (action === "remote reconcile") {
    const { adopt, recoverLock, json } = parsed;
    const state = await workflow.reconcile({ adopt, recoverLock });
    console.log(json ? JSON.stringify(state, null, 2) : formatRemoteState(state));
    return;
  }

  if (action === "remote revoke") {
    const { yes, json } = parsed;
    if (json && !yes) {
      throw new Error("remote revoke --json requires --yes; JSON mode never prompts for confirmation");
    }

    if (!yes && !(await confirmAction(
      "Replace the current remote capability route? Older immutable deployment URLs may remain readable. [y/N] ",
      "remote revoke requires --yes when no interactive terminal is available",
    ))) {
      console.log("Revoke cancelled.");
      return;
    }

    const result = await workflow.revoke();
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.revokedUrl ? `Revoked ${result.revokedUrl}` : "Remote capability revoked.");
      console.log(result.warning);
    }
    return;
  }

  throw new Error(`Unknown remote action: ${action}`);
}

async function confirmAction(question: string, unavailableMessage: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY || !stderr.isTTY) {
    throw new Error(unavailableMessage);
  }

  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await prompt.question(question);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
