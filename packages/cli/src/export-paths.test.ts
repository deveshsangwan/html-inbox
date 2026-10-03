import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { assertExportOutsideHome } from "./index";
import { containsPath } from "./path-containment";
import { temporaryHome } from "./test-fixtures";

test("Windows paths on different drives are outside each other", () => {
  const home = "C:\\html-inbox\\home";
  const output = "D:\\snapshots\\export";
  assert.equal(path.win32.relative(home, output), output);

  assert.equal(containsPath(home, output, path.win32), false);
  assert.equal(containsPath(output, home, path.win32), false);
});

for (const pathImplementation of [path.posix, path.win32]) {
  const platform = pathImplementation === path.win32 ? "Windows" : "POSIX";

  test(`${platform} containment respects path components`, () => {
    const root = pathImplementation === path.win32 ? "C:\\" : "/";
    const home = pathImplementation.join(root, "html-inbox", "home");
    const parent = pathImplementation.dirname(home);
    const output = pathImplementation.join(home, "snapshots", "export");
    const sibling = `${home}-export`;
    const dotPrefixSibling = pathImplementation.join(parent, "..export");

    assert.equal(containsPath(home, home, pathImplementation), true);
    assert.equal(containsPath(home, output, pathImplementation), true);
    assert.equal(containsPath(parent, home, pathImplementation), true);
    assert.equal(containsPath(home, parent, pathImplementation), false);
    assert.equal(containsPath(home, sibling, pathImplementation), false);
    assert.equal(containsPath(sibling, home, pathImplementation), false);
    assert.equal(containsPath(home, dotPrefixSibling, pathImplementation), false);
    assert.equal(containsPath(parent, dotPrefixSibling, pathImplementation), true);
  });
}

test("export rejects equal paths, ancestors, descendants and symlink aliases", async (t) => {
  const root = await temporaryHome(t);
  const home = path.join(root, "home");
  const homeAlias = path.join(root, "home-alias");
  await mkdir(home);
  await symlink(home, homeAlias, process.platform === "win32" ? "junction" : "dir");

  for (const output of [
    home,
    root,
    path.join(home, "snapshots", "export"),
    homeAlias,
    path.join(homeAlias, "snapshots", "export"),
  ]) {
    assert.throws(
      () => assertExportOutsideHome(output, home),
      /must not contain or be inside/,
    );
  }

  assert.throws(
    () => assertExportOutsideHome(root, homeAlias),
    /must not contain or be inside/,
  );
  assert.throws(
    () => assertExportOutsideHome(home, path.join(homeAlias, "nested-home")),
    /must not contain or be inside/,
  );
  assert.doesNotThrow(() => assertExportOutsideHome(`${home}-export`, home));
});

test("export command accepts a sibling output and rejects overlap", async (t) => {
  const root = await temporaryHome(t);
  const home = path.join(root, "home");
  const output = path.join(root, "export");
  const executable = path.join(__dirname, "index.js");
  const env = { ...process.env, HTML_INBOX_HOME: home };
  const exported = spawnSync(
    process.execPath,
    [executable, "export", "--out", output, "--json"],
    { env, encoding: "utf8" },
  );

  assert.equal(exported.status, 0, exported.stderr);
  assert.match(await readFile(path.join(output, "index.html"), "utf8"), /HTML Inbox/);

  for (const overlappingOutput of [home, root, path.join(home, "export")]) {
    const rejected = spawnSync(
      process.execPath,
      [executable, "export", "--out", overlappingOutput],
      { env, encoding: "utf8" },
    );

    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /must not contain or be inside HTML_INBOX_HOME/);
  }
});
