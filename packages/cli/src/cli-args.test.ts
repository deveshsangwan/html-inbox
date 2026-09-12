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
  assert.deepEqual(parseCommand(["remote", "reconcile", "--adopt", "--json"]), { command: "remote reconcile", adopt: true, json: true });
  assert.deepEqual(parseCommand(["remote", "init", "--account=id", "--project=name", "--branch=release", "--adopt"]), {
    command: "remote init", options: { accountId: "id", projectName: "name", branch: "release", adopt: true, json: false },
  });
  assert.deepEqual(parseCommand(["viewer", "status"]), { command: "viewer", action: "status" });
});
