import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensurePrivateDirectory, writePrivateFile } from "./private-storage";
import {
  assertInboxCapability,
  isRecord,
  normalizeCloudflareAccountId,
  normalizeCloudflareBranch,
  normalizeCloudflareProjectName,
  normalizeCloudflareProjectRef,
  type CloudflareProjectRef,
} from "./validation";
import { readBoundedFile } from "./bounded-file";
import {
  hashManifestFiles,
  type SnapshotFile,
  type StaticSecurityHeaders,
} from "./static-export";

export type { CloudflareProjectRef } from "./validation";

export const PINNED_WRANGLER_VERSION = "4.86.0";
export const CLOUDFLARE_UPLOAD_FILE_LIMIT = 20_000;
export const CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;
export const CLOUDFLARE_HEADER_RULE_LIMIT = 100;
export const CLOUDFLARE_HEADER_LINE_LIMIT = 2_000;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface CloudflareSnapshotRef {
  outputDir: string;
  capability: string;
  snapshotHash?: string;
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
  stdout: string;
  stderr: string;
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

export interface CloudflareProjectSummary {
  name: string;
  accountId: string;
  productionBranch: string;
}

export interface CloudflareDeploymentSummary {
  id: string;
  url: string;
  environment: string;
  status: string;
  isSkipped: boolean;
  branch: string;
  createdAt: string;
  commitHash: string;
  commitMessage: string;
}

export interface CloudflareDeployMetadata {
  commitHash: string;
  commitMessage: string;
}

export class NodeCommandRunner implements CommandRunner {
  async run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let failure: Error | null = null;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
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
        forceTimer = setTimeout(
          () => terminateProcessTree(child, "SIGKILL"),
          2_000,
        );
        forceTimer.unref();
      };
      const record = (chunk: string, stream: "stdout" | "stderr") => {
        if (failure) return;
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;

        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          fail(
            new Error(
              "Wrangler produced more than 1 MiB of output and was stopped",
            ),
          );
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => record(chunk, "stdout"));
      child.stderr.on("data", (chunk: string) => record(chunk, "stderr"));
      child.once("error", (error) =>
        fail(new Error(`Wrangler could not start: ${error.message}`)),
      );
      child.once("close", (code, signal) =>
        finish(() =>
          failure
            ? reject(failure)
            : resolve({ code: code ?? 1, signal, stdout, stderr }),
        ),
      );
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `Wrangler did not finish within ${invocation.timeoutMs}ms`,
            ),
          ),
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
    private readonly request: typeof fetch = fetch,
  ) {}

  async deploySnapshot(
    snapshot: CloudflareSnapshotRef,
    target: CloudflareProjectRef,
    branch = "main",
    metadata?: CloudflareDeployMetadata,
  ): Promise<CloudflareDeployReceipt> {
    const normalizedTarget = normalizeCloudflareProjectRef(target);
    const normalizedBranch = normalizeCloudflareBranch(branch);
    assertInboxCapability(snapshot.capability);
    const inboxPath = `/i/${snapshot.capability}`;
    const deployDir = await prepareCloudflareDeployment(snapshot);

    try {
      const args = [
        "pages",
        "deploy",
        ".",
        "--project-name",
        normalizedTarget.projectName,
        "--branch",
        normalizedBranch,
      ];
      if (metadata) {
        assertDeployMetadata(metadata);
        args.push(
          "--commit-hash",
          metadata.commitHash,
          "--commit-message",
          metadata.commitMessage,
        );
      }
      const output = await this.runWrangler(
        args,
        deployDir,
        normalizedTarget.accountId,
      );
      const urls = parseWranglerDeployUrls(output);
      return {
        target: normalizedTarget,
        branch: normalizedBranch,
        deploymentUrl: urls.deploymentUrl,
        projectUrl: urls.projectUrl,
        deploymentInboxUrl: joinInboxUrl(urls.deploymentUrl, inboxPath),
        projectInboxUrl: joinInboxUrl(urls.projectUrl, inboxPath),
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

  async listProjects(
    accountId: string,
    cwd: string,
  ): Promise<CloudflareProjectSummary[]> {
    const normalizedAccountId = normalizeCloudflareAccountId(accountId);
    const result = await this.listApi(
      `/accounts/${normalizedAccountId}/pages/projects`,
      cwd,
      normalizedAccountId,
    );
    return parseCloudflareProjects(result, normalizedAccountId);
  }

  async createProject(
    target: CloudflareProjectRef,
    cwd: string,
    productionBranch = "main",
  ): Promise<void> {
    const normalizedTarget = normalizeCloudflareProjectRef(target);
    const branch = normalizeCloudflareBranch(productionBranch);
    await this.runWrangler(
      [
        "pages",
        "project",
        "create",
        normalizedTarget.projectName,
        "--production-branch",
        branch,
      ],
      cwd,
      normalizedTarget.accountId,
    );
  }

  async listDeployments(
    target: CloudflareProjectRef,
    cwd: string,
  ): Promise<CloudflareDeploymentSummary[]> {
    const normalizedTarget = normalizeCloudflareProjectRef(target);
    const result = await this.listApi(
      `/accounts/${normalizedTarget.accountId}/pages/projects/${normalizedTarget.projectName}/deployments`,
      cwd,
      normalizedTarget.accountId,
    );
    return parseCloudflareDeployments(result);
  }

  private async listApi(
    resource: string,
    cwd: string,
    accountId: string,
  ): Promise<unknown[]> {
    // Wrangler's list --json output contains display rows, omitting recovery metadata.
    const logDirectory = await mkdtemp(
      path.join(os.tmpdir(), "html-inbox-auth-"),
    );
    let credentials: unknown;
    try {
      const logPath = path.join(logDirectory, "wrangler.log");
      await writePrivateFile(logPath, "");
      const invocation = createWranglerInvocation(
        ["auth", "token", "--json"],
        cwd,
        accountId,
        this.timeoutMs,
      );
      // Wrangler logs token output even with sanitization enabled. Keep that log
      // private and remove it on success, command failure, and malformed output.
      invocation.env.WRANGLER_LOG_PATH = logPath;
      const authResult = await this.runner.run(invocation).catch(() => {
        throw new Error(
          "Could not retrieve Cloudflare credentials from Wrangler",
        );
      });
      if (authResult.code !== 0)
        throw new Error(
          "Could not retrieve Cloudflare credentials from Wrangler",
        );
      credentials = parseJsonOutput(authResult.stdout);
    } finally {
      await rm(logDirectory, { recursive: true, force: true });
    }
    const headers: Record<string, string> = {};
    if (
      isRecord(credentials) &&
      (credentials.type === "oauth" || credentials.type === "api_token") &&
      typeof credentials.token === "string" &&
      credentials.token
    ) {
      headers.Authorization = `Bearer ${credentials.token}`;
    } else if (
      isRecord(credentials) &&
      credentials.type === "api_key" &&
      typeof credentials.key === "string" &&
      typeof credentials.email === "string"
    ) {
      headers["X-Auth-Key"] = credentials.key;
      headers["X-Auth-Email"] = credentials.email;
    } else {
      throw new Error("Wrangler returned unsupported credentials");
    }

    const records: unknown[] = [];
    const signal = AbortSignal.timeout(this.timeoutMs);
    for (let page = 1; ; page += 1) {
      const response = await this.request(
        `https://api.cloudflare.com/client/v4${resource}?page=${page}&per_page=100`,
        { headers, signal, redirect: "error" },
      );
      if (!response.ok)
        throw new Error(`Cloudflare list request failed (${response.status})`);
      const payload: unknown = await response.json();
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        !Array.isArray(payload.result) ||
        (payload.result_info !== undefined && !isRecord(payload.result_info))
      )
        throw new Error("Cloudflare returned an invalid list response");
      const totalPages = isRecord(payload.result_info)
        ? payload.result_info.total_pages
        : undefined;
      if (
        totalPages !== undefined &&
        (typeof totalPages !== "number" ||
          !Number.isSafeInteger(totalPages) ||
          totalPages < 0)
      )
        throw new Error("Cloudflare returned invalid pagination");
      records.push(...payload.result);
      if (
        typeof totalPages === "number"
          ? page >= totalPages
          : payload.result.length < 100
      )
        return records;
    }
  }

  private async runWrangler(
    args: string[],
    cwd: string,
    accountId: string,
  ): Promise<string> {
    const result = await this.runner.run(
      createWranglerInvocation(args, cwd, accountId, this.timeoutMs),
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      throw new Error(
        `Wrangler failed (${result.signal ?? result.code}). ${cleanOutput(output)}`,
      );
    }

    return output;
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
      CLOUDFLARE_ACCOUNT_ID: normalizeCloudflareAccountId(accountId),
      WRANGLER_LOG_SANITIZE: "true",
    },
    timeoutMs,
  };
}

function renderCloudflareHeaders(
  capability: string,
  security: StaticSecurityHeaders,
): string {
  assertInboxCapability(capability);
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
    throw new Error(
      "Wrangler completed without returning a Cloudflare Pages deployment URL",
    );
  }
  const deploymentUrl = match[0].replace(/[),.;]+$/g, "").replace(/\/+$/, "");
  const parsed = new URL(deploymentUrl);
  const labels = parsed.hostname.split(".");
  if (labels.length < 4 || !/^[0-9a-f]{6,12}$/i.test(labels[0])) {
    throw new Error(
      "Wrangler returned a Pages URL without an immutable deployment prefix",
    );
  }
  return {
    deploymentUrl,
    projectUrl: `https://${labels.slice(1).join(".")}`,
  };
}

export function receiptFromDeployment(
  deployment: CloudflareDeploymentSummary,
  target: CloudflareProjectRef,
  branch: string,
  inboxPath: string,
): CloudflareDeployReceipt {
  const urls = parseWranglerDeployUrls(deployment.url);
  return {
    target: normalizeCloudflareProjectRef(target),
    branch: normalizeCloudflareBranch(branch),
    deploymentUrl: urls.deploymentUrl,
    projectUrl: urls.projectUrl,
    deploymentInboxUrl: joinInboxUrl(urls.deploymentUrl, inboxPath),
    projectInboxUrl: joinInboxUrl(urls.projectUrl, inboxPath),
  };
}

export function parseCloudflareProjects(
  value: unknown,
  accountId: string,
): CloudflareProjectSummary[] {
  if (!Array.isArray(value))
    throw new Error("Cloudflare projects must be an array");

  const normalizedAccountId = normalizeCloudflareAccountId(accountId);
  return value.map((project) => {
    if (!isRecord(project)) throw new Error("Cloudflare project is invalid");
    return {
      name: normalizeCloudflareProjectName(requiredString(project.name)),
      accountId: normalizedAccountId,
      productionBranch: normalizeCloudflareBranch(
        requiredString(project.production_branch),
      ),
    };
  });
}

export function parseCloudflareDeployments(
  value: unknown,
): CloudflareDeploymentSummary[] {
  if (!Array.isArray(value))
    throw new Error("Cloudflare deployments must be an array");
  return value.map((deployment) => {
    if (
      !isRecord(deployment) ||
      !isRecord(deployment.deployment_trigger) ||
      !isRecord(deployment.deployment_trigger.metadata) ||
      !isRecord(deployment.latest_stage) ||
      typeof deployment.is_skipped !== "boolean"
    )
      throw new Error("Cloudflare deployment is invalid");
    const metadata = deployment.deployment_trigger.metadata;
    const url = requiredString(deployment.url);
    const parsedUrl = new URL(url);
    if (
      parsedUrl.protocol !== "https:" ||
      !parsedUrl.hostname.endsWith(".pages.dev") ||
      parsedUrl.origin !== url
    )
      throw new Error("Cloudflare deployment URL is invalid");
    const createdAt = requiredString(deployment.created_on);
    if (!Number.isFinite(Date.parse(createdAt)))
      throw new Error("Cloudflare deployment date is invalid");
    return {
      id: requiredString(deployment.id),
      url,
      environment: requiredString(deployment.environment),
      status: requiredString(deployment.latest_stage.status),
      isSkipped: deployment.is_skipped,
      branch: requiredString(metadata.branch),
      createdAt,
      commitHash: requiredString(metadata.commit_hash),
      commitMessage: requiredString(metadata.commit_message),
    };
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Cloudflare field must be a string");
  return value;
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
    assertRegularFile(
      path.join(
        sourceDir,
        `i/${snapshot.capability}`,
        "snapshot-manifest.json",
      ),
    ),
    assertRegularFile(
      path.join(sourceDir, `i/${snapshot.capability}`, "security-headers.json"),
    ),
  ]);
  const manifestPath = `i/${snapshot.capability}/snapshot-manifest.json`;
  const manifestBytes = await readSnapshotFile(
    path.join(sourceDir, manifestPath),
  );
  const inventory = parseSnapshotInventory(
    manifestBytes,
    snapshot.snapshotHash,
  );
  if (inventory.has(manifestPath))
    throw new Error("Snapshot manifest must not list itself");
  inventory.set(manifestPath, {
    size: manifestBytes.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  });

  const deployDir = `${sourceDir}.cloudflare-${randomUUID()}`;
  await ensurePrivateDirectory(deployDir);
  try {
    const limits = { files: 0 };
    await copyStaticTree(sourceDir, deployDir, limits, inventory);
    if (inventory.size !== 0)
      throw new Error("Static snapshot is missing manifest files");
    const security = parseStaticSecurityHeaders(
      await readFile(
        path.join(
          deployDir,
          `i/${snapshot.capability}`,
          "security-headers.json",
        ),
        "utf8",
      ),
    );
    await writePrivateFile(
      path.join(deployDir, "_headers"),
      renderCloudflareHeaders(snapshot.capability, security),
    );
    limits.files += 1;
    if (limits.files > CLOUDFLARE_UPLOAD_FILE_LIMIT) {
      throw new Error(
        `Cloudflare Direct Upload allows at most ${CLOUDFLARE_UPLOAD_FILE_LIMIT} files`,
      );
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
  inventory: Map<string, { size: number; sha256: string }>,
  relativeDir = "",
): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const entryStat = await lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(
        `Static snapshot contains a symbolic link: ${sourcePath}`,
      );
    }
    if (entryStat.isDirectory()) {
      await ensurePrivateDirectory(destinationPath);
      await copyStaticTree(
        sourcePath,
        destinationPath,
        limits,
        inventory,
        relativePath,
      );
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(
        `Static snapshot contains an unsupported entry: ${sourcePath}`,
      );
    }
    if (entryStat.size > CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT) {
      throw new Error(
        `Cloudflare Direct Upload file exceeds 25 MiB: ${sourcePath}`,
      );
    }
    limits.files += 1;
    if (limits.files > CLOUDFLARE_UPLOAD_FILE_LIMIT) {
      throw new Error(
        `Cloudflare Direct Upload allows at most ${CLOUDFLARE_UPLOAD_FILE_LIMIT} files`,
      );
    }
    const expected = inventory.get(relativePath);
    if (!expected)
      throw new Error(
        `Static snapshot contains an unlisted file: ${relativePath}`,
      );
    const contents = await readSnapshotFile(sourcePath);
    if (
      contents.length !== expected.size ||
      createHash("sha256").update(contents).digest("hex") !== expected.sha256
    )
      throw new Error(
        `Static snapshot file does not match manifest: ${relativePath}`,
      );
    await writePrivateFile(destinationPath, contents);
    inventory.delete(relativePath);
  }
}

function parseSnapshotInventory(contents: Buffer, expectedHash?: string) {
  const value: unknown = JSON.parse(contents.toString("utf8"));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    typeof value.snapshotHash !== "string"
  )
    throw new Error("Static snapshot manifest is invalid");
  const inventory = new Map<string, { size: number; sha256: string }>();
  const files: SnapshotFile[] = [];
  let previousPath = "";
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      file.path <= previousPath ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error("Static snapshot manifest file is invalid");
    previousPath = file.path;
    inventory.set(file.path, { size: file.size, sha256: file.sha256 });
    files.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  const digest = hashManifestFiles(files);
  if (
    digest !== value.snapshotHash ||
    (expectedHash !== undefined && digest !== expectedHash)
  )
    throw new Error("Static snapshot hash does not match remote intent");
  return inventory;
}

async function readSnapshotFile(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    if (!(await file.stat()).isFile()) {
      throw new Error(
        `Static snapshot contains an unsupported entry: ${filePath}`,
      );
    }
    return await readBoundedFile(
      file,
      CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT,
      `Cloudflare Direct Upload file exceeds 25 MiB: ${filePath}`,
    );
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

function assertDeployMetadata(metadata: CloudflareDeployMetadata): void {
  if (!/^[0-9a-f]{40,64}$/.test(metadata.commitHash)) {
    throw new Error(
      "Cloudflare deployment commit hash must be a 40-64 character lowercase digest",
    );
  }
  if (
    !metadata.commitMessage ||
    metadata.commitMessage.length > 200 ||
    /\r|\n/.test(metadata.commitMessage)
  ) {
    throw new Error(
      "Cloudflare deployment commit message must be 1-200 characters on one line",
    );
  }
}

function joinInboxUrl(baseUrl: string, inboxPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${inboxPath}/`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseJsonOutput(output: string): unknown {
  const cleaned = stripAnsi(output).trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Wrangler did not return valid JSON");
  }
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
      throw new Error(
        "Static snapshot security policy is missing Content-Security-Policy",
      );
    }
  }
  if (
    !security.common["Cache-Control"]
      ?.split(",")
      .some((value) => value.trim() === "no-store") ||
    security.common["Referrer-Policy"] !== "no-referrer" ||
    security.common["X-Content-Type-Options"] !== "nosniff" ||
    !security.common["X-Robots-Tag"]?.includes("noindex")
  ) {
    throw new Error("Static snapshot common security policy is incomplete");
  }
  return security;
}

function parseHeaderRecord(
  value: unknown,
  label: string,
): Record<string, string> {
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
