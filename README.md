# HTML Inbox

[Website](https://deveshsangwan.github.io/html-inbox/) | [Documentation](https://deveshsangwan.github.io/html-inbox/docs/) | [npm](https://www.npmjs.com/package/html-inbox)

HTML Inbox is a local library for generated HTML reports, notes, and dashboards. The CLI validates and stores each document, then opens it through a viewer with an isolated document frame and a restrictive Content Security Policy. The viewer listens on loopback by default, with explicit LAN and Tailscale reader modes for self-hosting.

HTML Inbox is local-first. Publishing, deletion, and process management stay in the local CLI. Optional Cloudflare Pages publishing deploys complete static snapshots; LAN and Tailscale modes serve the live library. See [ADR 0001](docs/adr/0001-static-remote-inbox.md).

The CLI is packaged as a self-contained `html-inbox` executable with no runtime package dependencies.

## Install with npm

Node.js 20 or newer is required. Install the CLI globally:

```sh
npm install --global html-inbox
html-inbox --help
```

For occasional use without a global install:

```sh
npx html-inbox --help
```

The operational examples below assume the installed `html-inbox` command; from a source checkout, run the same command as `corepack pnpm html-inbox ...`.

## Set up a source checkout for development

Use Node.js 24 for source development and release tooling. The installed CLI supports Node.js 20 or newer. Clone the repository and use its pinned pnpm version and lockfile:

```sh
git clone https://github.com/deveshsangwan/html-inbox.git
cd html-inbox
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm html-inbox --help
```

Run subsequent source commands from the checkout root. See [Development](#development) for the full test gate.

## Publish a document

```sh
html-inbox publish ./examples/report.html \
  --title "Quarterly migration report" \
  --type report
```

The command stores the original HTML under `~/.html-inbox`, starts or reuses the background viewer, and prints a usable document URL. Set `HTML_INBOX_HOME` to choose another library or `HTML_INBOX_PORT` to select a port. Publishing reuses an exposed viewer and its network URL.

On POSIX filesystems that enforce Unix permissions, the CLI creates and tightens managed directories to `0700` and files to `0600`. On Windows, privacy depends on the filesystem's existing and inherited access control lists. The CLI does not install or verify owner-only Windows ACLs. Keep `HTML_INBOX_HOME` in a protected local user directory and restrict access to its files and subdirectories, including `remote` state containing bearer capabilities. Follow the [Windows storage prerequisites](docs/threat-model.md#windows-storage-prerequisites) before storing sensitive reports or configuring remote publishing.

HTML documents are limited to 10 MiB by default. Set `HTML_INBOX_MAX_BYTES` to a positive byte count when a deliberate workflow needs a different limit.

Start or reuse the viewer in the background. The command returns after a verified readiness check, and the viewer keeps running when the terminal closes:

```sh
html-inbox viewer
```

Use `html-inbox viewer --foreground` to keep it attached for debugging, containers, or a service manager. Failed background startup reports an error and keeps diagnostics under the protected inbox home.

Stop a viewer started by an older HTML Inbox release before upgrading. The private control protocol has changed; the new CLI refuses to signal a process whose older record it cannot verify.

Manage the local library and viewer:

```sh
html-inbox list
html-inbox delete <document-id>
html-inbox viewer status
html-inbox viewer stop
```

Use `--json` with `list` or `delete` for automation. Non-interactive deletion requires `--force`. The viewer also supports server-rendered search across title, type, and source file name.

## Serve the live inbox on a home server

Expose the complete live library to devices that can reach a LAN port:

```sh
html-inbox viewer --lan
html-inbox viewer --lan --host 192.168.1.20 --port 4321
```

LAN mode trusts everyone who can reach that port. There is no password, login, or reader token. The default LAN address is `0.0.0.0`; the CLI reports concrete interface URLs instead of a wildcard browser URL. `--host` selects an IP address on a multi-interface server, and `--port` overrides `HTML_INBOX_PORT`. The operating system's firewall determines which devices can reach the listener.

Use an existing installed, connected Tailscale client to serve HTTPS within your tailnet:

```sh
html-inbox viewer --tailscale
```

Tailscale must already be signed in, with MagicDNS and HTTPS available. Reader access follows your tailnet policy. HTML Inbox keeps its backend on loopback, checks existing Serve and Funnel configuration, and refuses a conflicting route. It reports the verified HTTPS tailnet URL. It never installs Tailscale, logs in, changes access rules, enables Funnel, or resets all Serve configuration. Cleanup removes only its verified owned route. See the [Tailscale integration notes](docs/tailscale.md).

`--loopback`, `--lan`, and `--tailscale` are mutually exclusive. Status reports the active mode and URLs. Commands without explicit networking options reuse the saved configuration, including after `viewer stop`. To return an exposed viewer to loopback, run `viewer stop`, then `viewer --loopback`. Publishing through the local CLI updates the live inbox for its readers. All HTTP routes remain read-only, and reader health responses contain no inbox or process identity.

## Start the viewer at boot

Boot services are installed explicitly. Linux uses a systemd system service; macOS uses a LaunchDaemon. Both start before login and run the viewer as a selected normal user. Installation and removal require administrator privileges; ordinary viewer startup does not change boot configuration.

```sh
html-inbox viewer service status
```

See the [service setup instructions](docs/self-hosting.md) for installation, removal, custom inbox paths, exposure configuration, and behavior under `sudo`. Keep the selected Node and CLI executable paths available across reboot. Removing a service preserves the library's documents.

## Export a static inbox

Build a provider-independent static snapshot without contacting a hosting service:

```sh
html-inbox export --out ./html-inbox-export
```

The command prints the private inbox path, document count, and content hash. The deployed site root deliberately does not link to the inbox. Treat the generated `/i/<capability>/` path as a bearer secret: anyone who receives it can read that snapshot.

Exports preserve the original document bytes, include a browser-side library search, and replace a recognized prior export from a sibling staging directory. The same filesystem privacy prerequisites apply to the export output and its parent directory. Unrelated directories are refused. `security-headers.json` records the semantic security policies that a hosting adapter must install on every corresponding route alias. Use `--json` for automation or `--capability <value>` to reproduce a known 128-bit path; normally the command should generate the capability for you.

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

Every mutation records durable intent in local files under the storage protections described above before its remote side effect. If a request times out after Cloudflare may have accepted it, `remote reconcile` checks deployment history for the operation ID and snapshot digest before retrying.
If project creation was ambiguous, reconciliation requires `--adopt` before accepting the discovered project.

Revoke the shared production route:

```sh
html-inbox remote revoke
```

Revocation rotates to a new undisclosed empty capability and removes the previously shared route from the production deployment. It cannot erase older immutable deployment URLs; prune sensitive deployment history in Cloudflare before treating historical content as inaccessible. Use `--json` on remote commands for automation and `--yes` for non-interactive revoke.

## Supported HTML

HTML Inbox accepts UTF-8 `.html` and `.htm` files. HTTPS links in `<a href>` are allowed, along with relative and fragment links; other navigation is rejected. Non-allowlisted external resources produce warnings and are blocked by the viewer CSP, except for the supported Tailwind browser and Mermaid v11 script entry points. Accepted HTML is still untrusted: validation is a compatibility and policy gate, not sanitization.

Document-relative assets also produce advisory warnings. See [HTML compatibility](docs/html-compatibility.md) for supported resources and ways to embed them.

Documents render inside an iframe sandbox without `allow-same-origin`, popup, or top-navigation permission. Links and allowed scripts can navigate the current preview frame; `_blank` links remain blocked. Viewer responses default to `no-referrer`, but author markup or script can override that policy or place data directly in a destination URL. Do not open stored document files directly in a browser. Choose LAN or Tailscale exposure explicitly and share the viewer only with readers you trust to see the complete live library.

See [the architecture](docs/architecture.md) and [threat model](docs/threat-model.md) before changing storage, validation, rendering, or hosting behavior.

Existing local users can follow the [remote migration guide](docs/remote-migration.md). Maintainers should use the [release checklist](docs/releasing.md); registry publication is not automatic.

## Development

Use Node.js 24 from the checkout root. Build or run the unit and integration tests:

```sh
corepack pnpm build
corepack pnpm test
```

Install Chromium before running the full verification gate:

```sh
corepack pnpm exec playwright install chromium
corepack pnpm verify
```

`verify` runs a clean build, unit and integration tests, Chromium browser tests, and the package smoke test. Named tests exercise validation, storage, static export determinism, Cloudflare command recording, remote-operation recovery, security headers, and escaping of untrusted metadata. The browser suite checks theme persistence, search, and document isolation. CI installs dependencies and builds with Node 24, then tests the CLI on Node 20 and 24 on Linux and Node 24 on Windows.

## License

MIT
