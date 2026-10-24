import { execFile } from "node:child_process";
import path from "node:path";
import { canonicalizeInboxHome, readInboxIdentity } from "./inbox-home";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { assertExactKeys, parseBoolean, parseObject, parseString, parseUuid } from "./sync-model";
import { parseViewerNetworkConfig, type ViewerNetworkConfig } from "./viewer-network";
import { readSavedViewerConfiguration } from "./viewer-records";
import type { ViewerServiceUser } from "./viewer-service-runtime";

export const VIEWER_OWNER_PREFLIGHT = "--internal-viewer-owner-preflight";

export interface ViewerHomeInspection {
  home: string;
  instanceId: string | null;
  managed: boolean;
  configuration: ViewerNetworkConfig | null;
  tailscaleExecutable: string | null;
}

export interface ViewerOwnerPreflight {
  home: string;
  user: ViewerServiceUser;
  expectedInstanceId?: string;
  readConfiguration?: boolean;
}

// No user-controlled executable or environment is loaded before the credential
// switches. The selected CLI is spawned only after all account checks succeed.
export const ADMINISTRATOR_VIEWER_HELPER = `
const configuration = JSON.parse(process.argv[1]);
process.initgroups(configuration.user.uid, configuration.user.gid);
process.setgid(configuration.user.gid);
process.setuid(configuration.user.uid);
if (process.getuid() !== configuration.user.uid || process.getgid() !== configuration.user.gid) {
  throw new Error("Service status account identity did not match after dropping privileges");
}

const child = require("node:child_process").spawn(
  configuration.nodePath,
  [configuration.cliPath, ...configuration.args],
  { cwd: configuration.user.home, env: configuration.environment, stdio: ["ignore", "inherit", "inherit"] },
);
process.once("SIGTERM", () => child.kill("SIGKILL"));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
`;

export function assertViewerServiceUser(user: ViewerServiceUser): void {
  if (user.name === "root" || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(user.name) || !Number.isSafeInteger(user.uid) || user.uid <= 0 ||
      user.uid >= 4_294_967_295 || !Number.isSafeInteger(user.gid) || user.gid < 0 || user.gid >= 4_294_967_295 ||
      !path.isAbsolute(user.home) || /[\x00-\x1f\x7f]/.test(user.home)) {
    throw new Error("Viewer service status must run as the selected non-root user");
  }
}

/** Dedicated execFile boundary: CommandRunner merges process.env and is unsafe here. */
export function executeViewerServiceUser(user: ViewerServiceUser, nodePath: string, cliPath: string, args: string[], environment: NodeJS.ProcessEnv) {
  assertViewerServiceUser(user);
  const administrator = process.getuid?.() === 0;
  if (!administrator && process.getuid?.() !== user.uid) {
    throw new Error("Viewer service inspection requires the selected owner or administrator");
  }

  return new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(administrator ? process.execPath : nodePath, administrator
      ? ["--input-type=commonjs", "-e", ADMINISTRATOR_VIEWER_HELPER, JSON.stringify({ user, nodePath, cliPath, args, environment })]
      : [cliPath, ...args], {
      ...(administrator ? {} : { uid: user.uid, gid: user.gid }), cwd: administrator ? "/" : user.home,
      env: administrator ? { LANG: "C", LC_ALL: "C" } : environment, encoding: "utf8", timeout: 25_000, maxBuffer: 64 * 1024,
      killSignal: administrator ? "SIGTERM" : "SIGKILL",
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin?.end();
  });
}

export async function inspectViewerServiceHome(options: ViewerOwnerPreflight): Promise<ViewerHomeInspection> {
  assertViewerServiceUser(options.user);
  if (process.getuid?.() !== options.user.uid || process.getgid?.() !== options.user.gid) {
    throw new Error("Viewer service preflight requires the selected owner account");
  }

  const home = await canonicalizeInboxHome(options.home, true);
  const ledger = await assertManagedLifecycle(home);
  const instanceId = await readInboxIdentity(home);
  if (options.expectedInstanceId !== undefined && instanceId !== options.expectedInstanceId) {
    throw new Error("Selected service inbox has a missing or different registered identity");
  }

  const saved = options.readConfiguration ? await readSavedViewerConfiguration(home, { readOnly: true }) : null;
  return { home, instanceId: instanceId ?? null, managed: ledger !== null, configuration: saved?.config ?? null, tailscaleExecutable: saved?.tailscaleExecutable ?? null };
}

export async function preflightViewerServiceHome(options: ViewerOwnerPreflight): Promise<ViewerHomeInspection> {
  assertViewerServiceUser(options.user);
  if (process.getuid?.() === options.user.uid) {
    return inspectViewerServiceHome(options);
  }

  if (process.getuid?.() !== 0) {
    throw new Error("Viewer service inspection requires the selected owner or administrator");
  }

  const environment = { HOME: options.user.home, USER: options.user.name, LOGNAME: options.user.name, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const result = await executeViewerServiceUser(options.user, process.execPath, path.join(__dirname, "index.js"),
    [VIEWER_OWNER_PREFLIGHT, JSON.stringify(options)], environment);
  if (result.error) {
    throw new Error(`Viewer service owner preflight failed: ${(result.stderr.trim() || result.error.message).slice(0, 2000)}`, { cause: result.error });
  }

  if (Buffer.byteLength(result.stdout) > 8192) {
    throw new Error("Viewer service owner preflight output is too large");
  }

  const checked = parseViewerHomeInspection(JSON.parse(result.stdout));
  if (checked.home !== options.home || options.expectedInstanceId !== undefined && checked.instanceId !== options.expectedInstanceId ||
      !options.readConfiguration && (checked.configuration !== null || checked.tailscaleExecutable !== null)) {
    throw new Error("Viewer service owner preflight returned a different binding");
  }

  return checked;
}

export async function runViewerOwnerPreflight(argument: string): Promise<ViewerHomeInspection> {
  if (Buffer.byteLength(argument) > 8192) {
    throw new Error("Viewer owner preflight input is too large");
  }

  const record = parseObject(JSON.parse(argument), "viewer owner preflight");
  const optional = ["expectedInstanceId", "readConfiguration"].filter((key) => Object.hasOwn(record, key));
  assertExactKeys(record, ["home", "user", ...optional]);
  const user = parseObject(record.user, "selected account");
  assertExactKeys(user, ["name", "uid", "gid", "home"]);
  if (typeof user.uid !== "number" || typeof user.gid !== "number") {
    throw new Error("Invalid selected account identity");
  }

  return inspectViewerServiceHome({ home: parseString(record.home), user: { name: parseString(user.name), uid: user.uid, gid: user.gid, home: parseString(user.home) },
    ...(record.expectedInstanceId === undefined ? {} : { expectedInstanceId: parseUuid(record.expectedInstanceId) }),
    ...(record.readConfiguration === undefined ? {} : { readConfiguration: parseBoolean(record.readConfiguration) }) });
}

function parseViewerHomeInspection(value: unknown): ViewerHomeInspection {
  const record = parseObject(value, "viewer owner inspection");
  assertExactKeys(record, ["home", "instanceId", "managed", "configuration", "tailscaleExecutable"]);
  const home = parseString(record.home);
  const executable = record.tailscaleExecutable === null ? null : parseString(record.tailscaleExecutable);
  if (!path.isAbsolute(home) || executable !== null && !path.isAbsolute(executable)) {
    throw new Error("Invalid owner inspection path");
  }

  if (record.configuration !== null) {
    const config = parseObject(record.configuration, "saved viewer configuration");
    assertExactKeys(config, ["port", "exposure", "host", ...(Object.hasOwn(config, "tailscaleHostname") ? ["tailscaleHostname"] : [])]);
  }

  return { home, instanceId: record.instanceId === null ? null : parseUuid(record.instanceId), managed: parseBoolean(record.managed),
    configuration: record.configuration === null ? null : parseViewerNetworkConfig(record.configuration), tailscaleExecutable: executable };
}
