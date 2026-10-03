import { execFile, type ExecFileException } from "node:child_process";
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

        const { detail, advice } = describeTailscaleFailure(
          error,
          stderr,
          timeoutMs,
        );

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

function describeTailscaleFailure(
  error: ExecFileException,
  stderr: string,
  timeoutMs: number,
) {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return {
      detail: "exceeded the 1048576-byte command output limit",
      advice:
        "Inspect the existing client's output; HTML Inbox refuses oversized responses.",
    };
  }

  if (error.killed || error.code === "ETIMEDOUT") {
    return {
      detail: `timed out after ${timeoutMs}ms`,
      advice:
        "Check that the existing Tailscale daemon is responsive, then retry.",
    };
  }

  if (error.signal) {
    return {
      detail: `terminated by ${error.signal}`,
      advice:
        "Inspect the client and daemon logs for the interruption, then retry.",
    };
  }

  if (typeof error.code === "string") {
    return {
      detail: `could not execute the client (${error.code})`,
      advice:
        "Check the configured executable path and permissions for the existing Tailscale client.",
    };
  }

  return {
    detail:
      stderr.trim() ||
      `exited with code ${error.code ?? "unknown"} without stderr`,
    advice: getTailscaleStderrAdvice(stderr),
  };
}

function getTailscaleStderrAdvice(stderr: string) {
  if (/access denied|permission denied|not permitted|403/i.test(stderr)) {
    return "Ask the server administrator to grant this normal user Tailscale operator access. HTML Inbox does not elevate privileges.";
  }

  if (
    /unknown flag|unknown command|flag provided but not defined/i.test(stderr)
  ) {
    return "Use a Tailscale client supporting serve status --json, --bg, --yes, --https and --set-path.";
  }

  if (/https|certificate|magicdns/i.test(stderr)) {
    return "Ask the tailnet administrator to enable MagicDNS and HTTPS certificates, then retry.";
  }

  return "Check that the existing Tailscale daemon is running, signed in and connected, then retry.";
}
