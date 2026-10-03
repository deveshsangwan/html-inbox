import { spawn } from "node:child_process";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface CommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}

export class NodeCommandRunner implements CommandRunner {
  async run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failure: Error | null = null;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;

      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let forceTimer: NodeJS.Timeout | undefined;

      const finish = (action: () => void) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        action();
      };

      const fail = (error: Error) => {
        if (failure || settled) return;

        failure = error;
        terminateProcessTree(child);
        forceTimer = setTimeout(
          () => terminateProcessTree(child, "SIGKILL"),
          2_000,
        );
        forceTimer.unref();
      };

      const record = (chunk: string, stream: "stdout" | "stderr") => {
        if (failure) return;

        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;

        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          fail(
            new Error(
              "Wrangler produced more than 1 MiB of output and was stopped",
            ),
          );
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => record(chunk, "stdout"));
      child.stderr.on("data", (chunk: string) => record(chunk, "stderr"));
      child.once("error", (error) =>
        fail(new Error(`Wrangler could not start: ${error.message}`)),
      );
      child.once("close", (code, signal) =>
        finish(() =>
          failure
            ? reject(failure)
            : resolve({ code: code ?? 1, signal, stdout, stderr }),
        ),
      );

      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `Wrangler did not finish within ${invocation.timeoutMs}ms`,
            ),
          ),
        invocation.timeoutMs,
      );
      timer.unref();
    });
  }
}

function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    killer.once("error", () => child.kill(signal));
    killer.once("close", (code) => {
      if (code !== 0) child.kill(signal);
    });

    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
