import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export class RegistryUnavailableError extends Error {}

export function isStableVersion(value) {
  return typeof value === "string" && stableVersionPattern.test(value);
}

// Node fetch keeps no local npm cache. Keep the signal attached through the body read.
export async function readNpmRegistryJson(path, signal) {
  let body;
  try {
    const response = await fetch(`https://registry.npmjs.org${path}`, { cache: "no-store", signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }

    body = await response.text();
  } catch (cause) {
    throw new RegistryUnavailableError(`npm lookup for ${path} failed: ${cause.message}`, { cause });
  }

  return JSON.parse(body);
}

export async function readNpmDistTags(signal = AbortSignal.timeout(30_000)) {
  const tags = await readNpmRegistryJson("/-/package/html-inbox/dist-tags", signal);
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new Error("npm dist-tag lookup returned a value that is not a tag object");
  }

  return tags;
}

// Release-branch publication stays off until a release administrator protects the release
// branches and binds npm trusted publishing to an approval-gated environment. Enabling it
// takes a reviewed change to the entry point below.
export function verifyReleasePolicy({ version, engines, requestedVersion, ref, tag, latestVersion, isReleaseBranchApproved = false }) {
  if (!isStableVersion(version) || version !== requestedVersion) {
    throw new Error("Requested version must match the package's stable semantic version");
  }

  if (!isStableVersion(latestVersion)) {
    throw new Error("Read a stable npm latest version before choosing a release tag");
  }

  const versionParts = version.split(".").map(BigInt);
  const latestParts = latestVersion.split(".").map(BigInt);
  const [major, minor] = versionParts;

  if (major >= 1n) {
    // Modern publication stays blocked until the candidate's driver and package gates exist.
    throw new Error("Modern release activation is pending the 1.x runtime, storage and package qualification PR");
  }

  if (minor !== 6n && minor !== 7n) {
    throw new Error("Before 1.x activation, publish only 0.6.x or 0.7.x compatibility releases");
  }

  const hasModernLatest = latestParts[0] >= 1n;
  const differingPart = versionParts.findIndex((part, index) => part !== latestParts[index]);

  if (tag === "latest" && differingPart !== -1 && versionParts[differingPart] < latestParts[differingPart]) {
    throw new Error("A release must not move npm latest backward");
  }

  if (engines?.node !== ">=20") {
    throw new Error('Compatibility package engines.node must be exactly ">=20"');
  }

  // Keep 0.6 patch releases possible from main until the unpublished 0.7 line is ready.
  if (minor === 6n && ref !== "refs/heads/main") {
    throw new Error("Publish 0.6.x releases only from main");
  }

  if (minor === 7n && ref !== "refs/heads/main" && ref !== "refs/heads/release/0.7") {
    throw new Error("Publish 0.7.x releases from main or the approved release/0.7 branch");
  }

  if (ref === "refs/heads/release/0.7" && !isReleaseBranchApproved) {
    throw new Error("Publication from release/0.7 waits for branch protection and an approval-gated npm environment");
  }

  // Explicit tag selection is a maintainer-approved double check before publication.
  const expectedTag = hasModernLatest ? "node20" : "latest";
  if (tag !== expectedTag) {
    throw new Error(`Compatibility releases require npm tag ${expectedTag}`);
  }

  if (hasModernLatest && (minor !== 7n || ref !== "refs/heads/release/0.7")) {
    throw new Error("After 1.0, compatibility maintenance publishes only from release/0.7");
  }

  return { version, tag };
}

// Compare real paths so a symlinked invocation still runs the check instead of exiting silently.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { version, engines } = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
  const release = verifyReleasePolicy({
    version,
    engines,
    requestedVersion: process.env.EXPECTED_VERSION,
    ref: process.env.GITHUB_REF,
    tag: process.env.RELEASE_TAG,
    latestVersion: (await readNpmDistTags()).latest,
  });

  appendFileSync(process.env.GITHUB_OUTPUT, `version=${release.version}\ntag=${release.tag}\n`);
}
