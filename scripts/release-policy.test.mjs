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

  for (const change of [{ tag: "latest" }, { ref: "refs/heads/main" }, { version: "0.6.2", requestedVersion: "0.6.2" }]) {
    assert.throws(() => verifyReleasePolicy({ ...release, ...change }));
  }
});

test("reject invalid versions, refs, engines and premature tags before publication", () => {
  for (const change of [
    { requestedVersion: "0.7.1" }, { version: "0.7.0-rc.1", requestedVersion: "0.7.0-rc.1" },
    { latestVersion: "" }, { latestVersion: "1.0.0-rc.1" }, { ref: "refs/heads/feature" },
    { ref: "refs/tags/v0.7.0" }, { engines: { node: ">=24.19.0" } }, { engines: {} },
    { tag: "node20" }, { tag: "next" },
    { version: "1.0.0", requestedVersion: "1.0.0", engines: { node: ">=24.19.0" } },
  ]) {
    assert.throws(() => verifyReleasePolicy({ ...compatibilityRelease, ...change }));
  }
});
