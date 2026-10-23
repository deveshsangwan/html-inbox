import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { LocalDocumentBackend } from "./backend";
import { clearDefaultInbox, createInbox, InboxInspectionError, setDefaultInbox } from "./inbox-catalog";
import { InboxSelectionRequiredError, resolveInboxSelection } from "./inbox-selection";
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

  const hasConflict = (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict";
  await assert.rejects(resolveInboxSelection({ inbox: "first", home: second.home }, env), hasConflict);
  await assert.rejects(resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "first", HTML_INBOX_HOME: second.home }), hasConflict);

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

test("registered legacy fallback rejects replaced, missing, and copied identities and captures its name", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const modulePath = path.join(__dirname, "inbox-selection.js");
  const worker = `
    require(process.argv[1]).resolveInboxSelection({}, {HTML_INBOX_CATALOG_HOME: process.argv[2]})
      .then(value => process.stdout.write(JSON.stringify({value})))
      .catch(error => {
        if (typeof error.state !== "string") throw error;
        process.stdout.write(JSON.stringify({state: error.state}));
      });
  `;

  for (const state of ["replaced", "missing", "copied", "healthy"]) {
    const userHome = path.join(root, state);
    const catalogHome = path.join(userHome, "catalog");
    const legacyHome = path.join(userHome, ".html-inbox");
    const registeredHome = state === "copied" ? path.join(userHome, "original") : legacyHome;
    const entry = await createInbox("legacy", registeredHome, catalogHome);

    if (state === "replaced") {
      await writeFile(path.join(legacyHome, "instance-id"), randomUUID());
    }

    if (state === "missing") {
      await rename(legacyHome, path.join(userHome, "moved"));
    }

    if (state === "copied") {
      await cp(registeredHome, legacyHome, { recursive: true });
    }

    const result = await promisify(execFile)(process.execPath, ["-e", worker, modulePath, catalogHome], {
      env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
    });
    const expected = state === "healthy" ? { value: { ...entry, source: "legacy" } }
      : { state: state === "missing" ? "missing" : "conflict" };
    assert.deepEqual(JSON.parse(result.stdout), expected, state);

    if (state === "missing") {
      await assert.rejects(lstat(legacyHome), { code: "ENOENT" });
    }
  }
});

test("invalid lower-priority default cannot interrupt explicit or environment selections", async (t) => {
  const { catalogHome, first, second, env } = await selectionFixture(t);
  const defaultPath = path.join(catalogHome, "default.json");
  for (const contents of ["{", '{"schemaVersion":99}', "null"]) {
    await writeFile(defaultPath, contents);
    assert.deepEqual(await resolveInboxSelection({ inbox: "first" }, env), { ...first, source: "explicit" });
    assert.deepEqual(await resolveInboxSelection({ home: first.home }, env), { ...first, source: "explicit" });
    assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "second" }), { ...second, source: "environment" });
    assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_HOME: second.home }), { ...second, source: "environment" });
    await assert.rejects(resolveInboxSelection({}, env));
    assert.equal(await readFile(defaultPath, "utf8"), contents);
  }
});

test("legacy home override is used only after explicit, environment, and configured default selections", async (t) => {
  const { root, catalogHome, first, second, env } = await selectionFixture(t);
  const legacy = await createInbox("service", path.join(root, "service-user", ".html-inbox"), catalogHome);
  assert.deepEqual(await resolveInboxSelection({}, env, legacy.home), { ...legacy, source: "legacy" });
  assert.deepEqual(await resolveInboxSelection({ inbox: "first" }, env, "relative-unused"), { ...first, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({ home: first.home }, env, "relative-unused"), { ...first, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "second" }, "relative-unused"), { ...second, source: "environment" });
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_HOME: second.home }, "relative-unused"), { ...second, source: "environment" });

  await setDefaultInbox("first", catalogHome);
  assert.deepEqual(await resolveInboxSelection({}, env, "relative-unused"), { ...first, source: "default" });
  await clearDefaultInbox(catalogHome);
  await writeFile(path.join(legacy.home, "instance-id"), randomUUID());
  await assert.rejects(resolveInboxSelection({}, env, legacy.home),
    (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict");
});

test("only an unregistered missing legacy home can be prepared by the selected backend", async (t) => {
  const { root, catalogHome, env } = await selectionFixture(t);
  const unregistered = path.join(root, "unregistered-legacy");
  const selection = await resolveInboxSelection({}, env, unregistered);
  assert.deepEqual(selection, { home: unregistered, source: "legacy" });
  await assert.rejects(lstat(unregistered), { code: "ENOENT" });
  assert.deepEqual(await new LocalDocumentBackend(selection.home).listDocuments(), []);
  assert.equal((await lstat(path.join(unregistered, "documents"))).isDirectory(), true);

  const registered = await createInbox("legacy", path.join(root, "registered-legacy"), catalogHome);
  await rename(registered.home, path.join(root, "moved-legacy"));
  await assert.rejects(resolveInboxSelection({}, env, registered.home),
    (error: unknown) => error instanceof InboxInspectionError && error.state === "missing");
  await assert.rejects(lstat(registered.home), { code: "ENOENT" });
});

test("registered home selectors reject changed parent aliases even with a different UUID", { skip: process.platform === "win32" }, async (t) => {
  const { root, catalogHome, env } = await selectionFixture(t);
  const parent = path.join(root, "registered-parent");
  const entry = await createInbox("legacy", path.join(parent, ".html-inbox"), catalogHome);
  const movedParent = path.join(root, "moved-parent");
  await rename(parent, movedParent);
  await symlink(movedParent, parent);
  await writeFile(path.join(movedParent, ".html-inbox", "instance-id"), randomUUID());
  const hasConflict = (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict";

  await assert.rejects(resolveInboxSelection({ home: entry.home }, env), hasConflict);
  await assert.rejects(resolveInboxSelection({}, env, `${entry.home}${path.sep}`), hasConflict);
});

test("required selection lists all captured names without choosing or preparing a legacy home", async (t) => {
  const { root, first, second, env } = await selectionFixture(t);
  const legacyHome = path.join(root, "unused-legacy");
  await rm(second.home, { recursive: true });

  await assert.rejects(resolveInboxSelection({}, env, legacyHome, { requireSelection: true }), (error: unknown) => {
    assert(error instanceof InboxSelectionRequiredError);
    assert.deepEqual(error.availableNames, [first.name, second.name]);
    assert.match(error.message, /Available inboxes: first, second/);
    assert.match(error.message, /--inbox <name>/);
    return true;
  });
  await assert.rejects(lstat(legacyHome), { code: "ENOENT" });
});

test("a single registered inbox still requires a deliberate selection", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  await createInbox("only", path.join(root, "only"), catalogHome);

  await assert.rejects(resolveInboxSelection({}, { HTML_INBOX_CATALOG_HOME: catalogHome }, undefined, { requireSelection: true }),
    (error: unknown) => error instanceof InboxSelectionRequiredError && error.availableNames.join() === "only");
});

test("a non-interactive selection-required error leaves stdout empty", async (t) => {
  const { catalogHome } = await selectionFixture(t);
  const modulePath = path.join(__dirname, "inbox-selection.js");
  const worker = `
    require(process.argv[1]).resolveInboxSelection({}, {HTML_INBOX_CATALOG_HOME: process.argv[2]}, undefined, {requireSelection: true})
      .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
  `;

  await assert.rejects(promisify(execFile)(process.execPath, ["-e", worker, modulePath, catalogHome]), (error: unknown) => {
    assert(error instanceof Error && "stdout" in error && "stderr" in error);
    assert.equal(error.stdout, "");
    assert.match(String(error.stderr), /Available inboxes: first, second/);
    assert.match(String(error.stderr), /--inbox <name>/);
    return true;
  });
});

test("required selection preserves first-use behavior when the catalog is empty", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  const legacyHome = path.join(root, "legacy");
  const chooseInbox = async () => assert.fail("An empty catalog must not prompt");

  assert.deepEqual(await resolveInboxSelection({}, { HTML_INBOX_CATALOG_HOME: catalogHome }, legacyHome, { requireSelection: true, chooseInbox }),
    { home: legacyHome, source: "legacy" });
  assert.deepEqual(await readdir(root), []);
});

test("explicit, environment, and strict default tiers never invoke the chooser", async (t) => {
  const { catalogHome, first, second, env } = await selectionFixture(t);
  const options = { requireSelection: true, chooseInbox: async () => assert.fail("A bound operation must not prompt") };

  assert.deepEqual(await resolveInboxSelection({ inbox: "first" }, env, undefined, options), { ...first, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({}, { ...env, HTML_INBOX_NAME: "second" }, undefined, options), { ...second, source: "environment" });
  await setDefaultInbox("first", catalogHome);
  assert.deepEqual(await resolveInboxSelection({}, env, undefined, options), { ...first, source: "default" });
  await rm(first.home, { recursive: true });
  await assert.rejects(resolveInboxSelection({}, env, undefined, options),
    (error: unknown) => error instanceof InboxInspectionError && error.state === "missing");
  await writeFile(path.join(catalogHome, "default.json"), "{");
  await assert.rejects(resolveInboxSelection({}, env, undefined, options), /JSON/);
});

test("a chooser selects one captured binding without rereading catalog or changing defaults", async (t) => {
  const { catalogHome, first, second, env } = await selectionFixture(t);
  const entryPath = path.join(catalogHome, "inboxes", "first.json");
  const chooseInbox = async (inboxes: readonly typeof first[]) => {
    assert.deepEqual(inboxes, [first, second]);
    await writeFile(entryPath, "{");
    await writeFile(path.join(catalogHome, "default.json"), '{"schemaVersion":1,"name":"second"}');
    return "first";
  };

  assert.deepEqual(await resolveInboxSelection({}, env, undefined, { requireSelection: true, chooseInbox }), { ...first, source: "explicit" });
  assert.equal(await readFile(entryPath, "utf8"), "{");
  assert.equal(await readFile(path.join(catalogHome, "default.json"), "utf8"), '{"schemaVersion":1,"name":"second"}');
  assert.deepEqual(await readdir(catalogHome), ["default.json", "inboxes"]);
});

test("chooser argument mutation cannot retarget a captured binding", async (t) => {
  const { first, second, env } = await selectionFixture(t);
  const chooseInbox = async (inboxes: readonly typeof first[]) => {
    const entry = inboxes.find((inbox) => inbox.name === "first");
    assert(entry);
    Object.assign(entry, { home: second.home, instanceId: second.instanceId });
    return "first";
  };

  assert.deepEqual(await resolveInboxSelection({}, env, undefined, { chooseInbox }), { ...first, source: "explicit" });
});

test("rebinding the catalog name while choosing cannot move the captured selection", async (t) => {
  const { catalogHome, first, second, env } = await selectionFixture(t);
  const replacement = { ...second, name: "first" };
  const chooseInbox = async () => {
    await writeFile(path.join(catalogHome, "inboxes", "first.json"), JSON.stringify({ schemaVersion: 1, ...replacement }));
    await rm(path.join(catalogHome, "inboxes", "second.json"));
    return "first";
  };

  assert.deepEqual(await resolveInboxSelection({}, env, undefined, { chooseInbox }), { ...first, source: "explicit" });
  assert.deepEqual(await resolveInboxSelection({ inbox: "first" }, env), { ...replacement, source: "explicit" });
});

test("a chooser cannot adopt a changed identity or a newly registered catalog binding", async (t) => {
  const { catalogHome, first, env } = await selectionFixture(t);
  const entryPath = path.join(catalogHome, "inboxes", "first.json");
  const chooseInbox = async () => {
    const replacementId = randomUUID();
    await writeFile(path.join(first.home, "instance-id"), replacementId);
    await writeFile(entryPath, JSON.stringify({ schemaVersion: 1, ...first, instanceId: replacementId }));
    return "first";
  };

  await assert.rejects(resolveInboxSelection({}, env, undefined, { chooseInbox }),
    (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict");
  const original = await resolveInboxSelection({ inbox: "first" }, env);
  assert.notEqual(original.instanceId, first.instanceId);
});

test("a root removed while choosing fails instead of being recreated", async (t) => {
  const { first, env } = await selectionFixture(t);
  const chooseInbox = async () => {
    await rm(first.home, { recursive: true });
    return "first";
  };

  await assert.rejects(resolveInboxSelection({}, env, undefined, { chooseInbox }),
    (error: unknown) => error instanceof InboxInspectionError && error.state === "missing");
  await assert.rejects(lstat(first.home), { code: "ENOENT" });
});

test("a captured home cannot follow a changed parent alias while choosing", { skip: process.platform === "win32" }, async (t) => {
  const { root, first, env } = await selectionFixture(t);
  const movedRoot = `${root}-moved`;
  t.after(() => rm(movedRoot, { recursive: true, force: true }));
  const chooseInbox = async () => {
    await rename(root, movedRoot);
    await symlink(movedRoot, root);
    return "first";
  };

  await assert.rejects(resolveInboxSelection({}, env, undefined, { chooseInbox }),
    (error: unknown) => error instanceof InboxInspectionError && error.state === "conflict" && /canonical location/.test(error.message));
  assert.equal((await lstat(first.home)).isDirectory(), true);
});

test("chooser errors and unknown choices abort without falling back or adopting catalog additions", async (t) => {
  const { root, catalogHome, env } = await selectionFixture(t);
  const legacyHome = path.join(root, "unused-legacy");
  const cancellation = new Error("Cancelled by caller");
  await assert.rejects(resolveInboxSelection({}, env, legacyHome, { chooseInbox: async () => { throw cancellation; } }),
    (error: unknown) => error === cancellation);

  await assert.rejects(resolveInboxSelection({}, env, legacyHome, {
    chooseInbox: async () => {
      await createInbox("new", path.join(root, "new"), catalogHome);
      return "new";
    },
  }), /Unknown inbox: new/);
  await assert.rejects(lstat(legacyHome), { code: "ENOENT" });
});
