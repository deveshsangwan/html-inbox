import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function verifyReleasePolicy({ version, engines, requestedVersion, ref, tag, latestVersion }) {
  if (!stableVersionPattern.test(version) || version !== requestedVersion) {
    throw new Error("Requested version must match the package's stable semantic version");
  }

  if (!stableVersionPattern.test(latestVersion)) {
    throw new Error("Read a stable npm latest version before choosing a release tag");
  }

  const versionParts = version.split(".").map(BigInt);
  const latestParts = latestVersion.split(".").map(BigInt);
  const [major, minor] = versionParts;
  const hasModernLatest = latestParts[0] >= 1n;
  const differingPart = versionParts.findIndex((part, index) => part !== latestParts[index]);

  if (tag === "latest" && differingPart !== -1 && versionParts[differingPart] < latestParts[differingPart]) {
    throw new Error("A release must not move npm latest backward");
  }

  if (major === 0n && (minor === 6n || minor === 7n)) {
    // Keep 0.6 patch releases possible until the unpublished 0.7 line is ready.
    const allowedRefs = minor === 7n
      ? ["refs/heads/main", "refs/heads/release/0.7"]
      : ["refs/heads/main"];
    const expectedTag = hasModernLatest ? "node20" : "latest";

    if (engines?.node !== ">=20") {
      throw new Error('Compatibility package engines.node must be exactly ">=20"');
    }

    if (!allowedRefs.includes(ref)) {
      throw new Error("Publish compatibility releases from main or the approved release/0.7 branch");
    }

    // Explicit tag selection is a maintainer-approved double check before publication.
    if (tag !== expectedTag) {
      throw new Error(`Compatibility releases require npm tag ${expectedTag}`);
    }

    if (hasModernLatest && (minor !== 7n || ref !== "refs/heads/release/0.7")) {
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
