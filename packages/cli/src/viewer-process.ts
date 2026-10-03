import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedStorageError } from "./private-storage";
import { hasErrorCode } from "./viewer-records";
import type { ViewerNetworkConfig } from "./viewer-network";

export interface DetachedViewer {
  child: ChildProcess;
  logPath: string;
  getFailure(): Error | null;
  close(): Promise<void>;
}

export async function spawnDetachedViewer(
  home: string,
  config: ViewerNetworkConfig,
  lockToken: string,
  tailscaleExecutable?: string,
): Promise<DetachedViewer> {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot locate html-inbox executable to start viewer");
  }

  const selectedTailscaleExecutable = process.env.HTML_INBOX_TAILSCALE_COMMAND ?? tailscaleExecutable;
  const logPath = path.join(home, "viewer.log");
  const log = await open(logPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  let child: ChildProcess;
  let failure: Error | null = null;
  try {
    const logInfo = await log.stat();
    if (!logInfo.isFile() || logInfo.nlink !== 1) {
      throw new ManagedStorageError(`Viewer diagnostic log must be a regular private file: ${logPath}`);
    }

    await log.chmod(0o600);
    await log.write(`\n${new Date().toISOString()} Starting ${config.exposure} viewer on port ${config.port}\n`);
    child = spawn(process.execPath, [path.resolve(entry), "viewer", "--foreground"], {
      detached: true,
      env: {
        ...process.env,
        HTML_INBOX_HOME: home,
        HTML_INBOX_PORT: String(config.port),
        HTML_INBOX_VIEWER_CONFIG: JSON.stringify(config),
        HTML_INBOX_START_LOCK: lockToken,
        ...(selectedTailscaleExecutable ? { HTML_INBOX_TAILSCALE_COMMAND: selectedTailscaleExecutable } : {}),
      },
      stdio: ["ignore", log.fd, log.fd],
    });
    child.once("error", (error) => { failure = error; });
    child.unref();
  } finally {
    await log.close();
  }

  return {
    child,
    logPath,
    getFailure: () => failure,
    close: () => terminateChild(child),
  };
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Failed viewer child already exited; its process tree cannot be verified from its saved PID");
    }

    await terminateWindowsProcessTree(child.pid);
    const deadline = Date.now() + 2000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await delay(25);
    }

    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`Failed viewer child ${child.pid} could not be stopped`);
    }

    return;
  }

  terminateChildGroup(child, "SIGTERM");
  let deadline = Date.now() + 1000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(25);
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    terminateChildGroup(child, "SIGKILL");
    return;
  }

  terminateChildGroup(child, "SIGKILL");
  deadline = Date.now() + 2000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(25);
  }

  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Failed viewer child ${child.pid} could not be stopped`);
  }
}

function terminateChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  try {
    // Detached Node and its in-flight command children share this process group.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) {
      throw error;
    }
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      killer.kill("SIGKILL");
      reject(new Error(`Failed viewer child process tree ${pid} could not be stopped: taskkill timed out`));
    }, 5000);
    timer.unref();
    killer.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed viewer child process tree ${pid} could not be stopped: ${error.message}`, { cause: error }));
    });
    killer.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Failed viewer child process tree ${pid} could not be stopped: taskkill exited ${code}`));
        return;
      }

      resolve();
    });
  });
}
