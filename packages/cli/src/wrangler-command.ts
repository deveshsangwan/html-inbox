import path from "node:path";
import { normalizeCloudflareAccountId } from "./validation";
import type { CommandInvocation, CommandRunner } from "./command-runner";

export const PINNED_WRANGLER_VERSION = "4.86.0";
export const DEFAULT_WRANGLER_TIMEOUT_MS = 5 * 60 * 1_000;

export function createWranglerInvocation(
  args: string[],
  cwd: string,
  accountId: string,
  timeoutMs = DEFAULT_WRANGLER_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
): CommandInvocation {
  const npxArgs = ["--yes", `wrangler@${PINNED_WRANGLER_VERSION}`, ...args];

  return {
    command: platform === "win32" ? nodeExecutable : "npx",
    args:
      platform === "win32"
        ? [
            path.win32.join(
              path.win32.dirname(nodeExecutable),
              "node_modules",
              "npm",
              "bin",
              "npx-cli.js",
            ),
            ...npxArgs,
          ]
        : npxArgs,
    cwd,
    env: {
      CLOUDFLARE_ACCOUNT_ID: normalizeCloudflareAccountId(accountId),
      WRANGLER_LOG_SANITIZE: "true",
    },
    timeoutMs,
  };
}

export async function runWrangler(
  runner: CommandRunner,
  args: string[],
  cwd: string,
  accountId: string,
  timeoutMs = DEFAULT_WRANGLER_TIMEOUT_MS,
): Promise<string> {
  const result = await runner.run(
    createWranglerInvocation(args, cwd, accountId, timeoutMs),
  );
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 0) {
    throw new Error(
      `Wrangler failed (${result.signal ?? result.code}). ${cleanOutput(output)}`,
    );
  }

  return output;
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function cleanOutput(value: string): string {
  let cleaned = stripAnsi(value).trim();

  for (const [name, credential] of Object.entries(process.env)) {
    if (
      credential &&
      /^(?:CLOUDFLARE|CF)_.*(?:TOKEN|KEY|SECRET|PASSWORD|EMAIL)$/i.test(name)
    ) {
      cleaned = cleaned.split(credential).join("[redacted]");
    }
  }

  return cleaned.slice(-4_000);
}
