import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPackageTailscaleFixture } from "./package-tailscale-fixture.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "html-inbox-package-"));
let viewer;

try {
  assert.equal(process.argv.length <= 3, true, "Pass at most one package tarball");
  let tarballPath = process.argv[2]
    ? path.resolve(repositoryRoot, process.argv[2])
    : "";

  if (tarballPath) {
    assert.equal(path.extname(tarballPath), ".tgz", "Package artifact must be a .tgz file");
    assert.equal((await stat(tarballPath)).isFile(), true);
  } else {
    const packResult = await run(
      "npm",
      ["pack", "--pack-destination", temporaryRoot],
      path.join(repositoryRoot, "packages", "cli"),
      { npm_config_cache: path.join(temporaryRoot, "npm-cache") },
    );
    const tarballs = (await readdir(temporaryRoot)).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, `Expected one package tarball.\n${packResult.output}`);
    tarballPath = path.join(temporaryRoot, tarballs[0]);
  }

  const consumerRoot = path.join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "html-inbox-package-smoke", private: true }, null, 2)}\n`,
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarballPath,
    ],
    consumerRoot,
    { npm_config_cache: path.join(temporaryRoot, "npm-cache") },
  );

  const installedRoot = path.join(consumerRoot, "node_modules", "html-inbox");
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(installedPackage.bin, { "html-inbox": "bundle/index.js" });
  assert.equal(installedPackage.dependencies, undefined);
  assert.equal(installedPackage.devDependencies, undefined);

  const executable = path.join(installedRoot, "bundle", "index.js");
  assert.equal((await stat(executable)).isFile(), true);
  assert.equal((await run(process.execPath, [executable, "--version"], consumerRoot)).output.trim(), installedPackage.version);
  const installedBin = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "html-inbox.cmd" : "html-inbox",
  );
  assert.equal((await run(installedBin, ["--version"], consumerRoot)).output.trim(), installedPackage.version);
  const help = (await run(process.execPath, [executable, "--help"], consumerRoot)).output;
  assert.match(help, /remote init --account/);
  assert.match(help, /export --out <directory>/);
  assert.match(help, /viewer \[--foreground\]/);
  assert.match(help, /viewer service install/);

  const isolatedHome = path.join(temporaryRoot, "home");
  const viewerPort = await findAvailablePort();
  const cliEnvironment = {
    HTML_INBOX_HOME: isolatedHome,
    HTML_INBOX_PORT: String(viewerPort),
  };

  // Invoke the installed bundle without a shell so Windows preserves paths and titles with spaces.
  // The npm-installed command shim is checked separately above.
  const runInstalledCli = (args) => run(
    process.execPath,
    [executable, ...args],
    consumerRoot,
    cliEnvironment,
  );
  const status = await runInstalledCli(["remote", "status", "--json"]);
  assert.deepEqual(JSON.parse(status.stdout), {
    configured: false,
    state: null,
    operation: null,
  });

  // Own a foreground process so even a failed publish cannot strand a detached viewer.
  viewer = await startInstalledViewer(executable, consumerRoot, cliEnvironment);
  const originalHtml = Buffer.from(
    '<!doctype html><html><head><title>Installed report</title></head><body><h1>Packaged quarterly results</h1><p>Revenue grew by 12%.</p></body></html>\n',
  );
  const sourcePath = path.join(consumerRoot, "quarterly-results.html");
  await writeFile(sourcePath, originalHtml);
  const published = await runInstalledCli(
    ["publish", sourcePath, "--title", "Installed quarterly report", "--type", "report"],
  );
  const documentUrl = new URL(published.stdout.trim());
  assert.equal(documentUrl.origin, viewer.origin);
  assert.match(documentUrl.pathname, /^\/documents\/[a-zA-Z0-9_-]+$/);
  const documentId = documentUrl.pathname.split("/").at(-1);

  const listed = await runInstalledCli(["list", "--json"]);
  const documents = JSON.parse(listed.stdout);
  assert.equal(Array.isArray(documents), true);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, documentId);
  assert.equal(documents[0].title, "Installed quarterly report");
  assert.equal(documents[0].type, "report");
  assert.equal(documents[0].sourceFileName, "quarterly-results.html");

  const inbox = await fetch(viewer.origin, { signal: AbortSignal.timeout(3000) });
  assert.equal(inbox.status, 200);
  assert.match(await inbox.text(), /Installed quarterly report/);
  const shell = await fetch(documentUrl, { signal: AbortSignal.timeout(3000) });
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<iframe sandbox="allow-scripts"/);
  const content = await fetch(`${documentUrl.href}/content`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), originalHtml);

  const exportRoot = path.join(temporaryRoot, "export");
  const exported = await runInstalledCli(
    ["export", "--out", exportRoot, "--json"],
  );
  const exportResult = JSON.parse(exported.stdout);
  assert.equal(exportResult.manifest.documentCount, 1);
  assert.equal(exportResult.outputDir, exportRoot);
  assert.match(exportResult.inboxPath, /^\/i\/[A-Za-z0-9_-]{22}$/);
  const snapshotInbox = path.join(exportRoot, exportResult.inboxPath.slice(1));
  assert.match(await readFile(path.join(snapshotInbox, "index.html"), "utf8"), /Installed quarterly report/);
  assert.match(
    await readFile(path.join(snapshotInbox, "documents", documentId, "index.html"), "utf8"),
    new RegExp(`${exportResult.inboxPath}/documents/${documentId}/content/`),
  );
  assert.deepEqual(
    await readFile(path.join(snapshotInbox, "documents", documentId, "content", "index.html")),
    originalHtml,
  );
  const manifest = JSON.parse(await readFile(path.join(snapshotInbox, "snapshot-manifest.json"), "utf8"));
  assert.deepEqual(manifest, exportResult.manifest);
  assert.match(manifest.snapshotHash, /^[a-f0-9]{64}$/);
  assert.equal((await stat(path.join(exportRoot, "index.html"))).isFile(), true);
  assert.equal(
    (await stat(path.join(exportRoot, "__html-inbox", "ownership.json"))).isFile(),
    true,
  );

  const stopped = await runInstalledCli(["viewer", "stop"]);
  assert.equal(JSON.parse(stopped.stdout).state, "stopped");
  await viewer.close();
  const viewerStatus = await runInstalledCli(["viewer", "status"]);
  assert.equal(JSON.parse(viewerStatus.stdout).state, "stopped");

  const backgroundStarts = await Promise.all([
    runInstalledCli(["viewer"]),
    runInstalledCli(["viewer"]),
    runInstalledCli(["viewer"]),
  ]);
  for (const started of backgroundStarts) {
    assert.equal(started.stdout.trim(), viewer.origin);
  }

  const backgroundStatus = JSON.parse((await runInstalledCli(["viewer", "status"])).stdout);
  assert.equal(backgroundStatus.state, "running");
  assert.equal(typeof backgroundStatus.pid, "number");
  assert.equal((await fetch(`${viewer.origin}/health`)).status, 200);
  assert.equal(JSON.parse((await runInstalledCli(["viewer", "status"])).stdout).pid, backgroundStatus.pid);
  assert.equal(JSON.parse((await runInstalledCli(["viewer", "stop"])).stdout).state, "stopped");

  const restartedPublish = await runInstalledCli(
    ["publish", sourcePath, "--title", "Published after stop", "--type", "report"],
  );
  assert.equal((await fetch(restartedPublish.stdout.trim())).status, 200);
  assert.equal(JSON.parse((await runInstalledCli(["viewer", "stop"])).stdout).state, "stopped");

  await runInstalledCli(["viewer", "--lan", "--host", "127.0.0.1", "--port", String(viewerPort)]);
  assert.equal(JSON.parse((await runInstalledCli(["viewer", "status"])).stdout).exposure, "lan");
  const lanPublish = await runInstalledCli(["publish", sourcePath, "--title", "LAN report", "--type", "report"]);
  assert.equal(new URL(lanPublish.stdout.trim()).origin, viewer.origin);
  assert.equal((await fetch(lanPublish.stdout.trim())).status, 200);
  assert.deepEqual(await (await fetch(`${viewer.origin}/health`)).json(), { ok: true });
  assert.equal(JSON.parse((await runInstalledCli(["viewer", "stop"])).stdout).state, "stopped");

  await runInstalledCli(["viewer", "--loopback"]);
  assert.equal(JSON.parse((await runInstalledCli(["viewer", "status"])).stdout).exposure, "loopback");
  await runInstalledCli(["viewer", "stop"]);

  if (process.platform !== "win32") {
    const fixture = await createPackageTailscaleFixture(path.join(temporaryRoot, "recording-tailscale"));
    const runTailscaleCli = (args) => run(process.execPath, [executable, ...args], consumerRoot, {
      ...cliEnvironment,
      HTML_INBOX_TAILSCALE_COMMAND: fixture.executable,
    });
    const tailnetOrigin = `https://${fixture.hostname}`;
    assert.equal((await runTailscaleCli(["viewer", "--tailscale"])).stdout.trim(), tailnetOrigin);
    const tailscaleStatus = JSON.parse((await runTailscaleCli(["viewer", "status"])).stdout);
    assert.equal(tailscaleStatus.state, "running");
    assert.equal(tailscaleStatus.exposure, "tailscale");
    assert.equal("controlUrl" in tailscaleStatus, false);
    assert.equal((await runTailscaleCli(["viewer"])).stdout.trim(), tailnetOrigin);
    assert.equal(JSON.parse((await runTailscaleCli(["viewer", "status"])).stdout).pid, tailscaleStatus.pid);

    const tailnetPublish = await runTailscaleCli(["publish", sourcePath, "--title", "Tailnet report", "--type", "report"]);
    const tailnetDocument = new URL(tailnetPublish.stdout.trim());
    assert.equal(tailnetDocument.origin, tailnetOrigin);
    const proxiedContent = await readWithHost(new URL(`${tailnetDocument.pathname}/content`, viewer.origin), fixture.hostname);
    assert.equal(proxiedContent.statusCode, 200);
    assert.deepEqual(proxiedContent.body, originalHtml);
    assert.match(proxiedContent.headers["content-security-policy"], /sandbox allow-scripts/);

    assert.equal(JSON.parse((await runTailscaleCli(["viewer", "stop"])).stdout).state, "stopped");
    assert.deepEqual(JSON.parse(await readFile(fixture.configPath, "utf8")), fixture.originalConfig);
    await assert.rejects(readFile(path.join(isolatedHome, "tailscale-serve.json")), { code: "ENOENT" });
    const commands = (await readFile(fixture.commandsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(commands.filter((args) => args[0] === "serve" && args[1] !== "status"), [
      ["serve", "--bg", "--yes", "--https=443", "--set-path=/", `http://127.0.0.1:${viewerPort}`],
      ["serve", "--bg", "--yes", "--https=443", "--set-path=/", "off"],
    ]);
    console.log("Installed package Tailscale startup, publishing, reuse, and scoped cleanup passed with a recording executable.");
  }

  if ((process.platform === "linux" || process.platform === "darwin") && process.getuid?.() !== 0) {
    await assert.rejects(runInstalledCli(["viewer", "service", "install", "--user", userInfo().username]), /administrator privileges/);
  }

  console.log("Installed package foreground, detached concurrency, LAN, exposure reset, publish restart, content, export, and shutdown passed.");
} finally {
  try {
    await viewer?.close();
    const installedExecutable = path.join(temporaryRoot, "consumer", "node_modules", "html-inbox", "bundle", "index.js");
    await run(process.execPath, [installedExecutable, "viewer", "stop"], temporaryRoot, {
      HTML_INBOX_HOME: path.join(temporaryRoot, "home"),
    }).catch(() => {});
  } finally {
    if (process.env.HTML_INBOX_KEEP_PACKAGE_SMOKE !== "1") {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === "win32" && command !== process.execPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const output = stdout + stderr;
      if (code === 0) {
        resolve({ output, stdout, stderr });
        return;
      }

      reject(new Error(`${command} failed (${signal ?? code}).\n${output}`));
    });
  });
}

async function findAvailablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== "string");

  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function readWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: host }, timeout: 3000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once("timeout", () => request.destroy(new Error("Recorded proxy request timed out")));
    request.once("error", reject);
  });
}

async function startInstalledViewer(executable, cwd, env) {
  const child = spawn(process.execPath, [executable, "viewer", "--foreground"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let failure;
  let stderr = "";
  child.once("error", (error) => { failure = error; });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }

    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await closed;
    } finally {
      clearTimeout(timeout);
    }
  };

  const origin = `http://127.0.0.1:${env.HTML_INBOX_PORT}`;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Installed viewer exited before readiness.\n${failure ?? stderr}`);
      }

      const record = await readFile(path.join(env.HTML_INBOX_HOME, "viewer.json"), "utf8")
        .then((value) => JSON.parse(value)).catch(() => null);
      const response = record && await fetch(record.controlUrl, {
        signal: AbortSignal.timeout(500),
      }).catch(() => null);
      if (response?.ok) {
        const health = await response.json();
        assert.equal(health.ok, true);
        assert.equal(health.pid, child.pid);

        return { origin, close };
      }

      await delay(50);
    }

    throw new Error(`Installed viewer did not become ready at ${origin}.\n${stderr}`);
  } catch (error) {
    await close();

    throw error;
  }
}
