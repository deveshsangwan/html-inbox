#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
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
import { parseCommand, type CliCommand } from "./cli-args";
import { isRecord } from "./validation";
import { containsPath } from "./path-containment";
import { parseViewerNetworkConfig, resolveViewerNetworkConfig } from "./viewer-network";
import { getViewerServiceStatus, installViewerService, inspectViewerServiceSelection, resolveViewerServiceHome, uninstallViewerService } from "./viewer-service";
import { runViewerOwnerPreflight, VIEWER_OWNER_PREFLIGHT } from "./viewer-service-owner";
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

export const USAGE = `Usage: html-inbox <command> [options]

Commands:
  publish <file.html> --title <title> --type <type> [--json]
      Store an HTML document and print its active viewer URL.

  sync enroll --inbox <name> --yes [--json]
  sync configure --inbox <name> --config <absolute-runtime-json> [--json]
  sync status [--document <local-id>] [--json]
  sync mapping add --config <absolute-mapping-json>
  sync mapping remove <route-uuid> --revision <current>
  sync mapping reconnect <route-uuid> --revision <current> --config <absolute-json>
  sync target set <destination-uuid> --peer <peer-uuid> | sync target clear
  sync run [--route <uuid>] | sync retry --route <uuid> | sync pause | sync resume
  sync worker enable | start [--foreground] | startup | status | stop | disable | wake
  sync worker supervisor render --platform <systemd|launchd> --user <normal-user>
  sync worker supervisor status --definition <absolute-definition>
  sync restore inspect --home <canonical-home>
  sync restore quarantine --home <canonical-home> --expect-inbox <uuid> --yes
  sync fork --home <canonical-home> --expect-inbox <uuid> --yes
      Managed replication uses explicit matching peer grants and its own owned worker.
      Publish accepts --wait-ms, --request-timeout-ms and paired --target-inbox/--target-peer.

  list [--json]
      List locally stored documents.

  preferences [--appearance <system|light|dark>] [--json]
      Show or set the default viewer and generated-document appearance.
      System follows device settings and is the default.

  delete <id> [--force] [--json]
      Delete a document after confirmation.

  export --out <directory> [--capability <value>] [--json]
      Build a provider-independent static snapshot of the local library.

  remote init --account <id> --project <name> [--branch <name>] [--adopt] [--json]
  remote publish [--json]
  remote status [--json]
  remote reconcile [--adopt] [--recover-lock] [--json]
      Recover preserved intent; --recover-lock verifies and replaces an abandoned lock.
  remote revoke [--yes] [--json]
      Configure and manage a private capability inbox on Cloudflare Pages.

  viewer [--foreground] [--loopback|--lan|--tailscale] [--host <ip>] [--port <port>]
      Start or reuse a background viewer after verifying readiness.
      --foreground stays attached. First startup is loopback-only.
      LAN trusts all reachable readers; Tailscale uses existing HTTPS Serve.
      Omitted networking options reuse the saved configuration.

  viewer status [--json]
  viewer stop [--json]
      Inspect or stop the verified viewer through its local control endpoint.

  viewer service install [--user <normal-user>] [viewer networking options] [--json]
  viewer service uninstall [--user <normal-user>] [--json]
  viewer service status [--user <normal-user>] [--json]
      Manage boot startup with systemd or a macOS LaunchDaemon.
      Install and uninstall require administrator privileges; the viewer runs as a normal user.

  inbox create <name> --home <absolute-path> [--json]
  inbox register <name> --home <absolute-path> [--json]
  inbox list [--running] [--json]
  inbox default <name> | inbox default --clear
      Name independent libraries, inspect their local state, or choose a fallback.

  hub init --config <absolute-path> --inbox <name> [--inbox <name> ...] [--name <title>]
      Capture explicit reading membership in a new local config.
  hub --config <absolute-path> [--port <port>] [--loopback|--lan] [--host <ip>]
      Serve selected local libraries in the foreground. Default: loopback port 3218.
      Every reachable reader can read all selected libraries. Ctrl-C stops the hub.

Options:
  --inbox <name>  Select a registered library for this operation.
  --home <path>   Select an absolute library path for this operation.
  --json         Machine-readable results where supported; never prompt.
  -h, --help       Show this help.
  -v, --version    Print the installed version.

Environment:
  HTML_INBOX_NAME                 Registered library name.
  HTML_INBOX_CATALOG_HOME         Private catalog, default ~/.config/html-inbox.
  HTML_INBOX_HOME                 Library directory, default ~/.html-inbox.
  HTML_INBOX_PORT                 Port override, default 3217 on first startup.
  HTML_INBOX_TAILSCALE_COMMAND    Path to an existing Tailscale executable.

Selection:
  Explicit selection, then environment, then configured default.
  With named inboxes and no selection, interactive terminals offer a picker.
  Scripts and JSON mode require --inbox, --home, an environment binding, or a default.
  Without named inboxes, the legacy ~/.html-inbox home remains available.`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === VIEWER_OWNER_PREFLIGHT) {
    if (argv.length !== 2) {
      throw new Error("Viewer owner preflight requires one bounded input");
    }

    console.log(JSON.stringify(await runViewerOwnerPreflight(argv[1])));
    return;
  }

  const parsed = parseCommand(argv);
  const command = parsed.command;

  if (command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "version") {
    console.log(getCliVersion());
    return;
  }

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

export function getCliVersion(): string {
  const packagePath = path.join(__dirname, "..", "package.json");
  const packageJson: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!isRecord(packageJson) || typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("html-inbox package version is missing");
  }
  return packageJson.version;
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

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`html-inbox: ${message}`);
    process.exitCode = 1;
  });
}
