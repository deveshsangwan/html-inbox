import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { availablePort, temporaryHome } from "./test-fixtures";
import { defaultRuntime } from "./viewer-service-runtime";
import type { ViewerServiceDefinition } from "./viewer-service-definition";
import { queryViewerServiceProcess } from "./viewer-service-status";

test("service health commands drop to the selected account before loading user-controlled executable configuration", async (t) => {
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
