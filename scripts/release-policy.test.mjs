import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReleasePolicy } from "./release-policy.mjs";

const compatibilityRelease = {
  version: "0.7.0",
  requestedVersion: "0.7.0",
  engines: { node: ">=20" },
  ref: "refs/heads/release/0.7",
  tag: "latest",
  latestVersion: "0.6.1",
};

test("compatibility releases retain latest until a modern stable exists", () => {
  for (const ref of ["refs/heads/main", "refs/heads/release/0.7"]) {
    assert.deepEqual(verifyReleasePolicy({ ...compatibilityRelease, ref }), { version: "0.7.0", tag: "latest" });
  }

  assert.deepEqual(verifyReleasePolicy({
    ...compatibilityRelease, version: "0.6.1", requestedVersion: "0.6.1", ref: "refs/heads/main",
  }), { version: "0.6.1", tag: "latest" });
});

test("modern latest routes compatibility maintenance exclusively to node20", () => {
  const release = { ...compatibilityRelease, latestVersion: "1.0.0", tag: "node20" };
  assert.equal(verifyReleasePolicy(release).tag, "node20");

  for (const [change, message] of [
    [{ tag: "latest" }, /must not move npm latest backward/],
    [{ ref: "refs/heads/main" }, /After 1.0/],
    [{ version: "0.6.2", requestedVersion: "0.6.2" }, /approved release\/0.7 branch/],
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
