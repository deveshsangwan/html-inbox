# Moving a local inbox to Cloudflare Pages

Remote publishing does not move or mutate the local library. `~/.html-inbox/documents` remains the only document source of truth; each remote update is a complete generated snapshot.

## Before publishing

1. Upgrade the source checkout and run `corepack pnpm verify`.
2. Confirm the local library with `corepack pnpm html-inbox list` and open the viewer.
3. Inspect a provider-independent export with `corepack pnpm html-inbox export --out ./html-inbox-export`.
4. Treat every document in the local library as part of one shared remote capability. Delete anything that should not be in that snapshot.

## Configure Cloudflare

Authenticate with Wrangler browser login, or export a token scoped to Account / Cloudflare Pages / Edit:

```sh
npx --yes wrangler@4.86.0 login
```

Create a dedicated Pages target:

```sh
corepack pnpm html-inbox remote init \
  --account <cloudflare-account-id> \
  --project <new-pages-project>
```

Prefer a new project. `--adopt` is deliberately required for an existing project because the next publish replaces its complete deployed contents.

## Publish and verify

```sh
corepack pnpm html-inbox remote publish
corepack pnpm html-inbox remote status
```

Open the production capability URL, check search and at least one document, then test at a narrow viewport. Share only the `/i/<capability>/` URL. The Pages root has no inbox listing.

If the command loses its response or reports preserved intent, do not repeatedly publish by hand:

```sh
corepack pnpm html-inbox remote reconcile
```

Reconciliation checks deployment history for the snapshot digest before it retries.

## Revoke or roll back

```sh
corepack pnpm html-inbox remote revoke
```

Revoke replaces the production site and rotates away from the shared capability. It does not delete older immutable deployment URLs. Remove sensitive historical deployments from the Cloudflare dashboard before treating the old content as inaccessible.

The local viewer remains available throughout this process. Removing remote state or a Pages deployment is not a substitute for deleting local documents deliberately with `html-inbox delete`.
