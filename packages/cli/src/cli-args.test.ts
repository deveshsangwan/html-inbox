import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./cli-args";

test("publish accepts separated and equals options without changing metadata", () => {
  const expected = { command: "publish", options: { filePath: "report.html", title: "Quarterly report", type: "report" } };
  assert.deepEqual(parseCommand(["publish", "report.html", "--title", "Quarterly report", "--type=report"]), expected);
  assert.deepEqual(parseCommand(["publish", "--title=Quarterly report", "--type", "report", "report.html"]), expected);
  assert.deepEqual(parseCommand(["publish", "--title=Quarterly report", "--type=report", "--", "-report.html"]), {
    ...expected,
    options: { ...expected.options, filePath: "-report.html" },
  });
});

test("all commands reject unknown options and extra positional arguments", () => {
  for (const args of [
    ["list", "--unknown"], ["list", "extra"],
    ["delete", "id", "extra", "--force"],
    ["publish", "one.html", "two.html", "--title=Title", "--type=report"],
    ["export", "--out=output", "extra"],
    ["viewer", "status", "extra"], ["viewer", "stop", "--unknown"],
    ["remote", "init", "--account=id", "--project=name", "extra"],
    ["remote", "publish", "--adopt"], ["remote", "status", "extra"],
    ["remote", "reconcile", "--yes"], ["remote", "revoke", "--force"],
    ["--version", "extra"],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(" "));
  }
});

test("required and optional string flags reject missing or empty values", () => {
  for (const args of [
    ["publish", "report.html", "--title", "--type=report"],
    ["publish", "report.html", "--title=", "--type=report"],
    ["publish", "report.html", "--title=Title"],
    ["delete"], ["export", "--out="], ["export", "--out=output", "--capability="],
    ["remote", "init", "--account=id"],
    ["remote", "init", "--account=id", "--project=name", "--branch="],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(" "));
  }
});

test("destructive flags remain opt-in and remote options stay command-specific", () => {
  assert.deepEqual(parseCommand(["delete", "id"]), { command: "delete", id: "id", force: false, json: false });
  assert.deepEqual(parseCommand(["remote", "revoke"]), { command: "remote revoke", yes: false, json: false });
  assert.deepEqual(parseCommand(["remote", "reconcile", "--adopt", "--json"]), { command: "remote reconcile", adopt: true, recoverLock: false, json: true });
  assert.deepEqual(parseCommand(["remote", "init", "--account=id", "--project=name", "--branch=release", "--adopt"]), {
    command: "remote init", options: { accountId: "id", projectName: "name", branch: "release", adopt: true, json: false },
  });
  assert.deepEqual(parseCommand(["viewer", "status"]), { command: "viewer", action: "status" });
});

test("abandoned lock recovery is explicit and restricted to reconciliation", () => {
  assert.deepEqual(parseCommand(["remote", "reconcile", "--recover-lock", "--adopt", "--json"]), {
    command: "remote reconcile", adopt: true, recoverLock: true, json: true,
  });

  for (const command of ["init", "publish", "status", "revoke"]) {
    assert.throws(() => parseCommand(["remote", command, "--recover-lock"]), /Unknown option/);
  }
});

test("viewer startup and service installation accept explicit exposure and reject mixed actions", () => {
  assert.deepEqual(parseCommand(["viewer"]), { command: "viewer" });
  assert.deepEqual(parseCommand(["viewer", "--foreground", "--lan", "--host=192.168.1.4", "--port=4567"]), {
    command: "viewer", foreground: true, exposure: "lan", host: "192.168.1.4", port: 4567,
  });
  assert.deepEqual(parseCommand(["viewer", "service", "install", "--user=alice", "--loopback", "--port=3217"]), {
    command: "viewer service", action: "install", user: "alice", exposure: "loopback", port: 3217,
  });
  assert.deepEqual(parseCommand(["viewer", "service", "uninstall", "--user=alice"]), {
    command: "viewer service", action: "uninstall", user: "alice",
  });

  for (const args of [
    ["viewer", "--loopback", "--lan"], ["viewer", "--lan", "--tailscale"],
    ["viewer", "--port=0"], ["viewer", "--port=1.5"], ["viewer", "--port=1e3"], ["viewer", "--port="],
    ["viewer", "status", "--foreground"], ["viewer", "stop", "--port=4567"],
    ["viewer", "--user=alice"], ["viewer", "service"], ["viewer", "service", "install", "--user="],
    ["viewer", "service", "status", "--lan"], ["viewer", "service", "uninstall", "--foreground"],
    ["viewer", "service", "install", "--lan", "--tailscale"],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(" "));
  }
});
