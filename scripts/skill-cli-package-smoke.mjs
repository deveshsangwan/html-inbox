#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { createPackageTailscaleFixture } from "./package-tailscale-fixture.mjs";
import { readResolution, runResolvedCli } from "./skill-cli-fixtures.mjs";

assert(Number(process.versions.node.split(".")[0]) >= 20, "Registry smoke check requires Node.js 20 or newer");
assert.equal(process.argv.length, 2, "Registry smoke check takes no arguments");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "html-inbox-skill-registry-"));
let resolution;
let consumerRoot;
let cleanupEnvironment;
let failure;

try {
  resolution = await readResolution();
  consumerRoot = path.join(temporaryRoot, "empty consumer");
  await mkdir(consumerRoot);
  const environment = await createConsumerEnvironment(temporaryRoot);
  assert.deepEqual(await readdir(consumerRoot), [], "Fallback must start outside an npm project");
  assert.deepEqual(await readdir(environment.npm_config_cache), [], "Fallback must start with a fresh npm cache");

  console.log("Checking documented resolver with npx --yes html-inbox@0.2.0 and an empty consumer/cache.");
  const version = await runCli(resolution, ["--version"], consumerRoot, environment);
  assert.equal(version.stdout.trim(), "0.2.0", "Fallback version gate must select the pinned release");
  await verifyCachedPackage(environment.npm_config_cache);
  const help = await runCli(resolution, ["--help"], consumerRoot, environment);
  assert.match(help.stdout, /viewer service install \[--user <normal-user>\] \[viewer networking options\]/);
  assert.match(help.stdout, /viewer service uninstall \[--user <normal-user>\]/);

  const sourcePath = path.join(temporaryRoot, "registry report & notes.html");
  const originalHtml = Buffer.from("<!doctype html><html><head><title>Registry report</title></head><body><h1>Pinned registry content</h1><p>Detached viewer test.</p></body></html>\n");
  await writeFile(sourcePath, originalHtml);
  cleanupEnvironment = environment;

  await verifyDetachedLifecycle(resolution, consumerRoot, environment, sourcePath, originalHtml);
  const savedEnvironment = { ...environment, HTML_INBOX_PORT: undefined };
  cleanupEnvironment = savedEnvironment;
  await verifySavedLan(resolution, consumerRoot, savedEnvironment, sourcePath, originalHtml);

  if (process.platform !== "win32") {
    const fixture = await createPackageTailscaleFixture(path.join(temporaryRoot, "recording tailscale"));
    const tailscaleEnvironment = { ...savedEnvironment, ...fixture.environment, HTML_INBOX_TAILSCALE_COMMAND: fixture.executable };
    cleanupEnvironment = tailscaleEnvironment;
    await verifySavedTailscale(resolution, consumerRoot, tailscaleEnvironment, sourcePath, originalHtml, fixture);
  } else {
    console.log("Tailscale recording executable check skipped on Windows; fixture requires a POSIX shebang.");
  }

  await verifyRejectedRecords(resolution, consumerRoot, environment, sourcePath);
  await verifyRegistryFailure(resolution, consumerRoot, environment, sourcePath);
  assert.deepEqual(await readdir(consumerRoot), [], "npx must leave the consumer directory empty");
} catch (error) {
  failure = error;
} finally {
  let cleanupFailure;
  try {
    if (cleanupEnvironment) {
      await cleanupViewer(resolution, consumerRoot, cleanupEnvironment);
    }
  } catch (error) {
    cleanupFailure = error;
    console.error(`Viewer cleanup failed; retained cache and records at ${temporaryRoot}`);
  }

  if (!cleanupFailure) {
    // Windows can briefly retain an executable lock after its child process closes.
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  if (failure && cleanupFailure) {
    throw new AggregateError([failure, cleanupFailure], "Registry smoke check and viewer cleanup failed");
  }

  if (failure || cleanupFailure) {
    throw failure ?? cleanupFailure;
  }
}

console.log(`Pinned registry resolver lifecycle, saved exposure, record rejection, network failure, and cleanup passed using ${process.platform === "win32" ? "PowerShell" : "Bash"}.`);
console.log(`HTML_INBOX_SKILL_PACKAGE_SMOKE_OK node=${process.versions.node} platform=${process.platform}`);

async function createConsumerEnvironment(root) {
  const toolsDirectory = path.join(root, "tools");
  const npmExecutable = await findExecutable(process.platform === "win32" ? "npm.cmd" : "npm");
  const npxExecutable = await findExecutable(process.platform === "win32" ? "npx.cmd" : "npx");
  await mkdir(toolsDirectory);

  // Node and global npm commands can share a directory with html-inbox. Keep only the real prerequisites.
  if (process.platform === "win32") {
    await copyFile(process.execPath, path.join(toolsDirectory, "node.exe"));
    await copyFile(npmExecutable, path.join(toolsDirectory, "npm.cmd"));
    await copyFile(npxExecutable, path.join(toolsDirectory, "npx.cmd"));
    await mkdir(path.join(toolsDirectory, "node_modules"));
    await cp(path.join(path.dirname(npxExecutable), "node_modules", "npm"), path.join(toolsDirectory, "node_modules", "npm"), { recursive: true });
  } else {
    await symlink(process.execPath, path.join(toolsDirectory, "node"));
    await symlink(await realpath(npmExecutable), path.join(toolsDirectory, "npm"));
    await symlink(await realpath(npxExecutable), path.join(toolsDirectory, "npx"));
  }

  const searchDirectories = [toolsDirectory];
  for (const entry of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) {
      continue;
    }

    if (!(await hasInboxExecutable(entry))) {
      searchDirectories.push(entry);
    }
  }

  const home = path.join(root, "user home");
  const cache = path.join(root, "npm cache");
  await mkdir(home);
  await mkdir(cache);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    PATH: searchDirectories.join(path.delimiter),
    npm_config_cache: cache,
    npm_config_registry: process.env.npm_config_registry ?? "https://registry.npmjs.org",
    npm_config_update_notifier: "false",
    HTML_INBOX_HOME: path.join(root, "inbox home"),
    HTML_INBOX_PORT: String(await findAvailablePort()),
    HTML_INBOX_TAILSCALE_COMMAND: undefined,
    HTML_INBOX_VIEWER_CONFIG: undefined,
    HTML_INBOX_START_LOCK: undefined,
    HTML_INBOX_VIEWER_SERVICE_LOG: undefined,
  };

  for (const name of Object.keys(process.env)) {
    if (name.toLowerCase() === "path" && name !== "PATH") {
      environment[name] = undefined;
    }
  }

  for (const directory of searchDirectories) {
    assert.equal(await hasInboxExecutable(directory), false, `html-inbox must be absent from PATH: ${directory}`);
  }

  return environment;
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    const candidate = path.resolve(directory, name);
    if (await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) {
      return candidate;
    }
  }

  throw new Error(`Required npm executable is missing: ${name}`);
}

async function hasInboxExecutable(directory) {
  const names = process.platform === "win32"
    ? ["html-inbox", ...new Set((process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => `html-inbox${extension.toLowerCase()}`))]
    : ["html-inbox"];

  for (const name of names) {
    if (await access(path.join(directory, name), process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) {
      return true;
    }
  }

  return false;
}

async function verifyCachedPackage(cache) {
  const packages = [];
  for (const directory of await readdir(path.join(cache, "_npx"))) {
    const packagePath = path.join(cache, "_npx", directory, "node_modules", "html-inbox", "package.json");
    const contents = await readFile(packagePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    });
    if (contents) {
      packages.push(JSON.parse(contents));
    }
  }

  assert.equal(packages.length, 1, "Fresh npx cache must contain one real registry installation");
  assert.equal(packages[0].name, "html-inbox");
  assert.equal(packages[0].version, "0.2.0");
  assert.deepEqual(packages[0].bin, { "html-inbox": "bundle/index.js" });
}

async function verifyDetachedLifecycle(resolution, cwd, env, sourcePath, originalHtml) {
  const origin = `http://127.0.0.1:${env.HTML_INBOX_PORT}`;
  const published = await runCli(resolution, ["publish", sourcePath, "--title", 'Registry R&D "report" %PATH%', "--type", "report"], cwd, env);
  const documentUrl = assertDocumentUrl(published.stdout, origin);
  const status = await readStatus(resolution, cwd, env);
  assert.equal(status.state, "running");
  assert.equal(status.exposure, "loopback");
  assert.equal(status.port, Number(env.HTML_INBOX_PORT));
  assert.equal(typeof status.pid, "number", "Later npx invocation must verify the detached viewer PID");

  const record = JSON.parse(await readFile(path.join(env.HTML_INBOX_HOME, "viewer.json"), "utf8"));
  const health = await fetch(record.controlUrl, { signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).pid, status.pid);
  await verifyDocument(documentUrl, originalHtml);

  const listed = JSON.parse((await runCli(resolution, ["list", "--json"], cwd, env)).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, documentUrl.pathname.split("/").at(-1));
  assert.equal(listed[0].title, 'Registry R&D "report" %PATH%');
  assert.equal(listed[0].sourceFileName, path.basename(sourcePath));
  const repeated = await runCli(resolution, ["publish", sourcePath, "--title", "Next registry invocation", "--type", "report"], cwd, env);
  assertDocumentUrl(repeated.stdout, origin);
  assert.equal((await readStatus(resolution, cwd, env)).pid, status.pid, "Publish must reuse the verified detached viewer");
  await stopVerifiedViewer(resolution, cwd, env);
  console.log("Pinned fallback publish, later PID lookup/reuse, HTTP document/content, and detached stop passed.");
}

async function verifySavedLan(resolution, cwd, env, sourcePath, originalHtml) {
  const saved = JSON.parse(await readFile(path.join(env.HTML_INBOX_HOME, "viewer-config.json"), "utf8"));
  const port = saved.config.port;
  const origin = `http://127.0.0.1:${port}`;
  const started = await runCli(resolution, ["viewer", "--lan", "--host", "127.0.0.1", "--port", String(port)], cwd, env);
  assert.equal(started.stdout.trim(), origin);
  const lanStatus = await readStatus(resolution, cwd, env);
  assert.equal(lanStatus.state, "running");
  assert.equal(lanStatus.exposure, "lan");
  const lanConfiguration = await readFile(path.join(env.HTML_INBOX_HOME, "viewer-config.json"), "utf8");
  assert.equal(JSON.parse(lanConfiguration).config.host, "127.0.0.1");

  await runCli(resolution, ["publish", sourcePath, "--title", "LAN reuse", "--type", "report"], cwd, env);
  assert.equal((await readStatus(resolution, cwd, env)).pid, lanStatus.pid);
  await stopVerifiedViewer(resolution, cwd, env);
  assert.equal(await readFile(path.join(env.HTML_INBOX_HOME, "viewer-config.json"), "utf8"), lanConfiguration);

  const restarted = await runCli(resolution, ["publish", sourcePath, "--title", "Saved LAN restart", "--type", "report"], cwd, env);
  await verifyDocument(assertDocumentUrl(restarted.stdout, origin), originalHtml);
  const restartedStatus = await readStatus(resolution, cwd, env);
  assert.equal(restartedStatus.state, "running");
  assert.equal(restartedStatus.exposure, "lan");
  assert.equal(restartedStatus.port, port, "Saved port must survive an omitted HTML_INBOX_PORT");
  assert.equal(await readFile(path.join(env.HTML_INBOX_HOME, "viewer-config.json"), "utf8"), lanConfiguration);
  await stopVerifiedViewer(resolution, cwd, env);
  console.log("Saved LAN exposure and port survived publish restart without networking flags or HTML_INBOX_PORT.");
}

async function verifySavedTailscale(resolution, cwd, env, sourcePath, originalHtml, fixture) {
  const origin = `https://${fixture.hostname}`;
  const started = await runCli(resolution, ["viewer", "--tailscale"], cwd, env);
  assert.equal(started.stdout.trim(), origin);
  const status = await readStatus(resolution, cwd, env);
  assert.equal(status.state, "running");
  assert.equal(status.exposure, "tailscale");
  const configuration = JSON.parse(await readFile(path.join(env.HTML_INBOX_HOME, "viewer-config.json"), "utf8"));
  assert.equal(configuration.tailscaleExecutable, fixture.executable);

  const savedEnvironment = { ...env, HTML_INBOX_TAILSCALE_COMMAND: undefined };
  const published = await runCli(resolution, ["publish", sourcePath, "--title", "Saved Tailscale executable", "--type", "report"], cwd, savedEnvironment);
  assertDocumentUrl(published.stdout, origin);
  assert.equal((await readStatus(resolution, cwd, savedEnvironment)).pid, status.pid);
  await stopVerifiedViewer(resolution, cwd, savedEnvironment);
  assert.deepEqual(JSON.parse(await readFile(fixture.configPath, "utf8")), fixture.originalConfig);

  const restarted = await runCli(resolution, ["publish", sourcePath, "--title", "Saved tailnet restart", "--type", "report"], cwd, savedEnvironment);
  const documentUrl = assertDocumentUrl(restarted.stdout, origin);
  const restartedStatus = await readStatus(resolution, cwd, savedEnvironment);
  assert.equal(restartedStatus.state, "running");
  assert.equal(restartedStatus.exposure, "tailscale");
  assert.equal(restartedStatus.port, status.port);
  const journal = JSON.parse(await readFile(path.join(env.HTML_INBOX_HOME, "tailscale-serve.json"), "utf8"));
  assert.equal(journal.executable, fixture.executable, "Publish restart must use the saved Tailscale executable override");
  const content = await readWithHost(`http://127.0.0.1:${status.port}${documentUrl.pathname}/content`, fixture.hostname);
  assert.equal(content.status, 200);
  assert.deepEqual(content.body, originalHtml);
  await stopVerifiedViewer(resolution, cwd, savedEnvironment);

  assert.deepEqual(JSON.parse(await readFile(fixture.configPath, "utf8")), fixture.originalConfig);
  await assertMissing(path.join(env.HTML_INBOX_HOME, "tailscale-serve.json"));
  const commands = (await readFile(fixture.commandsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const mutations = commands.filter((args) => args[0] === "serve" && args[1] !== "status");
  const flags = ["serve", "--bg", "--yes", "--https=443", "--set-path=/"];
  assert.deepEqual(mutations, [
    [...flags, `http://127.0.0.1:${status.port}`], [...flags, "off"],
    [...flags, `http://127.0.0.1:${status.port}`], [...flags, "off"],
  ]);
  console.log("Tailscale override, saved executable reuse/restart, HTTP content, and scoped route restoration passed.");
}

async function verifyRejectedRecords(resolution, cwd, env, sourcePath) {
  const home = path.join(temporaryRoot, "rejected record home");
  await mkdir(home, { mode: 0o700 });
  const unrelated = await startUnrelatedServer();
  const rejectedEnvironment = { ...env, HTML_INBOX_HOME: home, HTML_INBOX_PORT: String(unrelated.port) };
  const instanceId = randomUUID();

  try {
    await writeFile(path.join(home, "instance-id"), instanceId, { mode: 0o600 });
    const records = [
      { state: "incompatible", value: { pid: unrelated.pid, host: "127.0.0.1", port: unrelated.port, processId: randomUUID(), startedAt: new Date().toISOString() } },
      { state: "conflict", value: {
        pid: unrelated.pid, instanceId, processId: randomUUID(), protocolVersion: 3,
        config: { port: unrelated.port, exposure: "loopback", host: "127.0.0.1" },
        urls: [unrelated.origin], controlUrl: `${unrelated.origin}/control/${"A".repeat(43)}`, startedAt: new Date().toISOString(),
      } },
    ];

    for (const record of records) {
      const recordPath = path.join(home, "viewer.json");
      const bytes = `${JSON.stringify(record.value)}\n`;
      await writeFile(recordPath, bytes, { mode: 0o600 });
      assert.equal((await readStatus(resolution, cwd, rejectedEnvironment)).state, record.state);
      const stopped = await runCli(resolution, ["viewer", "stop"], cwd, rejectedEnvironment);
      assert.equal(JSON.parse(stopped.stdout).state, record.state, "Stop must refuse the unverified process, even when exit code is zero");
      assertNoSuccessUrl(stopped);

      for (const args of [["viewer"], ["publish", sourcePath, "--title", "Must not publish", "--type", "report"]]) {
        const rejected = await runResolvedCli(resolution, args, { cwd, env: rejectedEnvironment });
        assert.notEqual(rejected.code, 0, `Unverified record must reject ${args[0]}`);
        assert.match(rejected.stderr, /older viewer|incompatible|unverified|conflict/i);
        assertNoSuccessUrl(rejected);
      }

      assert.equal(await readFile(recordPath, "utf8"), bytes, "Rejected operations must preserve the process record exactly");
      await assertMissing(path.join(home, "documents"));
      await assertMissing(path.join(home, "viewer.log"));
      await unrelated.assertAlive();
    }
  } finally {
    await unrelated.close();
  }

  console.log("Old and unverified records refused stop/start/publish; records and the unrelated HTTP process stayed intact.");
}

async function verifyRegistryFailure(resolution, cwd, env, sourcePath) {
  const home = path.join(temporaryRoot, "failed registry user home");
  const cache = path.join(temporaryRoot, "failed registry cache");
  const inboxHome = path.join(temporaryRoot, "failed registry inbox");
  await mkdir(home);
  await mkdir(cache);
  const registry = `http://127.0.0.1:${await findAvailablePort()}`;
  const failedEnvironment = {
    ...env, HOME: home, USERPROFILE: home, HTML_INBOX_HOME: inboxHome,
    npm_config_cache: cache, npm_config_registry: registry,
    npm_config_fetch_timeout: "1000", npm_config_fetch_retries: "0",
  };
  assert.deepEqual(await readdir(cache), [], "Network rejection must not use the successful fallback's cache");
  const startedAt = Date.now();
  const failed = await runResolvedCli(resolution, ["publish", sourcePath, "--title", "Offline publish must fail", "--type", "report"], { cwd, env: failedEnvironment });
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /\bECONNREFUSED\b/, "Resolver must preserve the original npm connection error");
  assert(failed.stderr.includes(registry), "npm diagnostic must identify the failed registry");
  assert(Date.now() - startedAt < 15_000, "Registry failure must respect short fetch timeout and zero retries");
  assertNoSuccessUrl(failed);
  await assertMissing(path.join(inboxHome, "documents"));
  await assertMissing(path.join(inboxHome, "viewer.json"));
  await assertMissing(path.join(inboxHome, "viewer-config.json"));
  console.log("Fresh-cache registry refusal preserved npm ECONNREFUSED and returned no document URL or stored document.");
}

async function runCli(resolution, args, cwd, env) {
  const result = await runResolvedCli(resolution, args, { cwd, env });
  assert.equal(result.code, 0, `Resolved inbox ${args[0]} failed.\n${result.stdout}${result.stderr}`);

  return result;
}

async function readStatus(resolution, cwd, env) {
  return JSON.parse((await runCli(resolution, ["viewer", "status"], cwd, env)).stdout);
}

async function stopVerifiedViewer(resolution, cwd, env) {
  const status = await readStatus(resolution, cwd, env);
  assert.equal(status.state, "running");
  assert.equal(typeof status.pid, "number", "Only a CLI-verified viewer may be stopped");
  const stopped = JSON.parse((await runCli(resolution, ["viewer", "stop"], cwd, env)).stdout);
  assert.equal(stopped.state, "stopped");
  assert.equal((await readStatus(resolution, cwd, env)).state, "stopped");
  await assertMissing(path.join(env.HTML_INBOX_HOME, "viewer.json"));
  await assert.rejects(fetch(`http://127.0.0.1:${status.port}/health`, { signal: AbortSignal.timeout(3000) }));
}

async function cleanupViewer(resolution, cwd, env) {
  const status = await readStatus(resolution, cwd, env);
  if (status.state === "stopped") {
    await assertMissing(path.join(env.HTML_INBOX_HOME, "viewer.json"));

    return;
  }

  assert.equal(status.state, "running", "Cleanup cannot manage an incompatible or conflicting process");
  assert.equal(typeof status.pid, "number", "Cleanup requires CLI-verified process identity");
  await stopVerifiedViewer(resolution, cwd, env);
}

function assertDocumentUrl(stdout, origin) {
  const url = new URL(stdout.trim());
  assert.equal(url.origin, origin);
  assert.match(url.pathname, /^\/documents\/[A-Za-z0-9_-]+$/);

  return url;
}

function assertNoSuccessUrl(result) {
  assert.doesNotMatch(result.stdout, /^\s*https?:\/\/\S+\s*$/m, "Failed operation must not print a success URL");
  assert.doesNotMatch(result.stdout, /\/documents\//, "Failed operation must not return a document URL");
}

async function verifyDocument(url, originalHtml) {
  const shell = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<iframe sandbox="allow-scripts"/);
  const content = await fetch(`${url.href}/content`, { signal: AbortSignal.timeout(3000) });
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), originalHtml);
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

async function findAvailablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  return address.port;
}

async function readWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: host }, timeout: 3000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.once("timeout", () => request.destroy(new Error("Tailscale fixture HTTP request timed out")));
    request.once("error", reject);
  });
}

async function startUnrelatedServer() {
  const source = `
    import http from "node:http";
    const server = http.createServer((_request, response) => response.end("Unrelated HTTP server is alive"));
    const close = () => {
      server.closeAllConnections();
      server.close(() => { if (process.connected) process.disconnect(); });
    };
    process.on("message", close);
    process.on("disconnect", close);
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Unrelated HTTP fixture startup timed out")), 5000);
    child.once("message", (message) => { clearTimeout(timer); resolve(message); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(`Unrelated HTTP fixture exited before readiness.\n${stderr}`)); });
  });

  const close = async () => {
    if (child.connected) {
      child.send("close");
    }

    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Unrelated HTTP fixture shutdown timed out.\n${stderr}`)), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const { port } = await ready;
    assert(Number.isInteger(port) && port > 0);
    const origin = `http://127.0.0.1:${port}`;

    return {
      pid: child.pid, port, origin, close,
      async assertAlive() {
        assert.equal(child.exitCode, null, `Rejected operation terminated the unrelated fixture.\n${stderr}`);
        assert.equal(child.signalCode, null, "Rejected operation must never signal the unrelated PID");
        const response = await fetch(origin, { signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "Unrelated HTTP server is alive");
      },
    };
  } catch (error) {
    await close();

    throw error;
  }
}
