#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./validation";
import { USAGE } from "./cli-usage";
import { VIEWER_OWNER_PREFLIGHT } from "./cli-entrypoints";

export { USAGE } from "./cli-usage";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === VIEWER_OWNER_PREFLIGHT) {
    if (argv.length !== 2) {
      throw new Error("Viewer owner preflight requires one bounded input");
    }

    const { runViewerOwnerPreflight } = await import("./viewer-service-owner.js");
    console.log(JSON.stringify(await runViewerOwnerPreflight(argv[1])));
    return;
  }

  // Only these complete invocations bypass the parser. All other arguments retain
  // its selection validation, option errors and end-of-options behavior.
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
    console.log(USAGE);
    return;
  }

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    console.log(getCliVersion());
    return;
  }

  const { parseCommand } = await import("./cli-args.js");
  const parsed = parseCommand(argv);

  if (parsed.command === "help") {
    console.log(USAGE);
    return;
  }

  if (parsed.command === "version") {
    console.log(getCliVersion());
    return;
  }

  const { runCommand } = await import("./cli-commands.js");
  await runCommand(parsed);
}

export function getCliVersion(): string {
  const packagePath = path.join(__dirname, "..", "package.json");
  const packageJson: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!isRecord(packageJson) || typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("html-inbox package version is missing");
  }
  return packageJson.version;
}


if (require.main === module) {
  const isDeletionWorker = process.argv.length === 3 && process.argv[2] === "__delete-document" &&
    typeof process.send === "function" && process.connected;
  const execution = isDeletionWorker
    ? import("./document-deletion-worker.js").then(({ runDocumentDeletionWorker }) => runDocumentDeletionWorker())
    : main();

  void execution.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`html-inbox: ${message}`);
    process.exitCode = 1;
  });
}
