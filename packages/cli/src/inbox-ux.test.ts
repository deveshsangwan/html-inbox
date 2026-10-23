import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout, stderr } from "node:process";
import { test, type TestContext } from "node:test";
import { createInbox, setDefaultInbox } from "./inbox-catalog";
import { main } from "./index";
import * as inboxPicker from "./inbox-picker";
import { temporaryHome } from "./test-fixtures";

async function uxFixture(t: TestContext) {
  const root = await realpath(await temporaryHome(t));
  const catalog = path.join(root, "catalog");
  const previous = { ...process.env };
  process.env.HTML_INBOX_CATALOG_HOME = catalog;
  delete process.env.HTML_INBOX_NAME;
  delete process.env.HTML_INBOX_HOME;
  delete process.env.HTML_INBOX_PORT;
  t.after(() => { process.env = previous; });

  const streams = [stdin, stdout, stderr];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  const setTty = (values: boolean[]) => {
    streams.forEach((stream, index) => Object.defineProperty(stream, "isTTY", { configurable: true, value: values[index] }));
  };
  setTty([true, true, true]);
  t.after(() => {
    streams.forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  });

  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => { output.push(value); });
  t.mock.method(console, "error", () => undefined);
  const inbox = await createInbox("home", path.join(root, "home"), catalog);

  return { root, catalog, inbox, output, setTty };
}

test("interactive destination choice is operation-local and binding tiers bypass the picker", async (t) => {
  const fixture = await uxFixture(t);
  let choices = 0;
  t.mock.method(inboxPicker, "promptForInbox", async () => { choices += 1; return "home"; });

  await main(["list"]);
  assert.equal(choices, 1);
  assert.deepEqual(fixture.output, ["No documents."]);
  await assert.rejects(lstat(path.join(fixture.catalog, "default.json")), { code: "ENOENT" });

  await main(["list", "--inbox=home"]);
  process.env.HTML_INBOX_NAME = "home";
  await main(["preferences"]);
  delete process.env.HTML_INBOX_NAME;
  await setDefaultInbox("home", fixture.catalog);
  await main(["list"]);
  assert.equal(choices, 1);
});

test("each redirected stream and every JSON command shape refuses an unbound destination without prompting", async (t) => {
  const fixture = await uxFixture(t);
  t.mock.method(inboxPicker, "promptForInbox", async () => assert.fail("Automation must never prompt"));

  for (const streams of [[false, true, true], [true, false, true], [true, true, false]]) {
    fixture.setTty(streams);
    await assert.rejects(main(["list"]), /--inbox/);
  }

  fixture.setTty([true, true, true]);
  for (const args of [
    ["list", "--json"],
    ["preferences", "--json"],
    ["publish", "report.html", "--title=Report", "--type=report", "--json"],
    ["export", "--out", path.join(fixture.root, "export"), "--json"],
    ["remote", "init", "--account=account", "--project=project", "--json"],
    ["viewer", "status", "--json"],
    ["viewer", "stop", "--json"],
    ["delete", "document-id", "--json"],
    ["remote", "revoke", "--json"],
  ]) {
    await assert.rejects(main(args), /--inbox/);
  }

  assert.deepEqual(fixture.output, []);
  await assert.rejects(lstat(path.join(fixture.root, "export")), { code: "ENOENT" });
});

test("catalog management bypasses destination choice and cancellation leaves stdout empty", async (t) => {
  const fixture = await uxFixture(t);
  t.mock.method(inboxPicker, "promptForInbox", async () => { throw new Error("Inbox selection cancelled"); });

  await main(["inbox", "list"]);
  assert.match(fixture.output[0] ?? "", /NAME\s+STATE\s+READER/);
  fixture.output.length = 0;
  await main(["inbox", "list", "--running", "--json"]);
  assert.deepEqual(JSON.parse(fixture.output[0] ?? ""), []);
  fixture.output.length = 0;

  await assert.rejects(main(["list"]), /selection cancelled/);
  assert.deepEqual(fixture.output, []);
});

test("JSON destructive commands require explicit authorization even with a full terminal", async (t) => {
  const fixture = await uxFixture(t);

  await assert.rejects(main(["delete", "document-id", "--inbox=home", "--json"]), /requires --force/);
  await assert.rejects(main(["remote", "revoke", "--inbox=home", "--json"]), /requires --yes/);
  assert.deepEqual(fixture.output, []);
});
