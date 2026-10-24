import path from "node:path";
import { realpath } from "node:fs/promises";
import { openPrivateFile } from "./sync-files";
import { readBoundedFile } from "./bounded-file";
import { assertExactKeys, parseInteger, parseObject, parseReference, parseString, parseUuid } from "./sync-model";
import { validateSyncListenHost } from "./sync-http-server";
import type { SyncRoute } from "./sync-model";

export interface SyncTarget {
  peerId: string;
  destinationInboxId: string;
}

export interface SyncRuntimeConfig {
  schemaVersion: 1;
  intendedTarget: SyncTarget | null;
  listener: { host: string; port: number; tlsRef: string } | null;
  timings: { foregroundMs: number; requestMs: number; reconcileMs: number; passMs: number };
  credentials: Record<string, string>;
  trust: Record<string, string | null>;
  tls: Record<string, { key: string; cert: string }>;
}

export function parseSyncTarget(value: unknown): SyncTarget {
  const target = parseObject(value, "intended target");
  assertExactKeys(target, ["peerId", "destinationInboxId"]);
  return { peerId: parseUuid(target.peerId), destinationInboxId: parseUuid(target.destinationInboxId) };
}

export function parseRuntimeConfig(value: unknown): SyncRuntimeConfig {
  const config = parseObject(value, "runtime configuration");
  assertExactKeys(config, ["schemaVersion", "intendedTarget", "listener", "timings", "credentials", "trust", "tls"]);
  if (config.schemaVersion !== 1) {
    throw new Error("Unsupported runtime configuration schema");
  }

  const timings = parseObject(config.timings, "sync timings");
  assertExactKeys(timings, ["foregroundMs", "requestMs", "reconcileMs", "passMs"]);
  const listener = config.listener === null ? null : parseObject(config.listener, "ingestion listener");
  if (listener) {
    assertExactKeys(listener, ["host", "port", "tlsRef"]);
  }

  const credentials = parseReferences(config.credentials, parseCanonicalFilePath);
  const trust = parseReferences(config.trust, (entry) => entry === null ? null : parseCanonicalFilePath(entry));
  const tls = parseReferences(config.tls, (entry) => {
    const files = parseObject(entry, "TLS file references");
    assertExactKeys(files, ["key", "cert"]);
    return { key: parseCanonicalFilePath(files.key), cert: parseCanonicalFilePath(files.cert) };
  });
  const configuredListener = listener ? { host: validateSyncListenHost(parseString(listener.host)), port: parseInteger(listener.port, 1, 65535), tlsRef: parseReference(listener.tlsRef) } : null;
  if (configuredListener && !Object.hasOwn(tls, configuredListener.tlsRef)) {
    throw new Error("Listener TLS reference is not configured");
  }

  return { schemaVersion: 1, intendedTarget: config.intendedTarget === null ? null : parseSyncTarget(config.intendedTarget), listener: configuredListener,
    timings: { foregroundMs: parseInteger(timings.foregroundMs, 100, 300_000), requestMs: parseInteger(timings.requestMs, 100, 30_000),
      reconcileMs: parseInteger(timings.reconcileMs, 1_000, 300_000), passMs: parseInteger(timings.passMs, 100, 60_000) }, credentials, trust, tls };
}

export function defaultRuntimeConfig(): SyncRuntimeConfig {
  return { schemaVersion: 1, intendedTarget: null, listener: null,
    timings: { foregroundMs: 30_000, requestMs: 5_000, reconcileMs: 30_000, passMs: 60_000 }, credentials: {}, trust: {}, tls: {} };
}

export function parseCanonicalFilePath(value: unknown): string {
  const file = parseString(value, "canonical absolute file path");
  if (!path.isAbsolute(file) || path.resolve(file) !== file || file.includes("\0")) {
    throw new Error("Configuration references require canonical absolute file paths");
  }

  return file;
}

export async function readSyncJson(filePath: string): Promise<unknown> {
  return JSON.parse((await readRuntimeFile(filePath, 256 * 1024, true)).toString("utf8"));
}

export async function readRuntimeFile(filePath: string, maximumBytes: number, privatePermissions: boolean): Promise<Buffer> {
  parseCanonicalFilePath(filePath);
  if (await realpath(filePath) !== filePath) {
    throw new Error("Runtime file references cannot contain symbolic links");
  }

  const file = await openPrivateFile(filePath, maximumBytes);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > maximumBytes || process.getuid && info.uid !== process.getuid()) {
      throw new Error("Runtime bytes must come from a bounded regular owned handle");
    }

    if (privatePermissions && (info.mode & 0o077) !== 0) {
      throw new Error("Credentials, configuration and private keys must have private permissions");
    }

    return await readBoundedFile(file, maximumBytes, "Runtime file exceeds byte limit");
  } finally {
    await file.close();
  }
}

export async function resolveRuntimeCredentials(config: SyncRuntimeConfig, routes: SyncRoute[]) {
  const credentials = new Map<string, { token: string; ca?: Buffer }>();
  const unavailableRouteIds: string[] = [];
  for (const route of routes.filter((entry) => entry.state === "active" || entry.state === "reconnecting")) {
    try {
      const tokenPath = config.credentials[route.credentialRef];
      if (!tokenPath || !Object.hasOwn(config.trust, route.tlsTrustRef)) {
        throw new Error("Route credential or TLS trust reference is not configured");
      }

      const token = (await readRuntimeFile(tokenPath, 256, true)).toString("utf8").trim();
      const bytes = Buffer.from(token, "base64url");
      if (bytes.length < 32 || bytes.length > 96 || bytes.toString("base64url") !== token) {
        throw new Error("Sync credential is not a canonical high-entropy token");
      }

      const trustPath = config.trust[route.tlsTrustRef];
      const ca = trustPath === null ? undefined : await readRuntimeFile(trustPath, 128 * 1024, false);
      credentials.set(credentialBinding(route), { token, ...(ca ? { ca } : {}) });
    } catch {
      unavailableRouteIds.push(route.id);
    }
  }

  const resolve = (route: SyncRoute) => {
    const credential = credentials.get(credentialBinding(route));
    if (!credential) {
      throw new Error("No configured credential for this route");
    }

    return credential;
  };
  return Object.assign(resolve, { unavailableRouteIds });
}

function parseReferences<T>(value: unknown, parse: (entry: unknown) => T): Record<string, T> {
  const entries = Object.entries(parseObject(value, "runtime references"));
  if (entries.length > 128) {
    throw new Error("Runtime configuration has too many references");
  }

  return Object.fromEntries(entries.map(([key, entry]) => [parseReference(key), parse(entry)]));
}

function credentialBinding(route: SyncRoute): string {
  return JSON.stringify([route.id, route.revision, route.credentialRef, route.tlsTrustRef]);
}
