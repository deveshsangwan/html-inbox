#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DeleteResult, DocumentMetadata } from "@html-inbox/shared";
import { getInboxHome, getViewerPort, LocalDocumentBackend } from "./backend";
import { loadPublishInput, PublishRequest } from "./publish-input";
import { exportStaticSnapshot, StaticSnapshotResult } from "./static-export";
import { ensureViewer, getViewerStatus, startViewer, stopViewer } from "./viewer";

const USAGE = `Usage: html-inbox <command> [options]

Commands:
  publish <file.html> --title <title> --type <type>
      Store an HTML document and print its local viewer URL.

  list [--json]
      List locally stored documents.

  delete <id> [--force] [--json]
      Delete a document after confirmation.

  export --out <directory> [--capability <value>] [--json]
      Build a provider-independent static snapshot of the local library.

  viewer [status|stop]
      Run the local viewer in the foreground.

Options:
  -h, --help       Show this help.
  -v, --version    Print the installed version.`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(formatUsage());
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(getCliVersion());
    return;
  }

  if (command === "publish") {
    const url = await publishCommand(parsePublishArgs(argv.slice(1)));
    console.log(url);
    return;
  }

  if (command === "list") {
    const json = parseBooleanFlag(argv.slice(1), "--json");
    const documents = await new LocalDocumentBackend(getInboxHome()).listDocuments();
    console.log(formatDocumentList(documents, json));
    return;
  }

  if (command === "delete") {
    await deleteCommand(argv.slice(1));
    return;
  }

  if (command === "export") {
    const options = parseExportArgs(argv.slice(1));
    const result = await exportStaticSnapshot(
      new LocalDocumentBackend(getInboxHome()),
      options,
    );
    console.log(formatStaticExportResult(result, options.json));
    return;
  }

  if (command === "viewer") {
    const home = getInboxHome();
    const port = getViewerPort();
    const action = argv[1];
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

  throw new Error(`Unknown command: ${command}\n\n${formatUsage()}`);
}

export function formatUsage(): string {
  return USAGE;
}

export function getCliVersion(): string {
  const packagePath = path.join(__dirname, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("html-inbox package version is missing");
  }
  return packageJson.version;
}

export async function publishCommand(args: PublishRequest): Promise<string> {
  const home = getInboxHome();
  const port = getViewerPort();
  const backend = new LocalDocumentBackend(home);
  const publishInput = await loadPublishInput(args);

  await ensureViewer(home, port);
  const result = await backend.publish(publishInput);
  return `http://127.0.0.1:${port}/documents/${result.metadata.id}`;
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

async function deleteCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id || id.startsWith("--")) {
    throw new Error("delete requires a document ID");
  }
  const flags = args.slice(1);
  const force = parseBooleanFlag(flags, "--force", ["--json"]);
  const json = parseBooleanFlag(flags, "--json", ["--force"]);
  const backend = new LocalDocumentBackend(getInboxHome());
  const document = await backend.getDocument(id);
  if (!document) {
    throw new Error(`Document not found: ${id}`);
  }

  if (!force) {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error("delete requires --force when no interactive terminal is available");
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question(`Delete "${document.metadata.title}"? [y/N] `);
      if (!/^y(?:es)?$/i.test(answer.trim())) {
        console.log("Delete cancelled.");
        return;
      }
    } finally {
      prompt.close();
    }
  }

  const result = await backend.deleteDocument(id);
  if (!result) {
    throw new Error(`Document disappeared before it could be deleted: ${id}`);
  }
  console.log(formatDeleteResult(result, json));
}

function parseBooleanFlag(
  args: string[],
  flag: string,
  otherAllowedFlags: string[] = [],
): boolean {
  for (const arg of args) {
    if (arg !== flag && !otherAllowedFlags.includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args.includes(flag);
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

function parsePublishArgs(args: string[]): PublishRequest {
  const filePath = args[0];
  if (!filePath) {
    throw new Error("publish requires a file path");
  }

  let title = "";
  let type = "";

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--title") {
      title = args[++index] ?? "";
    } else if (arg.startsWith("--title=")) {
      title = arg.slice("--title=".length);
    } else if (arg === "--type") {
      type = args[++index] ?? "";
    } else if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
    } else {
      throw new Error(`Unknown publish argument: ${arg}`);
    }
  }

  if (!title) {
    throw new Error("publish requires --title");
  }
  if (!type) {
    throw new Error("publish requires --type");
  }

  return { filePath, title, type };
}

interface ExportCommandOptions {
  outputDir: string;
  capability?: string;
  json: boolean;
}

function parseExportArgs(args: string[]): ExportCommandOptions {
  let outputDir = "";
  let capability: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("export requires --out <directory>");
      }
      outputDir = value;
    } else if (arg.startsWith("--out=")) {
      outputDir = arg.slice("--out=".length);
    } else if (arg === "--capability") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("export --capability requires a value");
      }
      capability = value;
    } else if (arg.startsWith("--capability=")) {
      capability = arg.slice("--capability=".length);
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown export argument: ${arg}`);
    }
  }

  if (!outputDir) {
    throw new Error("export requires --out <directory>");
  }
  if (capability === "") {
    throw new Error("export --capability requires a value");
  }
  return { outputDir, capability, json };
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`html-inbox: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
