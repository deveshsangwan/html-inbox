import { execFile } from "node:child_process";
import { isRecord } from "./validation";
import { isValidPid } from "./viewer-records";
import type { ViewerServiceDefinition } from "./viewer-service-definition";

export async function queryViewerServiceProcess(
  definition: ViewerServiceDefinition,
): Promise<{ state: string; pid?: number }> {
  if (
    !Number.isSafeInteger(definition.user.uid) ||
    definition.user.uid <= 0 ||
    !Number.isSafeInteger(definition.user.gid) ||
    definition.user.gid < 0
  ) {
    throw new Error(
      "Viewer service status must run as the selected non-root user",
    );
  }

  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      definition.nodePath,
      [definition.cliPath, "viewer", "status"],
      {
        uid: definition.user.uid,
        gid: definition.user.gid,
        cwd: definition.user.home,
        env: {
          ...definition.environment,
          HTML_INBOX_HOME: definition.home,
          HTML_INBOX_PORT: String(definition.port),
        },
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Viewer service status failed as ${definition.user.name}: ${(stderr.trim() || error.message).slice(0, 2000)}`,
              { cause: error },
            ),
          );
          return;
        }

        resolve(stdout);
      },
    );
    child.stdin?.end();
  });

  const status: unknown = JSON.parse(output);
  if (
    !isRecord(status) ||
    typeof status.state !== "string" ||
    !["running", "stopped", "conflict", "incompatible"].includes(
      status.state,
    ) ||
    (status.pid !== undefined && !isValidPid(status.pid))
  ) {
    throw new Error("Viewer service returned malformed normal-user status");
  }

  return {
    state: status.state,
    ...(isValidPid(status.pid) ? { pid: status.pid } : {}),
  };
}
