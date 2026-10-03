import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isRecord } from "./validation";

export type ViewerExposure = "loopback" | "lan" | "tailscale";

export interface ViewerNetworkOptions {
  port: number;
  exposure?: ViewerExposure;
  host?: string;
  tailscaleHostname?: string;
}

export interface ViewerNetworkConfig {
  port: number;
  exposure: ViewerExposure;
  host: string;
  tailscaleHostname?: string;
}

export function resolveViewerNetworkConfig(
  input: number | ViewerNetworkOptions,
): ViewerNetworkConfig {
  return parseViewerNetworkConfig(typeof input === "number" ? { port: input } : input);
}

export function parseViewerNetworkConfig(value: unknown): ViewerNetworkConfig {
  if (!isRecord(value)) {
    throw new Error("Viewer networking configuration must be an object");
  }

  if (
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 0 ||
    value.port > 65535
  ) {
    throw new Error("Viewer port must be an integer between 0 and 65535");
  }

  const exposure = value.exposure === undefined ? "loopback" : value.exposure;
  if (exposure !== "loopback" && exposure !== "lan" && exposure !== "tailscale") {
    throw new Error("Viewer exposure must be loopback, lan, or tailscale");
  }

  const defaultHost = exposure === "lan" ? "0.0.0.0" : "127.0.0.1";
  const host = normalizeIpAddress(value.host === undefined ? defaultHost : value.host);
  if (exposure !== "lan" && !isLoopbackAddress(host)) {
    throw new Error(`${exposure} viewer must bind a loopback IP address`);
  }

  if (exposure === "tailscale" && host !== "127.0.0.1") {
    throw new Error("tailscale viewer must bind 127.0.0.1 for its Serve proxy target");
  }

  if (value.tailscaleHostname !== undefined) {
    if (exposure !== "tailscale") {
      throw new Error("A Tailscale hostname requires tailscale exposure");
    }

    return {
      port: value.port,
      exposure,
      host,
      tailscaleHostname: normalizeTailscaleHostname(value.tailscaleHostname),
    };
  }

  return { port: value.port, exposure, host };
}

export function getViewerUrls(
  config: ViewerNetworkConfig,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  if (config.exposure === "tailscale") {
    if (!config.tailscaleHostname) {
      throw new Error("Resolve the Tailscale hostname before starting the viewer");
    }

    return [`https://${config.tailscaleHostname}`];
  }

  if (config.host !== "0.0.0.0" && config.host !== "::") {
    return [httpUrl(config.host, config.port)];
  }

  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => isUsableInterfaceAddress(address, config.host));
  const urls = [...new Set(addresses.map((address) => httpUrl(normalizeIpAddress(address), config.port)))];

  if (urls.length === 0) {
    throw new Error("No usable network interface addresses; choose an explicit viewer --host IP address");
  }

  return urls;
}

export function isAllowedViewerHost(
  hostHeader: string | undefined,
  config: ViewerNetworkConfig,
  urls: readonly string[],
): boolean {
  if (!hostHeader) {
    return false;
  }

  const allowedHosts = new Set(urls.map((url) => {
    const parsed = new URL(url);
    return parsed.protocol === "http:" ? `${parsed.hostname}:${config.port}` : parsed.host;
  }));
  const localHosts = config.host === "0.0.0.0"
    ? ["127.0.0.1", "localhost"]
    : config.host === "::"
      ? ["127.0.0.1", "::1", "localhost"]
      : [config.host, ...(isLoopbackAddress(config.host) ? ["localhost"] : [])];

  for (const host of localHosts) {
    allowedHosts.add(httpUrl(host, config.port).slice("http://".length));
  }

  if (config.port === 80) {
    for (const host of [...allowedHosts]) {
      if (host.endsWith(":80")) {
        allowedHosts.add(host.slice(0, -3));
      }
    }
  }

  if (config.exposure === "tailscale" && config.tailscaleHostname) {
    allowedHosts.add(config.tailscaleHostname);
    allowedHosts.add(`${config.tailscaleHostname}:443`);
  }

  return allowedHosts.has(hostHeader.toLowerCase());
}

function normalizeIpAddress(value: unknown): string {
  if (typeof value !== "string" || isIP(value) === 0 || value.includes("%")) {
    throw new Error("Viewer host must be an IPv4 or IPv6 address without a scope identifier");
  }

  const hostname = new URL(httpUrl(value, 80)).hostname;
  return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackAddress(host: string): boolean {
  return host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

function normalizeTailscaleHostname(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Tailscale hostname must be a DNS name under ts.net");
  }

  const hostname = value.toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 4 ||
    !hostname.endsWith(".ts.net") ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Tailscale hostname must be a DNS name under ts.net");
  }

  return hostname;
}

function isUsableInterfaceAddress(address: string, bindHost: string): boolean {
  const family = isIP(address);
  if (family === 0 || address.includes("%")) {
    return false;
  }

  const normalized = normalizeIpAddress(address);
  if (isLoopbackAddress(normalized)) {
    return false;
  }

  if (family === 4) {
    const firstOctet = Number(address.split(".")[0]);
    return firstOctet > 0 && firstOctet < 224;
  }

  return bindHost === "::" && normalized !== "::" && !/^(?:fe[89ab]|ff|::ffff:)/.test(normalized);
}

function httpUrl(host: string, port: number): string {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}
