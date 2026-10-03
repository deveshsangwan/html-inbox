import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
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
import {
  exportStaticSnapshot,
  hashManifestFiles,
  type StaticSecurityHeaders,
} from "./static-export";
import { DOCUMENT_CSP } from "./viewer-assets";
import { temporaryHome } from "./test-fixtures";

test("Cloudflare upload builds private headers, normalizes arguments and returns assigned URLs", async (t) => {
  const { home, snapshot } = await createSnapshot(t);
  const accountId = "A".repeat(32);
  const recordingRunner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    stderr: "",
    stdout:
      "✨ Deployment complete! Take a peek over at https://abc123.html-inbox-7x.pages.dev",
  });
  const cloudflare = new CloudflarePagesAdapter(recordingRunner, 12_345);
  const receipt = await cloudflare.deploySnapshot(
    snapshot,
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
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npx-cli.js",
      ),
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
    `https://html-inbox-7x.pages.dev/i/${snapshot.capability}/`,
  );
  assert(recordingRunner.headers);
  assert.equal(
    recordingRunner.headers.includes("/documents/:id/content/*"),
    true,
  );
  assert.equal(recordingRunner.headers.includes(DOCUMENT_CSP), true);

  const headerRules = recordingRunner.headers.trim().split("\n\n");
  const contentRule = headerRules.find((rule) =>
    rule.startsWith(`/i/${snapshot.capability}/documents/:id/content/*\n`),
  );
  assert(contentRule);
  assert.equal(
    contentRule.split("\n").slice(1).find((line) =>
      line.startsWith("  Content-Security-Policy: "),
    ),
    `  Content-Security-Policy: ${DOCUMENT_CSP}`,
  );
  assert.match(contentRule, /Content-Security-Policy: sandbox allow-scripts;/);
  assert.equal(contentRule.includes("allow-same-origin"), false);
  assert.equal(
    headerRules.filter((rule) => rule.includes("sandbox allow-scripts")).length,
    1,
  );

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
    readFile(path.join(snapshot.outputDir, "_headers")),
    /ENOENT/,
  );
  assert.equal(
    (await readdir(home)).some((entry) =>
      entry.startsWith("snapshot.cloudflare-"),
    ),
    false,
  );
});

test("Cloudflare project creation preserves its production branch", async (t) => {
  const home = await temporaryHome(t);
  const accountId = "A".repeat(32);
  const controlRunner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    stderr: "",
    stdout: "Created project",
  });
  const controlAdapter = new CloudflarePagesAdapter(controlRunner, 9_999);
  await controlAdapter.createProject(
    { accountId, projectName: "html-inbox" },
    home,
    "main",
  );
  assert.deepEqual(
    controlRunner.invocations[0].args.slice(
      process.platform === "win32" ? 3 : 2,
    ),
    ["pages", "project", "create", "html-inbox", "--production-branch", "main"],
  );
});

test("Cloudflare upload redacts credentials and removes staging after failure", async (t) => {
  const { home, snapshot } = await createSnapshot(t);
  const accountId = "A".repeat(32);
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  const previousApiKey = process.env.CLOUDFLARE_API_KEY;
  process.env.CLOUDFLARE_API_TOKEN = "super-secret-cloudflare-token";
  process.env.CLOUDFLARE_API_KEY = "super-secret-cloudflare-key";
  try {
    const failingRunner = new RecordingCommandRunner({
      code: 1,
      signal: null,
      stderr: "",
      stdout:
        "authentication failed: super-secret-cloudflare-token super-secret-cloudflare-key",
    });
    await assert.rejects(
      new CloudflarePagesAdapter(failingRunner).deploySnapshot(snapshot, {
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
});

test("Cloudflare upload rejects invalid account identifiers before invoking Wrangler", async (t) => {
  const { snapshot } = await createSnapshot(t);
  const runner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    stderr: "",
    stdout: "unused",
  });
  await assert.rejects(
    new CloudflarePagesAdapter(runner).deploySnapshot(snapshot, {
      accountId: "not-an-account-id",
      projectName: "html-inbox",
    }),
    /32 hexadecimal/,
  );
  assert.equal(runner.invocations.length, 0);
});

test("Cloudflare upload rejects incomplete common security policy in an otherwise valid snapshot", async (t) => {
  const { snapshot } = await createSnapshot(t);
  const runner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    stderr: "",
    stdout: "unused",
  });
  const headerPath = `i/${snapshot.capability}/security-headers.json`;
  const headers: StaticSecurityHeaders = JSON.parse(
    await readFile(path.join(snapshot.outputDir, headerPath), "utf8"),
  );
  delete headers.common["Cache-Control"];
  const bytes = Buffer.from(JSON.stringify(headers));
  await writeFile(path.join(snapshot.outputDir, headerPath), bytes);

  const manifestFile = snapshot.manifest.files.find(
    (file) => file.path === headerPath,
  );
  assert(manifestFile);
  manifestFile.size = bytes.length;
  manifestFile.sha256 = createHash("sha256").update(bytes).digest("hex");
  snapshot.manifest.snapshotHash = hashManifestFiles(snapshot.manifest.files);
  await writeFile(
    path.join(snapshot.outputDir, snapshot.inboxPath, "snapshot-manifest.json"),
    JSON.stringify(snapshot.manifest),
  );

  await assert.rejects(
    new CloudflarePagesAdapter(runner).deploySnapshot(snapshot, {
      accountId: "a".repeat(32),
      projectName: "html-inbox",
    }),
    /common security policy is incomplete/,
  );
  assert.equal(runner.invocations.length, 0);
});

test("Cloudflare upload rejects files above its size limit before invoking Wrangler", async (t) => {
  const { snapshot } = await createSnapshot(t);
  const runner = new RecordingCommandRunner({
    code: 0,
    signal: null,
    stderr: "",
    stdout: "unused",
  });
  const accountId = "A".repeat(32);
  const oversizedPath = path.join(snapshot.outputDir, "oversized.bin");
  const oversizedFile = await open(oversizedPath, "w");
  await oversizedFile.truncate(CLOUDFLARE_UPLOAD_FILE_SIZE_LIMIT + 1);
  await oversizedFile.close();
  try {
    await assert.rejects(
      new CloudflarePagesAdapter(runner).deploySnapshot(snapshot, {
        accountId,
        projectName: "html-inbox",
      }),
      /file exceeds 25 MiB/,
    );
  } finally {
    await rm(oversizedPath);
  }
  assert.equal(runner.invocations.length, 0);
});

async function createSnapshot(t: TestContext) {
  const home = await temporaryHome(t);
  const backend = new LocalDocumentBackend(home);
  await backend.publish({
    originalBytes: Buffer.from(
      "<!doctype html><html><body>Report</body></html>",
    ),
    title: "Report",
    type: "report",
    sourceFileName: "report.html",
  });
  const snapshot = await exportStaticSnapshot(backend, {
    outputDir: path.join(home, "snapshot"),
  });
  return { home, snapshot };
}

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
