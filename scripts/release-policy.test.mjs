import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyReleasePolicy } from "./release-policy.mjs";

const execFileAsync = promisify(execFile);

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

test("the workflow entry point reads npm latest itself and writes outputs only on acceptance", async () => {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/cli/package.json"), "utf8"));
  const directory = mkdtempSync(path.join(tmpdir(), "html-inbox-release-policy-"));
  const outputPath = path.join(directory, "output");
  const linkedScript = path.join(directory, "linked-release-policy.mjs");
  symlinkSync(path.join(repositoryRoot, "scripts/release-policy.mjs"), linkedScript);
  let isRegistryAvailable = true;
  const registry = createServer((request, response) => {
    if (!isRegistryAvailable || request.url !== "/-/package/html-inbox/dist-tags") {
      response.writeHead(503).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ latest: version }));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const registryUrl = `http://127.0.0.1:${registry.address().port}`;
  const run = async ({ tag = "latest", ref = "refs/heads/main", script = "scripts/release-policy.mjs" } = {}) => {
    try {
      await execFileAsync(process.execPath, [script], {
        cwd: repositoryRoot,
        env: { ...process.env, EXPECTED_VERSION: version, GITHUB_REF: ref, RELEASE_TAG: tag, GITHUB_OUTPUT: outputPath, HTML_INBOX_NPM_REGISTRY: registryUrl },
      });
      return { isAccepted: true, stderr: "" };
    } catch (error) {
      return { isAccepted: false, stderr: String(error.stderr) };
    }
  };
  const assertNoOutput = () => assert.throws(() => readFileSync(outputPath), { code: "ENOENT" });

  try {
    assert.match((await run({ tag: "node20" })).stderr, /require npm tag latest/);
    assertNoOutput();
    // The checkout's package version decides which release-branch refusal applies.
    assert.match((await run({ ref: "refs/heads/release/0.7" })).stderr, /only from main|waits for branch protection/);
    assertNoOutput();
    isRegistryAvailable = false;
    assert.match((await run()).stderr, /dist-tag lookup failed with HTTP 503/);
    assertNoOutput();
    isRegistryAvailable = true;

    assert.equal((await run({ script: linkedScript })).isAccepted, true);
    assert.equal(readFileSync(outputPath, "utf8"), `version=${version}\ntag=latest\n`);
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
