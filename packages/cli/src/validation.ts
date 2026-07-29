const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CloudflareProjectRef {
  accountId: string;
  projectName: string;
}

export function assertInboxCapability(value: string): void {
  const decoded =
    typeof value === "string" ? Buffer.from(value, "base64url") : Buffer.alloc(0);
  if (
    typeof value !== "string" ||
    !CAPABILITY_PATTERN.test(value) ||
    decoded.byteLength !== 16 ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error("Inbox capability must encode exactly 128 bits as 22 base64url characters");
  }
}

export function assertUuidV4(value: string, label: string): void {
  if (!UUID_V4_PATTERN.test(value)) {
    throw new Error(`${label} must be a version 4 UUID`);
  }
}

export function normalizeCloudflareProjectRef(
  value: CloudflareProjectRef,
): CloudflareProjectRef {
  if (
    !value ||
    typeof value.accountId !== "string" ||
    typeof value.projectName !== "string"
  ) {
    throw new Error("Cloudflare target is invalid");
  }
  return {
    accountId: normalizeCloudflareAccountId(value.accountId),
    projectName: normalizeCloudflareProjectName(value.projectName),
  };
}

export function normalizeCloudflareAccountId(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Cloudflare account ID must be 32 hexadecimal characters");
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("Cloudflare account ID must be 32 hexadecimal characters");
  }
  return normalized;
}

export function normalizeCloudflareProjectName(value: string): string {
  if (typeof value !== "string") {
    throw new Error(
      "Cloudflare Pages project name must use 1-63 lowercase letters, digits, or hyphens",
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      "Cloudflare Pages project name must use 1-63 lowercase letters, digits, or hyphens",
    );
  }
  return normalized;
}

export function normalizeCloudflareBranch(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Cloudflare Pages branch must use 1-128 safe characters");
  }
  const normalized = value.trim();
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

export function sameCloudflareProject(
  left: CloudflareProjectRef,
  right: CloudflareProjectRef,
): boolean {
  return (
    left.accountId.toLowerCase() === right.accountId.toLowerCase() &&
    left.projectName.toLowerCase() === right.projectName.toLowerCase()
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
