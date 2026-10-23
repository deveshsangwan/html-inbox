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
    ["preferences", "extra"], ["preferences", "--unknown"],
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
    ["preferences", "--appearance"], ["preferences", "--appearance="],
    ["remote", "init", "--account=id"],
    ["remote", "init", "--account=id", "--project=name", "--branch="],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(" "));
  }
});

test("preferences defaults to inspection and accepts only supported appearances", () => {
  assert.deepEqual(parseCommand(["preferences"]), { command: "preferences", json: false });
  assert.deepEqual(parseCommand(["preferences", "--json"]), { command: "preferences", json: true });

  for (const appearance of ["system", "light", "dark"]) {
    for (const flag of [["--appearance", appearance], [`--appearance=${appearance}`]]) {
      assert.deepEqual(parseCommand(["preferences", ...flag, "--json"]), {
        command: "preferences", appearance, json: true,
      });
    }
  }

  for (const appearance of ["auto", "Dark", " light", "dark "]) {
    assert.throws(() => parseCommand(["preferences", `--appearance=${appearance}`]), /Appearance must be system, light, or dark/);
  }
});

test("destructive flags remain opt-in and remote options stay command-specific", () => {
  assert.deepEqual(parseCommand(["delete", "id"]), { command: "delete", id: "id", force: false, json: false });
  assert.deepEqual(parseCommand(["delete", "id", "--json"]), { command: "delete", id: "id", force: false, json: true });
  assert.deepEqual(parseCommand(["remote", "revoke"]), { command: "remote revoke", yes: false, json: false });
  assert.deepEqual(parseCommand(["remote", "revoke", "--json"]), { command: "remote revoke", yes: false, json: true });
  assert.deepEqual(parseCommand(["remote", "reconcile", "--adopt", "--json"]), { command: "remote reconcile", adopt: true, recoverLock: false, json: true });
  assert.deepEqual(parseCommand(["remote", "init", "--account=id", "--project=name", "--branch=release", "--adopt"]), {
    command: "remote init", options: { accountId: "id", projectName: "name", branch: "release", adopt: true, json: false },
  });
  assert.deepEqual(parseCommand(["viewer", "status"]), { command: "viewer", action: "status", json: false });
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
    command: "viewer service", action: "install", user: "alice", exposure: "loopback", port: 3217, json: false,
  });
  assert.deepEqual(parseCommand(["viewer", "service", "uninstall", "--user=alice"]), {
    command: "viewer service", action: "uninstall", user: "alice", json: false,
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

test("viewer status and stop accept JSON without admitting startup options", () => {
  for (const action of ["status", "stop"]) {
    assert.deepEqual(parseCommand(["viewer", action]), { command: "viewer", action, json: false });
    assert.deepEqual(parseCommand(["viewer", action, "--json"]), { command: "viewer", action, json: true });
    assert.deepEqual(parseCommand(["viewer", "--json", action, "--inbox=office"]), {
      command: "viewer", action, json: true, inbox: "office",
    });

    for (const flag of ["--foreground", "--port=4567", "--host=127.0.0.1", "--loopback", "--lan", "--tailscale"]) {
      assert.throws(
        () => parseCommand(["viewer", action, "--json", flag]),
        /does not accept startup options/,
        `${action} ${flag}`,
      );
    }
  }

  assert.throws(() => parseCommand(["viewer", "--json"]), /requires status or stop/);
  assert.throws(() => parseCommand(["viewer", "--foreground", "--json"]), /requires status or stop/);
});

test("viewer service actions expose explicit JSON mode and preserve command-specific options", () => {
  for (const action of ["install", "status", "uninstall"]) {
    assert.deepEqual(parseCommand(["viewer", "service", action]), {
      command: "viewer service", action, json: false,
    });
    assert.deepEqual(parseCommand(["viewer", "service", action, "--json", "--user=alice", "--home=/libraries/office"]), {
      command: "viewer service", action, user: "alice", home: "/libraries/office", json: true,
    });

    for (const flag of ["--foreground", "--unknown", "--running"]) {
      assert.throws(() => parseCommand(["viewer", "service", action, "--json", flag]), /Unknown option/);
    }

    assert.throws(() => parseCommand(["viewer", "service", action, "--json", "extra"]), /Unexpected argument/);
    assert.throws(() => parseCommand(["viewer", "service", action, "--json", "--user="]), /requires a normal user name/);
  }

  assert.deepEqual(parseCommand(["viewer", "service", "install", "--json", "--lan", "--host=192.168.1.4", "--port=4567"]), {
    command: "viewer service", action: "install", exposure: "lan", host: "192.168.1.4", port: 4567, json: true,
  });

  for (const action of ["status", "uninstall"]) {
    for (const flag of ["--port=4567", "--host=127.0.0.1", "--loopback", "--lan", "--tailscale"]) {
      assert.throws(() => parseCommand(["viewer", "service", action, "--json", flag]), /Unknown option/);
    }
  }
});

test("catalog list accepts a running filter with optional JSON and rejects unrelated arguments", () => {
  assert.deepEqual(parseCommand(["inbox", "list"]), { command: "inbox list", running: false, json: false });
  assert.deepEqual(parseCommand(["inbox", "list", "--json"]), { command: "inbox list", running: false, json: true });
  assert.deepEqual(parseCommand(["inbox", "list", "--running"]), { command: "inbox list", running: true, json: false });
  assert.deepEqual(parseCommand(["inbox", "list", "--json", "--running"]), { command: "inbox list", running: true, json: true });

  for (const args of [
    ["inbox", "list", "extra"], ["inbox", "list", "--running=true"],
    ["inbox", "list", "--unknown"], ["inbox", "list", "--inbox=office"], ["inbox", "list", "--home=/office"],
    ["inbox", "create", "office", "--home=/office", "--running"],
    ["list", "--running"], ["viewer", "status", "--running"],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(" "));
  }
});

test("all library operations carry explicit selection without changing command options", () => {
  for (const args of [
    ["publish", "report.html", "--title=Title", "--type=report"],
    ["list", "--json"], ["preferences", "--appearance=dark"],
    ["delete", "id", "--force"], ["export", "--out=output"],
    ["viewer"], ["viewer", "status"], ["viewer", "stop"],
    ["viewer", "service", "status"], ["remote", "status"],
  ]) {
    assert.deepEqual(parseCommand([...args, "--inbox=office"]), { ...parseCommand(args), inbox: "office" });
    assert.deepEqual(parseCommand([...args, "--home", "/libraries/office"]), { ...parseCommand(args), home: "/libraries/office" });
  }

  assert.deepEqual(parseCommand(["publish", "--inbox=home", "--title=Title", "--type=report", "--", "--home"]), {
    command: "publish", inbox: "home", options: { filePath: "--home", title: "Title", type: "report" },
  });
  assert.throws(() => parseCommand(["list", "--inbox=a", "--inbox=b"]), /only once/);
  assert.throws(() => parseCommand(["list", "--home"]), /requires a value/);
  assert.throws(() => parseCommand(["--version", "--inbox=a"]), /requires a library command/);
});

test("catalog and hub administration require intentional names, homes and membership", () => {
  assert.deepEqual(parseCommand(["inbox", "create", "office", "--home=/libraries/office"]), {
    command: "inbox create", name: "office", home: "/libraries/office", json: false,
  });
  assert.deepEqual(parseCommand(["inbox", "default", "--clear"]), { command: "inbox default", clear: true });
  assert.deepEqual(parseCommand(["hub", "init", "--config=/hub.json", "--inbox=home", "--inbox=office"]), {
    command: "hub init", config: "/hub.json", name: "Reading hub", inboxes: ["home", "office"],
  });
  assert.deepEqual(parseCommand(["hub", "--config=/hub.json"]), { command: "hub", config: "/hub.json", port: 3218, exposure: "loopback" });

  for (const args of [
    ["inbox", "create", "office"], ["inbox", "register", "--home=/a"],
    ["inbox", "default", "office", "--clear"], ["hub", "init", "--config=/hub.json"],
    ["hub", "--config=/hub.json", "--tailscale"], ["hub", "--config=/hub.json", "--loopback", "--lan"],
  ]) {
    assert.throws(() => parseCommand(args), Error, args.join(" "));
  }
});
