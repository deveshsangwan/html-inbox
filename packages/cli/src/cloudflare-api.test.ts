import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  CloudflarePagesAdapter,
  parseCloudflareDeployments,
  parseCloudflareProjects,
} from "./cloudflare-pages";

// Wrangler 4.86.0 src/pages/projects.ts and src/pages/deployments.ts emit display rows,
// not the API records needed to check production branches and journal receipts.
const project = { name: "inbox-test", production_branch: "main" };
const deployment = {
  id: "deployment-id",
  url: "https://abcdef12.inbox-test.pages.dev",
  environment: "production",
  latest_stage: { status: "success" },
  is_skipped: false,
  created_on: "2026-09-05T00:00:00.000Z",
  deployment_trigger: {
    metadata: {
      branch: "main",
      commit_hash: "a".repeat(40),
      commit_message: "html-inbox:operation:publish:digest",
    },
  },
};

test("API parsers preserve recovery metadata and reject Wrangler display rows", () => {
  assert.equal(
    parseCloudflareDeployments([deployment])[0]?.commitMessage,
    deployment.deployment_trigger.metadata.commit_message,
  );
  assert.equal(parseCloudflareProjects([project])[0]?.productionBranch, "main");
  assert.throws(() => parseCloudflareProjects({ result: [] }));
  assert.throws(() =>
    parseCloudflareProjects([
      {
        "Project Name": "inbox-test",
        "Project Domains": "inbox-test.pages.dev",
        "Git Provider": "No",
        "Last Modified": "1 day ago",
      },
    ]),
  );
  assert.throws(() =>
    parseCloudflareDeployments([
      {
        Id: "id",
        Environment: "Production",
        Branch: "main",
        Source: "aaaaaaa",
        Deployment: deployment.url,
        Status: "1 day ago",
        Build: "https://dash.cloudflare.com",
      },
    ]),
  );
});

test("API listing uses Wrangler OAuth credentials and reads every page", async () => {
  let page = 0;
  const adapter = new CloudflarePagesAdapter(
    {
      async run(invocation) {
        assert.deepEqual(invocation.args.slice(-4), [
          "wrangler@4.86.0",
          "auth",
          "token",
          "--json",
        ]);
        return {
          code: 0,
          signal: null,
          output: JSON.stringify({ type: "oauth", token: "test-credential" }),
        };
      },
    },
    1000,
    async (input, init) => {
      page += 1;
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-credential",
      );
      assert.equal(init?.redirect, "error");
      assert.equal(
        new URL(String(input)).searchParams.get("page"),
        String(page),
      );
      return Response.json({
        success: true,
        result: [{ ...project, name: `project-${page}` }],
        result_info: { total_pages: 2 },
      });
    },
  );
  assert.equal(
    (await adapter.listProjects("a".repeat(32), process.cwd())).length,
    2,
  );
});

test("failed credential commands cannot leak their output", async () => {
  const adapter = new CloudflarePagesAdapter({
    async run() {
      return { code: 1, signal: null, output: "sensitive-token" };
    },
  });
  await assert.rejects(
    adapter.listProjects("a".repeat(32), process.cwd()),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("sensitive-token"),
  );
});

for (const outcome of ["success", "failed", "malformed", "throw"] as const) {
  test(`Wrangler credential log is private and removed on ${outcome}`, async () => {
    let logPath = "";
    const adapter = new CloudflarePagesAdapter(
      {
        async run(invocation) {
          logPath = invocation.env.WRANGLER_LOG_PATH;
          assert(logPath);
          if (process.platform !== "win32")
            assert.equal((await stat(logPath)).mode & 0o777, 0o600);
          await writeFile(logPath, "secret logged by Wrangler");
          if (outcome === "throw") throw new Error("secret logged by Wrangler");
          return {
            code: outcome === "failed" ? 1 : 0,
            signal: null,
            output:
              outcome === "malformed"
                ? "invalid"
                : JSON.stringify({ type: "oauth", token: "secret" }),
          };
        },
      },
      1000,
      async () => Response.json({ success: true, result: [] }),
    );
    const result = adapter.listProjects("a".repeat(32), process.cwd());
    if (outcome === "success") assert.deepEqual(await result, []);
    else
      await assert.rejects(
        result,
        (error: unknown) =>
          error instanceof Error && !error.message.includes("secret"),
      );
    await assert.rejects(readFile(logPath), /ENOENT/);
  });
}
