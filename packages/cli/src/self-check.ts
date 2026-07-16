import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import {
  CLOUDFLARE_HEADER_LINE_LIMIT,
  CloudflareDeployMetadata,
  CloudflareDeployReceipt,
  CloudflareDeploymentSummary,
  CloudflarePagesAdapter,
  CloudflareProjectRef,
  CloudflareProjectSummary,
  CloudflareSnapshotRef,
  CommandInvocation,
  CommandResult,
  CommandRunner,
  NodeCommandRunner,
  PINNED_WRANGLER_VERSION,
  parseWranglerDeployUrls,
  parseWranglerDeployments,
  parseWranglerProjects,
} from "./cloudflare-pages";
import {
  formatDeleteResult,
  formatDocumentList,
  formatRemoteState,
  formatRemoteStatus,
  formatStaticExportResult,
  formatUsage,
  getCliVersion,
} from "./index";
import { loadPublishInput } from "./publish-input";
import { RemoteDeploymentPort, RemoteWorkflow } from "./remote-workflow";
import {
  exportStaticSnapshot,
  generateInboxCapability,
  SnapshotManifest,
} from "./static-export";
import {
  documentCsp,
  ensureViewer,
  getViewerStatus,
  startViewer,
  stopViewer,
  VIEWER_PROTOCOL_VERSION,
} from "./viewer";

async function run(): Promise<void> {
  assert.match(formatUsage(), /publish <file\.html>/);
  assert.match(formatUsage(), /viewer/);
  assert.match(formatUsage(), /delete <id>/);
  assert.match(formatUsage(), /export --out <directory>/);
  assert.match(formatUsage(), /remote init --account/);
  assert.equal(getCliVersion(), "0.1.0");
  for (let index = 0; index < 10; index += 1) {
    const generatedCapability = generateInboxCapability();
    assert.equal(generatedCapability.length, 22);
    assert.equal(Buffer.from(generatedCapability, "base64url").byteLength, 16);
    assert.equal(
      Buffer.from(generatedCapability, "base64url").toString("base64url"),
      generatedCapability,
    );
  }
  const commandResult = await new NodeCommandRunner().run({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write(process.env.HTML_INBOX_RUNNER_TEST || ""); process.stderr.write(" stderr")',
    ],
    cwd: process.cwd(),
    env: { HTML_INBOX_RUNNER_TEST: "runner-ok" },
    timeoutMs: 5_000,
  });
  assert.equal(commandResult.code, 0);
  assert.equal(commandResult.output.includes("runner-ok"), true);
  assert.equal(commandResult.output.includes("stderr"), true);
  assert.deepEqual(
    parseWranglerDeployUrls(
      "\u001b[32mDeployment: https://abc123.assigned-project.pages.dev\u001b[0m",
    ),
    {
      deploymentUrl: "https://abc123.assigned-project.pages.dev",
      productionUrl: "https://assigned-project.pages.dev",
    },
  );
  assert.throws(() => parseWranglerDeployUrls("deployment finished without a URL"), /without returning/);
  assert.deepEqual(
    parseWranglerProjects(
      JSON.stringify([
        {
          name: "inbox-project",
          account_id: "a".repeat(32),
          production_branch: "main",
          domains: ["inbox-project.pages.dev"],
        },
      ]),
    ),
    [
      {
        name: "inbox-project",
        accountId: "a".repeat(32),
        productionBranch: "main",
        productionUrl: "https://inbox-project.pages.dev",
      },
    ],
  );
  assert.equal(
    parseWranglerDeployments(
      JSON.stringify([
        {
          id: "deployment-id",
          url: "https://abc123.inbox-project.pages.dev",
          environment: "production",
          created_on: "2026-07-16T00:00:00.000Z",
          deployment_trigger: {
            metadata: {
              branch: "main",
              commit_hash: "b".repeat(40),
              commit_message: "html-inbox:test",
            },
          },
        },
      ]),
    )[0].commitHash,
    "b".repeat(40),
  );

  const inputHome = await mkdtemp(path.join(tmpdir(), "html-inbox-input-"));
  const inputPath = path.join(inputHome, "report.html");
  const inputHtml = "<!doctype html><html><body>bounded</body></html>";
  await writeFile(inputPath, inputHtml);
  await assert.rejects(
    loadPublishInput(
      { filePath: inputPath, title: "Report", type: "report" },
      { HTML_INBOX_MAX_BYTES: "8" },
    ),
    /the limit is 8 bytes/,
  );
  await assert.rejects(
    loadPublishInput(
      { filePath: inputPath, title: " ", type: "report" },
      { HTML_INBOX_MAX_BYTES: "1024" },
    ),
    /title must not be empty/,
  );

  if (process.platform !== "win32") {
    const unsafeHome = await mkdtemp(path.join(tmpdir(), "html-inbox-unsafe-"));
    const symlinkTarget = path.join(unsafeHome, "target.txt");
    await writeFile(symlinkTarget, "do not overwrite");
    await symlink(symlinkTarget, path.join(unsafeHome, "instance-id"));
    await assert.rejects(
      startViewer(new LocalDocumentBackend(unsafeHome), unsafeHome, 0),
      /Managed file is not a regular file/,
    );
    assert.equal(await readFile(symlinkTarget, "utf8"), "do not overwrite");
  }

  const blockedHome = await mkdtemp(path.join(tmpdir(), "html-inbox-blocked-"));
  const blocker = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const blockerAddress = blocker.address();
  assert(blockerAddress && typeof blockerAddress !== "string");
  await assert.rejects(
    ensureViewer(blockedHome, blockerAddress.port),
    /Port .* is already in use/,
  );
  await new Promise<void>((resolve, reject) =>
    blocker.close((error) => (error ? reject(error) : resolve())),
  );

  const lifecycleHome = await mkdtemp(path.join(tmpdir(), "html-inbox-lifecycle-"));
  const lifecyclePort = await reservePort();
  const viewerProcess = spawn(process.execPath, [path.join(__dirname, "index.js"), "viewer"], {
    env: {
      ...process.env,
      HTML_INBOX_HOME: lifecycleHome,
      HTML_INBOX_PORT: String(lifecyclePort),
    },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 3000;
    while (
      (await getViewerStatus(lifecycleHome, lifecyclePort)).state !== "running" &&
      Date.now() < deadline
    ) {
      await delay(50);
    }
    assert.equal((await getViewerStatus(lifecycleHome, lifecyclePort)).state, "running");
    assert.equal((await stopViewer(lifecycleHome, lifecyclePort)).state, "stopped");
    if (viewerProcess.exitCode === null) {
      await once(viewerProcess, "exit");
    }
  } finally {
    if (viewerProcess.exitCode === null) {
      viewerProcess.kill("SIGTERM");
    }
  }

  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-"));
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (warning) => warnings.push(warning));
  assert.equal(await backend.getDocument("missing"), null);
  await assert.rejects(
    stat(path.join(home, "documents", "missing")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const failedViewerHome = await mkdtemp(path.join(tmpdir(), "html-inbox-failed-viewer-"));
  await mkdir(path.join(failedViewerHome, "viewer.json"));
  const failedViewerPort = await availablePort();
  await assert.rejects(
    startViewer(new LocalDocumentBackend(failedViewerHome), failedViewerHome, failedViewerPort),
    /Managed file is not a regular file/,
  );
  await assertPortAvailable(failedViewerPort);

  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const server = await startViewer(backend, home, 0);
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.ok, true);
    const health = (await healthResponse.json()) as Record<string, unknown>;
    assert.equal(health.protocolVersion, VIEWER_PROTOCOL_VERSION);
    assert.equal(typeof health.instanceId, "string");
    assert.equal("home" in health, false);

    const hostileHost = await requestWithHost(address.port, "attacker.example");
    assert.equal(hostileHost.statusCode, 421);
    assert.equal((await getViewerStatus(home, address.port)).state, "running");

    const interruptedStaging = path.join(home, "documents", ".staging", "interrupted");
    await mkdir(interruptedStaging, { recursive: true });
    await writeFile(path.join(interruptedStaging, "index.html"), html);

    const emptyIndex = await fetch(baseUrl);
    const emptyIndexCsp = emptyIndex.headers.get("content-security-policy") ?? "";
    const emptyIndexHtml = await emptyIndex.text();
    assert.equal(emptyIndexHtml.includes('class="empty-state"'), true);
    assert.equal(emptyIndexHtml.includes("No documents yet"), true);
    assert.equal(emptyIndexHtml.includes("0 documents"), true);

    const published = await backend.publish({
      originalBytes: Buffer.from(html),
      title: "Report",
      type: "report",
      sourceFileName: "report.html",
    });
    assert.equal(published.metadata.schemaVersion, 1);
    const stored = await readFile(
      path.join(home, "documents", published.metadata.id, "index.html"),
      "utf8",
    );
    assert.equal(stored, html);

    if (process.platform !== "win32") {
      assert.equal((await stat(home)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(home, "documents", published.metadata.id))).mode & 0o777,
        0o700,
      );
      assert.equal(
        (await stat(path.join(home, "documents", published.metadata.id, "index.html"))).mode &
          0o777,
        0o600,
      );
      assert.equal((await stat(path.join(home, "instance-id"))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(home, "viewer.json"))).mode & 0o777, 0o600);
    }

    const singularIndex = await fetch(baseUrl);
    const indexCsp = singularIndex.headers.get("content-security-policy") ?? "";
    assert.equal(indexCsp.includes("script-src 'self'"), true);
    assert.equal(indexCsp.includes("style-src 'self'"), true);
    assert.equal(indexCsp.includes("'unsafe-inline'"), false);
    assert.equal(emptyIndexCsp, indexCsp);
    const singularIndexHtml = await singularIndex.text();
    assert.equal(singularIndexHtml.includes('class="document-list"'), true);
    assert.equal(singularIndexHtml.includes("report.html"), true);
    assert.equal(singularIndexHtml.includes('data-theme-selector'), true);
    assert.equal(singularIndexHtml.includes("1 document"), true);
    assert.equal(singularIndexHtml.includes("1 documents"), false);

    const stylesheet = await fetch(`${baseUrl}/assets/viewer.css`);
    assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
    const stylesheetText = await stylesheet.text();
    assert.equal(stylesheetText.includes('[data-theme="dark"]'), true);
    assert.equal(stylesheetText.includes("--muted: #5d655f"), true);
    assert.equal(stylesheetText.includes("--faint: #646c66"), true);

    const viewerScript = await fetch(`${baseUrl}/assets/viewer.js`);
    assert.equal(viewerScript.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await viewerScript.text()).includes("html-inbox-theme"), true);

    const shell = await fetch(`${baseUrl}/documents/${published.metadata.id}`);
    assert.equal(shell.headers.get("content-security-policy")?.includes("frame-src 'self'"), true);
    const shellHtml = await shell.text();
    assert.equal(shellHtml.includes('<iframe sandbox="allow-scripts"'), true);
    assert.equal(shellHtml.includes("allow-same-origin"), false);
    assert.equal(shellHtml.includes("report.html"), true);
    assert.equal(shellHtml.includes("Back to inbox"), true);

    const content = await fetch(`${baseUrl}/documents/${published.metadata.id}/content`);
    const csp = content.headers.get("content-security-policy") ?? "";
    assert.equal(csp.includes("script-src 'unsafe-inline' https://cdn.tailwindcss.com"), true);
    assert.equal(csp.includes("https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"), true);
    assert.equal(csp.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/"), true);
    assert.equal(csp.includes("connect-src 'none'"), true);
    assert.equal(csp.includes("frame-src 'none'"), true);
    assert.equal(await content.text(), html);

    const hostileTitle = 'Title </h1><script>alert("title")</script>';
    const hostileType = "report\"><svg/onload=alert('type')>";
    const hostileSource = 'source.html\" autofocus onfocus="alert(\'source\')';
    const hostile = await backend.publish({
      originalBytes: Buffer.from(html),
      title: hostileTitle,
      type: hostileType,
      sourceFileName: hostileSource,
    });

    const pluralIndexHtml = await (await fetch(baseUrl)).text();
    assert.equal(pluralIndexHtml.includes("2 documents"), true);
    assert.equal(pluralIndexHtml.includes(hostileTitle), false);
    assert.equal(pluralIndexHtml.includes(hostileType), false);
    assert.equal(pluralIndexHtml.includes(hostileSource), false);

    const searchResultHtml = await (await fetch(`${baseUrl}/?q=report.html`)).text();
    assert.equal(searchResultHtml.includes("1 of 2 documents"), true);
    assert.equal(searchResultHtml.includes("Search documents"), true);
    assert.equal(searchResultHtml.includes('value="report.html"'), true);
    const noSearchResultHtml = await (await fetch(`${baseUrl}/?q=missing`)).text();
    assert.equal(noSearchResultHtml.includes("No matching documents"), true);
    assert.equal(
      pluralIndexHtml.includes(
        "Title &#60;/h1&#62;&#60;script&#62;alert(&#34;title&#34;)&#60;/script&#62;",
      ),
      true,
    );
    assert.equal(
      pluralIndexHtml.includes(
        "report&#34;&#62;&#60;svg/onload=alert(&#39;type&#39;)&#62;",
      ),
      true,
    );
    assert.equal(
      pluralIndexHtml.includes(
        "source.html&#34; autofocus onfocus=&#34;alert(&#39;source&#39;)",
      ),
      true,
    );

    const hostileShellHtml = await (
      await fetch(`${baseUrl}/documents/${hostile.metadata.id}`)
    ).text();
    assert.equal(hostileShellHtml.includes(hostileTitle), false);
    assert.equal(hostileShellHtml.includes(hostileType), false);
    assert.equal(hostileShellHtml.includes(hostileSource), false);
    assert.equal(hostileShellHtml.includes("&#60;/h1&#62;"), true);
    assert.equal(
      hostileShellHtml.includes(
        "report&#34;&#62;&#60;svg/onload=alert(&#39;type&#39;)&#62;",
      ),
      true,
    );
    assert.equal(
      hostileShellHtml.includes(
        "source.html&#34; autofocus onfocus=&#34;alert(&#39;source&#39;)",
      ),
      true,
    );
    assert.equal(hostileShellHtml.includes('onfocus="alert'), false);

    const snapshotDirectory = path.join(home, "snapshot");
    const capability = "AAAAAAAAAAAAAAAAAAAAAA";
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const firstSnapshot = await exportStaticSnapshot(backend, {
      outputDir: snapshotDirectory,
      capability,
      ownerId,
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    assert.equal(firstSnapshot.inboxPath, `/i/${capability}`);
    assert.equal(firstSnapshot.manifest.documentCount, 2);
    assert.match(formatStaticExportResult(firstSnapshot, false), /Exported 2 documents/);
    assert.equal(
      JSON.parse(formatStaticExportResult(firstSnapshot, true)).capability,
      capability,
    );

    const snapshotRoot = await readFile(path.join(snapshotDirectory, "index.html"), "utf8");
    assert.equal(snapshotRoot.includes(capability), false);
    assert.equal(snapshotRoot.includes("no public inbox listing"), true);
    const snapshotIndex = await readFile(
      path.join(snapshotDirectory, "i", capability, "index.html"),
      "utf8",
    );
    assert.equal(snapshotIndex.includes(`src="/i/${capability}/assets/viewer.js"`), true);
    assert.equal(snapshotIndex.includes("data-client-search"), true);
    assert.equal(
      snapshotIndex.includes(`/i/${capability}/documents/${published.metadata.id}/`),
      true,
    );
    const snapshotShell = await readFile(
      path.join(
        snapshotDirectory,
        "i",
        capability,
        "documents",
        published.metadata.id,
        "index.html",
      ),
      "utf8",
    );
    assert.equal(
      snapshotShell.includes(
        `/i/${capability}/documents/${published.metadata.id}/content/`,
      ),
      true,
    );
    assert.deepEqual(
      await readFile(
        path.join(
          snapshotDirectory,
          "i",
          capability,
          "documents",
          published.metadata.id,
          "content",
          "index.html",
        ),
      ),
      Buffer.from(html),
    );

    const ownerMarker = JSON.parse(
      await readFile(
        path.join(snapshotDirectory, "__html-inbox", "ownership.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(ownerMarker, { schemaVersion: 1, ownerId });
    const securityHeaders = JSON.parse(
      await readFile(
        path.join(snapshotDirectory, "i", capability, "security-headers.json"),
        "utf8",
      ),
    ) as {
      common: Record<string, string>;
      document: Record<string, string>;
    };
    assert.equal(securityHeaders.document["Content-Security-Policy"], documentCsp());
    assert.equal(securityHeaders.common["X-Robots-Tag"], "noindex, nofollow, noarchive");
    assert.deepEqual(
      firstSnapshot.manifest.files.map((file) => file.path),
      firstSnapshot.manifest.files.map((file) => file.path).sort(),
    );
    const manifestText = await readFile(
      path.join(snapshotDirectory, "i", capability, "snapshot-manifest.json"),
      "utf8",
    );
    assert.equal(manifestText.includes(home), false);

    const secondSnapshot = await exportStaticSnapshot(backend, {
      outputDir: snapshotDirectory,
      capability,
      ownerId,
      generatedAt: "2026-07-16T01:00:00.000Z",
    });
    assert.equal(secondSnapshot.manifest.snapshotHash, firstSnapshot.manifest.snapshotHash);

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
    assert.equal(deploymentInvocation.command, "npx");
    assert.deepEqual(deploymentInvocation.args, [
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
    });
    assert.equal(deploymentInvocation.timeoutMs, 12_345);
    assert.equal(
      deploymentInvocation.args.some((argument) => argument.includes("token")),
      false,
    );
    assert.equal(receipt.deploymentUrl, "https://abc123.html-inbox-7x.pages.dev");
    assert.equal(receipt.productionUrl, "https://html-inbox-7x.pages.dev");
    assert.equal(
      receipt.productionInboxUrl,
      `https://html-inbox-7x.pages.dev/i/${capability}/`,
    );
    assert(recordingRunner.headers);
    assert.equal(recordingRunner.headers.includes("/documents/:id/content/*"), true);
    assert.equal(recordingRunner.headers.includes(documentCsp()), true);
    assert.equal(
      recordingRunner.headers.split("\n").every((line) => line.length <= CLOUDFLARE_HEADER_LINE_LIMIT),
      true,
    );
    assert.equal(
      recordingRunner.headers
        .split("\n")
        .filter((line) => line && !line.startsWith(" ")).length,
      8,
    );
    await assert.rejects(readFile(path.join(snapshotDirectory, "_headers")), /ENOENT/);
    assert.equal(
      (await readdir(home)).some((entry) => entry.startsWith("snapshot.cloudflare-")),
      false,
    );

    const controlRunner = new RecordingCommandRunner({
      code: 0,
      signal: null,
      output: JSON.stringify([
        {
          name: "html-inbox",
          account_id: accountId.toLowerCase(),
          production_branch: "main",
          domains: ["html-inbox-7x.pages.dev"],
        },
      ]),
    });
    const controlAdapter = new CloudflarePagesAdapter(controlRunner, 9_999);
    const projects = await controlAdapter.listProjects(accountId, home);
    assert.equal(projects[0].productionUrl, "https://html-inbox-7x.pages.dev");
    await controlAdapter.createProject(
      { accountId, projectName: "html-inbox" },
      home,
      "main",
    );
    assert.deepEqual(controlRunner.invocations[0].args.slice(2), [
      "pages",
      "project",
      "list",
      "--json",
    ]);
    assert.deepEqual(controlRunner.invocations[1].args.slice(2), [
      "pages",
      "project",
      "create",
      "html-inbox",
      "--production-branch",
      "main",
    ]);

    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "super-secret-cloudflare-token";
    try {
      const failingRunner = new RecordingCommandRunner({
        code: 1,
        signal: null,
        output: "authentication failed: super-secret-cloudflare-token",
      });
      await assert.rejects(
        new CloudflarePagesAdapter(failingRunner).deploySnapshot(firstSnapshot, {
          accountId,
          projectName: "html-inbox",
        }),
        (error: Error) =>
          error.message.includes("[redacted]") &&
          !error.message.includes("super-secret-cloudflare-token"),
      );
      assert.equal(
        (await readdir(home)).some((entry) => entry.startsWith("snapshot.cloudflare-")),
        false,
      );
    } finally {
      if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previousToken;
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
        new CloudflarePagesAdapter(recordingRunner).deploySnapshot(firstSnapshot, {
          accountId,
          projectName: "html-inbox",
        }),
        /common security policy is incomplete/,
      );
    } finally {
      await writeFile(securityHeaderPath, originalSecurityHeaders);
    }

    const remoteHome = await mkdtemp(path.join(tmpdir(), "html-inbox-remote-"));
    const remoteBackend = new LocalDocumentBackend(remoteHome);
    await remoteBackend.publish({
      originalBytes: Buffer.from(html),
      title: "Remote report",
      type: "report",
      sourceFileName: "remote-report.html",
    });
    const remotePort = new RecordingRemoteDeploymentPort();
    let clockTick = 0;
    const remoteWorkflow = new RemoteWorkflow(
      remoteBackend,
      remoteHome,
      remotePort,
      () => new Date(Date.UTC(2026, 6, 16, 2, 0, clockTick++)).toISOString(),
    );
    const remoteAccountId = "c".repeat(32);
    const initializedRemote = await remoteWorkflow.init({
      accountId: remoteAccountId,
      projectName: "html-inbox-test",
    });
    assert.equal(remotePort.createdProjects.length, 1);
    assert.equal(initializedRemote.target.projectName, "html-inbox-test");
    assert.match(formatRemoteState(initializedRemote), /State: configured/);
    assert.equal((await remoteWorkflow.status()).operation, null);

    const remoteLockPath = path.join(remoteHome, "remote", "mutation.lock");
    await writeFile(
      remoteLockPath,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(remoteWorkflow.publish(), /Another HTML Inbox remote command is running/);
    await rm(remoteLockPath, { force: true });

    const publishedRemote = await remoteWorkflow.publish();
    assert.equal(publishedRemote.revoked, false);
    assert.equal(publishedRemote.lastDeployment?.kind, "publish");
    assert.match(
      publishedRemote.lastDeployment?.receipt.productionInboxUrl ?? "",
      /^https:\/\/html-inbox-test\.pages\.dev\/i\//,
    );
    assert.match(formatRemoteStatus(await remoteWorkflow.status()), /State: published/);
    assert.equal(remotePort.deployCalls.at(-1)?.manifest.documentCount, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(remoteHome, "remote", "state.json"))).mode & 0o777, 0o600);
    }

    await remoteBackend.publish({
      originalBytes: Buffer.from("<!doctype html><html><body>new remote state</body></html>"),
      title: "Recovery report",
      type: "report",
      sourceFileName: "recovery.html",
    });
    remotePort.failNextDeploy = true;
    await assert.rejects(remoteWorkflow.publish(), /remote reconcile/);
    const interruptedStatus = await remoteWorkflow.status();
    assert(interruptedStatus.operation?.snapshotHash);
    assert.equal(interruptedStatus.operation.phase, "prepared");
    assert.equal(interruptedStatus.operation.attempts, 1);
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(path.join(remoteHome, "remote", "operation.json"))).mode & 0o777,
        0o600,
      );
    }
    const callsBeforeReconcile = remotePort.deployCalls.length;
    remotePort.deployments.push({
      id: "recovered-deployment",
      url: "https://def456.html-inbox-test.pages.dev",
      environment: "production",
      branch: "main",
      createdAt: "2026-07-16T02:30:00.000Z",
      commitHash: interruptedStatus.operation.snapshotHash.slice(0, 40),
      commitMessage: `html-inbox:${interruptedStatus.operation.id}:publish:${interruptedStatus.operation.snapshotHash}`,
    });
    const reconciled = await remoteWorkflow.reconcile();
    assert.equal(remotePort.deployCalls.length, callsBeforeReconcile);
    assert.equal(
      reconciled.lastDeployment?.snapshotHash,
      interruptedStatus.operation.snapshotHash,
    );
    assert.equal((await remoteWorkflow.status()).operation, null);

    const capabilityBeforeRevoke = reconciled.capability;
    const productionUrlBeforeRevoke = reconciled.lastDeployment?.receipt.productionInboxUrl ?? "";
    const revokeResult = await remoteWorkflow.revoke();
    assert.equal(revokeResult.state.revoked, true);
    assert.notEqual(revokeResult.state.capability, capabilityBeforeRevoke);
    assert.equal(revokeResult.revokedUrl, productionUrlBeforeRevoke);
    assert.match(revokeResult.warning, /immutable Cloudflare deployment URLs may still work/);
    const revokeCall = remotePort.deployCalls.at(-1);
    assert.equal(revokeCall?.manifest.documentCount, 0);
    assert.equal(
      revokeCall?.manifest.files.some((file) => file.path.includes(capabilityBeforeRevoke)),
      false,
    );

    const adoptionHome = await mkdtemp(path.join(tmpdir(), "html-inbox-adoption-"));
    const adoptionPort = new RecordingRemoteDeploymentPort();
    adoptionPort.projects.push({
      name: "existing-inbox",
      accountId: remoteAccountId,
      productionBranch: "main",
      productionUrl: "https://existing-inbox.pages.dev",
    });
    const adoptionWorkflow = new RemoteWorkflow(remoteBackend, adoptionHome, adoptionPort);
    await assert.rejects(
      adoptionWorkflow.init({
        accountId: remoteAccountId,
        projectName: "existing-inbox",
      }),
      /--adopt/,
    );
    const adopted = await adoptionWorkflow.init({
      accountId: remoteAccountId,
      projectName: "existing-inbox",
      adopt: true,
    });
    assert.equal(adopted.target.projectName, "existing-inbox");
    assert.equal(adoptionPort.createdProjects.length, 0);

    const initRecoveryHome = await mkdtemp(path.join(tmpdir(), "html-inbox-init-recovery-"));
    const initRecoveryPort = new RecordingRemoteDeploymentPort();
    initRecoveryPort.failNextCreate = true;
    const initRecoveryWorkflow = new RemoteWorkflow(
      remoteBackend,
      initRecoveryHome,
      initRecoveryPort,
    );
    await assert.rejects(
      initRecoveryWorkflow.init({
        accountId: remoteAccountId,
        projectName: "recover-init",
      }),
      /remote reconcile/,
    );
    assert.equal((await initRecoveryWorkflow.status()).operation?.kind, "init");
    initRecoveryPort.projects.push({
      name: "recover-init",
      accountId: remoteAccountId,
      productionBranch: "main",
      productionUrl: "https://recover-init.pages.dev",
    });
    const recoveredInit = await initRecoveryWorkflow.reconcile();
    assert.equal(recoveredInit.target.projectName, "recover-init");
    assert.equal((await initRecoveryWorkflow.status()).operation, null);

    await assert.rejects(
      exportStaticSnapshot(backend, {
        outputDir: path.join(home, "invalid-snapshot"),
        capability: "too-short",
      }),
      /exactly 128 bits/,
    );
    await assert.rejects(
      exportStaticSnapshot(backend, {
        outputDir: path.join(home, "noncanonical-snapshot"),
        capability: "BBBBBBBBBBBBBBBBBBBBBB",
      }),
      /exactly 128 bits/,
    );

    if (process.platform !== "win32") {
      assert.equal((await stat(snapshotDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(snapshotDirectory, "index.html"))).mode & 0o777,
        0o600,
      );
    }

    const corruptId = "corrupt-record";
    const corruptDir = path.join(home, "documents", corruptId);
    await mkdir(corruptDir);
    await writeFile(path.join(corruptDir, "index.html"), html);
    await writeFile(path.join(corruptDir, "metadata.json"), "{not-json");

    const mismatchedId = "mismatched-record";
    const mismatchedDir = path.join(home, "documents", mismatchedId);
    await mkdir(mismatchedDir);
    await writeFile(path.join(mismatchedDir, "index.html"), html);
    await writeFile(
      path.join(mismatchedDir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "different-id",
        title: "Mismatched report",
        type: "report",
        createdAt: "2026-07-16T00:00:00.000Z",
        sourceFileName: "mismatched.html",
      }),
    );

    const documentsAfterCorruption = await backend.listDocuments();
    assert.equal(documentsAfterCorruption.length, 2);
    assert.equal(await backend.getDocument(corruptId), null);
    assert.equal(warnings.some((warning) => warning.includes(corruptId)), true);
    assert.equal(warnings.some((warning) => warning.includes(mismatchedId)), true);

    const textList = formatDocumentList(documentsAfterCorruption, false);
    assert.equal(textList.includes(published.metadata.id), true);
    assert.equal(JSON.parse(formatDocumentList(documentsAfterCorruption, true)).length, 2);

    const deleted = await backend.deleteDocument(hostile.metadata.id);
    assert(deleted);
    assert.equal(deleted.reclaimedBytes > 0, true);
    assert.match(formatDeleteResult(deleted, false), /reclaimed/);
    assert.equal(await backend.getDocument(hostile.metadata.id), null);
    assert.equal((await backend.listDocuments()).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertPortAvailable(port: number): Promise<void> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function requestWithHost(
  port: number,
  host: string,
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/health", headers: { Host: host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RecordingCommandRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];
  headers = "";

  constructor(private readonly result: CommandResult) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(structuredClone(invocation));
    try {
      this.headers = await readFile(path.join(invocation.cwd, "_headers"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.headers = "";
    }
    return this.result;
  }
}

class RecordingRemoteDeploymentPort implements RemoteDeploymentPort {
  readonly projects: CloudflareProjectSummary[] = [];
  readonly deployments: CloudflareDeploymentSummary[] = [];
  readonly createdProjects: CloudflareProjectRef[] = [];
  readonly deployCalls: Array<{
    snapshot: CloudflareSnapshotRef;
    manifest: SnapshotManifest;
    target: CloudflareProjectRef;
    branch: string;
    metadata: CloudflareDeployMetadata;
  }> = [];
  failNextDeploy = false;
  failNextCreate = false;

  async listProjects(): Promise<CloudflareProjectSummary[]> {
    return structuredClone(this.projects);
  }

  async createProject(target: CloudflareProjectRef): Promise<void> {
    this.createdProjects.push(structuredClone(target));
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("simulated ambiguous project creation failure");
    }
    this.projects.push({
      name: target.projectName,
      accountId: target.accountId,
      productionBranch: "main",
      productionUrl: `https://${target.projectName}.pages.dev`,
    });
  }

  async deploySnapshot(
    snapshot: CloudflareSnapshotRef,
    target: CloudflareProjectRef,
    branch = "main",
    metadata?: CloudflareDeployMetadata,
  ): Promise<CloudflareDeployReceipt> {
    assert(metadata);
    const manifestPath = path.join(
      snapshot.outputDir,
      snapshot.inboxPath.slice(1),
      "snapshot-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
    this.deployCalls.push({
      snapshot: structuredClone(snapshot),
      manifest,
      target: structuredClone(target),
      branch,
      metadata: structuredClone(metadata),
    });
    if (this.failNextDeploy) {
      this.failNextDeploy = false;
      throw new Error("simulated ambiguous deploy failure");
    }
    const prefix = this.deployCalls.length.toString(16).padStart(6, "0").slice(-6);
    const deploymentUrl = `https://${prefix}.${target.projectName}.pages.dev`;
    const productionUrl = `https://${target.projectName}.pages.dev`;
    this.deployments.push({
      id: `deployment-${this.deployCalls.length}`,
      url: deploymentUrl,
      environment: "production",
      branch,
      createdAt: new Date(Date.UTC(2026, 6, 16, 3, 0, this.deployCalls.length)).toISOString(),
      commitHash: metadata.commitHash,
      commitMessage: metadata.commitMessage,
    });
    return {
      target: structuredClone(target),
      branch,
      deploymentUrl,
      productionUrl,
      deploymentInboxUrl: `${deploymentUrl}${snapshot.inboxPath}/`,
      productionInboxUrl: `${productionUrl}${snapshot.inboxPath}/`,
    };
  }

  async listDeployments(): Promise<CloudflareDeploymentSummary[]> {
    return structuredClone(this.deployments);
  }
}

void run();
