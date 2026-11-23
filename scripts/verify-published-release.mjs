import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isStableVersion, readNpmDistTags, readNpmRegistryJson, RegistryUnavailableError } from "./release-policy.mjs";

export async function verifyPublishedRelease({ version, tag, expectedIntegrity, budgetMs = 300_000, retryMs = 15_000 }) {
  if (!isStableVersion(version) || !["latest", "node20"].includes(tag)) {
    throw new Error("Expected a stable release version and a compatibility release tag");
  }

  const signal = AbortSignal.timeout(budgetMs);
  try {
    while (true) {
      try {
        const manifest = await readNpmRegistryJson(`/html-inbox/${version}`, signal);
        if (manifest?.name !== "html-inbox" || manifest.version !== version || manifest.dist?.integrity !== expectedIntegrity) {
          throw new Error("Published package identity or integrity differs from the verified archive");
        }

        const tags = await readNpmDistTags(signal);
        if (Object.hasOwn(tags, tag)) {
          if (!isStableVersion(tags[tag])) {
            throw new Error(`npm returned an invalid stable version for the ${tag} tag`);
          }

          if (tags[tag] === version) {
            return;
          }
        }
      } catch (error) {
        if (!(error instanceof RegistryUnavailableError)) {
          throw error;
        }
      }

      // A missing version, missing tag or previous tag can be visible during propagation.
      await delay(retryMs, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Published version or its ${tag} tag is still unconfirmed after ${budgetMs} ms; inspect npm before retrying publication`, { cause: error });
    }

    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { RELEASE_VERSION: version, RELEASE_TAG: tag } = process.env;
  const archive = readFileSync(`html-inbox-${version}.tgz`);
  const expectedIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;

  await verifyPublishedRelease({ version, tag, expectedIntegrity });
  console.log(`Verified html-inbox@${version} as ${tag}: ${expectedIntegrity}`);
}
