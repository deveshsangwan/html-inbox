import { test } from "node:test";
import { strict as assert } from "node:assert";
import { open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import {
  CLOUDFLARE_HEADER_LINE_LIMIT,
  CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT,
  CloudflarePagesAdapter,
  CommandInvocation,
  CommandResult,
  CommandRunner,
  PINNED_WRANGLER_VERSION,
} from "./cloudflare-pages";
import { exportStaticSnapshot } from "./static-export";
import { DOCUMENT_CSP } from "./viewer-assets";
import { temporaryHome } from "./test-fixtures";

test("Cloudflare upload validates and isolates deployment files", async (t) => {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  await backend.publish({
    originalBytes: Buffer.from(html),
    title: "Report",
    type: "report",
    sourceFileName: "report.html",
  });
  const hostileTitle = 'Title </h1><script>alert("title")</script>';
  const hostileType = "report\"><svg/onload=alert('type')>";
  const hostileSource = "source.html\" autofocus onfocus=\"alert('source')";
  await backend.publish({
    originalBytes: Buffer.from(html),
    title: hostileTitle,
    type: hostileType,
    sourceFileName: hostileSource,
  });

  const snapshotDirectory = path.join(home, "snapshot");
  const capability = "AAAAAAAAAAAAAAAAAAAAAA";
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const firstSnapshot = await exportStaticSnapshot(backend, {
    outputDir: snapshotDirectory,
    capability,
    ownerId,
    generatedAt: "2026-07-16T00:00:00.000Z",
  });
  const accountId = "A".repeat(32);
  const recordingRunner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    output:
      "✨ Deployment complete! Take a peek over at https://abc123.html-inbox-7x.pages.dev",
  });
  const cloudflare = new CloudflarePagesAdapter(recordingRunner, 12_345);
  const receipt = await cloudflare.deploySnapshot(
    firstSnapshot,
    { accountId, projectName: "HTML-Inbox" },
    "main",
  );
  assert.equal(recordingRunner.invocations.length, 1);
  const deploymentInvocation = recordingRunner.invocations[0];
  const commandArguments = [...deploymentInvocation.args];
  if (process.platform === "win32") {
    assert.equal(deploymentInvocation.command, process.execPath);
    assert.equal(
      commandArguments.shift(),
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    );
  } else {
    assert.equal(deploymentInvocation.command, "npx");
  }

  assert.deepEqual(commandArguments, [
    "--yes",
    `wrangler@${PINNED_WRANGLER_VERSION}`,
    "pages",
    "deploy",
    ".",
    "--project-name",
    "html-inbox",
    "--branch",
    "main",
  ]);
  assert.deepEqual(deploymentInvocation.env, {
    CLOUDFLARE_ACCOUNT_ID: accountId.toLowerCase(),
    WRANGLER_LOG_SANITIZE: "true",
  });
  assert.equal(deploymentInvocation.timeoutMs, 12_345);
  assert.equal(
    deploymentInvocation.args.some((argument) => argument.includes("token")),
    false,
  );
  assert.equal(receipt.deploymentUrl, "https://abc123.html-inbox-7x.pages.dev");
  assert.equal(receipt.projectUrl, "https://html-inbox-7x.pages.dev");
  assert.equal(
    receipt.projectInboxUrl,
    `https://html-inbox-7x.pages.dev/i/${capability}/`,
  );
  assert(recordingRunner.headers);
  assert.equal(
    recordingRunner.headers.includes("/documents/:id/content/*"),
    true,
  );
  assert.equal(recordingRunner.headers.includes(DOCUMENT_CSP), true);
  assert.equal(
    recordingRunner.headers
      .split("\n")
      .every((line) => line.length <= CLOUDFLARE_HEADER_LINE_LIMIT),
    true,
  );
  assert.equal(
    recordingRunner.headers
      .split("\n")
      .filter((line) => line && !line.startsWith(" ")).length,
    8,
  );
  await assert.rejects(
    readFile(path.join(snapshotDirectory, "_headers")),
    /ENOENT/,
  );
  assert.equal(
    (await readdir(home)).some((entry) =>
      entry.startsWith("snapshot.cloudflare-"),
    ),
    false,
  );

  const controlRunner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    output: "Created project",
  });
  const controlAdapter = new CloudflarePagesAdapter(controlRunner, 9_999);
  await controlAdapter.createProject(
    { accountId, projectName: "html-inbox" },
    home,
    "main",
  );
  assert.deepEqual(controlRunner.invocations[0].args.slice(process.platform === "win32" ? 3 : 2), [
    "pages",
    "project",
    "create",
    "html-inbox",
    "--production-branch",
    "main",
  ]);

  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  const previousApiKey = process.env.CLOUDFLARE_API_KEY;
  process.env.CLOUDFLARE_API_TOKEN = "super-secret-cloudflare-token";
  process.env.CLOUDFLARE_API_KEY = "super-secret-cloudflare-key";
  try {
    const failingRunner = new RecordingCommandRunner({
      code: 1,
      signal: null,
      output:
        "authentication failed: super-secret-cloudflare-token super-secret-cloudflare-key",
    });
    await assert.rejects(
      new CloudflarePagesAdapter(failingRunner).deploySnapshot(firstSnapshot, {
        accountId,
        projectName: "html-inbox",
      }),
      (error: Error) =>
        error.message.includes("[redacted]") &&
        !error.message.includes("super-secret-cloudflare-token") &&
        !error.message.includes("super-secret-cloudflare-key"),
    );
    assert.equal(
      (await readdir(home)).some((entry) =>
        entry.startsWith("snapshot.cloudflare-"),
      ),
      false,
    );
  } finally {
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
    if (previousApiKey === undefined) delete process.env.CLOUDFLARE_API_KEY;
    else process.env.CLOUDFLARE_API_KEY = previousApiKey;
  }

  await assert.rejects(
    new CloudflarePagesAdapter(recordingRunner).deploySnapshot(firstSnapshot, {
      accountId: "not-an-account-id",
      projectName: "html-inbox",
    }),
    /32 hexadecimal/,
  );
  const securityHeaderPath = path.join(
    snapshotDirectory,
    "i",
    capability,
    "security-headers.json",
  );
  const originalSecurityHeaders = await readFile(securityHeaderPath, "utf8");
  const weakenedSecurityHeaders = JSON.parse(originalSecurityHeaders) as {
    common: Record<string, string>;
  };
  weakenedSecurityHeaders.common["Cache-Control"] = "public, max-age=3600";
  await writeFile(securityHeaderPath, JSON.stringify(weakenedSecurityHeaders));
  try {
    await assert.rejects(
      new CloudflarePagesAdapter(recordingRunner).deploySnapshot(
        firstSnapshot,
        {
          accountId,
          projectName: "html-inbox",
        },
      ),
      /does not match manifest/,
    );
  } finally {
    await writeFile(securityHeaderPath, originalSecurityHeaders);
  }
  const oversizedPath = path.join(snapshotDirectory, "oversized.bin");
  const oversizedFile = await open(oversizedPath, "w");
  await oversizedFile.truncate(CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT + 1);
  await oversizedFile.close();
  try {
    await assert.rejects(
      new CloudflarePagesAdapter(recordingRunner).deploySnapshot(
        firstSnapshot,
        {
          accountId,
          projectName: "html-inbox",
        },
      ),
      /file exceeds 25 MiB/,
    );
  } finally {
    await rm(oversizedPath);
  }
});

class RecordingCommandRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];
  headers = "";

  constructor(private readonly result: CommandResult) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(structuredClone(invocation));
    try {
      this.headers = await readFile(
        path.join(invocation.cwd, "_headers"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.headers = "";
    }
    return this.result;
  }
}
