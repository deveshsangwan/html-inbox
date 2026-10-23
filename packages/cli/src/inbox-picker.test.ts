import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { createInbox, type NamedInbox } from "./inbox-catalog";
import { InboxPickerCancelledError, promptForInbox } from "./inbox-picker";
import { resolveInboxSelection } from "./inbox-selection";
import { availablePort, temporaryHome } from "./test-fixtures";
import { VIEWER_PROTOCOL_VERSION } from "./viewer-status";

async function pickerFixture(t: TestContext) {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  const first = await createStoppedInbox("first", path.join(root, "first"), catalogHome);
  const second = await createStoppedInbox("second", path.join(root, "second"), catalogHome);
  return { root, catalogHome, first, second, env: { HTML_INBOX_CATALOG_HOME: catalogHome } };
}

async function createStoppedInbox(name: string, home: string, catalogHome: string) {
  const inbox = await createInbox(name, home, catalogHome);
  const port = await availablePort();
  await writeFile(path.join(home, "viewer-config.json"), JSON.stringify({
    version: 1,
    config: { port, host: "127.0.0.1", exposure: "loopback" },
    urls: [`http://127.0.0.1:${port}`],
  }));
  return inbox;
}

async function startPicker(inboxes: readonly NamedInbox[], isTerminal = false) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: isTerminal, columns: 120 });
  let transcript = "";
  const ready = new Promise<void>((resolve) => {
    output.on("data", (chunk: Buffer) => {
      transcript += chunk.toString("utf8");
      if (transcript.includes("Inbox: ")) {
        resolve();
      }
    });
  });
  const result = promptForInbox(inboxes, input, output);
  await ready;
  return { input, output, result, transcript: () => transcript };
}

async function privateViewerFixture(t: TestContext, inbox: NamedInbox, response: Record<string, unknown> = {}) {
  const token = randomBytes(32).toString("base64url");
  const processId = randomUUID();
  const requests: string[] = [];
  const server = http.createServer((request, reply) => {
    requests.push(request.url ?? "");
    reply.setHeader("Content-Type", "application/json");
    reply.end(JSON.stringify({ ok: true, instanceId: inbox.instanceId, processId, pid: process.pid, protocolVersion: VIEWER_PROTOCOL_VERSION, ...response }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const record = {
    pid: process.pid,
    instanceId: inbox.instanceId,
    processId,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    controlUrl: `http://127.0.0.1:${address.port}/control/${token}`,
    config: { port: address.port, host: "127.0.0.1", exposure: "loopback" },
    urls: [`http://127.0.0.1:${address.port}`],
    startedAt: new Date().toISOString(),
  };
  await writeFile(path.join(inbox.home, "viewer.json"), JSON.stringify(record));
  return { record, requests, token };
}

async function snapshotTree(root: string): Promise<unknown> {
  const info = await lstat(root);
  if (!info.isDirectory()) {
    return { mode: info.mode, contents: await readFile(root, "utf8"), modifiedAt: info.mtimeMs, changedAt: info.ctimeMs };
  }

  const entries = await readdir(root);
  return { mode: info.mode, changedAt: info.ctimeMs, entries: await Promise.all(entries.sort().map(async (name) => [name, await snapshotTree(path.join(root, name))])) };
}

test("picker accepts a listed #number or name for one operation", { timeout: 3000 }, async (t) => {
  const { first, second } = await pickerFixture(t);
  for (const answer of ["#2", "second", "  second  "]) {
    const picker = await startPicker([first, second]);
    assert.match(picker.transcript(), /#1 first\tviewer stopped/);
    assert.match(picker.transcript(), /#2 second\tviewer stopped/);
    picker.input.write(`${answer}\n`);
    assert.equal(await picker.result, "second");
    assert.equal(picker.input.isPaused(), true);
  }
});

test("blank, unknown, and invalid numbers reprompt without an implicit default", { timeout: 3000 }, async (t) => {
  const { first } = await pickerFixture(t);
  const picker = await startPicker([first]);
  picker.input.write("\nunknown\n#0\n#-1\n#1.5\n#99999999999999999999999\nfirst\n");

  assert.equal(await picker.result, "first");
  assert.equal(picker.transcript().split("Enter a listed name or #number, or :q to cancel.").length - 1, 6);
});

test("numeric names and the name q can be chosen explicitly", { timeout: 3000 }, async (t) => {
  const { root, catalogHome, first } = await pickerFixture(t);
  const numeric = await createStoppedInbox("1", path.join(root, "numeric"), catalogHome);
  const namedQ = await createStoppedInbox("q", path.join(root, "q"), catalogHome);
  for (const [answer, expected] of [["#1", first.name], ["1", numeric.name], ["q", namedQ.name], ["#3", namedQ.name]]) {
    const picker = await startPicker([first, numeric, namedQ]);
    picker.input.write(`${answer}\n`);
    assert.equal(await picker.result, expected);
  }

  const picker = await startPicker([namedQ]);
  picker.input.write(":q\n");
  await assert.rejects(picker.result, InboxPickerCancelledError);
});

test("missing, conflicting, and incompatible library roots remain visible and cannot be chosen", { timeout: 3000 }, async (t) => {
  const { root, catalogHome, first, second } = await pickerFixture(t);
  const incompatible = await createStoppedInbox("incompatible", path.join(root, "incompatible"), catalogHome);
  const healthy = await createStoppedInbox("healthy", path.join(root, "healthy"), catalogHome);
  await rm(first.home, { recursive: true });
  await writeFile(path.join(second.home, "instance-id"), randomUUID());
  await rm(path.join(incompatible.home, "documents"), { recursive: true });
  await writeFile(path.join(incompatible.home, "documents"), "not a directory");
  const before = await snapshotTree(root);
  const picker = await startPicker([first, second, incompatible, healthy]);

  assert.match(picker.transcript(), /first\tlibrary missing; unavailable/);
  assert.match(picker.transcript(), /second\tlibrary conflict; unavailable/);
  assert.match(picker.transcript(), /incompatible\tlibrary incompatible; unavailable/);
  picker.input.write("#1\nsecond\n#3\nhealthy\n");
  assert.equal(await picker.result, "healthy");
  assert.equal(picker.transcript().split("That library is unavailable.").length - 1, 3);
  assert.deepEqual(await snapshotTree(root), before);
});

test("all unavailable entries can be inspected and cancelled without choosing a target", { timeout: 3000 }, async (t) => {
  const { root, first, second } = await pickerFixture(t);
  await rm(first.home, { recursive: true });
  await rm(second.home, { recursive: true });
  const before = await snapshotTree(root);
  const picker = await startPicker([first, second]);
  picker.input.write("#1\nsecond\n\nq\n");

  await assert.rejects(picker.result, InboxPickerCancelledError);
  assert.equal(picker.transcript().split("library missing; unavailable").length - 1, 2);
  assert.equal(picker.transcript().split("That library is unavailable.").length - 1, 2);
  assert.deepEqual(await snapshotTree(root), before);
});

test("q, Ctrl-C, and EOF cancel without an operation or storage mutation", { timeout: 3000 }, async (t) => {
  const { root, first, env } = await pickerFixture(t);
  const before = await snapshotTree(root);
  for (const ending of ["q", ":q", "interrupt", "eof", "eof-without-enter", "close"]) {
    const picker = await startPicker([first], ending === "interrupt");
    if (ending === "eof") {
      picker.input.end();
    } else if (ending === "eof-without-enter") {
      picker.input.end("first");
    } else if (ending === "close") {
      picker.input.destroy();
    } else {
      picker.input.write(ending === "interrupt" ? "\x03" : `${ending}\n`);
    }

    await assert.rejects(picker.result, InboxPickerCancelledError);
    assert.equal(picker.input.isPaused(), true);
    assert.equal(picker.input.listenerCount("keypress"), 0);
    assert.equal(picker.input.listenerCount("end"), 0);
  }

  const input = new PassThrough();
  const output = new PassThrough();
  let operationCount = 0;
  const operation = resolveInboxSelection({}, env, undefined, {
    requireSelection: true,
    chooseInbox: (inboxes) => promptForInbox(inboxes, input, output),
  }).then(() => { operationCount += 1; });
  input.end();
  await assert.rejects(operation, InboxPickerCancelledError);
  assert.equal(operationCount, 0);
  assert.deepEqual(await snapshotTree(root), before);
});

test("an input that already reached EOF or was destroyed cancels without hanging", { timeout: 3000 }, async (t) => {
  const { first } = await pickerFixture(t);
  const input = new PassThrough();
  input.resume();
  const ended = new Promise<void>((resolve) => input.once("end", resolve));
  input.end();
  await ended;

  await assert.rejects(promptForInbox([first], input, new PassThrough()), InboxPickerCancelledError);
  const destroyed = new PassThrough();
  destroyed.destroy();
  await assert.rejects(promptForInbox([first], destroyed, new PassThrough()), InboxPickerCancelledError);
});

test("a cancelled choice preserves catalog permissions and metadata as well as library files", { timeout: 3000 }, async (t) => {
  const { root, catalogHome, env } = await pickerFixture(t);
  if (process.platform !== "win32") {
    await chmod(catalogHome, 0o755);
    await chmod(path.join(catalogHome, "inboxes"), 0o755);
    await chmod(path.join(catalogHome, "inboxes", "first.json"), 0o644);
    await chmod(path.join(catalogHome, "inboxes", "second.json"), 0o644);
  }
  const before = await snapshotTree(root);
  const input = new PassThrough();
  const output = new PassThrough();
  const ready = new Promise<void>((resolve) => output.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Inbox: ")) {
      resolve();
    }
  }));
  const operation = resolveInboxSelection({}, env, undefined, {
    requireSelection: true,
    chooseInbox: (inboxes) => promptForInbox(inboxes, input, output),
  });
  await ready;
  input.write("q\n");

  await assert.rejects(operation, InboxPickerCancelledError);
  assert.deepEqual(await snapshotTree(root), before);
});

test("viewer conflicts and incompatible records label healthy selectable libraries", { timeout: 3000 }, async (t) => {
  const { first, second } = await pickerFixture(t);
  const { record } = await privateViewerFixture(t, first);
  await writeFile(path.join(first.home, "viewer.json"), JSON.stringify({ ...record, instanceId: randomUUID() }));
  await writeFile(path.join(second.home, "viewer.json"), JSON.stringify({ ...record, instanceId: second.instanceId, protocolVersion: 1 }));

  for (const [answer, name] of [["#1", "first"], ["second", "second"]]) {
    const picker = await startPicker([first, second]);
    assert.match(picker.transcript(), /first\tviewer conflict/);
    assert.match(picker.transcript(), /second\tviewer incompatible/);
    picker.input.write(`${answer}\n`);
    assert.equal(await picker.result, name);
  }
});

test("running viewer labels use private control only and expose no control fields", { timeout: 3000 }, async (t) => {
  const { root, first } = await pickerFixture(t);
  const { record, requests, token } = await privateViewerFixture(t, first);
  if (process.platform !== "win32") {
    await chmod(first.home, 0o755);
    await chmod(path.join(first.home, "instance-id"), 0o644);
    await chmod(path.join(first.home, "viewer.json"), 0o644);
  }
  const before = await snapshotTree(root);
  const picker = await startPicker([first]);

  assert.match(picker.transcript(), /first\tviewer running/);
  assert.deepEqual(requests, [`/control/${token}`]);
  assert.equal(picker.transcript().includes(token), false);
  assert.equal(picker.transcript().includes(record.instanceId), false);
  assert.equal(picker.transcript().includes(record.processId), false);
  assert.equal(picker.transcript().includes(record.controlUrl), false);
  picker.input.write("first\n");
  assert.equal(await picker.result, "first");
  assert.deepEqual(await snapshotTree(root), before);
});

test("a control endpoint with another process identity labels a conflict without blocking selection", { timeout: 3000 }, async (t) => {
  const { first } = await pickerFixture(t);
  await privateViewerFixture(t, first, { processId: randomUUID() });
  const picker = await startPicker([first]);

  assert.match(picker.transcript(), /first\tviewer conflict/);
  picker.input.write("#1\n");
  assert.equal(await picker.result, "first");
});

test("reader and remote URLs in control records are never contacted", { timeout: 3000 }, async (t) => {
  const { first } = await pickerFixture(t);
  const { record, requests } = await privateViewerFixture(t, first);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => assert.fail("Invalid control endpoints must not be fetched"));

  for (const controlUrl of [record.urls[0], "http://example.invalid/control/private", "http://127.0.0.1:3217/health"]) {
    await writeFile(path.join(first.home, "viewer.json"), JSON.stringify({ ...record, controlUrl }));
    const picker = await startPicker([first]);
    assert.match(picker.transcript(), /first\tviewer incompatible/);
    picker.input.write("#1\n");
    assert.equal(await picker.result, "first");
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(requests, []);
});

test("selection revalidates the displayed identity after the user waits", { timeout: 3000 }, async (t) => {
  const { catalogHome, first, env } = await pickerFixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const ready = new Promise<void>((resolve) => output.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Inbox: ")) {
      resolve();
    }
  }));
  const operation = resolveInboxSelection({}, env, undefined, {
    requireSelection: true,
    chooseInbox: (inboxes) => promptForInbox(inboxes, input, output),
  });
  await ready;
  const replacementId = randomUUID();
  await writeFile(path.join(first.home, "instance-id"), replacementId);
  await writeFile(path.join(catalogHome, "inboxes", "first.json"), JSON.stringify({ schemaVersion: 1, ...first, instanceId: replacementId }));
  input.write("first\n");

  await assert.rejects(operation, /missing or different identity/);
});
