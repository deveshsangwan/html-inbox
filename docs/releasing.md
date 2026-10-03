# Releasing HTML Inbox

The repository remains a pnpm workspace for development, but the published `html-inbox` package contains one self-contained ncc executable and no runtime package dependencies. End-user documentation uses npm and the installed `html-inbox` command; pnpm appears here only because this checklist operates the source workspace and its lockfile.

## Set up the npm account

1. Create an account at [npmjs.com](https://www.npmjs.com/signup) if needed, and verify its email address.
2. [Enable two-factor authentication](https://docs.npmjs.com/configuring-two-factor-authentication/) on the account that will own the package. Interactive publishing requires 2FA.
3. Sign in from the terminal in the environment that will publish the package:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

   Complete the browser login yourself and confirm that `whoami` reports the intended owner. Keep passwords, tokens, and recovery codes out of source files and chat.
4. Check the package name with `npm view html-inbox --registry=https://registry.npmjs.org/`. An `E404` means no visible package exists; it does not guarantee the registry will accept the name. If another account owns it, obtain publishing access or choose a different name before packing.

The package to publish is `packages/cli`, currently version `0.1.0`. The workspace root is private and must not be published. The first successful publish creates the package on npm; there is no separate package creation step on the website. See [npm's public package publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/).

## Prepare

1. Update the package version and `CHANGELOG.md` together.
2. Use Node.js 24 and run `corepack pnpm install --frozen-lockfile` from a clean checkout.
3. Install the test browser with `corepack pnpm exec playwright install chromium`, then run `corepack pnpm verify`. This builds and tests the source, packs the CLI, installs it into a temporary consumer, and exercises the installed binary.
4. Inspect `npm pack --dry-run` from `packages/cli`. The archive should contain only `bundle/index.js`, `README.md`, `LICENSE`, and `package.json`.
5. Confirm the npm name immediately before the first release with `npm view html-inbox`; availability can change.

## Produce an artifact

Push a `v<version>` tag or run the Package release artifact workflow manually. The workflow repeats the full verification gate and uploads the `.tgz` without publishing it.

To build the same artifact locally after the verification gate, run these commands from the repository root. Replace `0.1.0` with the package version for later releases:

```sh
mkdir -p artifacts
cd packages/cli
npm pack --pack-destination ../../artifacts
cd ../..
node scripts/package-smoke.mjs artifacts/html-inbox-0.1.0.tgz
npm publish ./artifacts/html-inbox-0.1.0.tgz --dry-run --access public --registry=https://registry.npmjs.org/
```

Inspect the packed file list. Test and publish the same tarball so a rebuild cannot change the artifact between verification and publication. Local `artifacts/` files are ignored by Git.

## Publish deliberately

After verifying the downloaded tarball and authenticating the intended npm account, publish that exact artifact:

```sh
npm publish ./artifacts/html-inbox-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
```

Complete npm's 2FA challenge when prompted. After npm reports success, confirm the version and test installation from the registry:

```sh
npm view html-inbox@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
npm exec --yes --registry=https://registry.npmjs.org/ --package=html-inbox@0.1.0 -- html-inbox --version
```

The public package page is [npmjs.com/package/html-inbox](https://www.npmjs.com/package/html-inbox). Once publication is confirmed, date the changelog entry and update the README's first-release installation wording. Record the release with a matching Git tag. For later releases, increment the version and repeat the verification, packing, and publication steps.

Registry publication is intentionally not automatic: Git tags, GitHub artifacts, and npm publication are separate external side effects. Provenance requires publishing from a supported cloud CI runner, so the current manual path does not claim it. Do not reuse a version after any registry publish succeeds.

## Optional trusted publishing for later releases

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) lets GitHub Actions publish through OIDC without an npm token. After the first release, configure a trusted publisher in the package's npm settings for GitHub user `deveshsangwan` and repository `html-inbox`. A publishing workflow must exist before selecting its filename and must grant `id-token: write`, run verification, and publish the tested tarball with a supported npm CLI. Enable the publisher's direct `npm publish` permission if using direct releases.

The existing `package.yml` only builds artifacts. Adding a trusted publisher alone does not make that workflow publish. A future publishing workflow and its trigger should be configured together with the npm settings.
