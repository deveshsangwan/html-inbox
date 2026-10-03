#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DeleteResult, DocumentMetadata } from "./documents";
import { getInboxHome, getViewerPort, LocalDocumentBackend } from "./backend";
import { loadPublishInput, PublishRequest } from "./publish-input";
import { ensurePrivateDirectory } from "./private-storage";
import { RemoteState, RemoteStatus, RemoteWorkflow } from "./remote-workflow";
import { exportStaticSnapshot, StaticSnapshotResult } from "./static-export";
import { ensureViewer, getViewerStatus, startViewer, stopViewer } from "./viewer-server";
import { parseCommand, type CliCommand } from "./cli-args";
import { isRecord } from "./validation";
import { containsPath } from "./path-containment";

export const USAGE = `Usage: html-inbox <command> [options]

Commands:
  publish <file.html> --title <title> --type <type>
      Store an HTML document and print its local viewer URL.

  list [--json]
      List locally stored documents.

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

  viewer [status|stop]
      Run the local viewer in the foreground.

Options:
  -h, --help       Show this help.
  -v, --version    Print the installed version.`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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

  if (command === "publish") {
    const url = await publishCommand(parsed.options);
    console.log(url);
    return;
  }

  if (command === "list") {
    const json = parsed.json;
    const documents = await new LocalDocumentBackend(getInboxHome()).listDocuments();
    console.log(formatDocumentList(documents, json));
    return;
  }

  if (command === "delete") {
    await deleteCommand(parsed);
    return;
  }

  if (command === "export") {
    const options = parsed.options;
    const home = getInboxHome();
    await ensurePrivateDirectory(home);
    assertExportOutsideHome(options.outputDir, home);
    const result = await exportStaticSnapshot(
      new LocalDocumentBackend(home),
      options,
    );
    console.log(formatStaticExportResult(result, options.json));
    return;
  }

  if (command === "remote init" || command === "remote publish" || command === "remote status" || command === "remote reconcile" || command === "remote revoke") {
    await remoteCommand(parsed);
    return;
  }

  if (command === "viewer") {
    const home = getInboxHome();
    const port = getViewerPort();
    const action = parsed.action;
    if (action === "status") {
      console.log(JSON.stringify(await getViewerStatus(home, port), null, 2));
      return;
    }
    if (action === "stop") {
      console.log(JSON.stringify(await stopViewer(home, port), null, 2));
      return;
    }
    if (action) {
      throw new Error(`Unknown viewer action: ${action}`);
    }
    await startViewer(new LocalDocumentBackend(home), home, port);
    console.error(`html-inbox viewer listening on http://127.0.0.1:${port}`);
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

export async function publishCommand(args: PublishRequest): Promise<string> {
  const home = getInboxHome();
  const port = getViewerPort();
  const backend = new LocalDocumentBackend(home);
  const { input, warnings } = await loadPublishInput(args);

  for (const warning of warnings) {
    console.warn(`html-inbox: ${warning}`);
  }

  await ensureViewer(home, port);
  const metadata = await backend.publish(input);
  return `http://127.0.0.1:${port}/documents/${metadata.id}`;
}

export function formatDocumentList(documents: DocumentMetadata[], json: boolean): string {
  if (json) {
    return JSON.stringify(documents, null, 2);
  }
  if (documents.length === 0) {
    return "No documents.";
  }
  return documents
    .map((document) =>
      [document.id, document.type, document.createdAt, document.title].join("\t"),
    )
    .join("\n");
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
      return path.join(realpathSync(current), ...missing.reverse());
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

async function deleteCommand({ id, force, json }: Extract<CliCommand, { command: "delete" }>): Promise<void> {
  const backend = new LocalDocumentBackend(getInboxHome());
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

async function remoteCommand(parsed: Extract<CliCommand, { command: `remote ${string}` }>): Promise<void> {
  const action = parsed.command;
  const home = getInboxHome();
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
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(unavailableMessage);
  }

  const prompt = createInterface({ input: stdin, output: stdout });
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
