import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parseAppearance, readPreferences, setAppearancePreference } from "./preferences";
import { temporaryHome } from "./test-fixtures";

test("missing preferences use system without creating a home or record", async (t) => {
  const parent = await temporaryHome(t);
  const home = path.join(parent, "missing");
  assert.deepEqual(await readPreferences(home), { appearance: "system" });
  await assert.rejects(lstat(home), { code: "ENOENT" });

  assert.deepEqual(await readPreferences(parent), { appearance: "system" });
  assert.deepEqual(await readdir(parent), []);
});

test("appearance updates persist privately and can restore the system default", async (t) => {
  const parent = await temporaryHome(t);
  const home = path.join(parent, "inbox");

  for (const appearance of ["dark", "light", "system"] as const) {
    assert.deepEqual(await setAppearancePreference(home, appearance), { appearance });
    assert.deepEqual(await readPreferences(home), { appearance });
    assert.deepEqual(JSON.parse(await readFile(path.join(home, "preferences.json"), "utf8")), {
      schemaVersion: 1, appearance,
    });
    assert.deepEqual(await readdir(home), ["preferences.json"]);
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(home, "preferences.json"))).mode & 0o777, 0o600);

    await chmod(home, 0o755);
    await chmod(path.join(home, "preferences.json"), 0o644);
    await readPreferences(home);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(home, "preferences.json"))).mode & 0o777, 0o600);
  }
});

test("invalid records fail clearly and cannot be silently replaced", async (t) => {
  const home = await temporaryHome(t);
  const filePath = path.join(home, "preferences.json");
  const invalidRecords = [
    { contents: "{", message: /invalid JSON/ },
    { contents: "null", message: /schema version 1/ },
    { contents: "[]", message: /schema version 1/ },
    { contents: '{"appearance":"dark"}', message: /schema version 1/ },
    { contents: '{"schemaVersion":2,"appearance":"dark"}', message: /schema version 1/ },
    { contents: '{"schemaVersion":1}', message: /Appearance must/ },
    { contents: '{"schemaVersion":1,"appearance":"auto"}', message: /Appearance must/ },
    { contents: " ".repeat(4097), message: /too large/ },
  ];

  for (const { contents, message } of invalidRecords) {
    await writeFile(filePath, contents);
    await assert.rejects(readPreferences(home), message);
    await assert.rejects(setAppearancePreference(home, "dark"), message);
    assert.equal(await readFile(filePath, "utf8"), contents);
  }

  for (const value of [undefined, null, true, "auto", "Dark", {}, []]) {
    assert.throws(() => parseAppearance(value), /Appearance must be system, light, or dark/);
  }
});

test("preferences reject directories and non-directory homes", async (t) => {
  const parent = await temporaryHome(t);
  const fileHome = path.join(parent, "file");
  await writeFile(fileHome, "unchanged");
  await assert.rejects(readPreferences(fileHome), /not a regular directory/);
  await assert.rejects(setAppearancePreference(fileHome, "dark"), /not a regular directory/);
  assert.equal(await readFile(fileHome, "utf8"), "unchanged");

  const home = path.join(parent, "inbox");
  await mkdir(path.join(home, "preferences.json"), { recursive: true });
  await assert.rejects(readPreferences(home), /regular private file/);
  await assert.rejects(setAppearancePreference(home, "dark"), /regular private file/);
});

test("preferences reject symbolic links and hard links without changing their targets", { skip: process.platform === "win32" }, async (t) => {
  const parent = await temporaryHome(t);
  const target = path.join(parent, "outside");
  await mkdir(target);
  const original = '{"schemaVersion":1,"appearance":"light"}';
  const targetFile = path.join(target, "preferences.json");
  await writeFile(targetFile, original, { mode: 0o644 });
  const targetMode = (await stat(targetFile)).mode;

  const linkedHome = path.join(parent, "linked-home");
  await symlink(target, linkedHome);
  await assert.rejects(readPreferences(linkedHome), /not a regular directory/);
  await assert.rejects(setAppearancePreference(linkedHome, "dark"), /not a regular directory/);

  const linkedFileHome = path.join(parent, "linked-file");
  await mkdir(linkedFileHome);
  await symlink(targetFile, path.join(linkedFileHome, "preferences.json"));
  await assert.rejects(readPreferences(linkedFileHome), /regular private file/);
  await assert.rejects(setAppearancePreference(linkedFileHome, "dark"), /regular private file/);

  const hardLinkedHome = path.join(parent, "hard-linked-file");
  await mkdir(hardLinkedHome);
  await link(targetFile, path.join(hardLinkedHome, "preferences.json"));
  await assert.rejects(readPreferences(hardLinkedHome), /regular private file/);
  await assert.rejects(setAppearancePreference(hardLinkedHome, "dark"), /regular private file/);

  const danglingHome = path.join(parent, "dangling-home");
  await symlink(path.join(parent, "missing-target"), danglingHome);
  await assert.rejects(readPreferences(danglingHome), /not a regular directory/);

  assert.equal(await readFile(targetFile, "utf8"), original);
  assert.equal((await stat(targetFile)).mode, targetMode);
});
