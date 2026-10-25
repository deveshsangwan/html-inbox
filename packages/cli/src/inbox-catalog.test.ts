import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { clearDefaultInbox, createInbox, getInboxCatalogHome, InboxInspectionError, inspectRegisteredInbox, readInboxCatalog, readNamedInbox, registerInbox, setDefaultInbox } from "./inbox-catalog";
import { resolveInboxSelection } from "./inbox-selection";
import { temporaryHome } from "./test-fixtures";

const runNode = promisify(execFile);

async function catalogFixture(t: TestContext) {
  const root = await realpath(await temporaryHome(t));
  return { root, catalogHome: path.join(root, "catalog") };
}

async function legacyLibrary(root: string, name: string) {
  const home = path.join(root, name);
  await mkdir(path.join(home, "documents"), { recursive: true });
  return home;
}

function hasInspectionState(state: InboxInspectionError["state"]) {
  return (error: unknown) => error instanceof InboxInspectionError && error.state === state;
}

test("catalog location is independent of selected library and missing reads create nothing", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  assert.equal(getInboxCatalogHome({ HTML_INBOX_HOME: "/ignored" }), path.join(homedir(), ".config", "html-inbox"));
  assert.equal(getInboxCatalogHome({ HTML_INBOX_CATALOG_HOME: catalogHome, HTML_INBOX_HOME: "/ignored" }), catalogHome);
  assert.throws(() => getInboxCatalogHome({ HTML_INBOX_CATALOG_HOME: "relative" }), /absolute/);
  assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [] });
  assert.equal(await readNamedInbox("work", catalogHome), null);
  await clearDefaultInbox(catalogHome);
  assert.deepEqual(await readdir(root), []);
});

test("read-only catalog inspection preserves file bytes, modes and directory inventory", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const entry = await createInbox("work", path.join(root, "work"), catalogHome);
  await setDefaultInbox("work", catalogHome);
  const paths = [catalogHome, path.join(catalogHome, "inboxes"), path.join(catalogHome, "inboxes", "work.json"), path.join(catalogHome, "default.json")];
  if (process.platform !== "win32") {
    for (const target of paths) {
      await chmod(target, target.endsWith(".json") ? 0o640 : 0o750);
    }
  }
  const snapshot = async () => Promise.all(paths.map(async (target) => {
    const info = await lstat(target);
    return { target, mode: info.mode, ctimeMs: info.ctimeMs, content: info.isDirectory() ? await readdir(target) : await readFile(target, "utf8") };
  }));
  const before = await snapshot();

  assert.deepEqual(await readInboxCatalog(catalogHome, { readOnly: true }), { inboxes: [entry], defaultName: "work" });
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await readInboxCatalog(path.join(root, "missing"), { readOnly: true }), { inboxes: [] });
  await assert.rejects(lstat(path.join(root, "missing")), { code: "ENOENT" });
});

test("register adds identity to a legacy stopped library in place and persists a private catalog", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const home = await legacyLibrary(root, "existing");
  const contents = "legacy bytes stay unchanged";
  await writeFile(path.join(home, "documents", "original"), contents);
  const entry = await registerInbox("work", home, catalogHome);

  assert.deepEqual(entry, { name: "work", home, instanceId: (await readFile(path.join(home, "instance-id"), "utf8")).trim() });
  assert.equal(await readFile(path.join(home, "documents", "original"), "utf8"), contents);
  assert.deepEqual(await readNamedInbox("work", catalogHome), entry);
  assert.deepEqual(await inspectRegisteredInbox(entry), entry);
  assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry] });
  assert.deepEqual(await readdir(home), ["documents", "instance-id"]);
  assert.deepEqual(await readdir(path.join(catalogHome, "inboxes")), ["work.json"]);

  if (process.platform !== "win32") {
    for (const directory of [catalogHome, path.join(catalogHome, "inboxes")]) {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }

    assert.equal((await stat(path.join(catalogHome, "inboxes", "work.json"))).mode & 0o777, 0o600);
  }
});

test("create accepts new or empty homes and refuses unrelated data or existing libraries", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const entry = await createInbox("new", path.join(root, "nested", "new"), catalogHome);
  assert.deepEqual(await inspectRegisteredInbox(entry), entry);
  assert.equal((await stat(path.join(entry.home, "documents"))).isDirectory(), true);

  const empty = path.join(root, "empty");
  await mkdir(empty);
  await createInbox("empty", empty, catalogHome);

  const unrelated = path.join(root, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "keep");
  await assert.rejects(createInbox("other", unrelated, catalogHome), /nonempty/);
  assert.deepEqual(await readdir(unrelated), ["keep.txt"]);
  assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "keep");
  await assert.rejects(createInbox("another", entry.home, catalogHome), hasInspectionState("conflict"));

  const missing = path.join(root, "not-created");
  await assert.rejects(createInbox("new", missing, catalogHome), /already registered/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  await assert.rejects(createInbox("relative", "relative", catalogHome), /absolute/);
});

test("canonicalizing a home on an unavailable Windows drive stops at the missing root", async () => {
  const modulePath = path.join(__dirname, "inbox-home.js");
  const worker = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const { canonicalizeInboxHome } = require(process.argv[1]);
    for (const operation of ["isAbsolute", "resolve", "dirname", "basename", "join", "parse"]) {
      path[operation] = path.win32[operation];
    }

    const calls = [];
    for (const operation of ["lstat", "realpath"]) {
      fs[operation] = async home => {
        calls.push([operation, home]);
        if (calls.length > 8) throw new Error("Repeated missing-root lookup");
        throw Object.assign(new Error("Unavailable drive"), { code: "ENOENT", path: home });
      };
    }

    const home = String.raw\`Z:\\library\`;
    const root = path.parse(home).root;
    canonicalizeInboxHome(home, true)
      .then(() => { throw new Error("Unavailable drive was accepted"); })
      .catch(error => {
        assert.equal(error.code, "ENOENT");
        assert.equal(error.path, root);
        assert.deepEqual(calls, [["lstat", home], ["realpath", root], ["lstat", root]]);
      })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;

  await runNode(process.execPath, ["-e", worker, modulePath], { timeout: 5000 });
});

test("register rejects missing, unrelated, and unsupported homes without adopting them", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const missing = path.join(root, "missing");
  await assert.rejects(registerInbox("missing", missing, catalogHome), hasInspectionState("missing"));
  await assert.rejects(lstat(missing), { code: "ENOENT" });

  const unrelated = path.join(root, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "library.json"), '{"schemaVersion":99}');
  await assert.rejects(registerInbox("unrelated", unrelated, catalogHome), hasInspectionState("incompatible"));
  assert.deepEqual(await readdir(unrelated), ["library.json"]);

  const invalid = await legacyLibrary(root, "invalid");
  await writeFile(path.join(invalid, "instance-id"), "unsupported identity");
  await assert.rejects(registerInbox("invalid", invalid, catalogHome), hasInspectionState("incompatible"));
  assert.equal(await readFile(path.join(invalid, "instance-id"), "utf8"), "unsupported identity");
  await assert.rejects(lstat(catalogHome), { code: "ENOENT" });
});

test("24 independent concurrent registrations retain every distinct per-name record", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const registrations = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const name = `inbox-${String(index).padStart(2, "0")}`;
    const home = await legacyLibrary(root, name);
    return { name, home };
  }));
  const modulePath = path.join(__dirname, "inbox-catalog.js");
  const worker = "require(process.argv[1]).registerInbox(process.argv[2],process.argv[3],process.argv[4]).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1})";

  const results = await Promise.all(registrations.map(({ name, home }) => runNode(process.execPath, ["-e", worker, modulePath, name, home, catalogHome])));
  const catalog = await readInboxCatalog(catalogHome);
  assert.equal(catalog.inboxes.length, 24);
  assert.deepEqual(catalog.inboxes.map((entry) => JSON.stringify(entry)), results.map((result) => result.stdout));
  assert.equal(new Set(catalog.inboxes.map((entry) => entry.instanceId)).size, 24);
  assert.equal((await readdir(path.join(catalogHome, "inboxes"))).length, 24);
  await assert.rejects(lstat(path.join(catalogHome, "registration.lock")), { code: "ENOENT" });
});

for (const { platform, code, failureMode, canRegister } of [
  { platform: "win32", code: "EPERM", failureMode: "transient", canRegister: true },
  { platform: "win32", code: "EPERM", failureMode: "persistent", canRegister: false },
  { platform: "win32", code: "EPERM", failureMode: "deadline-boundary", canRegister: false },
  { platform: "linux", code: "EPERM", failureMode: "transient", canRegister: false },
  { platform: "win32", code: "EACCES", failureMode: "transient", canRegister: false },
]) {
  test(`registration ${canRegister ? "retries" : "rejects"} ${platform} ${failureMode} ${code} without bypassing the lock`, async (t) => {
    const { root, catalogHome } = await catalogFixture(t);
    const home = await legacyLibrary(root, "work");
    const modulePath = path.join(__dirname, "inbox-catalog.js");
    const worker = `
      const assert = require("node:assert/strict");
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const [modulePath, catalogHome, home, platform, code, failureMode, succeeds] = process.argv.slice(1);
      Object.defineProperty(process, "platform", { value: platform });
      const lockPath = path.join(catalogHome, "registration.lock");
      const perform = fs.open;
      const failure = Object.assign(new Error("Exclusive lock open denied"), { code, syscall: "open", path: lockPath });
      const start = Date.now();
      let attempts = 0;

      if (failureMode === "persistent") {
        Date.now = () => start + (attempts >= 3 ? 10_001 : 0);
      } else if (failureMode === "deadline-boundary") {
        let clockReads = 0;
        Date.now = () => {
          clockReads += 1;
          return start + (clockReads === 1 ? 0 : clockReads === 2 ? 9_999 : 10_000);
        };
      }

      fs.open = async (...args) => {
        if (args[0] === lockPath && args[1] === "wx") {
          attempts += 1;
          if (attempts === 1 || failureMode !== "transient") throw failure;
        }
        return perform(...args);
      };

      (async () => {
        const { registerInbox, readInboxCatalog } = require(modulePath);
        if (succeeds === "true") {
          const entry = await registerInbox("work", home, catalogHome);
          assert.equal(attempts, 2);
          assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry] });
        } else {
          await assert.rejects(registerInbox("work", home, catalogHome), error => error === failure);
          assert.equal(attempts, failureMode === "persistent" ? 3 : failureMode === "deadline-boundary" ? 2 : 1);
          assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [] });
          await assert.rejects(fs.lstat(path.join(home, "instance-id")), { code: "ENOENT" });
        }
        await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;

    await runNode(process.execPath, ["-e", worker, modulePath, catalogHome, home, platform, code, failureMode, String(canRegister)], { timeout: 5000 });
  });
}

test("concurrent same-name claims choose one complete winner and preserve it", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const homes = await Promise.all(Array.from({ length: 24 }, (_, index) => legacyLibrary(root, `candidate-${index}`)));
  const results = await Promise.allSettled(homes.map((home) => registerInbox("shared", home, catalogHome)));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 23);
  const winner = winners[0];
  assert(winner?.status === "fulfilled");
  assert.deepEqual(await readNamedInbox("shared", catalogHome), winner.value);
  assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [winner.value] });

  const recordPath = path.join(catalogHome, "inboxes", "shared.json");
  const originalRecord = await readFile(recordPath, "utf8");
  await assert.rejects(registerInbox("shared", homes[0] ?? root, catalogHome), /already registered/);
  assert.equal(await readFile(recordPath, "utf8"), originalRecord);
});

test("interrupted catalog publication leaves complete records readable before and after commit", async (t) => {
  const { root } = await catalogFixture(t);
  const modulePath = path.join(__dirname, "inbox-catalog.js");
  const worker = `
    const fs = require("node:fs/promises");
    const [modulePath, catalogHome, home, recordPath, stage] = process.argv.slice(1);
    for (const operation of ["rename", "link"]) {
      const perform = fs[operation];
      fs[operation] = async (...args) => {
        if (args[1] === recordPath && stage === "before") process.exit(86);
        const result = await perform(...args);
        if (args[1] === recordPath) process.exit(86);
        return result;
      };
    }
    require(modulePath).createInbox("work", home, catalogHome).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  for (const stage of ["before", "after"]) {
    const catalogHome = path.join(root, `${stage}-catalog`);
    const existing = await createInbox("existing", path.join(root, `${stage}-existing`), catalogHome);
    const home = path.join(root, `${stage}-work`);
    const recordPath = path.join(catalogHome, "inboxes", "work.json");
    await assert.rejects(runNode(process.execPath, ["-e", worker, modulePath, catalogHome, home, recordPath, stage]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === 86);

    assert.equal((await lstat(path.join(catalogHome, "registration.lock"))).isFile(), true);
    const entry = { name: "work", home, instanceId: (await readFile(path.join(home, "instance-id"), "utf8")).trim() };
    const expected = stage === "before" ? [existing] : [existing, entry];
    assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: expected });
    assert.deepEqual(await readNamedInbox("existing", catalogHome), existing);

    if (stage === "after") {
      assert.equal((await lstat(recordPath)).nlink, 1);
      assert.deepEqual(await resolveInboxSelection({ inbox: "work" }, { HTML_INBOX_CATALOG_HOME: catalogHome }), { ...entry, source: "explicit" });
    } else {
      assert.equal(await readNamedInbox("work", catalogHome), null);
    }

    await rm(path.join(catalogHome, "registration.lock"));
    assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: expected });
  }
});

test("stale registration lock and unpublished partial record do not block catalog reads or selection", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const entry = await createInbox("work", path.join(root, "work"), catalogHome);
  await setDefaultInbox("work", catalogHome);
  const lockPath = path.join(catalogHome, "registration.lock");
  const lockContents = "2147483647\n";
  await writeFile(lockPath, lockContents, { mode: 0o600 });
  await writeFile(path.join(catalogHome, "inboxes", `unfinished.json.tmp-${randomUUID()}`), "{", { mode: 0o600 });

  assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry], defaultName: "work" });
  assert.deepEqual(await readNamedInbox("work", catalogHome), entry);
  assert.deepEqual(await resolveInboxSelection({}, { HTML_INBOX_CATALOG_HOME: catalogHome }), { ...entry, source: "default" });
  assert.equal(await readFile(lockPath, "utf8"), lockContents);
});

test("catalog reads retry valid default replacement and unlink races before and after open", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const first = await createInbox("first", path.join(root, "first"), catalogHome);
  const second = await createInbox("second", path.join(root, "second"), catalogHome);
  const defaultPath = path.join(catalogHome, "default.json");
  const replacementPath = path.join(catalogHome, "replacement");
  const modulePath = path.join(__dirname, "inbox-catalog.js");
  const worker = `
    const fs = require("node:fs/promises");
    const [modulePath, catalogHome, defaultPath, replacementPath, mode] = process.argv.slice(1);
    const perform = fs.open;
    let isArmed = true;
    let replacementBlocked = false;
    fs.open = async (...args) => {
      if (args[0] !== defaultPath || !isArmed) return perform(...args);
      isArmed = false;

      if (mode === "after-open") {
        const file = await perform(...args);
        try {
          await fs.rename(replacementPath, defaultPath);
        } catch (error) {
          // Windows can deny replacing an open file; its existing value remains readable.
          if (process.platform !== "win32" || error.code !== "EPERM") throw error;
          replacementBlocked = true;
        }
        return file;
      }

      if (mode === "unlink") await fs.rm(defaultPath);
      else await fs.rename(replacementPath, defaultPath);
      return perform(...args);
    };
    require(modulePath).readInboxCatalog(catalogHome)
      .then(catalog => process.stdout.write(JSON.stringify({ catalog, replacementBlocked })))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;

  for (const mode of ["replace", "unlink", "after-open"]) {
    await setDefaultInbox("first", catalogHome);
    await writeFile(replacementPath, '{"schemaVersion":1,"name":"second"}', { mode: 0o600 });
    const result = await runNode(process.execPath, ["-e", worker, modulePath, catalogHome, defaultPath, replacementPath, mode]);
    const { catalog, replacementBlocked } = JSON.parse(result.stdout);
    assert.equal(typeof replacementBlocked, "boolean");
    if (replacementBlocked) {
      assert.equal(process.platform, "win32");
      assert.equal(mode, "after-open");
    }

    const expected = { inboxes: [first, second], ...(mode === "unlink" ? {} : { defaultName: replacementBlocked ? "first" : "second" }) };
    assert.deepEqual(catalog, expected, mode);
  }
});

test("replacement retries retain strict schema, byte limits, and hardlink validation", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  await createInbox("work", path.join(root, "work"), catalogHome);
  const defaultPath = path.join(catalogHome, "default.json");
  const replacementPath = path.join(catalogHome, "replacement");
  const modulePath = path.join(__dirname, "inbox-catalog.js");
  const worker = `
    const fs = require("node:fs/promises");
    const [modulePath, catalogHome, defaultPath, replacementPath] = process.argv.slice(1);
    const perform = fs.open;
    let isArmed = true;
    fs.open = async (...args) => {
      if (args[0] === defaultPath && isArmed) {
        isArmed = false;
        await fs.rename(replacementPath, defaultPath);
      }
      return perform(...args);
    };
    require(modulePath).readInboxCatalog(catalogHome)
      .then(() => { throw new Error("Unsafe replacement was accepted"); })
      .catch(error => process.stdout.write(error.message));
  `;

  for (const { contents, message } of [
    { contents: '{"schemaVersion":99}', message: /default must use schema version 1/ },
    { contents: " ".repeat(64 * 1024 + 1), message: /too large/ },
  ]) {
    await setDefaultInbox("work", catalogHome);
    await writeFile(replacementPath, contents, { mode: 0o600 });
    const result = await runNode(process.execPath, ["-e", worker, modulePath, catalogHome, defaultPath, replacementPath]);
    assert.match(result.stdout, message);
    assert.equal(await readFile(defaultPath, "utf8"), contents);
    await rm(defaultPath);
  }

  await setDefaultInbox("work", catalogHome);
  const target = path.join(root, "outside");
  await writeFile(target, '{"schemaVersion":1,"name":"work"}', { mode: 0o644 });
  const originalMode = (await stat(target)).mode;
  await link(target, replacementPath);
  const result = await runNode(process.execPath, ["-e", worker, modulePath, catalogHome, defaultPath, replacementPath]);
  assert.match(result.stdout, /regular private file/);
  assert.equal((await stat(target)).mode, originalMode);
});

test("catalog metadata retries unlinked regular snapshots without reading or repairing them", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const first = await createInbox("first", path.join(root, "first"), catalogHome);
  const second = await createInbox("second", path.join(root, "second"), catalogHome);
  const defaultPath = path.join(catalogHome, "default.json");
  const replacementPath = path.join(catalogHome, "replacement");
  const modulePath = path.join(__dirname, "inbox-catalog.js");
  const worker = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const [modulePath, catalogHome, defaultPath, replacementPath, mode] = process.argv.slice(1);
    const inspect = fs.lstat;
    const open = fs.open;
    let inspections = 0;
    let opens = 0;

    fs.lstat = async (...args) => {
      const info = await inspect(...args);
      if (args[0] !== defaultPath) return info;
      inspections += 1;
      if (mode === "replace" && inspections === 1) await fs.rename(replacementPath, defaultPath);
      if (mode !== "replace" || inspections === 1) Object.defineProperty(info, "nlink", { value: 0 });
      return info;
    };
    fs.open = async (...args) => {
      if (args[0] === defaultPath) opens += 1;
      return open(...args);
    };

    (async () => {
      const { readInboxCatalog } = require(modulePath);
      if (mode === "replace") {
        const catalog = await readInboxCatalog(catalogHome, { readOnly: true });
        assert.equal(inspections, 2);
        assert.equal(opens, 1);
        process.stdout.write(JSON.stringify(catalog));
      } else {
        await assert.rejects(readInboxCatalog(catalogHome, { readOnly: true }),
          mode === "unlinked" ? /changed repeatedly during read/ : /regular private file/);
        assert.equal(inspections, mode === "unlinked" ? 10 : 1);
        assert.equal(opens, 0);
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;

  for (const mode of ["replace", "unlinked", "directory"]) {
    await setDefaultInbox("first", catalogHome);
    await writeFile(replacementPath, '{"schemaVersion":1,"name":"second"}', { mode: 0o640 });
    const replacementMode = (await stat(replacementPath)).mode;

    if (mode === "directory") {
      await rm(defaultPath);
      await mkdir(defaultPath);
    }

    const before = await lstat(defaultPath);
    const result = await runNode(process.execPath, ["-e", worker, modulePath, catalogHome, defaultPath, replacementPath, mode], { timeout: 5000 });

    if (mode === "replace") {
      assert.deepEqual(JSON.parse(result.stdout), { inboxes: [first, second], defaultName: "second" });
      assert.equal((await stat(defaultPath)).mode, replacementMode);
      assert.equal(await readFile(defaultPath, "utf8"), '{"schemaVersion":1,"name":"second"}');
    } else {
      const after = await lstat(defaultPath);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode, before.mode);
      assert.equal(after.ctimeMs, before.ctimeMs);
    }
  }
});

test("catalog replacement retries stop after a bounded number of changing files", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  await createInbox("work", path.join(root, "work"), catalogHome);
  await setDefaultInbox("work", catalogHome);
  const modulePath = path.join(__dirname, "inbox-catalog.js");
  const defaultPath = path.join(catalogHome, "default.json");
  const worker = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const [modulePath, catalogHome, defaultPath] = process.argv.slice(1);
    const perform = fs.open;
    let attempts = 0;
    fs.open = async (...args) => {
      if (args[0] === defaultPath) {
        attempts += 1;
        assert(attempts <= 20, "Catalog retry loop did not stop");
        const replacementPath = defaultPath + ".replacement";
        await fs.writeFile(replacementPath, '{"schemaVersion":1,"name":"work"}', {mode: 0o600});
        await fs.rename(replacementPath, defaultPath);
      }
      return perform(...args);
    };
    require(modulePath).readInboxCatalog(catalogHome)
      .then(() => { throw new Error("Continuously changing record was accepted"); })
      .catch(error => {
        assert.match(error.message, /changed repeatedly during read/);
        assert(attempts > 1 && attempts <= 20);
        process.stdout.write("bounded retries verified");
      });
  `;

  const result = await runNode(process.execPath, ["-e", worker, modulePath, catalogHome, defaultPath], { timeout: 5000 });
  assert.equal(result.stdout, "bounded retries verified");
});

test("100 alternating default updates preserve three concurrent bound and catalog readers", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const first = await createInbox("first", path.join(root, "first"), catalogHome);
  await createInbox("second", path.join(root, "second"), catalogHome);
  await setDefaultInbox("first", catalogHome);
  const env = { HTML_INBOX_CATALOG_HOME: catalogHome };
  const updateDefaults = async () => {
    for (let index = 0; index < 100; index += 1) {
      await setDefaultInbox(index % 2 === 0 ? "second" : "first", catalogHome);
    }
  };
  const readSelections = async () => {
    for (let index = 0; index < 100; index += 1) {
      assert.deepEqual(await resolveInboxSelection({ inbox: "first" }, env), { ...first, source: "explicit" });
      const catalog = await readInboxCatalog(catalogHome);
      assert(catalog.defaultName === "first" || catalog.defaultName === "second");
    }
  };

  await Promise.all([updateDefaults(), readSelections(), readSelections(), readSelections()]);
});

test("duplicate locations and copied UUIDs fail even under concurrent different names", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const home = await legacyLibrary(root, "shared-location");
  const results = await Promise.allSettled([registerInbox("first", home, catalogHome), registerInbox("second", home, catalogHome)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const copied = path.join(root, "copied");
  await cp(home, copied, { recursive: true });
  await assert.rejects(registerInbox("copy", copied, catalogHome), hasInspectionState("conflict"));
  assert.equal((await readInboxCatalog(catalogHome)).inboxes.length, 1);

  const copyCatalog = path.join(root, "copy-catalog");
  const copyResults = await Promise.allSettled([registerInbox("original", home, copyCatalog), registerInbox("copy", copied, copyCatalog)]);
  assert.equal(copyResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(copyResults.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await readInboxCatalog(copyCatalog)).inboxes.length, 1);
});

test("read-only registered inspection distinguishes missing, replaced identity, and incompatible identity", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const entry = await createInbox("work", path.join(root, "library"), catalogHome);
  const identityPath = path.join(entry.home, "instance-id");
  if (process.platform !== "win32") {
    await chmod(entry.home, 0o755);
    await chmod(identityPath, 0o644);
    await inspectRegisteredInbox(entry);
    assert.equal((await stat(entry.home)).mode & 0o777, 0o755);
    assert.equal((await stat(identityPath)).mode & 0o777, 0o644);
  }

  await writeFile(identityPath, randomUUID());
  await assert.rejects(inspectRegisteredInbox(entry), hasInspectionState("conflict"));
  await rm(identityPath);
  await assert.rejects(inspectRegisteredInbox(entry), hasInspectionState("conflict"));
  await writeFile(identityPath, "broken");
  await assert.rejects(inspectRegisteredInbox(entry), hasInspectionState("incompatible"));
  await rm(entry.home, { recursive: true });
  await assert.rejects(inspectRegisteredInbox(entry), hasInspectionState("missing"));
  assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry] });
  await assert.rejects(lstat(entry.home), { code: "ENOENT" });
});

test("parent aliases canonicalize; leaf symlinks and canonical-root replacement fail", { skip: process.platform === "win32" }, async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const parent = path.join(root, "actual");
  await mkdir(parent);
  const alias = path.join(root, "alias");
  await symlink(parent, alias);
  const home = await legacyLibrary(parent, "library");
  const entry = await registerInbox("work", path.join(alias, "library"), catalogHome);
  assert.equal(entry.home, home);
  const created = await createInbox("new", path.join(alias, "new"), catalogHome);
  assert.equal(created.home, path.join(parent, "new"));

  const leaf = path.join(root, "leaf");
  await symlink(home, leaf);
  await assert.rejects(registerInbox("leaf", leaf, catalogHome), hasInspectionState("incompatible"));
  await assert.rejects(createInbox("leaf", leaf, catalogHome), /leaf symbolic link/);
  await assert.rejects(registerInbox("duplicate", path.join(alias, "library"), catalogHome), hasInspectionState("conflict"));

  const moved = path.join(root, "moved");
  await rename(parent, moved);
  await symlink(moved, parent);
  await assert.rejects(inspectRegisteredInbox(entry), hasInspectionState("conflict"));
});

test("identity and catalog file links are rejected without modifying their targets", { skip: process.platform === "win32" }, async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const home = await legacyLibrary(root, "library");
  const target = path.join(root, "identity");
  const identity = randomUUID();
  await writeFile(target, identity, { mode: 0o644 });
  await symlink(target, path.join(home, "instance-id"));
  await assert.rejects(registerInbox("work", home, catalogHome), hasInspectionState("incompatible"));
  await rm(path.join(home, "instance-id"));
  await link(target, path.join(home, "instance-id"));
  await assert.rejects(registerInbox("work", home, catalogHome), hasInspectionState("incompatible"));
  assert.equal(await readFile(target, "utf8"), identity);
  assert.equal((await stat(target)).mode & 0o777, 0o644);

  await mkdir(path.join(catalogHome, "inboxes"), { recursive: true });
  await symlink(target, path.join(catalogHome, "inboxes", "work.json"));
  await assert.rejects(readInboxCatalog(catalogHome), /regular private file/);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test("defaults validate named homes, persist independently, and clear without a current selection", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const first = await createInbox("first", path.join(root, "first"), catalogHome);
  const second = await createInbox("second", path.join(root, "second"), catalogHome);
  await setDefaultInbox("first", catalogHome);
  assert.equal((await readInboxCatalog(catalogHome)).defaultName, "first");
  await assert.rejects(setDefaultInbox("unknown", catalogHome), /Unknown inbox/);
  assert.equal((await readInboxCatalog(catalogHome)).defaultName, "first");
  await setDefaultInbox("second", catalogHome);
  await rm(second.home, { recursive: true });
  await assert.rejects(setDefaultInbox("second", catalogHome), hasInspectionState("missing"));
  assert.equal((await readInboxCatalog(catalogHome)).defaultName, "second");
  await clearDefaultInbox(catalogHome);
  assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [first, second] });
});

test("default mutations recover corrupt contents while ordinary reads remain strict", async (t) => {
  for (const { label, contents, message } of [
    { label: "invalid JSON", contents: "{", message: /JSON/ },
    { label: "invalid schema", contents: "null", message: /default must use schema version 1/ },
    { label: "unsupported schema", contents: '{"schemaVersion":99,"name":"work"}', message: /default must use schema version 1/ },
    { label: "oversized record", contents: " ".repeat(64 * 1024 + 1), message: /too large/ },
  ]) {
    for (const operation of ["clear", "reset"]) {
      await t.test(`${label}: ${operation}`, async (t) => {
        const { root, catalogHome } = await catalogFixture(t);
        const entry = await createInbox("work", path.join(root, "work"), catalogHome);
        const defaultPath = path.join(catalogHome, "default.json");
        await writeFile(defaultPath, contents, { mode: 0o600 });
        await assert.rejects(readInboxCatalog(catalogHome), message);
        await assert.rejects(resolveInboxSelection({}, { HTML_INBOX_CATALOG_HOME: catalogHome }), message);

        if (operation === "clear") {
          await clearDefaultInbox(catalogHome);
          await assert.rejects(lstat(defaultPath), { code: "ENOENT" });
          assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry] });
        } else {
          await setDefaultInbox("work", catalogHome);
          assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry], defaultName: "work" });
          assert.deepEqual(await resolveInboxSelection({}, { HTML_INBOX_CATALOG_HOME: catalogHome }), { ...entry, source: "default" });
          assert.equal((await lstat(defaultPath)).nlink, 1);

          if (process.platform !== "win32") {
            assert.equal((await stat(defaultPath)).mode & 0o777, 0o600);
          }
        }
      });
    }
  }
});

test("default recovery validates the destination before changing corrupt contents", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  const entry = await createInbox("work", path.join(root, "work"), catalogHome);
  const defaultPath = path.join(catalogHome, "default.json");
  const contents = "{";
  await writeFile(defaultPath, contents, { mode: 0o644 });
  const originalMode = (await stat(defaultPath)).mode;

  await assert.rejects(setDefaultInbox("unknown", catalogHome), /Unknown inbox/);
  assert.equal(await readFile(defaultPath, "utf8"), contents);
  assert.equal((await stat(defaultPath)).mode, originalMode);

  const moved = path.join(root, "moved");
  await rename(entry.home, moved);
  await assert.rejects(setDefaultInbox("work", catalogHome), hasInspectionState("missing"));
  await assert.rejects(lstat(entry.home), { code: "ENOENT" });
  assert.equal(await readFile(defaultPath, "utf8"), contents);
  assert.equal((await stat(defaultPath)).mode, originalMode);

  await rename(moved, entry.home);
  const replacementIdentity = randomUUID();
  await writeFile(path.join(entry.home, "instance-id"), replacementIdentity);
  await assert.rejects(setDefaultInbox("work", catalogHome), hasInspectionState("conflict"));
  assert.equal(await readFile(path.join(entry.home, "instance-id"), "utf8"), replacementIdentity);
  assert.equal(await readFile(defaultPath, "utf8"), contents);
  assert.equal((await stat(defaultPath)).mode, originalMode);
});

for (const kind of ["hardlink", "symlink"]) {
  test(`default reset refuses a ${kind} and clear unlinks it without changing its target`, async (t) => {
    const { root, catalogHome } = await catalogFixture(t);
    const entry = await createInbox("work", path.join(root, "work"), catalogHome);
    const defaultPath = path.join(catalogHome, "default.json");
    const target = path.join(root, "unrelated.json");
    const contents = '{"schemaVersion":1,"name":"work"}';
    await writeFile(target, contents, { mode: 0o644 });
    const originalMode = (await stat(target)).mode;

    if (kind === "hardlink") {
      await link(target, defaultPath);
    } else {
      try {
        await symlink(target, defaultPath);
      } catch (error) {
        if (process.platform === "win32" && error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
          t.skip("Creating file symlinks requires Windows privileges");
          return;
        }

        throw error;
      }
    }

    const originalLink = await lstat(defaultPath);
    await assert.rejects(setDefaultInbox("work", catalogHome), /regular private file/);
    const preservedLink = await lstat(defaultPath);
    assert.equal(preservedLink.isSymbolicLink(), originalLink.isSymbolicLink());
    assert.equal(preservedLink.ino, originalLink.ino);
    assert.equal(preservedLink.nlink, originalLink.nlink);
    assert.equal(await readFile(target, "utf8"), contents);
    assert.equal((await stat(target)).mode, originalMode);

    await clearDefaultInbox(catalogHome);
    await assert.rejects(lstat(defaultPath), { code: "ENOENT" });
    assert.equal(await readFile(target, "utf8"), contents);
    assert.equal((await stat(target)).mode, originalMode);
    assert.equal((await stat(target)).nlink, 1);
    assert.deepEqual(await readInboxCatalog(catalogHome), { inboxes: [entry] });
  });
}

test("default mutations refuse directories without removing contents or changing modes", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  await createInbox("work", path.join(root, "work"), catalogHome);
  const defaultPath = path.join(catalogHome, "default.json");
  await mkdir(defaultPath, { mode: 0o755 });
  const childPath = path.join(defaultPath, "keep.txt");
  await writeFile(childPath, "keep", { mode: 0o644 });
  const originalDirectoryMode = (await stat(defaultPath)).mode;
  const originalFileMode = (await stat(childPath)).mode;

  await assert.rejects(setDefaultInbox("work", catalogHome), /regular private file/);
  await assert.rejects(clearDefaultInbox(catalogHome));
  assert.deepEqual(await readdir(defaultPath), ["keep.txt"]);
  assert.equal(await readFile(childPath, "utf8"), "keep");
  assert.equal((await stat(defaultPath)).mode, originalDirectoryMode);
  assert.equal((await stat(childPath)).mode, originalFileMode);
});

test("malformed catalog boundaries and unsafe names fail instead of being adopted", async (t) => {
  const { root, catalogHome } = await catalogFixture(t);
  await mkdir(path.join(catalogHome, "inboxes"), { recursive: true });
  const entryPath = path.join(catalogHome, "inboxes", "work.json");
  for (const record of [null, [], { schemaVersion: 99 }, { schemaVersion: 1, name: "work", home: "relative", instanceId: randomUUID() }]) {
    await writeFile(entryPath, JSON.stringify(record));
    await assert.rejects(readInboxCatalog(catalogHome), /schema version 1/);
  }

  await rm(entryPath);
  for (const name of ["", "../escape", "a/b", "Upper", "a".repeat(64), "con", "nul"]) {
    await assert.rejects(createInbox(name, path.join(root, "unused"), catalogHome), /Inbox name/);
  }

  await writeFile(path.join(catalogHome, "default.json"), "null");
  await assert.rejects(readInboxCatalog(catalogHome), /default must use schema version 1/);
  await assert.rejects(lstat(path.join(root, "unused")), { code: "ENOENT" });
});
