import {
  isRecord,
  normalizeCloudflareAccountId,
  normalizeCloudflareBranch,
  normalizeCloudflareProjectName,
} from "./validation";

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

export async function listCloudflareRecords(
  resource: string,
  headers: Record<string, string>,
  timeoutMs: number,
  request: typeof fetch,
): Promise<unknown[]> {
  const records: unknown[] = [];
  const signal = AbortSignal.timeout(timeoutMs);

  for (let page = 1; ; page += 1) {
    const response = await request(
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
