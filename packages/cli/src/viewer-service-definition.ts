import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./validation";
import { readBoundedFile } from "./bounded-file";

export const SYSTEMD_VIEWER_NAME = "html-inbox-viewer.service";
export const LAUNCHD_VIEWER_LABEL = "com.html-inbox.viewer";
const DEFINITION_MARKER = "html-inbox-viewer-v1:";
const MAX_DEFINITION_BYTES = 64 * 1024;

export interface ViewerServiceDefinition {
  platform: "linux" | "darwin";
  home: string;
  port: number;
  exposure: "loopback" | "lan" | "tailscale";
  host?: string;
  user: { name: string; uid: number; gid: number; home: string };
  nodePath: string;
  cliPath: string;
  environment: Record<string, string>;
}

export function renderViewerServiceDefinition(definition: ViewerServiceDefinition): string {
  const metadata = Buffer.from(JSON.stringify(definition)).toString("base64url");
  const args = [definition.nodePath, definition.cliPath, "viewer", "--foreground", "--port", String(definition.port)];
  args.push(`--${definition.exposure}`);
  if (definition.host) args.push("--host", definition.host);

  const environment = Object.entries(definition.environment).sort(([left], [right]) => left.localeCompare(right));
  if (definition.platform === "linux") {
    return validateDefinitionSize([
      `# ${DEFINITION_MARKER}${metadata}`,
      "[Unit]",
      "Description=HTML Inbox viewer",
      "Wants=network-online.target",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=exec",
      `User=${definition.user.name}`,
      `Group=${definition.user.gid}`,
      "WorkingDirectory=~",
      ...environment.map(([key, value]) => `Environment=${quoteSystemdValue(`${key}=${value}`)}`),
      `ExecStart=${args.map((value) => quoteSystemdValue(value, true)).join(" ")}`,
      "Restart=on-failure",
      "RestartSec=5",
      "TimeoutStopSec=120",
      "UMask=0077",
      "StandardOutput=journal",
      "StandardError=journal",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n"));
  }

  return validateDefinitionSize([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0"><!-- ${DEFINITION_MARKER}${metadata} -->`,
    "<dict>",
    `<key>Label</key><string>${LAUNCHD_VIEWER_LABEL}</string>`,
    `<key>UserName</key><string>${escapeXml(definition.user.name)}</string>`,
    `<key>WorkingDirectory</key><string>${escapeXml(definition.user.home)}</string>`,
    "<key>ProgramArguments</key><array>",
    ...args.map((value) => `<string>${escapeXml(value)}</string>`),
    "</array>",
    "<key>EnvironmentVariables</key><dict>",
    ...environment.map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`),
    "</dict>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ThrottleInterval</key><integer>5</integer>",
    "<key>ExitTimeOut</key><integer>120</integer>",
    "<key>Umask</key><integer>63</integer>",
    "</dict></plist>",
    "",
  ].join("\n"));
}

function validateDefinitionSize(contents: string): string {
  if (Buffer.byteLength(contents, "utf8") > MAX_DEFINITION_BYTES) {
    throw new Error("Viewer service definition exceeds 64 KiB; reduce the preserved environment values before installing");
  }

  return contents;
}

export function parseViewerServiceDefinition(contents: string): ViewerServiceDefinition {
  const encoded = new RegExp(`${DEFINITION_MARKER}([A-Za-z0-9_-]+)`).exec(contents)?.[1];
  if (!encoded) throw new Error("Refusing an unrelated viewer service definition");

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Refusing a malformed viewer service definition");
  }

  if (
    !isRecord(value) ||
    (value.platform !== "linux" && value.platform !== "darwin") ||
    !isAbsoluteValue(value.home) ||
    !isPort(value.port) ||
    (value.exposure !== "loopback" && value.exposure !== "lan" && value.exposure !== "tailscale") ||
    (value.host !== undefined && !isTextValue(value.host)) ||
    !isRecord(value.user) ||
    typeof value.user.name !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(value.user.name) ||
    !Number.isSafeInteger(value.user.uid) || typeof value.user.uid !== "number" || value.user.uid <= 0 ||
    !Number.isSafeInteger(value.user.gid) || typeof value.user.gid !== "number" || value.user.gid < 0 ||
    !isAbsoluteValue(value.user.home) ||
    !isAbsoluteValue(value.nodePath) ||
    !isAbsoluteValue(value.cliPath) ||
    !isRecord(value.environment)
  ) {
    throw new Error("Refusing a malformed viewer service definition");
  }

  const environment: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || !isTextValue(item)) {
      throw new Error("Refusing a malformed viewer service environment");
    }
    environment[key] = item;
  }

  const definition: ViewerServiceDefinition = {
    platform: value.platform,
    home: value.home,
    port: value.port,
    exposure: value.exposure,
    host: value.host,
    user: { name: value.user.name, uid: value.user.uid, gid: value.user.gid, home: value.user.home },
    nodePath: value.nodePath,
    cliPath: value.cliPath,
    environment,
  };
  if (renderViewerServiceDefinition(definition) !== contents) {
    throw new Error("Refusing a modified viewer service definition");
  }

  return definition;
}

function quoteSystemdValue(value: string, isCommand = false) {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${isCommand ? escaped.replaceAll("$", "$$") : escaped}"`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function isTextValue(value: unknown): value is string {
  return typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value);
}

function isAbsoluteValue(value: unknown): value is string {
  return isTextValue(value) && path.isAbsolute(value);
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export async function readOwnedDefinition(definitionPath: string, home: string, platform: "linux" | "darwin") {
  try {
    const file = await open(definitionPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let contents: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_DEFINITION_BYTES || (info.mode & 0o022) !== 0) {
        throw new Error("Refusing an unsafe or unrelated viewer service definition");
      }

      contents = (await readBoundedFile(file, MAX_DEFINITION_BYTES, "Viewer service definition is too large")).toString("utf8");
    } finally {
      await file.close();
    }

    const definition = parseViewerServiceDefinition(contents);
    if (definition.home !== path.resolve(home) || definition.platform !== platform) {
      throw new Error("Refusing a viewer service configured for a different inbox or platform");
    }

    return { contents, definition };
  } catch (error) {
    if (isFileMissing(error)) return null;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error("Refusing an unsafe or unrelated viewer service definition", { cause: error });
    }

    throw error;
  }
}

export async function writeDefinition(definitionPath: string, contents: string) {
  validateDefinitionSize(contents);

  const temporaryPath = `${definitionPath}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o644);
  try {
    await file.writeFile(contents);
    await file.chmod(0o644);
    await file.close();
    await rename(temporaryPath, definitionPath);
  } finally {
    await file.close();
    await rm(temporaryPath, { force: true });
  }
}

function isFileMissing(error: unknown) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
