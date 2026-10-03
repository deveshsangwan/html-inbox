import { rm } from "node:fs/promises";
import {
  assertInboxCapability,
  normalizeCloudflareAccountId,
  normalizeCloudflareBranch,
  normalizeCloudflareProjectRef,
  type CloudflareProjectRef,
} from "./validation";
import { NodeCommandRunner, type CommandRunner } from "./command-runner";
import {
  listCloudflareRecords,
  parseCloudflareDeployments,
  parseCloudflareProjects,
  type CloudflareDeploymentSummary,
  type CloudflareProjectSummary,
} from "./cloudflare-api";
import {
  prepareCloudflareDeployment,
  type CloudflareSnapshotRef,
} from "./cloudflare-snapshot";
import { readCloudflareAuthHeaders } from "./wrangler-credentials";
import {
  DEFAULT_WRANGLER_TIMEOUT_MS,
  runWrangler,
  stripAnsi,
} from "./wrangler-command";

export type { CloudflareProjectRef } from "./validation";
export {
  NodeCommandRunner,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
} from "./command-runner";
export {
  PINNED_WRANGLER_VERSION,
  createWranglerInvocation,
} from "./wrangler-command";
export {
  CLOUDFLARE_UPLOAD_FILE_LIMIT,
  CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT,
  type CloudflareSnapshotRef,
} from "./cloudflare-snapshot";
export {
  CLOUDFLARE_HEADER_RULE_LIMIT,
  CLOUDFLARE_HEADER_LINE_LIMIT,
} from "./cloudflare-headers";
export {
  parseCloudflareProjects,
  parseCloudflareDeployments,
  type CloudflareProjectSummary,
  type CloudflareDeploymentSummary,
} from "./cloudflare-api";

export interface CloudflareDeployReceipt {
  target: CloudflareProjectRef;
  branch: string;
  deploymentUrl: string;
  projectUrl: string;
  deploymentInboxUrl: string;
  projectInboxUrl: string;
}

export interface CloudflareDeployMetadata {
  commitHash: string;
  commitMessage: string;
}

export class CloudflarePagesAdapter {
  constructor(
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly timeoutMs = DEFAULT_WRANGLER_TIMEOUT_MS,
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

      const output = await runWrangler(
        this.runner,
        args,
        deployDir,
        normalizedTarget.accountId,
        this.timeoutMs,
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
    await runWrangler(
      this.runner,
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
      this.timeoutMs,
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
    const headers = await readCloudflareAuthHeaders(
      this.runner,
      cwd,
      accountId,
      this.timeoutMs,
    );

    // Preserve the receiver of the injected fetch callback.
    return listCloudflareRecords(
      resource,
      headers,
      this.timeoutMs,
      this.request.bind(this),
    );
  }
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
