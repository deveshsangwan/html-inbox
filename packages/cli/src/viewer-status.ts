import { DEFAULT_PORT } from "./backend";
import net from "node:net";
import { ManagedStorageError } from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";
import { getViewerUrls, resolveViewerNetworkConfig, type ViewerExposure, type ViewerNetworkConfig, type ViewerNetworkOptions } from "./viewer-network";
import { getTailscaleStatus } from "./viewer-tailscale";
import { getInboxInstanceId, hasErrorCode, isValidPid, readSavedViewerConfiguration, readViewerRecord, type ViewerRecord } from "./viewer-records";

export const VIEWER_PROTOCOL_VERSION = 3;

export interface ViewerStatus {
  state: "running" | "stopped" | "conflict" | "incompatible";
  url: string;
  urls: string[];
  exposure: ViewerExposure;
  port: number;
  pid?: number;
  reason?: string;
}

export async function resolveViewerConfiguration(
  home: string,
  input?: number | ViewerNetworkOptions,
): Promise<ViewerNetworkConfig> {
  const saved = await readSavedViewerConfiguration(home);
  if (input === undefined) {
    return saved?.config ?? resolveViewerNetworkConfig(DEFAULT_PORT);
  }

  if (typeof input === "number") {
    return resolveViewerNetworkConfig({ ...(saved?.config ?? {}), port: input });
  }

  const exposure = input.exposure ?? saved?.config.exposure ?? "loopback";
  const usesSavedExposure = exposure === saved?.config.exposure;
  return resolveViewerNetworkConfig({
    ...input,
    exposure,
    host: input.host ?? (usesSavedExposure ? saved?.config.host : undefined),
    tailscaleHostname: exposure === "tailscale"
      ? input.tailscaleHostname ?? saved?.config.tailscaleHostname
      : undefined,
  });
}

export async function getViewerStatus(
  home: string,
  port?: number,
  options: { refreshLanUrls?: boolean } = {},
): Promise<ViewerStatus> {
  const config = await resolveViewerConfiguration(home, port);
  let record: ViewerRecord | null;
  let recordFailure: string | undefined;
  try {
    record = await readViewerRecord(home);
  } catch (error) {
    if (error instanceof ManagedStorageError) {
      throw error;
    }

    record = null;
    recordFailure = error instanceof Error ? error.message : String(error);
  }

  const selected = record && (port === undefined || record.config.port === port) ? record : null;
  const selectedConfig = selected?.config ?? config;
  const hasWildcardLanBind = selectedConfig.exposure === "lan" &&
    (selectedConfig.host === "0.0.0.0" || selectedConfig.host === "::");
  const metadataConfig = options.refreshLanUrls === false && hasWildcardLanBind
    ? { ...selectedConfig, host: selectedConfig.host === "::" ? "::1" : "127.0.0.1" }
    : selectedConfig;
  const urls = options.refreshLanUrls !== false && hasWildcardLanBind
    ? getViewerUrls(selectedConfig)
    : selected?.urls ?? getViewerUrls(metadataConfig);
  const base = { url: urls[0], urls, exposure: selectedConfig.exposure, port: selectedConfig.port };
  if (!selected) {
    return {
      ...base,
      state: recordFailure?.startsWith("Older viewer process record:")
        ? "incompatible"
        : await isPortListening(selectedConfig) ? "conflict" : "stopped",
      ...(recordFailure ? { reason: recordFailure } : {}),
    };
  }

  const health = await getControlHealth(selected.controlUrl);
  if (health.state === "unavailable") {
    return { ...base, state: await isPortListening(selectedConfig) ? "conflict" : "stopped" };
  }

  if (health.state !== "ready") {
    return { ...base, state: health.state === "incompatible" ? "incompatible" : "conflict" };
  }

  const instanceId = await getInboxInstanceId(home);
  if (health.instanceId !== instanceId || selected.instanceId !== instanceId) {
    return { ...base, state: "conflict", reason: "Viewer belongs to a different HTML_INBOX_HOME" };
  }

  const hasMatchingProcess = health.processId === selected.processId && health.pid === selected.pid &&
    selected.protocolVersion === VIEWER_PROTOCOL_VERSION;
  if (selected.config.exposure === "tailscale") {
    const mapping = await getTailscaleStatus(home, { executable: process.env.HTML_INBOX_TAILSCALE_COMMAND });
    if (mapping.state !== "running" || mapping.instanceId !== instanceId || mapping.processId !== selected.processId ||
        mapping.backendPort !== selected.config.port || mapping.url !== base.url) {
      return {
        ...base,
        state: "conflict",
        ...(hasMatchingProcess ? { pid: selected.pid } : {}),
        reason: `Tailscale exposure ${mapping.state}: ${mapping.reason ?? "route ownership does not match this viewer"}`,
      };
    }
  }

  return {
    ...base,
    state: "running",
    ...(hasMatchingProcess ? { pid: selected.pid } : { reason: "Viewer process record is missing or stale" }),
  };
}

type ControlHealth =
  | { state: "unavailable" | "invalid" | "incompatible" }
  | { state: "ready"; instanceId: string; processId: string; pid: number };

export async function getControlHealth(controlUrl: string): Promise<ControlHealth> {
  try {
    const response = await fetch(controlUrl, { signal: AbortSignal.timeout(400), redirect: "error" });
    if (!response.ok) {
      return { state: "invalid" };
    }

    const value: unknown = await response.json();
    if (!isRecord(value) || value.ok !== true || typeof value.instanceId !== "string" ||
        typeof value.protocolVersion !== "number" || !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) {
      return { state: "invalid" };
    }

    assertUuidV4(value.instanceId, "Viewer inbox identity");
    if (value.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
      return { state: "incompatible" };
    }

    if (typeof value.processId !== "string" || !isValidPid(value.pid)) {
      return { state: "invalid" };
    }

    assertUuidV4(value.processId, "Viewer process identity");
    return { state: "ready", instanceId: value.instanceId, processId: value.processId, pid: value.pid };
  } catch (error) {
    return { state: error instanceof SyntaxError ? "invalid" : "unavailable" };
  }
}

export async function isPortListening(config: ViewerNetworkConfig): Promise<boolean> {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: config.port, host });
    const finish = (isListening: boolean) => {
      socket.destroy();
      resolve(isListening);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", (error: Error) => finish(!hasErrorCode(error, "ECONNREFUSED")));
    socket.setTimeout(400, () => finish(true));
  });
}
