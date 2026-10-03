import { constants } from "node:fs";
import { access, chown, lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { CommandRunner, NodeCommandRunner } from "./command-runner";
import { ViewerServiceDefinition } from "./viewer-service-definition";
import { resolveViewerNetworkConfig } from "./viewer-network";
import { readSavedViewerConfiguration } from "./viewer-records";
import { queryViewerServiceProcess } from "./viewer-service-status";

export interface ViewerServiceOptions {
  home: string;
  port: number;
  exposure: "loopback" | "lan" | "tailscale";
  host?: string;
  user?: string;
}

export interface ViewerServiceUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export interface ViewerServiceRuntime {
  platform: NodeJS.Platform;
  uid: number;
  currentUser: string;
  environment: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  managerPath: string;
  serviceDirectory: string;
  tailscalePath?: string;
  lookupUser(name: string): Promise<ViewerServiceUser>;
  runner: CommandRunner;
  chown(filePath: string, uid: number, gid: number, file?: FileHandle): Promise<void>;
  getViewerStatus(definition: ViewerServiceDefinition): Promise<{ state: string; pid?: number }>;
  readinessTimeoutMs?: number;
}

export function defaultRuntime(): ViewerServiceRuntime {
  const platform = process.platform;
  const runner = new NodeCommandRunner();
  const cliPath = process.argv[1] ?? "";
  return {
    platform,
    uid: process.getuid?.() ?? -1,
    currentUser: userInfo().username,
    environment: process.env,
    nodePath: process.execPath,
    cliPath,
    managerPath: platform === "darwin" ? "/bin/launchctl" : "/usr/bin/systemctl",
    serviceDirectory: platform === "darwin" ? "/Library/LaunchDaemons" : "/etc/systemd/system",
    lookupUser: (name) => lookupSystemUser(name, platform, runner),
    runner,
    chown: (filePath, uid, gid, file) => file ? file.chown(uid, gid) : chown(filePath, uid, gid),
    getViewerStatus: queryViewerServiceProcess,
  };
}

export function supportedPlatform(runtime: ViewerServiceRuntime): "linux" | "darwin" {
  if (runtime.platform !== "linux" && runtime.platform !== "darwin") {
    throw new Error("Boot services require Linux with systemd or macOS with launchd");
  }

  return runtime.platform;
}

export function assertAdministrator(runtime: ViewerServiceRuntime) {
  supportedPlatform(runtime);
  if (runtime.uid !== 0) {
    throw new Error("Boot service installation and removal require administrator privileges; invoke the command as an administrator with --user <normal-user>");
  }
}

export async function selectUser(requestedUser: string | undefined, runtime: ViewerServiceRuntime) {
  const name = requestedUser ?? (runtime.uid === 0 ? runtime.environment.SUDO_USER : runtime.currentUser);
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(name) || name === "root") {
    throw new Error("Select a non-root normal account with --user <normal-user>");
  }

  const user = await runtime.lookupUser(name);
  if (user.name !== name || !Number.isSafeInteger(user.uid) || user.uid <= 0 || !Number.isSafeInteger(user.gid) || user.gid < 0 || !path.isAbsolute(user.home)) {
    throw new Error(`Viewer service account ${name} must be a normal, non-root user with an absolute home directory`);
  }

  assertSafeText(user.home, "User home");
  return user;
}

export async function prepareDefinition(options: ViewerServiceOptions, runtime: ViewerServiceRuntime, platform: "linux" | "darwin") {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Service port must be an integer from 1 to 65535");
  }
  const config = resolveViewerNetworkConfig({ port: options.port, exposure: options.exposure, host: options.host });
  if (config.exposure === "tailscale" && config.host !== "127.0.0.1") {
    throw new Error("Tailscale service must bind 127.0.0.1 for its local Serve backend");
  }

  const user = await selectUser(options.user, runtime);
  const home = path.resolve(options.home);
  assertSafeText(home, "Inbox home");
  const nodePath = await resolveInstalledPath(runtime.nodePath, true);
  const cliPath = await resolveInstalledPath(runtime.cliPath, false);
  const environment: Record<string, string> = {
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    HTML_INBOX_HOME: home,
    HTML_INBOX_PORT: String(options.port),
    PATH: await stablePath(runtime.environment.PATH, nodePath),
  };
  if (platform === "darwin") {
    environment.HTML_INBOX_VIEWER_SERVICE_LOG = "1";
  }

  for (const key of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = runtime.environment[key];
    if (value !== undefined) {
      assertSafeText(value, key);
      environment[key] = value;
    }
  }

  if (config.exposure === "tailscale") {
    const saved = await readSavedViewerConfiguration(home);
    const override = runtime.tailscalePath ?? runtime.environment.HTML_INBOX_TAILSCALE_COMMAND ?? saved?.tailscaleExecutable;
    environment.HTML_INBOX_TAILSCALE_COMMAND = await resolveExecutable(override ?? "tailscale", runtime.environment.PATH);
  }

  const definition: ViewerServiceDefinition = { platform, home, port: config.port, exposure: config.exposure, host: config.host, user, nodePath, cliPath, environment };
  return definition;
}

async function resolveInstalledPath(filePath: string, executable: boolean) {
  assertSafeText(filePath, "Executable path");
  if (!path.isAbsolute(filePath)) throw new Error(`Service executable must have an absolute installed path: ${filePath}`);

  const resolved = await realpath(filePath);
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error(`Service executable is not a regular file: ${resolved}`);

  await access(resolved, executable ? constants.X_OK : constants.R_OK);
  return resolved;
}

async function resolveExecutable(command: string, executablePath = "") {
  if (path.isAbsolute(command)) return resolveInstalledPath(command, true);
  if (command.includes("/") || command !== "tailscale") throw new Error("Tailscale executable override must be an absolute path");

  for (const directory of executablePath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;

    try {
      return await resolveInstalledPath(path.join(directory, command), true);
    } catch (error) {
      if (!isFileMissing(error) && !(error instanceof Error && "code" in error && error.code === "EACCES")) throw error;
    }
  }

  throw new Error("Cannot locate a stable Tailscale executable for the boot service");
}

async function stablePath(executablePath: string | undefined, nodePath: string) {
  const directories = [path.dirname(nodePath), "/usr/local/bin", "/usr/bin", "/bin"];
  for (const directory of (executablePath ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;

    try {
      const resolved = await realpath(directory);
      if (!(await lstat(resolved)).isDirectory()) continue;

      directories.push(resolved);
    } catch (error) {
      if (!isFileMissing(error)) throw error;
    }
  }

  const result = [...new Set(directories)].join(path.delimiter);
  assertSafeText(result, "Service PATH");
  return result;
}

export async function prepareViewerServiceInbox(definition: ViewerServiceDefinition, runtime: ViewerServiceRuntime) {
  let createdHome = false;
  try {
    await mkdir(definition.home, { mode: 0o700 });
    createdHome = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }

  const directory = await open(definition.home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || (!createdHome && info.uid !== definition.user.uid)) {
      throw new Error("Service inbox must be a regular directory owned by the selected user; documents are never recursively re-owned");
    }
    if (createdHome) await runtime.chown(definition.home, definition.user.uid, definition.user.gid, directory);
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }

}

async function lookupSystemUser(name: string, platform: NodeJS.Platform, runner: CommandRunner): Promise<ViewerServiceUser> {
  const result = await runner.run({ command: platform === "darwin" ? "/usr/bin/dscl" : "/usr/bin/getent", args: platform === "darwin" ? [".", "-read", `/Users/${name}`, "UniqueID", "PrimaryGroupID", "NFSHomeDirectory"] : ["passwd", name], cwd: "/", env: {}, timeoutMs: 5000 });
  if (result.code !== 0) throw new Error(`Cannot look up service user ${name}: ${result.stderr.trim()}`);

  if (platform === "darwin") {
    const uid = /^UniqueID: (\d+)$/m.exec(result.stdout)?.[1];
    const gid = /^PrimaryGroupID: (\d+)$/m.exec(result.stdout)?.[1];
    const home = /^NFSHomeDirectory: (.+)$/m.exec(result.stdout)?.[1];
    if (!uid || !gid || !home) throw new Error(`Invalid account information for ${name}`);

    return { name, uid: Number(uid), gid: Number(gid), home };
  }

  const fields = result.stdout.trim().split(":");
  const [accountName, , uid, gid, , home, shell] = fields;
  if (fields.length !== 7 || accountName !== name || !/^\d+$/.test(uid) || !/^\d+$/.test(gid) || !home || !shell || /(?:nologin|false)$/.test(shell)) {
    throw new Error(`Invalid normal account information for ${name}`);
  }

  return { name, uid: Number(uid), gid: Number(gid), home };
}

function assertSafeText(value: string, label: string) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} contains unsupported control characters or is empty`);
}

function isFileMissing(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
