#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { validateHtml } from "@html-inbox/shared";
import { getInboxHome, getViewerPort, LocalDocumentBackend } from "./backend";
import { ensureViewer, startViewer } from "./viewer";

interface PublishArgs {
  filePath: string;
  title: string;
  type: string;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];

  if (command === "publish") {
    const url = await publishCommand(parsePublishArgs(argv.slice(1)));
    console.log(url);
    return;
  }

  if (command === "viewer") {
    const home = getInboxHome();
    const port = getViewerPort();
    await startViewer(new LocalDocumentBackend(home), home, port);
    console.error(`html-inbox viewer listening on http://127.0.0.1:${port}`);
    return;
  }

  throw new Error("Usage: html-inbox publish <file.html> --title <title> --type <type>");
}

export async function publishCommand(args: PublishArgs): Promise<string> {
  const home = getInboxHome();
  const port = getViewerPort();
  const backend = new LocalDocumentBackend(home);
  const publishInput = await readPublishInput(args);

  await ensureViewer(home, port);
  const result = await backend.publish(publishInput);
  return `http://127.0.0.1:${port}/documents/${result.metadata.id}`;
}

async function readPublishInput(args: PublishArgs) {
  const absolutePath = path.resolve(args.filePath);
  const extension = path.extname(absolutePath).toLowerCase();

  if (extension !== ".html" && extension !== ".htm") {
    throw new Error("Published file must use .html or .htm");
  }

  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("Published path must be a file");
  }

  const originalBytes = await readFile(absolutePath);
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes);
  } catch {
    throw new Error("Published file must be valid UTF-8");
  }

  const validation = validateHtml(html);
  if (!validation.ok) {
    throw new Error(`HTML validation failed: ${validation.errors.join("; ")}`);
  }

  return {
    html,
    originalBytes,
    title: args.title,
    type: args.type,
    sourceFileName: path.basename(absolutePath),
  };
}

function parsePublishArgs(args: string[]): PublishArgs {
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

if (require.main === module) {
  void main().catch((error) => {
    console.error(`html-inbox: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
