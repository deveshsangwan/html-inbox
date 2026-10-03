import { strict as assert } from "node:assert";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";
import { CommandInvocation, CommandResult, CommandRunner, NodeCommandRunner } from "./command-runner";
import { getViewerServiceStatus, installViewerService, resolveViewerServiceHome, uninstallViewerService, ViewerServiceRuntime } from "./viewer-service";
import { LAUNCHD_VIEWER_LABEL, parseViewerServiceDefinition, renderViewerServiceDefinition, SYSTEMD_VIEWER_NAME } from "./viewer-service-definition";
import { saveViewerConfiguration } from "./viewer-records";
import { defaultRuntime, prepareDefinition } from "./viewer-service-runtime";
import { queryManager, runManager } from "./viewer-service-manager";

const serviceRecordingSkip = process.platform === "win32"
  ? "Boot service ownership and recording executable checks require a POSIX platform."
  : false;

test("boot managers and waiting commands allow slow serialized cleanup to finish", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const contents = renderViewerServiceDefinition({
      platform,
      home: "/home/alice/inbox",
      port: 3217,
      exposure: "loopback",
      user: { name: "alice", uid: 500, gid: 500, home: "/home/alice" },
      nodePath: "/usr/bin/node",
      cliPath: "/home/alice/html-inbox.js",
      environment: {},
    });
    assert.match(contents, platform === "linux"
      ? /^TimeoutStopSec=120$/m
      : /<key>ExitTimeOut<\/key><integer>120<\/integer>/);
  }

  const invocations: CommandInvocation[] = [];
  const runtime = defaultRuntime();
  runtime.runner = {
    run: async (invocation) => {
      invocations.push(invocation);
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
  };
  for (const args of [["stop"], ["restart"], ["bootout"], ["disable", "--now"], ["show"], ["print"], ["disable"]]) {
    await runManager(runtime, args);
  }

  assert.deepEqual(invocations.map(({ timeoutMs }) => timeoutMs), [150_000, 150_000, 150_000, 150_000, 15_000, 15_000, 15_000]);
});

async function serviceFixture(t: TestContext, platform: "linux" | "darwin" = "linux") {
  const directory = await mkdtemp(path.join(tmpdir(), "html-inbox-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "selected inbox");
  const userHome = path.join(directory, "normal-user");
  const definitionDirectory = path.join(directory, "services");
  const cliPath = path.join(directory, "html-inbox.js");
  await Promise.all([
    mkdir(home),
    mkdir(userHome),
    mkdir(definitionDirectory),
    writeFile(cliPath, "// Installed CLI fixture\n"),
  ]);
  const definitionPath = path.join(definitionDirectory, platform === "linux" ? SYSTEMD_VIEWER_NAME : `${LAUNCHD_VIEWER_LABEL}.plist`);
  const manager = new RecordingManager(platform, definitionPath);
  const user = { name: "alice", uid: process.getuid?.() ?? 1001, gid: process.getgid?.() ?? 1001, home: userHome };
  const changedOwners: string[] = [];
  const runtime: ViewerServiceRuntime = {
    platform,
    uid: 0,
    currentUser: "root",
    environment: { SUDO_USER: "alice", HOME: "/root", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, SECRET: "never persist" },
    nodePath: process.execPath,
    cliPath,
    managerPath: path.join(directory, "recording-manager"),
    serviceDirectory: definitionDirectory,
    lookupUser: async (name) => ({ ...user, name }),
    runner: manager,
    chown: async (filePath, uid, gid, file) => {
      assert.equal(uid, user.uid);
      assert.equal(gid, user.gid);
      assert(file, "Ownership changes must use the validated file descriptor");
      changedOwners.push(filePath);
    },
    getViewerStatus: async (definition) => {
      assert.equal(definition.user.uid, user.uid);
      assert.equal(definition.user.gid, user.gid);
      assert.equal(definition.home, home);
      return { state: "running", pid: manager.pid };
    },
    readinessTimeoutMs: 20,
  };
  return { directory, home, userHome, definitionPath, manager, runtime, changedOwners, options: { home, port: 3217, exposure: "loopback" as const } };
}

class RecordingManager implements CommandRunner {
  invocations: CommandInvocation[] = [];
  loaded = false;
  enabled = false;
  active = false;
  pid = 4242;
  failNext: string | undefined;
  fragmentPath: string;
  dropInPaths = "";

  constructor(private platform: "linux" | "darwin", private definitionPath: string) {
    this.fragmentPath = definitionPath;
  }

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation);
    assert.equal(invocation.cwd, "/");
    const command = invocation.args[0];
    if (command === this.failNext) {
      this.failNext = undefined;
      return { code: 1, signal: null, stdout: "", stderr: "recorded manager failure" };
    }

    let stdout = "";
    if (command === "show") {
      stdout = `LoadState=${this.loaded ? "loaded" : "not-found"}\nActiveState=${this.active ? "active" : "inactive"}\nUnitFileState=${this.enabled ? "enabled" : "disabled"}\nFragmentPath=${this.loaded ? this.fragmentPath : ""}\nDropInPaths=${this.dropInPaths}\nMainPID=${this.active ? this.pid : 0}\n`;
    } else if (command === "print-disabled") {
      stdout = `disabled services = {\n "${LAUNCHD_VIEWER_LABEL}" => ${!this.enabled}\n}\n`;
    } else if (command === "print") {
      if (!this.loaded) return { code: 113, signal: null, stdout: "", stderr: `Could not find service "${LAUNCHD_VIEWER_LABEL}" in domain for system` };

      stdout = `system/${LAUNCHD_VIEWER_LABEL} = {\n path = ${this.fragmentPath}\n state = ${this.active ? "running" : "not running"}\n pid = ${this.active ? this.pid : 0}\n last exit code = 0\n}\n`;
    } else if (command === "enable") {
      this.enabled = true;
    } else if (command === "disable") {
      this.enabled = false;
      if (invocation.args.includes("--now")) this.active = false;
    } else if (command === "stop") {
      this.active = false;
    } else if (command === "start" || command === "restart" || command === "bootstrap" || command === "kickstart") {
      this.loaded = true;
      this.active = true;
    } else if (command === "bootout") {
      this.loaded = false;
      this.active = false;
    } else if (command === "daemon-reload") {
      this.loaded = await access(this.definitionPath).then(() => true, () => false);
    } else {
      throw new Error(`Unexpected recording manager command ${command} on ${this.platform}`);
    }

    return { code: 0, signal: null, stdout, stderr: "" };
  }
}

test("system boot service preserves the selected user and inbox while logging to the journal", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  const document = path.join(fixture.home, "document.html");
  await writeFile(document, "<h1>Keep this document</h1>");
  const status = await installViewerService({ ...fixture.options, exposure: "lan", host: "0.0.0.0" }, fixture.runtime);
  assert.equal(status.state, "running");
  assert.equal(status.enabled, true);
  assert.equal(status.pid, fixture.manager.pid);
  const contents = await readFile(fixture.definitionPath, "utf8");
  const definition = parseViewerServiceDefinition(contents);
  assert.equal(definition.home, fixture.home);
  assert.equal(definition.environment.HOME, fixture.userHome);
  assert.equal(definition.environment.HTML_INBOX_HOME, fixture.home);
  assert.equal(definition.environment.SECRET, undefined);
  assert.match(contents, /\[Service\]\nType=exec\nUser=alice/);
  assert.match(contents, /"viewer" "--foreground" "--port" "3217" "--lan" "--host" "0.0.0.0"/);
  assert.match(contents, /WantedBy=multi-user.target/);
  assert.match(contents, /^StandardOutput=journal$/m);
  assert.match(contents, /^StandardError=journal$/m);
  assert.match(contents, /^TimeoutStopSec=120$/m);
  assert.doesNotMatch(contents, /^Standard(?:Output|Error)=(?:append|file|truncate):/m);
  assert.doesNotMatch(contents, /default.target|--user|ExecStart=.*(?:sh|bash) -c/);
  assert.equal((await lstat(fixture.definitionPath)).mode & 0o777, 0o644);
  await assert.rejects(access(path.join(fixture.home, "viewer.log")), { code: "ENOENT" });
  assert.equal((await lstat(fixture.home)).mode & 0o777, 0o700);
  assert.deepEqual(fixture.changedOwners, []);

  await uninstallViewerService(fixture.options, fixture.runtime);
  assert.equal(await readFile(document, "utf8"), "<h1>Keep this document</h1>");
  assert.equal(fixture.manager.enabled, false);
  assert.equal(fixture.manager.active, false);
  assert.equal((await getViewerServiceStatus(fixture.options, fixture.runtime)).state, "not-installed");
  await uninstallViewerService(fixture.options, fixture.runtime);
});

test("LaunchDaemon uses the system domain and selected normal user before login", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t, "darwin");
  await installViewerService(fixture.options, fixture.runtime);
  const contents = await readFile(fixture.definitionPath, "utf8");
  assert.match(contents, /<key>UserName<\/key><string>alice<\/string>/);
  assert.match(contents, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(contents, /<string>viewer<\/string>\n<string>--foreground<\/string>/);
  assert.match(contents, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(contents, /<key>ExitTimeOut<\/key><integer>120<\/integer>/);
  assert.doesNotMatch(contents, /<key>Standard(?:Out|Error)Path<\/key>/);
  assert.equal(parseViewerServiceDefinition(contents).environment.HTML_INBOX_VIEWER_SERVICE_LOG, "1");
  assert.equal(parseViewerServiceDefinition(contents).environment.HOME, fixture.userHome);
  assert(fixture.manager.invocations.some(({ args }) => args[0] === "bootstrap" && args[1] === "system" && args[2] === fixture.definitionPath));
  assert(fixture.manager.invocations.every(({ args }) => !args.some((arg) => arg.startsWith("gui/") || arg.startsWith("user/"))));

  await uninstallViewerService(fixture.options, fixture.runtime);
  assert.equal(fixture.manager.loaded, false);
  assert.equal(fixture.manager.enabled, false);
});

test("service installation is idempotent and only restarts a changed configuration", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  await installViewerService(fixture.options, fixture.runtime);
  const contents = await readFile(fixture.definitionPath, "utf8");
  fixture.manager.invocations.length = 0;
  await installViewerService(fixture.options, fixture.runtime);
  assert.equal(await readFile(fixture.definitionPath, "utf8"), contents);
  assert(!fixture.manager.invocations.some(({ args }) => args[0] === "daemon-reload" || args[0] === "restart"));

  await installViewerService({ ...fixture.options, port: 4317 }, fixture.runtime);
  assert.equal(parseViewerServiceDefinition(await readFile(fixture.definitionPath, "utf8")).port, 4317);
  assert(fixture.manager.invocations.some(({ args }) => args[0] === "restart"));
});

test("sudo account selection never picks root's home and explicit custom inbox wins", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  assert.equal(await resolveViewerServiceHome({}, fixture.runtime), path.join(fixture.userHome, ".html-inbox"));
  assert.equal(await resolveViewerServiceHome({ home: fixture.home, user: "alice" }, fixture.runtime), fixture.home);
  await assert.rejects(resolveViewerServiceHome({ user: "root" }, fixture.runtime), /non-root normal account/);
  await assert.rejects(resolveViewerServiceHome({}, { ...fixture.runtime, environment: {} }), /non-root normal account/);
  await assert.rejects(resolveViewerServiceHome({ user: "daemon" }, { ...fixture.runtime, lookupUser: async (name) => ({ name, uid: 0, gid: 1, home: fixture.userHome }) }), /normal, non-root/);

  fixture.runtime.uid = 1001;
  await assert.rejects(installViewerService(fixture.options, fixture.runtime), /administrator privileges/);
  await assert.rejects(uninstallViewerService(fixture.options, fixture.runtime), /administrator privileges/);
  assert.equal(fixture.manager.invocations.length, 0);
});

test("owned services reject a different inbox, modified definitions, symlinks, and unrelated loaded units", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  await writeFile(fixture.definitionPath, "[Service]\nExecStart=/some/other/program\n");
  await assert.rejects(installViewerService(fixture.options, fixture.runtime), /unrelated viewer service/);
  await assert.rejects(uninstallViewerService(fixture.options, fixture.runtime), /unrelated viewer service/);
  await rm(fixture.definitionPath);
  await installViewerService(fixture.options, fixture.runtime);
  await assert.rejects(getViewerServiceStatus({ home: path.join(fixture.home, "another") }, fixture.runtime), /different inbox/);
  const contents = await readFile(fixture.definitionPath, "utf8");
  await writeFile(fixture.definitionPath, `${contents}ExecStart=/unrelated\n`);
  await assert.rejects(uninstallViewerService(fixture.options, fixture.runtime), /modified viewer service/);
  await writeFile(fixture.definitionPath, contents);
  fixture.manager.fragmentPath = "/unrelated/service.service";
  await assert.rejects(uninstallViewerService(fixture.options, fixture.runtime), /unrelated definition/);
  assert.equal(await readFile(fixture.definitionPath, "utf8"), contents);

  const target = path.join(fixture.directory, "unrelated");
  await writeFile(target, contents);
  await rm(fixture.definitionPath);
  await symlink(target, fixture.definitionPath);
  await assert.rejects(getViewerServiceStatus(fixture.options, fixture.runtime), /unsafe or unrelated/);
});

for (const platform of ["linux", "darwin"] as const) {
  test(`${platform} oversized service definitions are refused before diagnostics or manager commands`, { skip: serviceRecordingSkip }, async (t) => {
    const fixture = await serviceFixture(t, platform);
    fixture.runtime.environment.NODE_OPTIONS = `--title=${"é".repeat(20_000)}`;

    await assert.rejects(installViewerService(fixture.options, fixture.runtime), /service definition.*too large|service definition.*64 KiB/);
    assert.equal(fixture.manager.invocations.length, 0);
    await assert.rejects(access(fixture.definitionPath), { code: "ENOENT" });
    await assert.rejects(access(path.join(fixture.home, "viewer.log")), { code: "ENOENT" });
  });

  test(`${platform} install failure restores definition and manager state`, { skip: serviceRecordingSkip }, async (t) => {
    const fixture = await serviceFixture(t, platform);
    await installViewerService(fixture.options, fixture.runtime);
    const contents = await readFile(fixture.definitionPath, "utf8");
    fixture.manager.failNext = platform === "linux" ? "restart" : "bootstrap";
    await assert.rejects(installViewerService({ ...fixture.options, port: 5317 }, fixture.runtime), /recorded manager failure/);
    assert.equal(await readFile(fixture.definitionPath, "utf8"), contents);
    assert.equal(fixture.manager.enabled, true);
    assert.equal(fixture.manager.active, true);
    assert.equal((await getViewerServiceStatus(fixture.options, fixture.runtime)).state, "running");
  });

  test(`${platform} fresh failed installation removes the definition and stops the child service`, { skip: serviceRecordingSkip }, async (t) => {
    const fixture = await serviceFixture(t, platform);
    fixture.runtime.getViewerStatus = async () => ({ state: "conflict", pid: 99 });
    await assert.rejects(installViewerService(fixture.options, fixture.runtime), /did not become healthy/);
    await assert.rejects(access(fixture.definitionPath), { code: "ENOENT" });
    assert.equal(fixture.manager.active, false);
    assert.equal(fixture.manager.enabled, false);
  });
}

test("uninstall failure restores the previous service and documents", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  await installViewerService(fixture.options, fixture.runtime);
  const contents = await readFile(fixture.definitionPath, "utf8");
  fixture.manager.failNext = "daemon-reload";
  await assert.rejects(uninstallViewerService(fixture.options, fixture.runtime), /recorded manager failure/);
  assert.equal(await readFile(fixture.definitionPath, "utf8"), contents);
  assert.equal(fixture.manager.enabled, true);
  assert.equal(fixture.manager.active, true);
});

test("Tailscale boot service keeps a stable executable path and safely encodes special characters", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  const tailscalePath = path.join(fixture.directory, "tailscale $safe%&");
  await writeFile(tailscalePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fixture.runtime.environment.HTML_INBOX_TAILSCALE_COMMAND = tailscalePath;
  fixture.runtime.environment.NODE_OPTIONS = "--title=viewer-$safe%name";
  await installViewerService({ ...fixture.options, exposure: "tailscale" }, fixture.runtime);
  const contents = await readFile(fixture.definitionPath, "utf8");
  const definition = parseViewerServiceDefinition(contents);
  assert.equal(definition.environment.HTML_INBOX_TAILSCALE_COMMAND, tailscalePath);
  assert.match(contents, /"HTML_INBOX_TAILSCALE_COMMAND=.*tailscale \$safe%%&"/);
  assert.match(contents, /"--tailscale"/);
  await assert.rejects(installViewerService({ ...fixture.options, host: "0.0.0.0\nUser=root" }, fixture.runtime), /Viewer host must be an IPv4 or IPv6/);
});

test("service manager failures and malformed output are reported rather than guessed as absence", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  fixture.manager.failNext = "show";
  await assert.rejects(getViewerServiceStatus(fixture.options, fixture.runtime), /recorded manager failure/);
  fixture.runtime.runner = { run: async () => ({ code: 0, signal: null, stdout: "ActiveState=active\n", stderr: "" }) };
  await assert.rejects(getViewerServiceStatus(fixture.options, fixture.runtime), /malformed viewer status/);
});

test("systemd drop-in definitions cannot replace or remove the owned viewer service", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  await installViewerService(fixture.options, fixture.runtime);
  const contents = await readFile(fixture.definitionPath, "utf8");
  fixture.manager.dropInPaths = "/etc/systemd/system/html-inbox-viewer.service.d/override.conf";
  fixture.manager.invocations.length = 0;
  await assert.rejects(getViewerServiceStatus(fixture.options, fixture.runtime), /unrelated systemd drop-in definitions/);
  await assert.rejects(installViewerService({ ...fixture.options, port: 4321 }, fixture.runtime), /unrelated systemd drop-in definitions/);
  await assert.rejects(uninstallViewerService(fixture.options, fixture.runtime), /unrelated systemd drop-in definitions/);
  assert.equal(await readFile(fixture.definitionPath, "utf8"), contents);
  assert.equal(fixture.manager.active, true);
  assert(fixture.manager.invocations.every(({ args }) => args[0] === "show"));
});

test("invalid exposure bind addresses fail before service manager commands and filesystem changes", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  for (const options of [
    { ...fixture.options, host: "0.0.0.0" },
    { ...fixture.options, exposure: "lan" as const, host: "inbox.example.com" },
    { ...fixture.options, exposure: "tailscale" as const, host: "::1" },
    { ...fixture.options, exposure: "tailscale" as const, host: "127.0.0.2" },
  ]) {
    await assert.rejects(installViewerService(options, fixture.runtime), /loopback IP address|IPv4 or IPv6 address|127.0.0.1/);
  }
  assert.equal(fixture.manager.invocations.length, 0);
  await assert.rejects(access(fixture.definitionPath), { code: "ENOENT" });
  await assert.rejects(access(path.join(fixture.home, "viewer.log")), { code: "ENOENT" });
});

test("normal users can query owned service status without administrator privileges", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  await installViewerService(fixture.options, fixture.runtime);
  fixture.runtime.uid = 1001;
  const status = await getViewerServiceStatus(fixture.options, fixture.runtime);
  assert.equal(status.state, "running");
  assert.equal((await lstat(fixture.definitionPath)).mode & 0o777, 0o644);
  fixture.runtime.getViewerStatus = async () => ({ state: "running", pid: fixture.manager.pid + 1 });
  assert.equal((await getViewerServiceStatus(fixture.options, fixture.runtime)).state, "failed");
});

test("LaunchDaemon status recognizes current textual enablement output", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t, "darwin");
  await installViewerService(fixture.options, fixture.runtime);
  fixture.runtime.runner = {
    run: async (invocation) => invocation.args[0] === "print-disabled"
      ? { code: 0, signal: null, stdout: `disabled services = {\n "${LAUNCHD_VIEWER_LABEL}" => disabled\n}\n`, stderr: "" }
      : fixture.manager.run(invocation),
  };
  assert.equal((await getViewerServiceStatus(fixture.options, fixture.runtime)).enabled, false);
});

test("LaunchDaemon disabled-service output is validated before assuming the viewer is enabled", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t, "darwin");
  for (const stdout of [
    "not valid launchctl output",
    `disabled services = {\n "${LAUNCHD_VIEWER_LABEL}" => unknown\n}\n`,
    `disabled services = {\n "${LAUNCHD_VIEWER_LABEL}" => true\n "${LAUNCHD_VIEWER_LABEL}" => false\n}\n`,
  ]) {
    const runtime = { ...fixture.runtime, runner: { run: async (invocation: CommandInvocation) => ({ code: 0, signal: null, stdout: invocation.args[0] === "print-disabled" ? stdout : `system/${LAUNCHD_VIEWER_LABEL} = {\n path = ${fixture.definitionPath}\n state = running\n pid = 4242\n}\n`, stderr: "" }) } };
    await assert.rejects(queryManager(runtime, fixture.definitionPath, true), /malformed.*disabled.*status/);
  }

  const runtime = {
    ...fixture.runtime,
    runner: { run: async (invocation: CommandInvocation) => invocation.args[0] === "print-disabled"
      ? { code: 0, signal: null, stdout: "disabled services = {\n}\n", stderr: "" }
      : { code: 113, signal: null, stdout: "", stderr: "Could not find service" } },
  };
  assert.deepEqual(await queryManager(runtime, fixture.definitionPath, false), { loaded: false, enabled: false, state: "stopped" });
});

test("unsupported service platforms fail before looking up a Unix account or invoking a manager", async () => {
  const forbidden = async (): Promise<never> => { throw new Error("Unsupported platforms must not cross a Unix service boundary"); };
  const runtime: ViewerServiceRuntime = {
    platform: "win32",
    uid: -1,
    currentUser: "Alice Smith",
    environment: {},
    nodePath: process.execPath,
    cliPath: "unused",
    managerPath: "unused",
    serviceDirectory: "unused",
    lookupUser: forbidden,
    runner: { run: forbidden },
    chown: forbidden,
    getViewerStatus: forbidden,
  };

  await assert.rejects(resolveViewerServiceHome({}, runtime), /Linux with systemd or macOS with launchd/);
  await assert.rejects(installViewerService({ home: "unused", port: 3217, exposure: "loopback" }, runtime), /Linux with systemd or macOS with launchd/);
  await assert.rejects(uninstallViewerService({ home: "unused" }, runtime), /Linux with systemd or macOS with launchd/);
  await assert.rejects(getViewerServiceStatus({ home: "unused" }, runtime), /Linux with systemd or macOS with launchd/);
});

test("Tailscale service uses the saved absolute command when sudo PATH omits it", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  const executable = path.join(fixture.directory, "tailscale-installed");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await saveViewerConfiguration(fixture.home, {
    config: { port: 3217, exposure: "tailscale", host: "127.0.0.1", tailscaleHostname: "old-name.tailnet.ts.net" },
    urls: ["https://old-name.tailnet.ts.net"],
    tailscaleExecutable: executable,
  });
  fixture.runtime.environment.PATH = "/usr/bin:/bin";
  await installViewerService({ ...fixture.options, exposure: "tailscale" }, fixture.runtime);
  const contents = await readFile(fixture.definitionPath, "utf8");
  assert.equal(parseViewerServiceDefinition(contents).environment.HTML_INBOX_TAILSCALE_COMMAND, executable);
  assert.doesNotMatch(contents, /old-name|--tailscale-hostname/);
});

for (const platform of ["linux", "darwin"] as const) {
  test(`${platform} privileged service installation leaves normal-user log paths untouched`, { skip: serviceRecordingSkip }, async (t) => {
    const fixture = await serviceFixture(t, platform);
    const target = path.join(fixture.directory, "unrelated-log");
    await writeFile(target, "untouched", { mode: 0o640 });
    const before = await lstat(target);
    await symlink(target, path.join(fixture.home, "viewer.log"));

    assert.equal((await installViewerService(fixture.options, fixture.runtime)).state, "running");
    assert.equal(await readFile(target, "utf8"), "untouched");
    assert.equal((await lstat(target)).mode, before.mode);
    assert.equal((await lstat(path.join(fixture.home, "viewer.log"))).isSymbolicLink(), true);
    assert.deepEqual(fixture.changedOwners, []);
  });
}

test("a temporary recording executable receives system service status arguments", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  const recordingFile = path.join(fixture.directory, "calls.json");
  const recordingExecutable = path.join(fixture.directory, "record-service-manager");
  await writeFile(recordingExecutable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(recordingFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('LoadState=not-found\\nActiveState=inactive\\nUnitFileState=disabled\\nFragmentPath=\\nDropInPaths=\\nMainPID=0\\n');\n`);
  await chmod(recordingExecutable, 0o755);
  fixture.runtime.managerPath = recordingExecutable;
  fixture.runtime.runner = new NodeCommandRunner();
  assert.equal((await getViewerServiceStatus(fixture.options, fixture.runtime)).state, "not-installed");
  assert.deepEqual(JSON.parse(await readFile(recordingFile, "utf8")), ["show", "--all", "--no-pager", "--property=LoadState,ActiveState,UnitFileState,FragmentPath,DropInPaths,MainPID", SYSTEMD_VIEWER_NAME]);
});

test("administrator-selected normal UID 500 accounts retain their real home and service identity", { skip: serviceRecordingSkip }, async (t) => {
  const fixture = await serviceFixture(t);
  const runtime = { ...fixture.runtime, lookupUser: async (name: string) => ({ name, uid: 500, gid: 500, home: fixture.userHome }) };
  assert.equal(await resolveViewerServiceHome({ user: "alice" }, runtime), path.join(fixture.userHome, ".html-inbox"));
  const definition = await prepareDefinition({ ...fixture.options, user: "alice" }, runtime, "linux");
  assert.equal(definition.user.uid, 500);
  assert.equal(definition.environment.HOME, fixture.userHome);
  assert.equal(definition.user.name, "alice");
  assert.equal(fixture.manager.invocations.length, 0);
});
