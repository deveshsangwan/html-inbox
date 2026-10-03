import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandRunner } from "./command-runner";
import { writePrivateFile } from "./private-storage";
import { isRecord } from "./validation";
import { createWranglerInvocation, stripAnsi } from "./wrangler-command";

export async function readCloudflareAuthHeaders(
  runner: CommandRunner,
  cwd: string,
  accountId: string,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const logDirectory = await mkdtemp(path.join(os.tmpdir(), "html-inbox-auth-"));
  let credentials: unknown;

  try {
    const logPath = path.join(logDirectory, "wrangler.log");
    await writePrivateFile(logPath, "");
    const invocation = createWranglerInvocation(
      ["auth", "token", "--json"],
      cwd,
      accountId,
      timeoutMs,
    );

    // Wrangler logs token output even with sanitization enabled. Keep that log
    // private and remove it on success, command failure, and malformed output.
    invocation.env.WRANGLER_LOG_PATH = logPath;
    const authResult = await runner.run(invocation).catch(() => {
      throw new Error("Could not retrieve Cloudflare credentials from Wrangler");
    });

    if (authResult.code !== 0)
      throw new Error("Could not retrieve Cloudflare credentials from Wrangler");

    credentials = parseJsonOutput(authResult.stdout);
  } finally {
    await rm(logDirectory, { recursive: true, force: true });
  }

  const headers: Record<string, string> = {};
  if (
    isRecord(credentials) &&
    (credentials.type === "oauth" || credentials.type === "api_token") &&
    typeof credentials.token === "string" &&
    credentials.token
  ) {
    headers.Authorization = `Bearer ${credentials.token}`;
  } else if (
    isRecord(credentials) &&
    credentials.type === "api_key" &&
    typeof credentials.key === "string" &&
    typeof credentials.email === "string"
  ) {
    headers["X-Auth-Key"] = credentials.key;
    headers["X-Auth-Email"] = credentials.email;
  } else {
    throw new Error("Wrangler returned unsupported credentials");
  }

  return headers;
}

function parseJsonOutput(output: string): unknown {
  const cleaned = stripAnsi(output).trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Wrangler did not return valid JSON");
  }
}
