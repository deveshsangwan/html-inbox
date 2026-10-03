import { execFile } from "node:child_process";
import { isRecord } from "./validation";
import { isValidPid } from "./viewer-records";
import type { ViewerServiceDefinition } from "./viewer-service-definition";

// The administrator helper loads only this constant code and builtin modules before dropping privileges.
const ADMINISTRATOR_STATUS_HELPER = `
const configuration = JSON.parse(process.argv[1]);
process.initgroups(configuration.user.uid, configuration.user.gid);
process.setgid(configuration.user.gid);
process.setuid(configuration.user.uid);
if (process.getuid() !== configuration.user.uid || process.getgid() !== configuration.user.gid) {
  throw new Error("Service status account identity did not match after dropping privileges");
}

const child = require("node:child_process").spawn(
  configuration.nodePath,
  [configuration.cliPath, "viewer", "status"],
  { cwd: configuration.user.home, env: configuration.environment, stdio: ["ignore", "inherit", "inherit"] },
);
process.once("SIGTERM", () => child.kill("SIGKILL"));
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
`;

export async function queryViewerServiceProcess(
  definition: ViewerServiceDefinition,
): Promise<{ state: string; pid?: number }> {
  if (
    definition.user.name === "root" ||
    !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(definition.user.name) ||
    !Number.isSafeInteger(definition.user.uid) ||
    definition.user.uid <= 0 ||
    definition.user.uid >= 4_294_967_295 ||
    !Number.isSafeInteger(definition.user.gid) ||
    definition.user.gid < 0 ||
    definition.user.gid >= 4_294_967_295
  ) {
    throw new Error(
      "Viewer service status must run as the selected non-root user",
    );
  }

  const isAdministrator = process.getuid?.() === 0;
  const environment = {
    ...definition.environment,
    HTML_INBOX_HOME: definition.home,
    HTML_INBOX_PORT: String(definition.port),
  };
  const command = isAdministrator ? process.execPath : definition.nodePath;
  const args = isAdministrator
    ? [
        "--input-type=commonjs",
        "-e",
        ADMINISTRATOR_STATUS_HELPER,
        JSON.stringify({
          user: definition.user,
          nodePath: definition.nodePath,
          cliPath: definition.cliPath,
          environment,
        }),
      ]
    : [definition.cliPath, "viewer", "status"];

  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        ...(isAdministrator
          ? {}
          : { uid: definition.user.uid, gid: definition.user.gid }),
        cwd: isAdministrator ? "/" : definition.user.home,
        env: isAdministrator ? { LANG: "C", LC_ALL: "C" } : environment,
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 64 * 1024,
        killSignal: isAdministrator ? "SIGTERM" : "SIGKILL",
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
