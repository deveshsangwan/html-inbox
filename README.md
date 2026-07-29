# HTML Inbox

HTML Inbox is a local library for generated HTML reports, notes, and dashboards. The CLI validates and stores each document, then opens it through a loopback-only viewer with an isolated document frame and a restrictive Content Security Policy.

HTML Inbox is local-first. Optional remote publishing deploys complete static snapshots to a user-owned Cloudflare Pages project; the local viewer and its administrative capabilities remain private to the machine running the CLI. See [ADR 0001](docs/adr/0001-static-remote-inbox.md).

The CLI is packaged as a self-contained `html-inbox` executable with no runtime package dependencies.

## Install with npm

Node.js 20 or newer is required. After the first registry release, install the CLI globally:

```sh
npm install --global html-inbox
html-inbox --help
```

For occasional use without a global install:

```sh
npx html-inbox --help
```

Until the first registry release, use a source checkout. The operational examples below assume the installed `html-inbox` command; from a source checkout, run the same command as `corepack pnpm html-inbox ...`.

## Set up a source checkout for development

The repository is a pnpm workspace, so contributor and release commands use the checked-in pnpm lockfile:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Build and inspect the CLI:

```sh
corepack pnpm build
corepack pnpm html-inbox --help
```

## Publish a document

```sh
html-inbox publish ./examples/report.html \
  --title "Quarterly migration report" \
  --type report
```

The command stores the original HTML under `~/.html-inbox`, starts or reuses the local viewer, and prints the document URL. Set `HTML_INBOX_HOME` to use an isolated library or `HTML_INBOX_PORT` to choose another loopback port.

HTML documents are limited to 10 MiB by default. Set `HTML_INBOX_MAX_BYTES` to a positive byte count when a deliberate workflow needs a different limit.

Run the viewer directly when you want it to remain attached to the terminal:

```sh
html-inbox viewer
```

Manage the local library and viewer:

```sh
html-inbox list
html-inbox delete <document-id>
html-inbox viewer status
html-inbox viewer stop
```

Use `--json` with `list` or `delete` for automation. Non-interactive deletion requires `--force`. The viewer also supports server-rendered search across title, type, and source file name.

## Export a static inbox

Build a provider-independent static snapshot without contacting a hosting service:

```sh
html-inbox export --out ./html-inbox-export
```

The command prints the private inbox path, document count, and content hash. The deployed site root deliberately does not link to the inbox. Treat the generated `/i/<capability>/` path as a bearer secret: anyone who receives it can read that snapshot.

Exports preserve the original document bytes, include a browser-side library search, and replace a recognized prior export from a private sibling staging directory. Unrelated directories are refused. `security-headers.json` records the semantic security policies that a hosting adapter must install on every corresponding route alias. Use `--json` for automation or `--capability <value>` to reproduce a known 128-bit path; normally the command should generate the capability for you.

## Publish a remote inbox

HTML Inbox can deploy the complete local library as an unlisted static snapshot to a Cloudflare Pages project you own. Authenticate Wrangler once:

```sh
npx --yes wrangler@4.86.0 login
```

For non-interactive use, provide a Cloudflare API token with Account / Cloudflare Pages / Edit permission through `CLOUDFLARE_API_TOKEN`. The account ID is explicit configuration, not a secret; the token is inherited by Wrangler and is never written into HTML Inbox state or passed as a command argument.

Configure a target and publish:

```sh
html-inbox remote init \
  --account <cloudflare-account-id> \
  --project <pages-project-name>
html-inbox remote publish
```

`remote init` creates the Pages project when it does not exist. An existing project requires `--adopt` because the first publish will replace its complete contents. The publish command prints the production capability URL. Anyone with that URL can read and reshare the complete snapshot; this is an unlisted bearer link, not authentication.

Inspect and recover remote state:

```sh
html-inbox remote status
html-inbox remote reconcile
```

Every mutation records private durable intent before its remote side effect. If a request times out after Cloudflare may have accepted it, `remote reconcile` checks deployment history for the operation ID and snapshot digest before retrying.
If project creation was ambiguous, reconciliation requires `--adopt` before accepting the discovered project.

Revoke the shared production route:

```sh
html-inbox remote revoke
```

Revocation rotates to a new undisclosed empty capability and removes the previously shared route from the production deployment. It cannot erase older immutable deployment URLs; prune sensitive deployment history in Cloudflare before treating historical content as inaccessible. Use `--json` on remote commands for automation and `--yes` for non-interactive revoke.

## Supported HTML

HTML Inbox accepts UTF-8 `.html` and `.htm` files. It rejects inline event-handler attributes and external URLs except for the explicitly supported Tailwind browser and Mermaid v11 script entry points. Accepted HTML is still untrusted: validation is a compatibility and policy gate, not sanitization.

Documents render inside an iframe sandbox without `allow-same-origin`. Do not open stored document files directly in a browser and do not expose the viewer port to a LAN, VPN, container wildcard mapping, or public interface.

See [the architecture](docs/architecture.md) and [threat model](docs/threat-model.md) before changing storage, validation, rendering, or hosting behavior.

Existing local users can follow the [remote migration guide](docs/remote-migration.md). Maintainers should use the [release checklist](docs/releasing.md); registry publication is not automatic.

## Development

```sh
corepack pnpm build
corepack pnpm test
corepack pnpm verify
```

`verify` is the same clean build-and-test gate used by continuous integration. Package self-checks exercise validation, storage, static export determinism, Cloudflare command recording, remote-operation recovery, security headers, iframe isolation, theme behavior, and escaping of untrusted metadata.

## License

MIT
