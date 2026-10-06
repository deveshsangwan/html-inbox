import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function readResolution() {
  const reference = await readFile(new URL("../skills/html-inbox/references/cli-resolution.md", import.meta.url), "utf8");
  const remoteReference = await readFile(new URL("../skills/html-inbox-remote/references/cli-resolution.md", import.meta.url), "utf8");
  assert.equal(remoteReference, reference, "Individually installed skills must carry the same resolution policy");
  const runner = await readFile(new URL("../skills/html-inbox/scripts/windows-cli.cjs", import.meta.url), "utf8");
  const remoteRunner = await readFile(new URL("../skills/html-inbox-remote/scripts/windows-cli.cjs", import.meta.url), "utf8");
  assert.equal(remoteRunner, runner, "Both skills must carry their own identical Windows dispatcher");

  const shellExamples = reference.replaceAll("\r\n", "\n");
  const bash = /```bash\n([\s\S]*?)\n```/.exec(shellExamples)?.[1];
  const powershell = /```powershell\n([\s\S]*?)\n```/.exec(shellExamples)?.[1];
  assert(bash && powershell, "Both shell examples must be executable");

  const skillDirectory = fileURLToPath(new URL("../skills/html-inbox/", import.meta.url)).replaceAll("'", "''");

  return { bash, powershell: powershell.replace("<installed-skill-directory>", skillDirectory) };
}

export async function runResolvedCli(resolution, args, { cwd, env = {}, shell } = {}) {
  const command = shell ?? (process.platform === "win32"
    ? (await runCommand("where.exe", ["pwsh"])).stdout.trim().split(/\r?\n/)[0]
    : "/bin/bash");
  const isPowerShell = /(?:^|[/\\])(?:pwsh|powershell)(?:\.exe)?$/.test(command);
  const shellArguments = isPowerShell
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'\n${resolution.powershell}\n$operationArguments = [string[]](ConvertFrom-Json $env:HTML_INBOX_TEST_ARGUMENTS)\ninbox @operationArguments\nexit $LASTEXITCODE`]
    : ["-c", `${resolution.bash}\ninbox "$@"`, "skill-operation", ...args];

  return runCommand(command, shellArguments, {
    cwd,
    env: { ...env, HTML_INBOX_TEST_ARGUMENTS: JSON.stringify(args) },
  });
}

export async function runCommand(command, args, { cwd, env = {}, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated with ${signal}.\n${stderr}`));
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}
