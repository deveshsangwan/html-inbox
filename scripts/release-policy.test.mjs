import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyReleasePolicy } from "./release-policy.mjs";

const compatibilityRelease = {
  version: "0.7.0",
  requestedVersion: "0.7.0",
  engines: { node: ">=20" },
  ref: "refs/heads/main",
  tag: "latest",
  latestVersion: "0.6.1",
};

test("compatibility releases retain latest until a modern stable exists", () => {
  const releaseBranch = { ...compatibilityRelease, ref: "refs/heads/release/0.7" };
  assert.deepEqual(verifyReleasePolicy(compatibilityRelease), { version: "0.7.0", tag: "latest" });
  assert.deepEqual(verifyReleasePolicy({ ...releaseBranch, isReleaseBranchApproved: true }), { version: "0.7.0", tag: "latest" });
  assert.throws(() => verifyReleasePolicy(releaseBranch), /waits for branch protection/);

  assert.deepEqual(verifyReleasePolicy({
    ...compatibilityRelease, version: "0.6.1", requestedVersion: "0.6.1", ref: "refs/heads/main",
  }), { version: "0.6.1", tag: "latest" });
});

test("modern latest routes compatibility maintenance exclusively to node20", () => {
  const release = { ...compatibilityRelease, ref: "refs/heads/release/0.7", latestVersion: "1.0.0", tag: "node20", isReleaseBranchApproved: true };
  assert.equal(verifyReleasePolicy(release).tag, "node20");

  for (const [change, message] of [
    [{ tag: "latest" }, /must not move npm latest backward/],
    [{ ref: "refs/heads/main" }, /After 1.0/],
    [{ version: "0.6.2", requestedVersion: "0.6.2" }, /0.6.x releases only from main/],
  ]) {
    assert.throws(() => verifyReleasePolicy({ ...release, ...change }), message);
  }
});

test("reject invalid versions, refs, engines and premature tags before publication", () => {
  for (const [change, message] of [
    [{ requestedVersion: "0.7.1" }, /stable semantic version/],
    [{ version: "0.7.0-rc.1", requestedVersion: "0.7.0-rc.1" }, /stable semantic version/],
    [{ latestVersion: "" }, /Read a stable npm latest/],
    [{ latestVersion: "1.0.0-rc.1" }, /Read a stable npm latest/],
    [{ latestVersion: undefined }, /Read a stable npm latest/],
    [{ latestVersion: "0.6.3\n1.0.0" }, /Read a stable npm latest/],
    [{ version: "0.5.1", requestedVersion: "0.5.1", latestVersion: "0.6.3" }, /only 0.6.x or 0.7.x/],
    [{ version: "0.6.4", requestedVersion: "0.6.4", ref: "refs/heads/release/0.7" }, /0.6.x releases only from main/],
    [{ version: "0.8.0", requestedVersion: "0.8.0" }, /only 0.6.x or 0.7.x/],
    [{ ref: "refs/heads/feature" }, /approved release\/0.7 branch/],
    [{ ref: "refs/tags/v0.7.0" }, /approved release\/0.7 branch/],
    [{ engines: { node: ">=24.19.0" } }, /must be exactly/],
    [{ engines: {} }, /must be exactly/],
    [{ tag: "node20" }, /require npm tag latest/],
    [{ tag: "next" }, /require npm tag latest/],
    [{ version: "1.0.0", requestedVersion: "1.0.0", engines: { node: ">=24.19.0" } }, /Modern release activation is pending/],
  ]) {
    assert.throws(() => verifyReleasePolicy({ ...compatibilityRelease, ...change }), message);
  }
});

test("latest cannot move backward across minor or patch versions", () => {
  for (const [version, latestVersion] of [["0.6.2", "0.7.3"], ["0.7.2", "0.7.10"]]) {
    assert.throws(() => verifyReleasePolicy({
      ...compatibilityRelease, version, requestedVersion: version, latestVersion, ref: "refs/heads/main",
    }), /must not move npm latest backward/);
  }

  assert.equal(verifyReleasePolicy({
    ...compatibilityRelease, version: "0.7.10", requestedVersion: "0.7.10", latestVersion: "0.7.9",
  }).tag, "latest");
});

test("the workflow entry point writes outputs only for an accepted release", () => {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/cli/package.json"), "utf8"));
  const directory = mkdtempSync(path.join(tmpdir(), "html-inbox-release-policy-"));
  const outputPath = path.join(directory, "output");
  const run = (tag) => spawnSync(process.execPath, ["scripts/release-policy.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, EXPECTED_VERSION: version, GITHUB_REF: "refs/heads/main", RELEASE_TAG: tag, NPM_LATEST_VERSION: version, GITHUB_OUTPUT: outputPath },
  });

  try {
    const rejected = run("node20");
    assert.notEqual(rejected.status, 0);
    assert.throws(() => readFileSync(outputPath), { code: "ENOENT" });

    const accepted = run("latest");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(outputPath, "utf8"), `version=${version}\ntag=latest\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
