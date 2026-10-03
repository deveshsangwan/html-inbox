import { assertInboxCapability, isRecord } from "./validation";
import type { StaticSecurityHeaders } from "./static-export";

export const CLOUDFLARE_HEADER_RULE_LIMIT = 100;
export const CLOUDFLARE_HEADER_LINE_LIMIT = 2_000;

export function renderCloudflareHeaders(
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

export function parseStaticSecurityHeaders(
  value: string,
): StaticSecurityHeaders {
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
