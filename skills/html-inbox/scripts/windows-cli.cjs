const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

try {
  const invocation = JSON.parse(process.env.HTML_INBOX_SKILL_INVOCATION ?? "null");
  if (!invocation || typeof invocation.command !== "string" || !path.isAbsolute(invocation.command) ||
      !Array.isArray(invocation.args) || !invocation.args.every((argument) => typeof argument === "string")) {
    throw new Error("HTML Inbox invocation requires an absolute command and an argument array");
  }

  let command = invocation.command;
  let args = invocation.args;
  const extension = path.extname(command).toLowerCase();
  if (extension === ".cmd") {
    const shim = readFileSync(command, "utf8");
    // npm's batch shim reparses arguments through CMD. Run its Node entry directly instead.
    args = [resolveNpmEntry(command, shim), ...args];
    command = process.execPath;
  } else if (extension !== ".exe" && extension !== ".com") {
    throw new Error(`Unsupported Windows command: ${command}. Use an npm-installed CLI or native executable.`);
  }

  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function resolveNpmEntry(command, shim) {
  const directory = path.dirname(command);
  const entry = /"%dp0%[\\/]([^"\r\n]+\.[cm]?js)"\s+%\*/i.exec(shim)?.[1];
  if (entry && !entry.includes("%")) {
    return path.resolve(directory, entry.replaceAll("\\", path.sep));
  }

  const bundledEntry = /^\s*SET "NPX_CLI_JS=%~dp0[\\/]([^"\r\n]+npx-cli\.js)"\s*$/im.exec(shim)?.[1];
  if (path.basename(command).toLowerCase() !== "npx.cmd" || !bundledEntry || bundledEntry.includes("%") ||
      !/"%NODE_EXE%"\s+"%NPX_CLI_JS%"\s+%\*/i.test(shim)) {
    throw new Error(`Unsupported npm command shim: ${command}. Use an npm-installed CLI or native executable.`);
  }

  const prefixEntry = /^\s*SET "NPM_PREFIX_JS=%~dp0[\\/]([^"\r\n]+npm-prefix\.js)"\s*$/im.exec(shim)?.[1];
  const legacyPrefixEntry = /^\s*SET "NPM_CLI_JS=%~dp0[\\/]([^"\r\n]+npm-cli\.js)"\s*$/im.exec(shim)?.[1];
  const prefixScript = prefixEntry ?? legacyPrefixEntry;
  if (!prefixScript || prefixScript.includes("%")) {
    throw new Error(`Unsupported npm prefix discovery in command shim: ${command}`);
  }

  const prefix = spawnSync(process.execPath, [
    path.resolve(directory, prefixScript.replaceAll("\\", path.sep)),
    ...(prefixEntry ? [] : ["prefix", "-g"]),
  ], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", windowsHide: true });
  if (prefix.error) {
    throw prefix.error;
  }

  if (prefix.status !== 0 || !path.isAbsolute(prefix.stdout.trim())) {
    throw new Error(`npm prefix discovery failed for command shim: ${command}`);
  }

  const globalEntry = path.join(prefix.stdout.trim(), "node_modules", "npm", "bin", "npx-cli.js");
  return existsSync(globalEntry)
    ? globalEntry
    : path.resolve(directory, bundledEntry.replaceAll("\\", path.sep));
}
