import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./validation";

interface TcpHandler {
  HTTPS?: boolean;
  HTTP?: boolean;
  TCPForward?: string;
  TerminateTLS?: string;
  ProxyProtocol?: number;
}

interface HttpHandler {
  Proxy?: string;
  Path?: string;
  Text?: string;
  Redirect?: string;
  AcceptAppCaps?: string[];
}

interface WebServer {
  Handlers: Record<string, HttpHandler>;
}

interface ServiceConfig {
  TCP?: Record<string, TcpHandler> | null;
  Web?: Record<string, WebServer> | null;
  Tun?: boolean;
}

export interface ServeConfig extends ServiceConfig {
  AllowFunnel?: Record<string, boolean> | null;
  Foreground?: Record<string, ServeConfig> | null;
  Services?: Record<string, ServiceConfig> | null;
}

export interface TailscaleNode {
  nodeId: string;
  hostname: string;
}

export function parseTailscaleNode(
  text: string,
  requireServe = true,
): TailscaleNode {
  const value: unknown = parseJson(text, "status");
  if (!isRecord(value) || typeof value.BackendState !== "string") {
    throw new Error(
      "Tailscale status has no valid BackendState; inspect tailscale status --json",
    );
  }

  if (value.BackendState !== "Running") {
    throw new Error(
      `Tailscale is ${value.BackendState}; connect the existing signed-in client before starting the viewer`,
    );
  }

  if (
    !isRecord(value.Self) ||
    typeof value.Self.ID !== "string" ||
    !value.Self.ID ||
    typeof value.Self.DNSName !== "string"
  ) {
    throw new Error(
      "Tailscale status has no valid connected node identity; inspect tailscale status --json",
    );
  }

  if (value.Self.Online !== true || value.Self.Expired === true) {
    throw new Error(
      "Tailscale node is offline or expired; reconnect the existing client before starting the viewer",
    );
  }

  if (
    !isRecord(value.CurrentTailnet) ||
    (requireServe && value.CurrentTailnet.MagicDNSEnabled !== true) ||
    typeof value.CurrentTailnet.MagicDNSSuffix !== "string"
  ) {
    throw new Error(
      "Tailscale Serve requires MagicDNS; ask the tailnet administrator to enable it",
    );
  }

  const hostname = value.Self.DNSName.replace(/\.$/, "").toLowerCase();
  const suffix = value.CurrentTailnet.MagicDNSSuffix.toLowerCase();
  assertTailnetHostname(hostname);
  if (
    !hostname.endsWith(`.${suffix}`) ||
    hostname.slice(0, -(suffix.length + 1)).includes(".")
  ) {
    throw new Error(
      "Tailscale node hostname does not match the connected tailnet MagicDNS suffix",
    );
  }

  if (
    requireServe &&
    (!Array.isArray(value.CertDomains) ||
      !value.CertDomains.some((domain: unknown) => domain === hostname))
  ) {
    throw new Error(
      "Tailscale HTTPS certificates are unavailable for this node; ask the tailnet administrator to enable HTTPS before retrying",
    );
  }

  if (
    requireServe &&
    (!isRecord(value.Self.CapMap) || !Object.hasOwn(value.Self.CapMap, "https"))
  ) {
    throw new Error(
      "Tailscale node has no enabled HTTPS capability; ask the tailnet administrator to enable HTTPS. HTML Inbox will not start the CLI's consent flow.",
    );
  }

  return { nodeId: value.Self.ID, hostname };
}

export function assertTailnetHostname(hostname: string): void {
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 4 ||
    !hostname.endsWith(".ts.net") ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error(
      "Tailscale hostname must be an explicit device hostname in the connected ts.net tailnet",
    );
  }
}

export function parseServeConfig(text: string): ServeConfig {
  const value: unknown = parseJson(text, "Serve configuration");
  if (value === null) {
    return {};
  }

  assertServeConfig(value);
  return value;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Tailscale ${label} is malformed JSON; inspect the installed client's JSON output before retrying`,
    );
  }
}

function assertKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(
      `Tailscale ${label} contains an unsupported field; its routing contract cannot be verified`,
    );
  }
}

function assertMap(
  value: unknown,
  check: (entry: unknown, key: string) => void,
): void {
  if (value === undefined || value === null) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error("Tailscale Serve configuration contains an invalid map");
  }

  for (const [key, entry] of Object.entries(value)) {
    check(entry, key);
  }
}

function assertPort(key: string): void {
  if (!/^[1-9][0-9]{0,4}$/.test(key) || Number(key) > 65535) {
    throw new Error("Tailscale Serve configuration contains an invalid port");
  }
}

function assertHostPort(key: string): void {
  const parts = key.split(":");
  if (parts.length !== 2 || !parts[0]) {
    throw new Error(
      "Tailscale Serve configuration contains an invalid host:port",
    );
  }

  assertPort(parts[1]);
}

function assertTcpHandler(value: unknown, key: string): void {
  assertPort(key);
  if (!isRecord(value)) {
    throw new Error(
      "Tailscale Serve configuration contains an invalid TCP handler",
    );
  }

  assertKeys(
    value,
    ["HTTPS", "HTTP", "TCPForward", "TerminateTLS", "ProxyProtocol"],
    "TCP handler",
  );
  for (const property of ["HTTPS", "HTTP"]) {
    if (value[property] !== undefined && typeof value[property] !== "boolean") {
      throw new Error(
        "Tailscale Serve configuration contains an invalid TCP protocol",
      );
    }
  }

  for (const property of ["TCPForward", "TerminateTLS"]) {
    if (value[property] !== undefined && typeof value[property] !== "string") {
      throw new Error(
        "Tailscale Serve configuration contains an invalid TCP target",
      );
    }
  }

  if (
    value.ProxyProtocol !== undefined &&
    value.ProxyProtocol !== 0 &&
    value.ProxyProtocol !== 1 &&
    value.ProxyProtocol !== 2
  ) {
    throw new Error(
      "Tailscale Serve configuration contains an invalid proxy protocol",
    );
  }
}

function assertWebServer(value: unknown, key: string): void {
  assertHostPort(key);
  if (!isRecord(value) || !isRecord(value.Handlers)) {
    throw new Error(
      "Tailscale Serve configuration contains an invalid Web handler map",
    );
  }

  assertKeys(value, ["Handlers"], "Web server");
  assertMap(value.Handlers, (handler, mount) => {
    if (!mount.startsWith("/") || !isRecord(handler)) {
      throw new Error(
        "Tailscale Serve configuration contains an invalid HTTP handler",
      );
    }

    assertKeys(
      handler,
      ["Proxy", "Path", "Text", "Redirect", "AcceptAppCaps"],
      "HTTP handler",
    );
    for (const property of ["Proxy", "Path", "Text", "Redirect"]) {
      if (
        handler[property] !== undefined &&
        typeof handler[property] !== "string"
      ) {
        throw new Error(
          "Tailscale Serve configuration contains an invalid HTTP target",
        );
      }
    }

    if (
      handler.AcceptAppCaps !== undefined &&
      (!Array.isArray(handler.AcceptAppCaps) ||
        handler.AcceptAppCaps.some(
          (entry: unknown) => typeof entry !== "string",
        ))
    ) {
      throw new Error(
        "Tailscale Serve configuration contains invalid app capabilities",
      );
    }
  });
}

function assertServiceConfig(value: unknown): asserts value is ServiceConfig {
  if (!isRecord(value)) {
    throw new Error(
      "Tailscale Serve configuration contains an invalid service",
    );
  }

  assertKeys(value, ["TCP", "Web", "Tun"], "service");
  assertMap(value.TCP, assertTcpHandler);
  assertMap(value.Web, assertWebServer);
  if (value.Tun !== undefined && typeof value.Tun !== "boolean") {
    throw new Error(
      "Tailscale Serve configuration contains an invalid TUN setting",
    );
  }
}

function assertServeConfig(
  value: unknown,
  depth = 0,
): asserts value is ServeConfig {
  if (!isRecord(value) || depth > 1) {
    throw new Error(
      "Tailscale Serve configuration contains an invalid foreground configuration",
    );
  }

  assertKeys(
    value,
    ["TCP", "Web", "AllowFunnel", "Foreground", "Services"],
    "configuration",
  );
  assertMap(value.TCP, assertTcpHandler);
  assertMap(value.Web, assertWebServer);
  assertMap(value.Services, assertServiceConfig);
  assertMap(value.AllowFunnel, (entry, key) => {
    assertHostPort(key);
    if (typeof entry !== "boolean") {
      throw new Error(
        "Tailscale Serve configuration contains an invalid Funnel setting",
      );
    }
  });
  assertMap(value.Foreground, (entry) => assertServeConfig(entry, depth + 1));
}

export function getRoute(config: ServeConfig, hostname: string) {
  return config.Web?.[`${hostname}:443`]?.Handlers["/"];
}

export function routeMatches(
  config: ServeConfig,
  hostname: string,
  proxy: string,
): boolean {
  return isDeepStrictEqual(getRoute(config, hostname), { Proxy: proxy });
}

export function assertSafeListener(
  config: ServeConfig,
  hostname: string,
): void {
  const hostPort = `${hostname}:443`;
  if (
    Object.keys(config.AllowFunnel ?? {}).some((key) => key.endsWith(":443"))
  ) {
    throw new Error(
      "Tailscale HTTPS port 443 has existing Funnel configuration; choose another setup manually before starting HTML Inbox",
    );
  }

  for (const foreground of Object.values(config.Foreground ?? {})) {
    if (
      foreground.TCP?.["443"] ||
      Object.keys(foreground.Web ?? {}).some((key) => key.endsWith(":443")) ||
      Object.keys(foreground.AllowFunnel ?? {}).some((key) =>
        key.endsWith(":443"),
      )
    ) {
      throw new Error(
        "Tailscale HTTPS port 443 conflicts with an existing foreground Serve/Funnel session",
      );
    }
  }

  if (
    Object.keys(config.Web ?? {}).some(
      (key) => key.endsWith(":443") && key !== hostPort,
    )
  ) {
    throw new Error(
      "Tailscale HTTPS port 443 is shared by another hostname; HTML Inbox cannot safely own its root route",
    );
  }

  const listener = config.TCP?.["443"];
  if (listener && !isDeepStrictEqual(listener, { HTTPS: true })) {
    throw new Error(
      "Tailscale port 443 already has a conflicting TCP/HTTP listener",
    );
  }

  if (
    listener &&
    Object.keys(config.Web?.[hostPort]?.Handlers ?? {}).length === 0
  ) {
    throw new Error(
      "Tailscale HTTPS port 443 has an existing listener without routes; HTML Inbox will preserve it",
    );
  }
}

export function unrelatedConfig(
  config: ServeConfig,
  hostname: string,
): ServeConfig {
  const result = structuredClone(config);
  const hostPort = `${hostname}:443`;
  const web = result.Web?.[hostPort];
  if (web) {
    delete web.Handlers["/"];
    if (Object.keys(web.Handlers).length === 0) {
      delete result.Web?.[hostPort];
      delete result.TCP?.["443"];
    }
  }

  // Go's omitempty removes empty maps when the CLI serializes its new configuration.
  for (const property of [
    "TCP",
    "Web",
    "AllowFunnel",
    "Foreground",
    "Services",
  ] as const) {
    if (
      result[property] == null ||
      Object.keys(result[property]).length === 0
    ) {
      delete result[property];
    }
  }

  return result;
}
