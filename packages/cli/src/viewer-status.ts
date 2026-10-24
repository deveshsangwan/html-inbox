import { assertManagedLifecycle } from "./sync-lifecycle";
import { verifyViewerLocalOwner } from "./viewer-ownership";
import { DEFAULT_PORT } from "./backend";
import net from "node:net";
import { readInboxIdentity } from "./inbox-home";
import { ManagedStorageError } from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";
import { getViewerUrls, resolveViewerNetworkConfig, type ViewerExposure, type ViewerNetworkConfig, type ViewerNetworkOptions } from "./viewer-network";
import { getTailscaleStatus } from "./viewer-tailscale";
import { getInboxInstanceId, hasErrorCode, isValidPid, readSavedViewerConfiguration, readViewerRecord, type ViewerRecord, type ViewerRecordReadOptions } from "./viewer-records";

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
  options: ViewerRecordReadOptions = {},
): Promise<ViewerNetworkConfig> {
  await assertManagedLifecycle(home);
  const saved = await readSavedViewerConfiguration(home, options);
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
  options: { refreshLanUrls?: boolean; readOnly?: boolean; instanceId?: string; deadlineAt?: number; signal?: AbortSignal; probeMissingRecord?: boolean } = {},
): Promise<ViewerStatus> {
  const managed = await assertManagedLifecycle(home);
  if (options.instanceId !== undefined) {
    assertUuidV4(options.instanceId, "Expected inbox identity");
  }

  const config = await resolveViewerConfiguration(home, port, options);
  let record: ViewerRecord | null;
  let recordFailure: string | undefined;
  try {
    record = await readViewerRecord(home, options);
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
  const inspectedInstanceId = options.readOnly ? await readInboxIdentity(home) : undefined;
  if (options.readOnly && !inspectedInstanceId) {
    return { ...base, state: "conflict", reason: "Inbox identity is missing; viewer cannot be verified" };
  }

  if (options.readOnly && options.instanceId !== undefined && inspectedInstanceId !== options.instanceId.toLowerCase()) {
    return { ...base, state: "conflict", reason: "Inbox identity changed since selection" };
  }

  if (!selected) {
    if (managed && recordFailure) {
      return { ...base, state: "incompatible", reason: recordFailure };
    }

    return {
      ...base,
      state: recordFailure && (options.readOnly || recordFailure.startsWith("Older viewer process record:"))
        ? "incompatible"
        : options.probeMissingRecord === false ? "stopped" : await isPortListening(selectedConfig, options.deadlineAt, options.signal) ? "conflict" : "stopped",
      ...(recordFailure ? { reason: recordFailure } : {}),
    };
  }

  if (options.readOnly && selected.protocolVersion !== VIEWER_PROTOCOL_VERSION) {
    return { ...base, state: "incompatible", reason: "Viewer process record uses an incompatible protocol" };
  }

  if (managed && await verifyViewerLocalOwner(home, selected) === "dead") {
    return { ...base, state: "stopped", reason: "Recorded viewer owner is conclusively dead" };
  }

  const health = await getControlHealth(selected.controlUrl, options);
  if (health.state === "unavailable") {
    return { ...base, state: await isPortListening(selectedConfig, options.deadlineAt, options.signal) ? "conflict" : "stopped" };
  }

  if (health.state !== "ready") {
    return { ...base, state: health.state === "incompatible" ? "incompatible" : "conflict" };
  }

  const instanceId = options.readOnly ? inspectedInstanceId : await getInboxInstanceId(home);
  // Registered identities use canonical UUID spelling while legacy lifecycle records may use uppercase.
  const canonicalInstanceId = instanceId?.toLowerCase();
  if (health.instanceId.toLowerCase() !== canonicalInstanceId || selected.instanceId.toLowerCase() !== canonicalInstanceId) {
    return { ...base, state: "conflict", reason: "Viewer belongs to a different HTML_INBOX_HOME" };
  }

  const hasMatchingProcess = health.processId === selected.processId && health.pid === selected.pid &&
    selected.protocolVersion === VIEWER_PROTOCOL_VERSION;
  if (options.readOnly && !hasMatchingProcess) {
    return { ...base, state: "conflict", reason: "Viewer process record is missing or stale" };
  }

  if (selected.config.exposure === "tailscale") {
    const mapping = await getTailscaleStatus(home, { executable: process.env.HTML_INBOX_TAILSCALE_COMMAND, deadlineAt: options.deadlineAt, signal: options.signal }, options);
    if (mapping.state !== "running" || mapping.instanceId?.toLowerCase() !== canonicalInstanceId || mapping.processId !== selected.processId ||
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
  | { state: "ready"; instanceId: string; processId: string; pid: number; managedCompatible: boolean };

export async function getControlHealth(controlUrl: string, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<ControlHealth> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(1, Math.min(400, (options.deadlineAt ?? Infinity) - Date.now())));
  try {
    const response = await fetch(controlUrl, { signal: controller.signal, redirect: "error" });
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
    return { state: "ready", instanceId: value.instanceId, processId: value.processId, pid: value.pid,
      managedCompatible: isRecord(value.capabilities) && Array.isArray(value.capabilities.managedLedgerSchemas) &&
        value.capabilities.managedLedgerSchemas.includes(1) && value.capabilities.dynamicFormatSwitch === true };
  } catch (error) {
    return { state: error instanceof SyntaxError ? "invalid" : "unavailable" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function isPortListening(config: ViewerNetworkConfig, deadlineAt?: number, signal?: AbortSignal): Promise<boolean> {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: config.port, host });
    const finish = (isListening: boolean) => {
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(isListening);
    };

    const onAbort = () => finish(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.once("connect", () => finish(true));
    socket.once("error", (error: Error) => finish(!hasErrorCode(error, "ECONNREFUSED")));
    socket.setTimeout(Math.max(1, Math.min(400, (deadlineAt ?? Infinity) - Date.now())), () => finish(true));
  });
}
