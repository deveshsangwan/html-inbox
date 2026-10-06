const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
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
    const entry = /"%dp0%[\\/]([^"\r\n]+\.[cm]?js)"\s+%\*/i.exec(shim)?.[1];
    if (!entry || entry.includes("%")) {
      throw new Error(`Unsupported npm command shim: ${command}. Use an npm-installed CLI or native executable.`);
    }

    // npm's batch shim reparses arguments through CMD. Run its Node entry directly instead.
    args = [path.resolve(path.dirname(command), entry.replaceAll("\\", path.sep)), ...args];
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
