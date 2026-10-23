import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parseHubConfig, readHubConfig, writeHubConfig, type HubConfiguration } from "./hub-config";
import { temporaryHome } from "./test-fixtures";

test("hub config stores only explicit membership and refuses to overwrite", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const filePath = path.join(home, "hub.json");
  const config: HubConfiguration = {
    schemaVersion: 1,
    name: "My reports",
    sources: [{ name: "work", home: path.join(home, "not-created"), instanceId: randomUUID() }],
  };
  assert.deepEqual(await writeHubConfig(filePath, config), config);
  assert.deepEqual(await readHubConfig(filePath), config);
  assert.deepEqual(await readdir(home), ["hub.json"]);
  if (process.platform !== "win32") {
    assert.equal((await lstat(filePath)).mode & 0o777, 0o600);
    await chmod(filePath, 0o400);
  }

  const before = await lstat(filePath);
  await assert.rejects(writeHubConfig(filePath, { ...config, name: "replacement" }), { code: "EEXIST" });
  assert.deepEqual(await readHubConfig(filePath), config);
  const after = await lstat(filePath);
  assert.equal(after.mode, before.mode);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("hub config rejects unsupported and ambiguous local configuration", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const source = { name: "work", home, instanceId: randomUUID() };
  const config = { schemaVersion: 1, name: "local", sources: [source] };
  const invalid = [
    null, [], { ...config, schemaVersion: 2 }, { ...config, name: "bad\nname" },
    { ...config, sources: [] }, { ...config, sources: Array(129).fill(source) },
    { ...config, sources: [source, source] }, { ...config, exposure: "lan" },
    { ...config, sources: [source, { ...source, name: "other", instanceId: randomUUID() }] },
    { ...config, sources: [source, { ...source, name: "other", home: path.join(home, "other") }] },
    { ...config, name: " " }, { ...config, name: "a".repeat(201) },
    { ...config, sources: [{ ...source, url: "https://example.test" }] },
    ...["", "../escape", "Upper", "a".repeat(64), "con", "nul", "com1", "lpt9"].map((name) => ({ ...config, sources: [{ ...source, name }] })),
    ...["relative", `${home}/..`, `${home}/`, `${home}\0escape`].map((sourceHome) => ({ ...config, sources: [{ ...source, home: sourceHome }] })),
    { ...config, sources: [{ ...source, instanceId: "unknown" }] },
  ];

  for (const value of invalid) {
    assert.throws(() => parseHubConfig(value));
  }

  assert.deepEqual(parseHubConfig(config), config);
  assert.equal(parseHubConfig({ ...config, sources: [{ ...source, instanceId: source.instanceId.toUpperCase() }] }).sources[0].instanceId, source.instanceId);
  for (const name of ["with_underscore", "trailing-", "7"]) {
    assert.equal(parseHubConfig({ ...config, sources: [{ ...source, name }] }).sources[0].name, name);
  }
  const filePath = path.join(home, "hub.json");
  await writeFile(filePath, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(readHubConfig(filePath), /byte limit/);
  await writeFile(filePath, "{");
  await assert.rejects(readHubConfig(filePath), SyntaxError);
});

test("hub config publication is exclusive under concurrent writers and survives a retained temporary link", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const filePath = path.join(home, "hub.json");
  const config: HubConfiguration = { schemaVersion: 1, name: "Reading hub", sources: [{ name: "work", home, instanceId: randomUUID() }] };
  const attempts = await Promise.allSettled([
    writeHubConfig(filePath, config),
    writeHubConfig(filePath, { ...config, name: "Other hub" }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert(rejected?.status === "rejected");
  const reason: unknown = rejected.reason;
  assert(reason instanceof Error && "code" in reason);
  assert.equal(reason.code, "EEXIST");
  const winner = await readHubConfig(filePath);
  assert(["Reading hub", "Other hub"].includes(winner.name));
  assert.deepEqual(await readdir(home), ["hub.json"]);

  await link(filePath, path.join(home, ".hub.json.tmp-interrupted"));
  assert.deepEqual(await readHubConfig(filePath), winner);
});

test("hub config rejects managed symlinks and non-file paths", { skip: process.platform === "win32" }, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const target = path.join(home, "target.json");
  const linkPath = path.join(home, "hub.json");
  const config: HubConfiguration = { schemaVersion: 1, name: "local", sources: [{ name: "work", home, instanceId: randomUUID() }] };
  await writeHubConfig(target, config);
  await symlink(target, linkPath);
  await assert.rejects(readHubConfig(linkPath), /regular file/);
  await assert.rejects(writeHubConfig(linkPath, config), { code: "EEXIST" });
  assert.equal(await readFile(target, "utf8"), `${JSON.stringify(config, null, 2)}\n`);

  const directory = path.join(home, "directory");
  await mkdir(directory);
  await assert.rejects(readHubConfig(directory), /regular file/);
  const parentLink = path.join(home, "linked-parent");
  await symlink(directory, parentLink);
  await assert.rejects(writeHubConfig(path.join(parentLink, "hub.json"), config), /canonical/);
});
