# Releasing HTML Inbox

The source workspace uses Node.js 24, Corepack, and the pinned pnpm lockfile. The published `html-inbox` CLI supports Node.js 20 or newer and contains one self-contained ncc executable with no runtime package dependencies. Publish `packages/cli`, never the private workspace root.

## Prepare a version

1. Update `packages/cli/package.json` and `CHANGELOG.md` together. Never reuse a version that npm has accepted.
2. Tell users about upgrade requirements. For 0.2.0, stop viewers started by 0.1.0 with the old CLI before upgrading. The private process-control protocol changed; stored documents remain intact.
   Version 0.2.2 keeps the 0.2.x CLI and control protocol unchanged; restart an existing viewer after updating to load the new diagnostics.
   For 0.3.0, migrate automation to explicit `--json` on viewer/service inspections and explicit library selection when named entries exist. Catalog, picker, and hub inspection do not repair source permissions or create missing roots. The private control protocol remains compatible with 0.2.x; restart existing viewers to load the new code. See the [0.3.0 upgrade notes](../CHANGELOG.md#upgrade-to-030) and [named inbox guide](named-inboxes.md).
   Version 0.4.0 keeps the 0.3.x CLI and private protocol unchanged. Restart verified live viewers after an authorized update to load copy controls; existing static readers require owner-controlled regeneration and publication. New snapshots add one copy JSON file per document.
   Audit the root and packed READMEs, changelog, relevant guides, website, CLI help, and skill instructions against the exact candidate. Correct stale live claims and record the audit and validation results. Preserve explicitly historical evidence and keep any preparation fallback pinned to a published package.
3. From a clean checkout, run:

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm exec playwright install chromium
   corepack pnpm verify
   ```

4. Review the change, commit it, and record the exact release commit. Keep the website guides consistent with the released commands.
5. Inspect the packed files. The package should contain `bundle/index.js`, `README.md`, `LICENSE`, and `package.json`, with no runtime dependencies, credentials, inbox documents, or source tests.

On hosts where zsh startup adds Node to the resolver tests' restricted PATH, run verification with `ZDOTDIR` set to an empty temporary directory, then remove that directory. This isolates shell configuration without weakening the tests or changing the user's shell files.

## Publish locally

The normal release path is the main-only [GitHub publishing workflow](#publish-with-github-actions). Local publication is an alternative for an authenticated package owner.

Authenticate the package owner on the machine that will publish. Run `npm login --registry=https://registry.npmjs.org/` yourself, complete its browser sign-in, and check `npm whoami --registry=https://registry.npmjs.org/`. A 401 means the publishing session needs to be restored. Keep tokens, passwords, and recovery codes out of repository files and chat.

Build and test the same archive you will publish. From the checkout root, read its version from the reviewed package metadata:

```sh
mkdir -p artifacts
inbox_release_version=$(node -p "require('./packages/cli/package.json').version")
npm pack ./packages/cli --pack-destination ./artifacts
node scripts/package-smoke.mjs "artifacts/html-inbox-${inbox_release_version}.tgz"
npm publish "./artifacts/html-inbox-${inbox_release_version}.tgz" --dry-run --access public --registry=https://registry.npmjs.org/
```

After the file list and installed-package checks pass, publish that exact archive:

```sh
npm publish "./artifacts/html-inbox-${inbox_release_version}.tgz" --access public --registry=https://registry.npmjs.org/
```

Complete any npm authentication or 2FA challenge. Local publication does not claim GitHub provenance. A dry run validates the archive; it does not prove that npm will authorize the real publish.

## Publish with GitHub Actions

The [Publish npm release workflow](../.github/workflows/publish.yml) verifies source and browser tests, builds a tarball, runs installed-package smoke against that exact tarball, uploads it as an artifact, and publishes it through npm's trusted-publishing identity. It runs on GitHub-hosted Linux with Node.js 24 and grants `id-token: write` only to its publishing job. It needs no npm token secret.

The package owner must configure a trusted publisher once in [html-inbox package settings](https://www.npmjs.com/package/html-inbox/access). Use these exact values:

| Setting | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `deveshsangwan` |
| Repository | `html-inbox` |
| Workflow filename | `publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable direct `npm publish` |

The workflow file must already exist on GitHub. New trusted-publisher configurations can allow staged publishing alone; this workflow uses direct publishing, so select its permission explicitly. See the [current npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).

With npm 11.15.0 or newer, the authenticated owner can configure the same relationship through the [npm trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/):

```sh
npm trust list html-inbox --registry=https://registry.npmjs.org/
npm trust github html-inbox --repo deveshsangwan/html-inbox --file publish.yml \
  --allow-publish --yes --registry=https://registry.npmjs.org/
```

Complete the browser 2FA challenge. Inspect existing relationships first; preserve unrelated configurations and do not revoke one simply to retry setup. Once the matching relationship is configured, no repeated setup is needed for subsequent releases.

Complete the first successful publish within two days of creating the connection. Otherwise npm marks it expired and disables editing; delete that expired connection, recreate it with the values above, and publish before the new deadline.

For each release, merge the reviewed version change into main and verify that merge commit's required checks. Open Actions, choose **Publish npm release**, select **Run workflow** on main, and enter the exact package version. The workflow refuses a mismatched or non-stable version. It has a manual trigger so merging code or pushing an artifact tag does not publish unexpectedly. Successful trusted publishing from this public repository produces npm provenance automatically.

The existing [Package release artifact workflow](../.github/workflows/package.yml) still creates verified archives on `v<version>` tags or manual runs and never publishes to npm. Website deployment, package artifact generation, and npm publication are separate workflows.

## Verify the public release

After publishing, inspect npm's version, tag, and integrity and exercise the public package:

```sh
inbox_release_version=$(node -p "require('./packages/cli/package.json').version")
npm view "html-inbox@${inbox_release_version}" version dist.integrity --registry=https://registry.npmjs.org/
npm view html-inbox dist-tags --json --registry=https://registry.npmjs.org/
npm exec --yes --registry=https://registry.npmjs.org/ --package="html-inbox@${inbox_release_version}" -- html-inbox --version
```

Compare `dist.integrity` with the tested archive's SHA-512 integrity. Confirm that `latest` points to the intended stable version. Record a matching `v<version>` Git tag at the reviewed release commit and attach the tested archive to release notes when creating a GitHub release.

If npm reports an error after uploading, query the exact version before retrying. A version that already exists cannot be overwritten or republished. Preserve the tested artifact and command output while determining whether the upload completed.

npm may accept the upload before the version becomes publicly available. The publish workflow retries its registry lookup for up to five minutes and compares the public integrity with the verified archive. If verification times out after a successful upload, check the registry again; do not rerun publication just to repeat verification.
