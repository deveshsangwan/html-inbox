import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export interface TailscaleCommandOptions {
  executable?: string;
  timeoutMs?: number;
}

export async function resolveTailscaleExecutable(
  executable = process.env.HTML_INBOX_TAILSCALE_COMMAND ?? "tailscale",
): Promise<string> {
  if (!executable || executable.includes("\0")) {
    throw new Error("Tailscale executable must be an existing command or path");
  }

  const hasPath = path.isAbsolute(executable) || executable.includes(path.sep);
  const directories = hasPath
    ? [""]
    : (process.env.PATH ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32" && !path.extname(executable)
      ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";")
      : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, executable + extension);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }

  throw new Error(
    `Tailscale CLI is missing or not executable: ${executable}. Use an existing installed, signed-in client and set HTML_INBOX_TAILSCALE_COMMAND to its absolute path if needed.`,
  );
}

export async function runTailscale(
  executable: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Tailscale command timeout must be between 1 and 60000ms");
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }

        const detail = stderr.trim() || error.message;
        const advice =
          /access denied|permission denied|not permitted|403/i.test(detail)
            ? "Ask the server administrator to grant this normal user Tailscale operator access. HTML Inbox does not elevate privileges."
            : /unknown flag|unknown command|flag provided but not defined/i.test(
                  detail,
                )
              ? "Use a Tailscale client supporting serve status --json, --bg, --yes, --https and --set-path."
              : /https|certificate|magicdns/i.test(detail)
                ? "Ask the tailnet administrator to enable MagicDNS and HTTPS certificates, then retry."
                : "Check that the existing Tailscale daemon is running, signed in and connected, then retry.";

        reject(
          new Error(
            `Tailscale ${args.slice(0, 2).join(" ")} failed: ${detail.slice(0, 2000)}. ${advice}`,
            { cause: error },
          ),
        );
      },
    );

    // The integration must never participate in an interactive setup or consent flow.
    child.stdin?.end();
  });
}
