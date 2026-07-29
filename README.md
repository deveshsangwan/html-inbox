# HTML Inbox

HTML Inbox is a local library for generated HTML reports, notes, and dashboards. The CLI validates and stores each document, then opens it through a loopback-only viewer with an isolated document frame and a restrictive Content Security Policy.

The current release is local-only. The accepted remote design publishes complete static snapshots to a user-owned Cloudflare Pages project; the local viewer and its administrative capabilities remain private to the machine running the CLI. See [ADR 0001](docs/adr/0001-static-remote-inbox.md).

## Requirements

- Node.js 20 or newer
- Corepack

## Set up a source checkout

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
corepack pnpm html-inbox publish ./examples/report.html \
  --title "Quarterly migration report" \
  --type report
```

The command stores the original HTML under `~/.html-inbox`, starts or reuses the local viewer, and prints the document URL. Set `HTML_INBOX_HOME` to use an isolated library or `HTML_INBOX_PORT` to choose another loopback port.

HTML documents are limited to 10 MiB by default. Set `HTML_INBOX_MAX_BYTES` to a positive byte count when a deliberate workflow needs a different limit.

Run the viewer directly when you want it to remain attached to the terminal:

```sh
corepack pnpm html-inbox viewer
```

Manage the local library and viewer:

```sh
corepack pnpm html-inbox list
corepack pnpm html-inbox delete <document-id>
corepack pnpm html-inbox viewer status
corepack pnpm html-inbox viewer stop
```

Use `--json` with `list` or `delete` for automation. Non-interactive deletion requires `--force`. The viewer also supports server-rendered search across title, type, and source file name.

## Supported HTML

HTML Inbox accepts UTF-8 `.html` and `.htm` files. It rejects inline event-handler attributes and external URLs except for the explicitly supported Tailwind browser and Mermaid v11 script entry points. Accepted HTML is still untrusted: validation is a compatibility and policy gate, not sanitization.

Documents render inside an iframe sandbox without `allow-same-origin`. Do not open stored document files directly in a browser and do not expose the viewer port to a LAN, VPN, container wildcard mapping, or public interface.

See [the architecture](docs/architecture.md) and [threat model](docs/threat-model.md) before changing storage, validation, rendering, or hosting behavior.

## Development

```sh
corepack pnpm build
corepack pnpm test
corepack pnpm verify
```

`verify` is the same clean build-and-test gate used by continuous integration. Package self-checks exercise validation, storage, security headers, iframe isolation, theme behavior, and escaping of untrusted metadata.

## License

MIT
