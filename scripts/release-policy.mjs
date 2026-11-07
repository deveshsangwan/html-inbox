import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyReleasePolicy({ version, engines, requestedVersion, ref, tag, latestVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version !== requestedVersion) {
    throw new Error("Requested version must match the package's stable semantic version");
  }

  if (!/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    throw new Error("Read a stable npm latest version before choosing a release tag");
  }

  const major = Number(version.split(".")[0]);
  const minor = Number(version.split(".")[1]);
  const hasModernLatest = Number(latestVersion.split(".")[0]) >= 1;

  if (major === 0 && (minor === 6 || minor === 7)) {
    const allowedRefs = minor === 7
      ? ["refs/heads/main", "refs/heads/release/0.7"]
      : ["refs/heads/main"];
    const expectedTag = hasModernLatest ? "node20" : "latest";

    if (engines?.node !== ">=20" || !allowedRefs.includes(ref) || tag !== expectedTag) {
      throw new Error(`Compatibility releases require Node >=20, an approved branch and tag ${expectedTag}`);
    }

    if (hasModernLatest && (minor !== 7 || ref !== "refs/heads/release/0.7")) {
      throw new Error("After 1.0, compatibility maintenance publishes only from release/0.7");
    }

    return { version, tag };
  }

  // Modern publication stays blocked until the candidate's driver and package gates exist.
  throw new Error("Modern release activation is pending the 1.x runtime, storage and package qualification PR");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, engines } = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
  const release = verifyReleasePolicy({
    version,
    engines,
    requestedVersion: process.env.EXPECTED_VERSION,
    ref: process.env.GITHUB_REF,
    tag: process.env.RELEASE_TAG,
    latestVersion: process.env.NPM_LATEST_VERSION,
  });

  appendFileSync(process.env.GITHUB_OUTPUT, `version=${release.version}\ntag=${release.tag}\n`);
}
