import path from "node:path";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  LAUNCHD_VIEWER_LABEL,
  SYSTEMD_VIEWER_NAME,
  readOwnedDefinition,
  renderViewerServiceDefinition,
  writeDefinition,
  ViewerServiceDefinition,
} from "./viewer-service-definition";
import { launchdTarget, ManagerStatus, queryManager, rollbackService, runManager } from "./viewer-service-manager";
import {
  assertAdministrator,
  defaultRuntime,
  prepareDefinition,
  prepareViewerServiceInbox,
  selectUser,
  supportedPlatform,
  ViewerServiceOptions,
  ViewerServiceRuntime,
} from "./viewer-service-runtime";

export type { ViewerServiceOptions, ViewerServiceRuntime, ViewerServiceUser } from "./viewer-service-runtime";

export interface ViewerServiceStatus {
  state: "not-installed" | "running" | "stopped" | "failed";
  enabled: boolean;
  definitionPath: string;
  user?: string;
  pid?: number;
}

export async function resolveViewerServiceHome(
  options: { home?: string; user?: string },
  runtime: ViewerServiceRuntime = defaultRuntime(),
): Promise<string> {
  supportedPlatform(runtime);
  const user = await selectUser(options.user, runtime);
  return path.resolve(options.home ?? path.join(user.home, ".html-inbox"));
}

export async function installViewerService(
  options: ViewerServiceOptions,
  runtime: ViewerServiceRuntime = defaultRuntime(),
): Promise<ViewerServiceStatus> {
  assertAdministrator(runtime);

  const platform = supportedPlatform(runtime);
  const definition = await prepareDefinition(options, runtime, platform);
  const contents = renderViewerServiceDefinition(definition);
  const definitionPath = getDefinitionPath(runtime);
  const previous = await readOwnedDefinition(definitionPath, options.home, platform);
  const before = await queryManager(runtime, definitionPath, previous !== null);
  await prepareViewerServiceInbox(definition, runtime);

  try {
    if (previous?.contents !== contents) {
      if (before.loaded && platform === "darwin") await runManager(runtime, ["bootout", launchdTarget()]);

      await writeDefinition(definitionPath, contents);
      if (platform === "linux") await runManager(runtime, ["daemon-reload"]);
    }

    if (platform === "linux") {
      await runManager(runtime, ["enable", SYSTEMD_VIEWER_NAME]);
      await runManager(runtime, [previous?.contents !== contents && before.loaded ? "restart" : "start", SYSTEMD_VIEWER_NAME]);
    } else {
      await runManager(runtime, ["enable", launchdTarget()]);
      if (!before.loaded || previous?.contents !== contents) await runManager(runtime, ["bootstrap", "system", definitionPath]);
      else if (before.state !== "running") await runManager(runtime, ["kickstart", launchdTarget()]);
    }

    return await waitForService(definition, runtime, definitionPath);
  } catch (error) {
    await rollbackService(runtime, definitionPath, previous?.contents ?? null, before, error);
    throw error;
  }
}

export async function uninstallViewerService(
  options: Pick<ViewerServiceOptions, "home">,
  runtime: ViewerServiceRuntime = defaultRuntime(),
): Promise<ViewerServiceStatus> {
  assertAdministrator(runtime);

  const definitionPath = getDefinitionPath(runtime);
  const previous = await readOwnedDefinition(definitionPath, options.home, supportedPlatform(runtime));
  const before = await queryManager(runtime, definitionPath, previous !== null);
  if (!previous) return { state: "not-installed", enabled: false, definitionPath };

  try {
    if (runtime.platform === "linux") {
      await runManager(runtime, ["disable", "--now", SYSTEMD_VIEWER_NAME]);
    } else {
      if (before.loaded) await runManager(runtime, ["bootout", launchdTarget()]);
      await runManager(runtime, ["disable", launchdTarget()]);
    }

    await rm(definitionPath);
    if (runtime.platform === "linux") await runManager(runtime, ["daemon-reload"]);

    const after = await queryManager(runtime, definitionPath, false);
    if (after.loaded || after.enabled || after.state === "running") {
      throw new Error("Viewer service is still registered after removal");
    }

    return { state: "not-installed", enabled: false, definitionPath };
  } catch (error) {
    await rollbackService(runtime, definitionPath, previous.contents, before, error);
    throw error;
  }
}

export async function getViewerServiceStatus(
  options: Pick<ViewerServiceOptions, "home">,
  runtime: ViewerServiceRuntime = defaultRuntime(),
): Promise<ViewerServiceStatus> {
  const definitionPath = getDefinitionPath(runtime);
  const saved = await readOwnedDefinition(definitionPath, options.home, supportedPlatform(runtime));
  const manager = await queryManager(runtime, definitionPath, saved !== null);
  if (!saved) return { state: "not-installed", enabled: false, definitionPath };

  return describeService(saved.definition, manager, runtime, definitionPath);
}

function getDefinitionPath(runtime: ViewerServiceRuntime) {
  const platform = supportedPlatform(runtime);
  if (!path.isAbsolute(runtime.serviceDirectory)) throw new Error("Service definition directory must be absolute");

  return path.join(runtime.serviceDirectory, platform === "linux" ? SYSTEMD_VIEWER_NAME : `${LAUNCHD_VIEWER_LABEL}.plist`);
}

async function describeService(definition: ViewerServiceDefinition, manager: ManagerStatus, runtime: ViewerServiceRuntime, definitionPath: string): Promise<ViewerServiceStatus> {
  const viewer = manager.state === "running" ? await runtime.getViewerStatus(definition) : undefined;
  const state = manager.state === "running" && (viewer?.state !== "running" || viewer.pid !== manager.pid) ? "failed" : manager.state;
  return { state, enabled: manager.enabled, definitionPath, user: definition.user.name, pid: manager.pid };
}

async function waitForService(definition: ViewerServiceDefinition, runtime: ViewerServiceRuntime, definitionPath: string) {
  const timeoutMs = runtime.readinessTimeoutMs ?? (definition.exposure === "tailscale" ? 45_000 : 10_000);
  const deadline = Date.now() + timeoutMs;
  do {
    const manager = await queryManager(runtime, definitionPath, true);
    const status = await describeService(definition, manager, runtime, definitionPath);
    if (status.state === "running" && status.enabled) return status;
    if (manager.state === "failed") break;

    await delay(100);
  } while (Date.now() < deadline);

  const diagnostics = definition.platform === "linux"
    ? `journalctl --unit=${SYSTEMD_VIEWER_NAME}`
    : path.join(definition.home, "viewer.log");
  throw new Error(`Viewer boot service did not become healthy; inspect ${diagnostics}`);
}
