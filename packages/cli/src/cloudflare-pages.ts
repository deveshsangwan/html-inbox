import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDirectory,
  writePrivateFile,
} from "./private-storage";
import type { StaticSecurityHeaders } from "./static-export";

export const PINNED_WRANGLER_VERSION = "4.86.0";
export const CLOUDFLARE_UPLOAD_FILE_LIMIT = 20_000;
export const CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;
export const CLOUDFLARE_HEADER_RULE_LIMIT = 100;
export const CLOUDFLARE_HEADER_LINE_LIMIT = 2_000;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface CloudflareProjectRef {
  accountId: string;
  projectName: string;
}

export interface CloudflareSnapshotRef {
  outputDir: string;
  capability: string;
  inboxPath: string;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface CommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  output: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}

export interface CloudflareDeployReceipt {
  target: CloudflareProjectRef;
  branch: string;
  deploymentUrl: string;
  projectUrl: string;
  deploymentInboxUrl: string;
  projectInboxUrl: string;
}

export class NodeCommandRunner implements CommandRunner {
  async run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failure: Error | null = null;
      let output = "";
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        action();
      };
      const fail = (error: Error) => {
        if (failure || settled) return;
        failure = error;
        terminateProcessTree(child);
        forceTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2_000);
        forceTimer.unref();
      };
      const record = (chunk: Buffer) => {
        if (failure) return;
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          fail(new Error("Wrangler produced more than 1 MiB of output and was stopped"));
        }
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      child.once("error", (error) => fail(new Error(`Wrangler could not start: ${error.message}`)));
      child.once("close", (code, signal) =>
        finish(() =>
          failure ? reject(failure) : resolve({ code: code ?? 1, signal, output }),
        ),
      );
      const timer = setTimeout(
        () => fail(new Error(`Wrangler did not finish within ${invocation.timeoutMs}ms`)),
        invocation.timeoutMs,
      );
      timer.unref();
    });
  }
}

export class CloudflarePagesAdapter {
  constructor(
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async deploySnapshot(
    snapshot: CloudflareSnapshotRef,
    target: CloudflareProjectRef,
    branch = "main",
  ): Promise<CloudflareDeployReceipt> {
    const normalizedTarget = normalizeProjectRef(target);
    const normalizedBranch = normalizeBranch(branch);
    assertSnapshotRef(snapshot);
    const deployDir = await prepareCloudflareDeployment(snapshot);

    try {
      const invocation = createWranglerInvocation(
        [
          "pages",
          "deploy",
          ".",
          "--project-name",
          normalizedTarget.projectName,
          "--branch",
          normalizedBranch,
        ],
        deployDir,
        normalizedTarget.accountId,
        this.timeoutMs,
      );
      const result = await this.runner.run(invocation);
      if (result.code !== 0) {
        throw new Error(
          `Cloudflare Pages deploy failed (${result.signal ?? result.code}). ${cleanOutput(result.output)}`,
        );
      }
      const urls = parseWranglerDeployUrls(result.output);
      return {
        target: normalizedTarget,
        branch: normalizedBranch,
        deploymentUrl: urls.deploymentUrl,
        projectUrl: urls.projectUrl,
        deploymentInboxUrl: joinInboxUrl(urls.deploymentUrl, snapshot.inboxPath),
        projectInboxUrl: joinInboxUrl(urls.projectUrl, snapshot.inboxPath),
      };
    } finally {
      try {
        await rm(deployDir, { recursive: true, force: true });
      } catch (error) {
        process.emitWarning(
          `Could not remove temporary Cloudflare deployment directory: ${(error as Error).message}`,
        );
      }
    }
  }
}

export function createWranglerInvocation(
  args: string[],
  cwd: string,
  accountId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
): CommandInvocation {
  const npxArgs = ["--yes", `wrangler@${PINNED_WRANGLER_VERSION}`, ...args];
  return {
    command: platform === "win32" ? nodeExecutable : "npx",
    args:
      platform === "win32"
        ? [
            path.win32.join(
              path.win32.dirname(nodeExecutable),
              "node_modules",
              "npm",
              "bin",
              "npx-cli.js",
            ),
            ...npxArgs,
          ]
        : npxArgs,
    cwd,
    env: {
      CLOUDFLARE_ACCOUNT_ID: normalizeAccountId(accountId),
      WRANGLER_LOG_SANITIZE: "true",
    },
    timeoutMs,
  };
}

function renderCloudflareHeaders(
  capability: string,
  security: StaticSecurityHeaders,
): string {
  assertCapability(capability);
  const inboxPath = `/i/${capability}`;
  const rules: Array<{ path: string; headers: Record<string, string> }> = [
    { path: "/*", headers: security.common },
    { path: "/", headers: security.root },
    { path: "/index.html", headers: security.root },
    { path: `${inboxPath}/`, headers: security.shell },
    {
      path: `${inboxPath}/index.html`,
      headers: security.shell,
    },
    {
      path: `${inboxPath}/documents/:id/`,
      headers: security.shell,
    },
    {
      path: `${inboxPath}/documents/:id/index.html`,
      headers: security.shell,
    },
    {
      path: `${inboxPath}/documents/:id/content/*`,
      headers: security.document,
    },
  ];
  if (rules.length > CLOUDFLARE_HEADER_RULE_LIMIT) {
    throw new Error("Cloudflare _headers rule limit exceeded");
  }
  const output = `${rules
    .map(
      (rule) =>
        `${rule.path}\n${Object.entries(rule.headers)
          .map(([name, value]) => `  ${name}: ${value}`)
          .join("\n")}`,
    )
    .join("\n\n")}\n`;
  for (const line of output.split("\n")) {
    if (line.length > CLOUDFLARE_HEADER_LINE_LIMIT) {
      throw new Error("Cloudflare _headers line limit exceeded");
    }
  }
  return output;
}

export function parseWranglerDeployUrls(output: string): {
  deploymentUrl: string;
  projectUrl: string;
} {
  const cleaned = stripAnsi(output);
  const match = cleaned.match(
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pages\.dev(?:\/[^\s"'<>)]*)?/i,
  );
  if (!match) {
    throw new Error("Wrangler completed without returning a Cloudflare Pages deployment URL");
  }
  const deploymentUrl = match[0].replace(/[),.;]+$/g, "").replace(/\/+$/, "");
  const parsed = new URL(deploymentUrl);
  const labels = parsed.hostname.split(".");
  if (labels.length < 4 || !/^[0-9a-f]{6,12}$/i.test(labels[0])) {
    throw new Error("Wrangler returned a Pages URL without an immutable deployment prefix");
  }
  return {
    deploymentUrl,
    projectUrl: `https://${labels.slice(1).join(".")}`,
  };
}

async function prepareCloudflareDeployment(
  snapshot: CloudflareSnapshotRef,
): Promise<string> {
  const sourceDir = path.resolve(snapshot.outputDir);
  const sourceStat = await lstat(sourceDir);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Static snapshot is not a regular directory: ${sourceDir}`);
  }
  await Promise.all([
    assertRegularFile(path.join(sourceDir, "__html-inbox", "ownership.json")),
    assertRegularFile(path.join(sourceDir, snapshot.inboxPath.slice(1), "snapshot-manifest.json")),
    assertRegularFile(path.join(sourceDir, snapshot.inboxPath.slice(1), "security-headers.json")),
  ]);
  const security = parseStaticSecurityHeaders(
    await readFile(
      path.join(sourceDir, snapshot.inboxPath.slice(1), "security-headers.json"),
      "utf8",
    ),
  );

  const deployDir = `${sourceDir}.cloudflare-${randomUUID()}`;
  await ensurePrivateDirectory(deployDir);
  try {
    const limits = { files: 0 };
    await copyStaticTree(sourceDir, deployDir, limits);
    await writePrivateFile(
      path.join(deployDir, "_headers"),
      renderCloudflareHeaders(snapshot.capability, security),
    );
    limits.files += 1;
    if (limits.files > CLOUDFLARE_UPLOAD_FILE_LIMIT) {
      throw new Error(`Cloudflare Direct Upload allows at most ${CLOUDFLARE_UPLOAD_FILE_LIMIT} files`);
    }
    return deployDir;
  } catch (error) {
    await rm(deployDir, { recursive: true, force: true });
    throw error;
  }
}

async function copyStaticTree(
  sourceDir: string,
  destinationDir: string,
  limits: { files: number },
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const entryStat = await lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Static snapshot contains a symbolic link: ${sourcePath}`);
    }
    if (entryStat.isDirectory()) {
      await ensurePrivateDirectory(destinationPath);
      await copyStaticTree(sourcePath, destinationPath, limits);
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(`Static snapshot contains an unsupported entry: ${sourcePath}`);
    }
    if (entryStat.size > CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT) {
      throw new Error(`Cloudflare Direct Upload file exceeds 25 MiB: ${sourcePath}`);
    }
    limits.files += 1;
    if (limits.files > CLOUDFLARE_UPLOAD_FILE_LIMIT) {
      throw new Error(`Cloudflare Direct Upload allows at most ${CLOUDFLARE_UPLOAD_FILE_LIMIT} files`);
    }
    await writePrivateFile(destinationPath, await readBoundedFile(sourcePath));
  }
}

async function readBoundedFile(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error(`Static snapshot contains an unsupported entry: ${filePath}`);
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT - byteLength + 1),
      );
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT) {
        throw new Error(`Cloudflare Direct Upload file exceeds 25 MiB: ${filePath}`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, byteLength);
  } finally {
    await file.close();
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Static snapshot file is not regular: ${filePath}`);
  }
}

function assertSnapshotRef(snapshot: CloudflareSnapshotRef): void {
  assertCapability(snapshot.capability);
  if (snapshot.inboxPath !== `/i/${snapshot.capability}`) {
    throw new Error("Static snapshot capability and inbox path do not match");
  }
}

function assertCapability(capability: string): void {
  const decoded = Buffer.from(capability, "base64url");
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(capability) ||
    decoded.byteLength !== 16 ||
    decoded.toString("base64url") !== capability
  ) {
    throw new Error("Inbox capability must encode exactly 128 bits");
  }
}

function normalizeProjectRef(target: CloudflareProjectRef): CloudflareProjectRef {
  return {
    accountId: normalizeAccountId(target.accountId),
    projectName: normalizeProjectName(target.projectName),
  };
}

function normalizeAccountId(accountId: string): string {
  const normalized = accountId.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("Cloudflare account ID must be 32 hexadecimal characters");
  }
  return normalized;
}

function normalizeProjectName(projectName: string): string {
  const normalized = projectName.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error("Cloudflare Pages project name must use 1-63 lowercase letters, digits, or hyphens");
  }
  return normalized;
}

function normalizeBranch(branch: string): string {
  const normalized = branch.trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    normalized.startsWith("-") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new Error("Cloudflare Pages branch must use 1-128 safe characters");
  }
  return normalized;
}

function joinInboxUrl(baseUrl: string, inboxPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${inboxPath}/`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function cleanOutput(value: string): string {
  let cleaned = stripAnsi(value).trim();
  for (const [name, credential] of Object.entries(process.env)) {
    if (
      credential &&
      /^(?:CLOUDFLARE|CF)_.*(?:TOKEN|KEY|SECRET|PASSWORD|EMAIL)$/i.test(name)
    ) {
      cleaned = cleaned.split(credential).join("[redacted]");
    }
  }
  return cleaned.slice(-4_000);
}

function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    killer.once("error", () => child.kill(signal));
    killer.once("close", (code) => {
      if (code !== 0) child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function parseStaticSecurityHeaders(value: string): StaticSecurityHeaders {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Static snapshot security headers are not valid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("Static snapshot security header schema is unsupported");
  }
  const security: StaticSecurityHeaders = {
    schemaVersion: 1,
    common: parseHeaderRecord(parsed.common, "common"),
    root: parseHeaderRecord(parsed.root, "root"),
    shell: parseHeaderRecord(parsed.shell, "shell"),
    document: parseHeaderRecord(parsed.document, "document"),
  };
  for (const policy of [security.root, security.shell, security.document]) {
    if (!policy["Content-Security-Policy"]) {
      throw new Error("Static snapshot security policy is missing Content-Security-Policy");
    }
  }
  if (
    !security.common["Cache-Control"]?.split(",").some((value) => value.trim() === "no-store") ||
    security.common["Referrer-Policy"] !== "no-referrer" ||
    security.common["X-Content-Type-Options"] !== "nosniff" ||
    !security.common["X-Robots-Tag"]?.includes("noindex")
  ) {
    throw new Error("Static snapshot common security policy is incomplete");
  }
  return security;
}

function parseHeaderRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Static snapshot ${label} headers are invalid`);
  }
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof headerValue !== "string") {
      throw new Error(`Static snapshot ${label} headers are invalid`);
    }
    if (/\r|\n/.test(headerValue)) {
      throw new Error(`Static snapshot ${label} header contains a line break`);
    }
    result[name] = headerValue;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
