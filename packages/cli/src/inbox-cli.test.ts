import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { availablePort, temporaryHome } from "./test-fixtures";
import { stopViewer } from "./viewer-server";
import { LocalDocumentBackend } from "./backend";

const executeFile = promisify(execFile);

test("catalog CLI clears and resets corrupt defaults without starting a listener", async (t) => {
  const root = await temporaryHome(t);
  const catalogHome = path.join(root, "catalog");
  const env = { ...process.env, HTML_INBOX_CATALOG_HOME: catalogHome, HTML_INBOX_HOME: undefined, HTML_INBOX_NAME: undefined };
  const run = (...args: string[]) => executeFile(process.execPath, [path.join(__dirname, "index.js"), ...args], { env });
  await run("inbox", "create", "work", "--home", path.join(root, "work"));
  const defaultPath = path.join(catalogHome, "default.json");

  for (const contents of ["{", "null", '{"schemaVersion":99,"name":"work"}', " ".repeat(64 * 1024 + 1)]) {
    await writeFile(defaultPath, contents, { mode: 0o600 });
    await assert.rejects(run("list", "--json"));
    await run("inbox", "default", "--clear");
    await assert.rejects(lstat(defaultPath), { code: "ENOENT" });

    await writeFile(defaultPath, contents, { mode: 0o600 });
    await run("inbox", "default", "work");
    assert.deepEqual(JSON.parse(await readFile(defaultPath, "utf8")), { schemaVersion: 1, name: "work" });
    assert.deepEqual(JSON.parse((await run("list", "--json")).stdout), []);
  }
});

test("named CLI destinations isolate data, startup identity, preferences, export and lifecycle", { timeout: 60_000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-named-cli-")));
  const viewers: { home: string; port: number }[] = [];
  t.after(async () => {
    try {
      for (const viewer of viewers) {
        await stopViewer(viewer.home, viewer.port);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const env = { ...process.env, HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"), HTML_INBOX_HOME: undefined, HTML_INBOX_NAME: undefined, HTML_INBOX_PORT: undefined };
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => executeFile(process.execPath, [path.join(__dirname, "index.js"), ...args], { env: { ...env, ...overrides } });
  await run(["inbox", "create", "first", "--home", first]);
  await run(["inbox", "create", "second", "--home", second]);
  await run(["inbox", "default", "second"]);
  const firstPort = String(await availablePort());
  viewers.push({ home: first, port: Number(firstPort) });
  await run(["viewer", "--inbox", "first", "--port", firstPort], { HTML_INBOX_NAME: "second" });
  const status = JSON.parse((await run(["viewer", "status", "--json", "--inbox=first"])).stdout);
  assert.equal(status.state, "running");
  assert.equal(status.inbox, "first");
  assert.equal(status.port, Number(firstPort));
  assert.match(await (await fetch(status.url)).text(), /<h1 class="library__title">first<\/h1>/);
  const secondPort = String(await availablePort());
  viewers.push({ home: second, port: Number(secondPort) });
  await run(["viewer", "--inbox=second", "--port", secondPort]);

  const source = path.join(root, "report.html");
  const bytes = Buffer.from("<!doctype html><html><body><h1>Selected library</h1></body></html>");
  await writeFile(source, bytes);
  const published = await run(["publish", source, "--title=Selected library", "--type=report", "--inbox=first"], { HTML_INBOX_NAME: "second" });
  assert.match(published.stdout, /^http:\/\/127\.0\.0\.1:\d+\/documents\/[a-zA-Z0-9_-]+\n$/);
  assert.match(published.stderr, /Inbox first/);
  assert.equal(new URL(published.stdout.trim()).origin, status.url);
  const firstDocuments = JSON.parse((await run(["list", "--inbox=first", "--json"])).stdout);
  assert.equal(firstDocuments.length, 1);
  assert.deepEqual(JSON.parse((await run(["list", "--json"])).stdout), []);
  assert.deepEqual(await readFile(path.join(first, "documents", firstDocuments[0].id, "index.html")), bytes);

  await run(["preferences", "--inbox=first", "--appearance=dark"]);
  assert.deepEqual(JSON.parse((await run(["preferences", "--inbox=second", "--json"])).stdout), { appearance: "system" });
  assert.match((await run(["remote", "status", "--inbox=first"])).stdout, /not configured/);
  await run(["export", "--inbox=first", "--out", path.join(root, "export")]);
  await assert.rejects(run(["list", "--inbox=unknown"]), /Unknown inbox/);
  await assert.rejects(run(["list", "--inbox=first", "--home", second]));
  const receipt = JSON.parse((await run(["publish", source, "--title=JSON receipt", "--type=report", "--inbox=second", "--json"])).stdout);
  assert.equal(receipt.inbox, "second");
  assert.equal(receipt.home, second);
  assert.equal(new URL(receipt.url).port, secondPort);

  await run(["viewer", "stop", "--inbox=first"]);
  assert.equal(JSON.parse((await run(["viewer", "status", "--json", "--inbox=second"])).stdout).state, "running");
  await run(["delete", firstDocuments[0].id, "--inbox=first", "--force"]);
  assert.deepEqual(JSON.parse((await run(["list", "--inbox=first", "--json"])).stdout), []);
});

test("catalog CLI retains missing and conflicting entries without recreating their homes", async (t) => {
  const root = await temporaryHome(t);
  const home = path.join(root, "library");
  const env = { ...process.env, HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"), HTML_INBOX_HOME: undefined, HTML_INBOX_NAME: undefined };
  const run = (...args: string[]) => executeFile(process.execPath, [path.join(__dirname, "index.js"), ...args], { env });
  await run("inbox", "create", "home", "--home", home);
  await cp(home, path.join(root, "copy"), { recursive: true });
  await assert.rejects(run("inbox", "register", "copy", "--home", path.join(root, "copy")));

  await rename(home, path.join(root, "moved"));
  const missing = JSON.parse((await run("inbox", "list", "--json")).stdout);
  assert.equal(missing[0].state, "missing");
  await assert.rejects(run("list", "--inbox=home"));
  await assert.rejects(readFile(path.join(home, "instance-id")), { code: "ENOENT" });
});

test("legacy first use stays available and named CLI choices validate identity before reading or deleting", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const home = path.join(root, ".html-inbox");
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"),
    HTML_INBOX_HOME: undefined,
    HTML_INBOX_NAME: undefined,
  };
  const run = (...args: string[]) => executeFile(process.execPath, [path.join(__dirname, "index.js"), ...args], { env });
  assert.deepEqual(JSON.parse((await run("list", "--json")).stdout), []);
  await run("inbox", "register", "personal", "--home", home);
  await assert.rejects(run("list", "--json"), /--inbox/);
  const registeredListing = await run("list", "--json", "--inbox=personal");

  const moved = path.join(root, "moved");
  await rename(home, moved);
  await assert.rejects(run("list", "--json", "--inbox=personal"), /Cannot inspect registered inbox personal/);
  await assert.rejects(readFile(path.join(home, "instance-id")), { code: "ENOENT" });

  await cp(moved, home, { recursive: true });
  await writeFile(path.join(home, "instance-id"), randomUUID());
  const metadata = await new LocalDocumentBackend(home).publish({
    originalBytes: Buffer.from("<!doctype html><html><body>Replacement library</body></html>"),
    title: "Replacement report", type: "report", sourceFileName: "replacement.html",
  });
  await assert.rejects(run("list", "--json", "--inbox=personal"), /missing or different identity/);
  await assert.rejects(run("delete", metadata.id, "--force", "--inbox=personal"), /missing or different identity/);
  assert.match(await readFile(path.join(home, "documents", metadata.id, "index.html"), "utf8"), /Replacement library/);
  assert.match(registeredListing.stderr, /Inbox personal/);
});
