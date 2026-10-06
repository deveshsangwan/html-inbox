import assert from "node:assert/strict";
import { access, copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readResolution, runCommand, runResolvedCli } from "./skill-cli-fixtures.mjs";

const resolution = await readResolution();
const powershellPath = process.platform === "win32"
  ? (await runCommand("where.exe", ["pwsh"])).stdout.trim().split(/\r?\n/)[0]
  : undefined;
const shells = process.platform === "win32"
  ? [powershellPath, path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
  : ["/bin/bash", ...await access("/bin/zsh").then(() => ["/bin/zsh"]).catch(() => [])];

for (const shell of shells) {
  test(`${path.basename(shell)} selects once and reuses its prefix throughout an operation`, async (t) => {
    for (const version of ["0.2.0", null]) {
      const fixture = await createExecutables(t, { version });
      const isPowerShell = /(?:pwsh|powershell)(?:\.exe)?$/.test(shell);
      const commands = "\ninbox publish report.html\ninbox viewer status\ninbox viewer stop\ninbox remote status\ninbox viewer service status\n";
      const args = isPowerShell
        ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'\n${resolution.powershell}${commands}exit $LASTEXITCODE`]
        : ["-c", resolution.bash + commands];
      const result = await runCommand(shell, args, fixture);
      assert.equal(result.code, 0, result.stderr);

      const recorded = await fixture.commands();
      const selected = recorded.filter(({ executable }) => executable === (version ? "html-inbox" : "npx"));
      assert.equal(selected.filter(({ args }) => args.at(-1) === "--version").length, 1);
      assert.equal(selected.length, 6);
      assertPreservedEnvironment(recorded, fixture.env);
    }
  });

  test(`${path.basename(shell)} uses a compatible installed CLI and preserves arguments/environment`, async (t) => {
    const fixture = await createExecutables(t, { version: "0.2.0" });
    const args = ["publish", "report&notes with spaces.html", "--title", 'R&D "results" %PATH% | $growth Résumé δ', "--type", "report", ""];
    const result = await runResolvedCli(resolution, args, { ...fixture, shell });
    assert.equal(result.code, 0, result.stderr);

    const commands = await fixture.commands();
    assert.deepEqual(commands.map(({ executable, args }) => [executable, ...args]), [
      ["html-inbox", "--version"],
      ["html-inbox", ...args],
    ]);
    assertPreservedEnvironment(commands, fixture.env);
  });

  test(`${path.basename(shell)} accepts stable patch releases and surrounding whitespace`, async (t) => {
    const fixture = await createExecutables(t, { version: " 0.2.12\r\n" });
    const result = await runResolvedCli(resolution, ["viewer", "status"], { ...fixture, shell });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await fixture.commands()).at(-1).executable, "html-inbox");
  });

  test(`${path.basename(shell)} preserves a single operation argument`, async (t) => {
    for (const version of ["0.2.0", null]) {
      const fixture = await createExecutables(t, { version });
      const result = await runResolvedCli(resolution, ["--version"], { ...fixture, shell });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "0.2.0");

      const commands = await fixture.commands();
      assert.equal(commands.length, 2);
      const prefix = version ? [] : ["--yes", "html-inbox@0.2.0"];
      assert.deepEqual(commands.at(-1).args, [...prefix, "--version"]);
    }
  });

  if (/(?:pwsh|powershell)(?:\.exe)?$/.test(shell)) {
    test(`${path.basename(shell)} converts literal and variable numeric arguments to native strings`, async (t) => {
      for (const version of ["0.2.0", null]) {
        const fixture = await createExecutables(t, { version });
        const result = await runCommand(shell, [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference = 'Stop'\n${resolution.powershell}\ninbox viewer --port 4321\n$port = 4322\ninbox viewer --port $port\nexit $LASTEXITCODE`,
        ], fixture);
        assert.equal(result.code, 0, result.stderr);

        const operations = (await fixture.commands()).slice(-2).map(({ args }) => args);
        const prefix = version ? [] : ["--yes", "html-inbox@0.2.0"];
        assert.deepEqual(operations, [
          [...prefix, "viewer", "--port", "4321"],
          [...prefix, "viewer", "--port", "4322"],
        ]);
      }
    });
  }

  for (const version of [null, "0.1.9", "0.3.0", "1.0.0", "0.2.0-beta.1", "0.2.0+build", "0.2.01", "v0.2.0", "0.2.0\nunexpected", "garbage"]) {
    test(`${path.basename(shell)} falls back for ${version === null ? "an absent executable" : version}`, async (t) => {
      const fixture = await createExecutables(t, { version });
      for (const args of [["publish", "report.html"], ["viewer", "status"], ["viewer", "stop"], ["remote", "status"], ["viewer", "service", "status"]]) {
        const result = await runResolvedCli(resolution, args, { ...fixture, shell });
        assert.equal(result.code, 0, result.stderr);
      }

      const commands = await fixture.commands();
      const npmCommands = commands.filter(({ executable }) => executable === "npx");
      assert.equal(npmCommands.length, 10);
      for (const command of npmCommands) {
        assert.deepEqual(command.args.slice(0, 2), ["--yes", "html-inbox@0.2.0"]);
      }
      assert.equal(commands.filter(({ executable, args }) => executable === "html-inbox" && args[0] !== "--version").length, 0);
      assertPreservedEnvironment(commands, fixture.env);
    });
  }

  test(`${path.basename(shell)} falls back when the installed version check fails`, async (t) => {
    const fixture = await createExecutables(t, { version: "0.2.0", installedFailure: true });
    const result = await runResolvedCli(resolution, ["publish", "report.html"], { ...fixture, shell });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /installed executable failed/);
    assert.deepEqual((await fixture.commands()).at(-1).args, ["--yes", "html-inbox@0.2.0", "publish", "report.html"]);
  });

  test(`${path.basename(shell)} preserves npm failure and never attempts publishing`, async (t) => {
    const fixture = await createExecutables(t, { version: null, npmFailure: true });
    const result = await runResolvedCli(resolution, ["publish", "report.html"], { ...fixture, shell });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /npm error ECONNREFUSED original-registry-failure/);
    assert.equal(result.stdout, "");
    assert.deepEqual((await fixture.commands()).map(({ args }) => args), [["--yes", "html-inbox@0.2.0", "--version"]]);
  });

  test(`${path.basename(shell)} rejects an unexpected fallback version before publishing`, async (t) => {
    const fixture = await createExecutables(t, { version: null, fallbackVersion: "0.2.1" });
    const result = await runResolvedCli(resolution, ["publish", "report.html"], { ...fixture, shell });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unexpected HTML Inbox fallback version/);
    assert.equal(result.stdout, "");
    assert.equal((await fixture.commands()).length, 1);
  });

  test(`${path.basename(shell)} stops before CLI checks when Node is absent`, async (t) => {
    const fixture = await createExecutables(t, { version: "0.2.0" });
    await rm(path.join(fixture.cwd, "bin", process.platform === "win32" ? "node.exe" : "node"));
    const result = await runResolvedCli(resolution, ["publish", "report.html"], { ...fixture, shell });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /node|Node/);
    assert.equal(result.stdout, "");
    await assert.rejects(readFile(path.join(fixture.cwd, "commands.jsonl")), { code: "ENOENT" });
  });

  if (!/(?:pwsh|powershell)(?:\.exe)?$/.test(shell)) {
    test(`${path.basename(shell)} uses native commands for both probe and operation despite shell functions`, async (t) => {
      const fixture = await createExecutables(t, { version: null });
      const shadowed = {
        ...resolution,
        bash: `html-inbox() { printf '0.2.0\\n'; }\nnpx() { printf '0.2.0\\n'; }\n${resolution.bash}`,
      };
      const args = ["publish", "report & $.html", "--title", 'Quarterly "results" & $growth'];
      const result = await runResolvedCli(shadowed, args, { ...fixture, shell });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual((await fixture.commands()).map(({ args }) => args), [
        ["--yes", "html-inbox@0.2.0", "--version"],
        ["--yes", "html-inbox@0.2.0", ...args],
      ]);
    });
  }
}

test("skills reach their own resolver before operations and use its prefix", async () => {
  for (const name of ["html-inbox", "html-inbox-remote"]) {
    const skill = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, /\[CLI resolution\]\(\.\/references\/cli-resolution\.md\)/);
    assert(skill.indexOf("## Resolve the CLI") < skill.indexOf(name === "html-inbox" ? "## Publish" : "## Choose the operation"));
    assertSelectedCommandExamples(skill);
    assert.match(skill, /\binbox (?:publish|remote init)\b/);
  }
});

test("command examples exempt only stable absolute Node and CLI service administration", () => {
  for (const example of [
    "sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service install --user alice --loopback --port 3217",
    "sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service uninstall --user alice",
    'sudo env HTML_INBOX_HOME="/absolute/inbox with spaces" \\\n  /absolute/path/to/node /absolute/path/to/html-inbox \\\n  viewer service install --user alice',
  ]) {
    assertSelectedCommandExamples(example);
  }

  for (const example of [
    "sudo node /absolute/path/to/html-inbox viewer service install --user alice",
    "sudo /absolute/path/to/node html-inbox viewer service install --user alice",
    "sudo /absolute/path/to/node ./html-inbox viewer service install --user alice",
    "sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service status",
    "html-inbox viewer service uninstall --user alice",
    "html-inbox publish report.html",
  ]) {
    assert.throws(() => assertSelectedCommandExamples(example));
  }
});

test("Windows PowerShell resolves native npm shims and ignores function/script shadowing", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createExecutables(t, { version: "0.2.0" });
  await writeFile(path.join(fixture.cwd, "bin", "html-inbox.ps1"), 'throw "blocked script shim should not execute"\n');
  const shadowed = {
    ...resolution,
    powershell: `function html-inbox { throw 'shadowing function should not execute' }\n${resolution.powershell}`,
  };
  const result = await runResolvedCli(shadowed, ["viewer", "status"], fixture);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await fixture.commands()).at(-1).executable, "html-inbox");
});

test("Windows PowerShell falls back for an unsupported installed shim without running it", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createExecutables(t, { version: "0.2.0" });
  const marker = path.join(fixture.cwd, "unsafe shim must never run");
  await writeFile(path.join(fixture.cwd, "bin", "html-inbox.cmd"), `@echo 0.2.0\r\necho unsafe > "${marker}"\r\n`);
  const result = await runResolvedCli(resolution, ["publish", "report&notes.html"], fixture);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Unsupported npm command shim/);
  assert((await fixture.commands()).every(({ executable }) => executable === "npx"));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

async function createExecutables(t, { version, installedFailure = false, npmFailure = false, fallbackVersion = "0.2.0" }) {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-inbox skill resolution "));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  const log = path.join(cwd, "commands.jsonl");
  const env = {
    HTML_INBOX_HOME: path.join(cwd, "custom inbox"),
    HTML_INBOX_PORT: "4321",
    HTML_INBOX_TAILSCALE_COMMAND: path.join(cwd, "tailscale override"),
    CLOUDFLARE_API_TOKEN: "recording-fixture-token",
    HTML_INBOX_TEST_LOG: log,
    HTML_INBOX_TEST_VERSION: version ?? "",
    HTML_INBOX_TEST_INSTALLED_FAILURE: String(installedFailure),
    HTML_INBOX_TEST_NPM_FAILURE: String(npmFailure),
    HTML_INBOX_TEST_FALLBACK_VERSION: fallbackVersion,
    PATH: process.platform === "win32" ? `${bin};${process.env.SystemRoot}\\System32` : bin,
  };

  if (process.platform === "win32") {
    await link(process.execPath, path.join(bin, "node.exe")).catch(() => copyFile(process.execPath, path.join(bin, "node.exe")));
  } else {
    await symlink(process.execPath, path.join(bin, "node"));
  }

  const source = `const fs = require("node:fs");
const path = require("node:path");
const executable = path.basename(process.argv[1], ".cjs");
const args = process.argv.slice(2);
const environment = Object.fromEntries(["HTML_INBOX_HOME", "HTML_INBOX_PORT", "HTML_INBOX_TAILSCALE_COMMAND", "CLOUDFLARE_API_TOKEN"].map(key => [key, process.env[key]]));
fs.appendFileSync(process.env.HTML_INBOX_TEST_LOG, JSON.stringify({ executable, args, environment }) + "\\n");
if (executable === "html-inbox" && process.env.HTML_INBOX_TEST_INSTALLED_FAILURE === "true") {
  console.error("installed executable failed");
  process.exit(23);
}
if (executable === "npx" && process.env.HTML_INBOX_TEST_NPM_FAILURE === "true") {
  console.error("npm error ECONNREFUSED original-registry-failure");
  process.exit(1);
}
if (args.at(-1) === "--version") {
  console.log(executable === "npx" ? process.env.HTML_INBOX_TEST_FALLBACK_VERSION : process.env.HTML_INBOX_TEST_VERSION);
} else {
  console.log(JSON.stringify({ state: "stopped" }));
}
`;
  const recording = path.join(cwd, "recording");
  await mkdir(recording);
  for (const executable of version === null ? ["npx"] : ["html-inbox", "npx"]) {
    const script = path.join(recording, `${executable}.cjs`);
    await writeFile(script, source);
    const shim = process.platform === "win32"
      ? `@echo off\r\nSET "_prog=${process.execPath}"\r\n"%_prog%" "%dp0%\\..\\recording\\${executable}.cjs" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`;
    await writeFile(path.join(bin, executable + (process.platform === "win32" ? ".cmd" : "")), shim, { mode: 0o700 });
  }

  return {
    cwd,
    env,
    ...(powershellPath ? { shell: powershellPath } : {}),
    commands: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
  };
}

function assertPreservedEnvironment(commands, env) {
  for (const { environment } of commands) {
    assert.deepEqual(environment, {
      HTML_INBOX_HOME: env.HTML_INBOX_HOME,
      HTML_INBOX_PORT: env.HTML_INBOX_PORT,
      HTML_INBOX_TAILSCALE_COMMAND: env.HTML_INBOX_TAILSCALE_COMMAND,
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    });
  }
}

function assertSelectedCommandExamples(skill) {
  const commands = skill.replace(/\\\r?\n[ \t]*/g, " ");
  const stableAdministration = /\bsudo[ \t]+(?:env[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)[ \t]+)+)?\/absolute\/path\/to\/node[ \t]+\/absolute\/path\/to\/html-inbox[ \t]+viewer[ \t]+service[ \t]+(?:install|uninstall)\b/g;
  const ordinaryCommands = commands.replace(stableAdministration, "stable service administrator command");

  assert.doesNotMatch(ordinaryCommands, /\bhtml-inbox (?:publish|viewer|remote)\b/);
}
