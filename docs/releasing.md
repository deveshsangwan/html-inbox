# Releasing HTML Inbox

The repository remains a pnpm workspace for development, but the published `html-inbox` package contains one self-contained ncc executable and no runtime package dependencies.

## Prepare

1. Update the package version and `CHANGELOG.md` together.
2. Run `corepack pnpm install --frozen-lockfile` from a clean checkout.
3. Run `corepack pnpm verify`. This builds and tests the source, packs the CLI, installs it into a temporary consumer, and exercises the installed binary.
4. Inspect `npm pack --dry-run` from `packages/cli`. The archive should contain only `bundle/index.js`, `README.md`, `LICENSE`, and `package.json`.
5. Confirm the npm name immediately before the first release with `npm view html-inbox`; availability can change.

## Produce an artifact

Push a `v<version>` tag or run the Package release artifact workflow manually. The workflow repeats the full verification gate and uploads the `.tgz` without publishing it.

## Publish deliberately

After verifying the downloaded tarball and authenticating the intended npm account, publish that exact artifact:

```sh
npm publish ./html-inbox-<version>.tgz --access public
```

Registry publication is intentionally not automatic: Git tags, GitHub artifacts, and npm publication are separate external side effects. Provenance requires publishing from a supported cloud CI runner, so the current manual path does not claim it. Do not reuse a version after any registry publish succeeds.
