import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { ExecFileOptions, SpawnOptions } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { availablePort, temporaryHome } from "./test-fixtures";
import { defaultRuntime } from "./viewer-service-runtime";
import type { ViewerServiceDefinition } from "./viewer-service-definition";
import { queryViewerServiceProcess } from "./viewer-service-status";

test("service health commands drop to the selected account before loading user-controlled executable configuration", async (t) => {
  const originalGetUid = process.getuid;
  process.getuid = () => 500;
  t.after(() => {
    process.getuid = originalGetUid;
  });

  const definition: ViewerServiceDefinition = {
    platform: "linux",
    home: "/selected/inbox",
    port: 3217,
    exposure: "tailscale",
    user: { name: "alice", uid: 500, gid: 500, home: "/selected/home" },
    nodePath: "/selected/node",
    cliPath: "/selected/html-inbox.js",
    environment: {
      HTML_INBOX_TAILSCALE_COMMAND: "/selected/user-controlled-tailscale",
    },
  };
  let invocations = 0;
  let status: unknown = { state: "running", pid: 4242 };
  t.mock.method(
    childProcess,
    "execFile",
    (
      command: string,
      args: string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      invocations += 1;
      assert.equal(command, definition.nodePath);
      assert.deepEqual(args, [definition.cliPath, "viewer", "status"]);
      assert.equal(options.uid, 500);
      assert.equal(options.gid, 500);
      assert.equal(options.cwd, definition.user.home);
      assert.equal(
        options.env?.HTML_INBOX_TAILSCALE_COMMAND,
        definition.environment.HTML_INBOX_TAILSCALE_COMMAND,
      );
      assert.equal(options.env?.HTML_INBOX_HOME, definition.home);
      assert.equal(options.env?.HTML_INBOX_PORT, "3217");
      assert.equal(options.env?.SUDO_USER, undefined);
      callback(null, JSON.stringify(status), "");
      return new childProcess.ChildProcess();
    },
  );

  assert.deepEqual(await defaultRuntime().getViewerStatus(definition), {
    state: "running",
    pid: 4242,
  });
  await assert.rejects(
    queryViewerServiceProcess({
      ...definition,
      user: { ...definition.user, uid: 0 },
    }),
    /selected non-root user/,
  );
  await assert.rejects(
    queryViewerServiceProcess({
      ...definition,
      user: { ...definition.user, uid: -1 },
    }),
    /selected non-root user/,
  );
  assert.equal(invocations, 1);

  status = { state: ["running"], pid: 4242 };
  await assert.rejects(
    queryViewerServiceProcess(definition),
    /malformed normal-user status/,
  );
  status = { state: "running", pid: 0 };
  await assert.rejects(
    queryViewerServiceProcess(definition),
    /malformed normal-user status/,
  );
  assert.equal(invocations, 3);
});

test("administrator status initializes account groups and drops privileges before executing selected code", async (t) => {
  const originalGetUid = process.getuid;
  process.getuid = () => 0;
  t.after(() => {
    process.getuid = originalGetUid;
  });
  const definition: ViewerServiceDefinition = {
    platform: "linux",
    home: "/selected/inbox",
    port: 3217,
    exposure: "tailscale",
    user: { name: "alice", uid: 500, gid: 500, home: "/selected/home" },
    nodePath: "/selected/node",
    cliPath: "/selected/html-inbox.js",
    environment: {
      NODE_OPTIONS: "--require=/selected/user-code.js",
      NODE_PATH: "/selected/modules",
      HTML_INBOX_TAILSCALE_COMMAND: "/selected/tailscale",
    },
  };
  let invocations = 0;
  t.mock.method(
    childProcess,
    "execFile",
    (
      command: string,
      args: string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      invocations += 1;
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(0, 2), ["--input-type=commonjs", "-e"]);
      assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
      assert.equal(options.cwd, "/");
      assert.equal(options.uid, undefined);
      assert.equal(options.gid, undefined);
      assert.equal(options.timeout, 25_000);
      assert.equal(options.maxBuffer, 64 * 1024);
      assert.equal(options.killSignal, "SIGTERM");

      const operations: string[] = [];
      const statusChild = new childProcess.ChildProcess();
      const signalHandlers = new Map<string, () => void>();
      const helperProcess = {
        argv: [process.execPath, args[3]],
        initgroups: (uid: number, gid: number) => {
          operations.push(`initgroups:${uid}:${gid}`);
        },
        setgid: (gid: number) => {
          operations.push(`setgid:${gid}`);
        },
        setuid: (uid: number) => {
          operations.push(`setuid:${uid}`);
        },
        getuid: () => {
          operations.push("getuid");
          return 500;
        },
        getgid: () => {
          operations.push("getgid");
          return 500;
        },
        once: (signal: string, handler: () => void) => {
          signalHandlers.set(signal, handler);
        },
        exitCode: undefined,
      };
      vm.runInNewContext(args[2], {
        process: helperProcess,
        console: { error: () => assert.fail("Unexpected helper error") },
        require: (specifier: string) => {
          assert.deepEqual(operations, [
            "initgroups:500:500",
            "setgid:500",
            "setuid:500",
            "getuid",
            "getgid",
          ]);
          assert.equal(specifier, "node:child_process");
          return {
            spawn: (
              selectedCommand: string,
              selectedArgs: string[],
              selectedOptions: SpawnOptions,
            ) => {
              operations.push("spawn");
              assert.equal(selectedCommand, definition.nodePath);
              assert.deepEqual(Array.from(selectedArgs), [
                definition.cliPath,
                "viewer",
                "status",
              ]);
              assert.equal(selectedOptions.uid, undefined);
              assert.equal(selectedOptions.gid, undefined);
              assert.equal(selectedOptions.cwd, definition.user.home);
              assert.deepEqual(
                { ...selectedOptions.env },
                {
                  ...definition.environment,
                  HTML_INBOX_HOME: definition.home,
                  HTML_INBOX_PORT: "3217",
                },
              );
              assert(Array.isArray(selectedOptions.stdio));
              assert.deepEqual(Array.from(selectedOptions.stdio), [
                "ignore",
                "inherit",
                "inherit",
              ]);
              return statusChild;
            },
          };
        },
      });
      assert.deepEqual(operations, [
        "initgroups:500:500",
        "setgid:500",
        "setuid:500",
        "getuid",
        "getgid",
        "spawn",
      ]);
      let childKillSignal: string | number | undefined;
      t.mock.method(statusChild, "kill", (signal?: string | number) => {
        childKillSignal = signal;
        return true;
      });
      signalHandlers.get("SIGTERM")?.();
      assert.equal(childKillSignal, "SIGKILL");
      statusChild.emit("exit", 0, null);
      assert.equal(helperProcess.exitCode, 0);
      callback(null, JSON.stringify({ state: "running", pid: 4242 }), "");
      return new childProcess.ChildProcess();
    },
  );

  assert.deepEqual(await queryViewerServiceProcess(definition), {
    state: "running",
    pid: 4242,
  });
  for (const user of [
    { ...definition.user, uid: 0 },
    { ...definition.user, gid: -1 },
    { ...definition.user, name: "root" },
    { ...definition.user, name: "invalid\naccount" },
  ]) {
    await assert.rejects(
      queryViewerServiceProcess({ ...definition, user }),
      /selected non-root user/,
    );
  }
  assert.equal(invocations, 1);
});

test("administrator status refuses to load selected code when any credential switch fails", async (t) => {
  const originalGetUid = process.getuid;
  process.getuid = () => 0;
  t.after(() => {
    process.getuid = originalGetUid;
  });
  t.mock.method(
    childProcess,
    "execFile",
    (
      command: string,
      args: string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(0, 2), ["--input-type=commonjs", "-e"]);
      assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
      for (const failedOperation of ["initgroups", "setgid", "setuid"]) {
        const operations: string[] = [];
        const recordSwitch = (operation: string) => {
          operations.push(operation);
          if (operation === failedOperation)
            throw new Error("Recorded account switch failure");
        };
        assert.throws(
          () =>
            vm.runInNewContext(args[2], {
              process: {
                argv: [process.execPath, args[3]],
                initgroups: () => recordSwitch("initgroups"),
                setgid: () => recordSwitch("setgid"),
                setuid: () => recordSwitch("setuid"),
              },
              require: () =>
                assert.fail(
                  "Selected code must not load before credential switches succeed",
                ),
            }),
          /Recorded account switch failure/,
        );
        assert.equal(operations.at(-1), failedOperation);
      }

      for (const identity of [
        { uid: 501, gid: 500 },
        { uid: 500, gid: 501 },
      ]) {
        assert.throws(
          () =>
            vm.runInNewContext(args[2], {
              process: {
                argv: [process.execPath, args[3]],
                initgroups: () => {},
                setgid: () => {},
                setuid: () => {},
                getuid: () => identity.uid,
                getgid: () => identity.gid,
              },
              require: () =>
                assert.fail(
                  "Selected code must not load with a mismatched identity",
                ),
            }),
          /identity did not match/,
        );
      }

      callback(new Error("Recorded account switch failure"), "", "");
      return new childProcess.ChildProcess();
    },
  );
  await assert.rejects(
    queryViewerServiceProcess({
      platform: "linux",
      home: "/selected/inbox",
      port: 3217,
      exposure: "loopback",
      user: { name: "alice", uid: 500, gid: 500, home: "/selected/home" },
      nodePath: "/selected/node",
      cliPath: "/selected/cli.js",
      environment: {},
    }),
    /Recorded account switch failure/,
  );
});

test(
  "a service health child runs the ordinary viewer status CLI under the current normal account",
  {
    skip:
      process.platform === "win32"
        ? "Boot service UID/GID checks require POSIX account APIs."
        : false,
  },
  async (t) => {
    const home = await temporaryHome(t);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    assert(uid !== undefined && uid > 0 && gid !== undefined);
    const status = await queryViewerServiceProcess({
      platform: "linux",
      home,
      port: await availablePort(),
      exposure: "loopback",
      user: { name: "normal-user", uid, gid, home },
      nodePath: process.execPath,
      cliPath: path.join(__dirname, "index.js"),
      environment: { PATH: path.dirname(process.execPath) },
    });

    assert.deepEqual(status, { state: "stopped" });
  },
);
