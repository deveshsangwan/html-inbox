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
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "html-inbox-package-"));

try {
  const packResult = await run(
    "npm",
    ["pack", "--pack-destination", temporaryRoot],
    path.join(repositoryRoot, "packages", "cli"),
    { npm_config_cache: path.join(temporaryRoot, "npm-cache") },
  );
  const tarballs = (await readdir(temporaryRoot)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `Expected one package tarball.\n${packResult.output}`);
  const tarballPath = path.join(temporaryRoot, tarballs[0]);

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
  assert.equal((await stat(executable)).size > 10_000, true);
  assert.equal((await run(process.execPath, [executable, "--version"], consumerRoot)).output.trim(), "0.1.0");
  const installedBin = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "html-inbox.cmd" : "html-inbox",
  );
  assert.equal((await run(installedBin, ["--version"], consumerRoot)).output.trim(), "0.1.0");
  const help = (await run(process.execPath, [executable, "--help"], consumerRoot)).output;
  assert.match(help, /remote init --account/);
  assert.match(help, /export --out <directory>/);

  const isolatedHome = path.join(temporaryRoot, "home");
  const status = await run(
    process.execPath,
    [executable, "remote", "status", "--json"],
    consumerRoot,
    { HTML_INBOX_HOME: isolatedHome },
  );
  assert.deepEqual(JSON.parse(status.output), {
    configured: false,
    state: null,
    operation: null,
  });

  const exportRoot = path.join(temporaryRoot, "export");
  const exported = await run(
    process.execPath,
    [executable, "export", "--out", exportRoot, "--json"],
    consumerRoot,
    { HTML_INBOX_HOME: isolatedHome },
  );
  const exportResult = JSON.parse(exported.output);
  assert.equal(exportResult.manifest.documentCount, 0);
  assert.equal((await stat(path.join(exportRoot, "index.html"))).isFile(), true);
  assert.equal(
    (await stat(path.join(exportRoot, "__html-inbox", "ownership.json"))).isFile(),
    true,
  );
} finally {
  if (process.env.HTML_INBOX_KEEP_PACKAGE_SMOKE !== "1") {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ output });
      else reject(new Error(`${command} failed (${signal ?? code}).\n${output}`));
    });
  });
}
