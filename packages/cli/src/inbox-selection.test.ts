import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createInbox, InboxInspectionError, setDefaultInbox } from "./inbox-catalog";
import { resolveInboxSelection } from "./inbox-selection";
import { temporaryHome } from "./test-fixtures";

async function selectionFixture(t: TestContext) {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  const first = await createInbox("first", path.join(root, "first"), catalogHome);
  const second = await createInbox("second", path.join(root, "second"), catalogHome);
  return { root, catalogHome, first, second, env: { HTML_INBOX_CATALOG_HOME: catalogHome } };
}

test("explicit selectors override the environment tier and configured default", async (t) => {
  const { catalogHome, first, second, env } = await selectionFixture(t);
  await setDefaultInbox("first", catalogHome);
  const conflictingEnv = { ...env, HTML_INBOX_NAME: "unknown", HTML_INBOX_HOME: first.home };

  assert.deepEqual(await resolveInboxSelection({ inbox: "second" }, conflictingEnv), { ...second, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({ home: second.home }, conflictingEnv), { ...second, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "second" }), { ...second, source: "environment" });
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_HOME: second.home }), { ...second, source: "environment" });
  assert.deepEqual(await resolveInboxSelection({}, env), { ...first, source: "default" });
});

test("same-tier name and home selectors must agree; unknown names never create", async (t) => {
  const { root, first, second, env } = await selectionFixture(t);
  assert.deepEqual(await resolveInboxSelection({ inbox: "first", home: first.home }, env), { ...first, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "first", HTML_INBOX_HOME: first.home }), { ...first, source: "environment" });

  for (const resolution of [
    resolveInboxSelection({ inbox: "first", home: second.home }, env),
    resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "first", HTML_INBOX_HOME: second.home }),
  ]) {
    await assert.rejects(resolution, (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict");
  }

  const missing = path.join(root, "missing");
  await assert.rejects(resolveInboxSelection({ inbox: "unknown", home: missing }, env), /Unknown inbox/);
  await assert.rejects(resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "unknown", HTML_INBOX_HOME: missing }), /Unknown inbox/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  await assert.rejects(resolveInboxSelection({ home: "relative" }, env), /absolute/);
});

test("relative environment homes retain legacy cwd semantics while explicit homes stay absolute", async (t) => {
  const { root, first, env } = await selectionFixture(t);
  const relativeHome = path.relative(process.cwd(), first.home);
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_HOME: relativeHome }), { ...first, source: "environment" });
  const missing = path.join(root, "new", "home");
  assert.deepEqual(await resolveInboxSelection({ home: missing }, env), { home: missing, source: "explicit" });
  await assert.rejects(lstat(path.join(root, "new")), { code: "ENOENT" });
});

test("stale defaults, changed or missing identities, and copied homes fail without mutation", async (t) => {
  const { root, catalogHome, first, second, env } = await selectionFixture(t);
  await setDefaultInbox("first", catalogHome);
  const copy = path.join(root, "copy");
  await cp(first.home, copy, { recursive: true });
  await assert.rejects(resolveInboxSelection({ home: copy }, env), (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict");

  await writeFile(path.join(first.home, "instance-id"), randomUUID());
  await assert.rejects(resolveInboxSelection({ inbox: "first" }, env), (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict");
  await assert.rejects(resolveInboxSelection({ home: first.home }, env), (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict");
  assert.deepEqual(await resolveInboxSelection({ inbox: "second" }, env), { ...second, source: "explicit" });

  await rm(first.home, { recursive: true });
  await assert.rejects(resolveInboxSelection({}, env), (error: unknown) => error instanceof InboxInspectionError && error.state === "missing");
  await assert.rejects(lstat(first.home), { code: "ENOENT" });
  await writeFile(path.join(catalogHome, "default.json"), '{"schemaVersion":1,"name":"unknown"}');
  await assert.rejects(resolveInboxSelection({}, env), /Unknown inbox/);
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "second" }), { ...second, source: "environment" });
});

test("selection has no last-used state and returns one captured concrete result", async (t) => {
  const { catalogHome, first, second, env } = await selectionFixture(t);
  await setDefaultInbox("first", catalogHome);
  const defaultPath = path.join(catalogHome, "default.json");
  const originalDefault = await readFile(defaultPath, "utf8");
  const selected = await resolveInboxSelection({}, env);
  await resolveInboxSelection({ inbox: "second" }, env);
  assert.equal(await readFile(defaultPath, "utf8"), originalDefault);
  await setDefaultInbox("second", catalogHome);
  assert.deepEqual(selected, { ...first, source: "default" });
  assert.deepEqual(await resolveInboxSelection({}, env), { ...second, source: "default" });
  assert.deepEqual(await readdir(catalogHome), ["default.json", "inboxes"]);
});

test("parent path aliases find registered names while leaf symlinks fail", { skip: process.platform === "win32" }, async (t) => {
  const { root, first, env } = await selectionFixture(t);
  const alias = path.join(root, "parent-alias");
  await symlink(root, alias);
  assert.deepEqual(await resolveInboxSelection({ home: path.join(alias, "first") }, env), { ...first, source: "explicit" });

  const leaf = path.join(root, "leaf");
  await symlink(first.home, leaf);
  await assert.rejects(resolveInboxSelection({ home: leaf }, env), /leaf symbolic link/);
});

test("legacy fallback uses getInboxHome without making a catalog or library", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  const modulePath = path.join(__dirname, "inbox-selection.js");
  const worker = "require(process.argv[1]).resolveInboxSelection({}, {HTML_INBOX_CATALOG_HOME:process.argv[2]}).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1})";
  const result = await promisify(execFile)(process.execPath, ["-e", worker, modulePath, catalogHome], {
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  assert.deepEqual(JSON.parse(result.stdout), { home: path.join(root, ".html-inbox"), source: "legacy" });
  assert.deepEqual(await readdir(root), []);

  const unregistered = path.join(root, "unregistered");
  await mkdir(unregistered);
  assert.deepEqual(await resolveInboxSelection({}, { HTML_INBOX_CATALOG_HOME: catalogHome, HTML_INBOX_HOME: unregistered }), { home: unregistered, source: "environment" });
});
