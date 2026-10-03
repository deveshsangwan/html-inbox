import { rm } from "node:fs/promises";
import { CommandResult } from "./command-runner";
import { LAUNCHD_VIEWER_LABEL, SYSTEMD_VIEWER_NAME, writeDefinition } from "./viewer-service-definition";
import { ViewerServiceRuntime } from "./viewer-service-runtime";

export interface ManagerStatus {
  loaded: boolean;
  enabled: boolean;
  state: "running" | "stopped" | "failed";
  pid?: number;
}

export async function runManager(runtime: ViewerServiceRuntime, args: string[]) {
  const waitsForShutdown = args[0] === "stop" || args[0] === "bootout" || args[0] === "restart" ||
    (args[0] === "disable" && args.includes("--now"));
  const result = await runtime.runner.run({ command: runtime.managerPath, args, cwd: "/", env: { LANG: "C", LC_ALL: "C" }, timeoutMs: waitsForShutdown ? 150_000 : 15_000 });
  if (result.code !== 0) throw commandError(args, result);

  return result;
}

function commandError(args: string[], result: CommandResult) {
  const diagnostic = (result.stderr.trim() || result.stdout.trim()).slice(0, 2048);
  return new Error(`Service manager ${args.join(" ")} failed with exit ${result.code}${diagnostic ? `: ${diagnostic}` : ""}`);
}

export function launchdTarget() {
  return `system/${LAUNCHD_VIEWER_LABEL}`;
}

export async function queryManager(runtime: ViewerServiceRuntime, definitionPath: string, hasDefinition: boolean): Promise<ManagerStatus> {
  if (runtime.platform === "linux") {
    const result = await runManager(runtime, ["show", "--all", "--no-pager", "--property=LoadState,ActiveState,UnitFileState,FragmentPath,DropInPaths,MainPID", SYSTEMD_VIEWER_NAME]);
    const fields = new Map(result.stdout.trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (!fields.has("LoadState") || !fields.has("ActiveState") || !fields.has("UnitFileState") || !fields.has("FragmentPath") || !fields.has("DropInPaths") || !fields.has("MainPID")) {
      throw new Error("Service manager returned malformed viewer status");
    }

    const loaded = fields.get("LoadState") !== "not-found";
    if (loaded && (!hasDefinition || fields.get("FragmentPath") !== definitionPath)) {
      throw new Error("Refusing a loaded viewer service with an unrelated definition");
    }
    if (fields.get("DropInPaths")) {
      throw new Error("Refusing a viewer service with unrelated systemd drop-in definitions");
    }
    const pid = parsePid(fields.get("MainPID"));
    return { loaded, enabled: fields.get("UnitFileState") === "enabled", state: fields.get("ActiveState") === "failed" ? "failed" : fields.get("ActiveState") === "active" && pid ? "running" : "stopped", pid };
  }

  const disabled = await runManager(runtime, ["print-disabled", "system"]);
  const enabled = parseLaunchdEnabled(disabled.stdout);
  const args = ["print", launchdTarget()];
  const result = await runtime.runner.run({ command: runtime.managerPath, args, cwd: "/", env: { LANG: "C", LC_ALL: "C" }, timeoutMs: 15_000 });
  if (result.code !== 0) {
    if (!/could not find service|service .*not found/i.test(result.stderr)) throw commandError(args, result);

    return { loaded: false, enabled: hasDefinition && enabled, state: "stopped" };
  }

  const servicePath = /^\s*path = (.+)$/m.exec(result.stdout)?.[1];
  if (!hasDefinition || servicePath !== definitionPath) throw new Error("Refusing a loaded viewer service with an unrelated definition");

  const pid = parsePid(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1]);
  const lastExit = /^\s*last exit code = (\d+)$/m.exec(result.stdout)?.[1];
  return { loaded: true, enabled, state: pid ? "running" : lastExit && lastExit !== "0" ? "failed" : "stopped", pid };
}

function parseLaunchdEnabled(output: string): boolean {
  const envelope = /^\s*disabled services = \{([\s\S]*?)\}\s*$/.exec(output);
  if (!envelope) {
    throw new Error("Service manager returned malformed disabled-services status");
  }

  const entries = new Map<string, boolean>();
  for (const line of envelope[1].split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const entry = /^\s*"([^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)\s*$/.exec(line);
    if (!entry || entries.has(entry[1])) {
      throw new Error("Service manager returned malformed disabled-services status");
    }

    entries.set(entry[1], entry[2] === "true" || entry[2] === "disabled");
  }

  return entries.get(LAUNCHD_VIEWER_LABEL) !== true;
}

function parsePid(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return undefined;

  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export async function rollbackService(runtime: ViewerServiceRuntime, definitionPath: string, previous: string | null, before: ManagerStatus, failure: unknown) {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };

  if (runtime.platform === "linux") {
    await attempt(() => runManager(runtime, ["stop", SYSTEMD_VIEWER_NAME]));
    if (!before.enabled) await attempt(() => runManager(runtime, ["disable", SYSTEMD_VIEWER_NAME]));
  } else {
    const current = await queryManager(runtime, definitionPath, true).catch(() => undefined);
    if (current?.loaded) await attempt(() => runManager(runtime, ["bootout", launchdTarget()]));
  }

  await attempt(() => previous === null ? rm(definitionPath, { force: true }) : writeDefinition(definitionPath, previous));
  if (runtime.platform === "linux") {
    await attempt(() => runManager(runtime, ["daemon-reload"]));
    if (before.enabled) await attempt(() => runManager(runtime, ["enable", SYSTEMD_VIEWER_NAME]));
    if (before.state === "running") await attempt(() => runManager(runtime, ["start", SYSTEMD_VIEWER_NAME]));
  } else {
    await attempt(() => runManager(runtime, [before.enabled ? "enable" : "disable", launchdTarget()]));
    if (before.loaded && previous !== null) await attempt(() => runManager(runtime, ["bootstrap", "system", definitionPath]));
  }

  if (errors.length) throw new AggregateError([failure, ...errors], "Viewer service operation failed and rollback was incomplete; inspect the service manager before retrying");
}
