# Library selection and hub operation

Read this after resolving the `inbox` executable and before library commands. Examples use that selected prefix. Preserve the same selection and environment throughout the operation.

## Check capabilities before dispatch

Run `inbox --help` with the selected executable. Named inboxes, the local hub, the terminal picker, `inbox inbox list --running`, readable default output, and explicit JSON flags for viewer status/stop and service commands are available starting in 0.3.0. The intentionally pinned, published `html-inbox@0.2.2` fallback lacks them. A checkout may report the same version while providing different capabilities. Inspect the actual help for each command and flag the operation needs; a successful version check alone does not prove feature availability.

- Use `--inbox`, `--home`, `HTML_INBOX_NAME`, and catalog/default commands only when named selection is supported. If a requested named destination is unavailable, report that capability gap and stop the dependent operation. Keep the intended destination intact.
- Use `inbox inbox list --running --json` only when help advertises `--running` for catalog listing. Named commands alone do not establish this newer capability. If absent, report that native running-only discovery is unavailable.
- Use `inbox viewer status --json` and `inbox viewer stop --json` only when help advertises those flags. Legacy 0.2.x status/stop commands already emit JSON without a flag. With that older CLI, use `inbox viewer status` and `inbox viewer stop`, then parse their existing JSON. Do not add a new flag to a legacy command.
- Check `inbox viewer service status --json` independently of viewer status/stop. Use JSON flags on service commands only when help advertises them for that operation. Legacy service commands emit JSON without a flag; named commands or viewer JSON support alone do not prove service JSON support.
- Check `publish --json` separately before requesting a JSON publish receipt. Plain `publish` remains the URL-output path on both CLIs. `list --json` and `preferences --json` are separate capabilities; follow the appearance setup check for older CLIs without `preferences`.

For ordinary publishing with the legacy fallback, use its existing commands and an already intended `HTML_INBOX_HOME`, if configured. It does not implement named routing or the picker. Never let an unsupported `HTML_INBOX_NAME` silently become a legacy-home publish. Keep the tested fallback pin unchanged. Report the selected executable, missing capability, and whether the requested operation is available. Install or update only when the user authorizes it; a missing feature does not authorize an upgrade, deployment, or a different library.

## Select one destination

With named selection support, the CLI resolves one destination per operation from one catalog snapshot:

1. Explicit `--inbox NAME` or absolute `--home PATH`.
2. Process `HTML_INBOX_NAME` or `HTML_INBOX_HOME`.
3. Configured default name.
4. If there is no binding or default, offer a human terminal choice when the catalog has entries. Use the legacy home only when there are no registered entries.

An explicit tier overrides the whole environment tier. A name and home in the same tier must identify the same registered root. Relative `HTML_INBOX_HOME` retains its legacy meaning relative to the operation's working directory; `--home` requires an absolute path. Unknown names, missing or replaced registered roots, identity conflicts, and invalid defaults fail without fallback. An explicit or environment binding ignores an unused default, so deliberate recovery can still target a healthy library.

For an agent operation, keep an explicit selector on every library command, or preserve the process binding/default already chosen by the user:

```sh
inbox inbox list --json
inbox list --inbox development --json
inbox publish ./report.html --title "Build report" --type report --inbox development
```

To bind a shell to an existing named library, use `export HTML_INBOX_NAME=development` in Bash/zsh or `$env:HTML_INBOX_NAME = 'development'` in PowerShell. Keep any same-tier home consistent. Catalog inspection reports private local paths and viewer details; these are operator data, not reader handoff material.

## Handle an unbound operation

When registered entries exist but no selector, environment binding, or default applies, a human gets a picker only if stdin, stdout, and stderr are all TTYs and `--json` is absent. Enter the exact inbox name or `#N` for a displayed row, such as `#2`. A numeric name such as `123` selects that exact name; use the `#` prefix for a row choice. Use `:q`, Ctrl-C, or EOF to cancel without running the operation. The choice applies to that operation alone. It never updates a default, current inbox, or last-used inbox, even when only one library is registered.

Pipelines and any redirected stream, whether stdin, stdout, or stderr, disable the picker. Non-TTY agents and `--json` mode never prompt. A choice-required failure lists available names and explicit `--inbox` guidance on stderr, exits unsuccessfully, and leaves stdout empty. Treat it as an unresolved destination. Use the task's established destination if known, otherwise ask which listed library the user intends. Retry with that explicit selector after the destination is known. Do not pick by catalog order, running state, or the fact that there is only one entry.

Entries with missing, conflicting, or incompatible library roots stay visible but cannot be picked. Valid stopped libraries remain selectable. A valid root with a conflicting or incompatible standalone viewer can be selected for read-only work such as listing documents; that viewer state does not relax startup or shutdown verification. A picker choice still has to pass the operation's normal checks.

Picker inspection grants no reader network authority and creates or repairs no library storage. After waiting for input, the CLI revalidates the captured canonical home and expected UUID. It does not re-read a mutable name mapping to redirect the choice. If identity changes during the wait, preserve the failure and resolve a new operation deliberately.

With no registered entries, existing first-use behavior at `~/.html-inbox` remains. A named entry for that home participates in the same choice rules as every other entry.

## Choose machine output explicitly

On a CLI with the revised output support, status commands, catalog inspection, and document lists use human text or tables by default. Use their advertised `--json` forms for automation. JSON preserves the existing result fields and schemas. Inspect result state as well as exit code; viewer `conflict` or `incompatible` can be a successful inspection result.

JSON mode never prompts, including destructive confirmation. It does not imply consent: document deletion still requires `--force`, and remote revocation still requires `--yes`. Use those flags only for the authorized destructive operation.

```sh
inbox inbox list --running --json
inbox viewer status --inbox development --json
inbox viewer stop --inbox development --json
```

`inbox inbox list --running` includes only registered libraries whose running viewer passes private lifecycle verification. Stopped, missing, conflicting, and incompatible entries remain visible in the unfiltered catalog. Libraries absent from the catalog are never auto-discovered. Reader `/health` and remembered URLs do not prove process ownership or running state.

Plain `publish`, detached `viewer` startup, and foreground `hub` startup keep URL-only stdout. Named context, picker text, warnings, and diagnostics go to stderr. `viewer --foreground` keeps its existing listening diagnostic on stderr. When supported, `publish --json` returns the existing receipt fields including `url`, `inbox`, and `home`; take the reader URL from `url`. Use the exact successful URL in handoffs, and report no success URL after a failed command. Keep private control URLs and catalog paths out of reader links.

## Manage names and defaults deliberately

```sh
inbox inbox register home --home /absolute/path/to/existing-inbox
inbox inbox create development --home /absolute/path/to/new-inbox
inbox inbox default home
inbox inbox default --clear
```

Register an existing library in place; create a new root only for an intentional user-requested destination. Names bind canonical homes and durable UUIDs without moving documents. Ordinary artifact tasks reuse that destination. Another agent running does not justify a task-specific library or a default change.

Names use 1-63 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit; Windows reserved filenames are rejected. Registering requires an existing valid identity or a regular `documents/` directory and creates an identity for a legacy library when needed. Managed home leaf symlinks, replaced identities, and UUID copies at different registered locations fail validation.

The private per-user catalog lives at `~/.config/html-inbox`, independently of the library home. Preserve `HTML_INBOX_CATALOG_HOME` when set. Catalog and library storage require owner-restricted Windows ACLs; POSIX mode handling does not establish Windows privacy. If registration reports an abandoned `registration.lock`, stop all registration writers before removing only that stale lock according to the diagnostic. Catalog reads remain available; preserve entries and library files.

Setting a default affects future unbound operations. Clearing it restores the choice requirement when entries remain, and legacy-home first use when none remain. A malformed, stale, or unavailable default is a strict selection error. Clear it or reset it to a healthy registered name for a user-requested repair. Preserve healthy entries and documents; inspect an intended healthy library with an explicit selector while recovering the default. Never clear configuration merely to bypass a selection error.

Different standalone libraries need nonconflicting ports. Stop a verified viewer before changing its port or exposure. Naming or choosing a library preserves its saved mode, host, and port; omitted network options reuse them. The normal private control checks still govern reuse and stop. For elevated service administration, resolve the intended normal user's absolute home first and use that same home under elevation. Named libraries do not add multiple boot-service definitions.

A saved boot service may reference an older executable than the selected shell CLI. The revised service-status path requests JSON first and retries without `--json` only for the exact parser error `Unknown option '--json'`, preserving the existing normal-user privilege drop. Other failures remain failures. This compatibility path does not authorize replacing the service executable, changing its library, or bypassing private lifecycle checks.

## Read explicit local membership through a hub

For user-requested combined reading, check help for `hub init` and `hub`, then capture only the approved names in a new trusted local config:

```sh
inbox hub init --config /absolute/path/to/reading-hub.json \
  --name "My reports" --inbox home --inbox development
inbox hub --config /absolute/path/to/reading-hub.json --port 4322
```

`hub init` refuses to replace an existing config. It records each source's canonical home and expected UUID. Registering another library, choosing an inbox, or changing a default never adds a mount. Review new membership deliberately when the user asks to change it. The catalog is not an automatic list of hub mounts.

The foreground hub combines list/search results with source badges and a source filter. It namespaces document links by source name and original document ID. It reads files directly for the same OS account on the same machine, including sources with stopped or private standalone viewers. It creates no source directories, changes no source permissions or preferences, and copies no runtime records. Sources retain their own publish destination and viewer lifecycle.

Unavailable, identity-mismatched, or corrupt sources produce an incomplete-results notice while healthy sources stay readable. A corrupt committed record makes its source unavailable. Reader messages contain source names and generic availability; detailed filesystem causes go to the operator's stderr. Treat an incomplete hub result as a reading view, never an authoritative inventory for deletion or replication. Hub reads use `HTML_INBOX_MAX_BYTES`, default 10 MiB; preserve an intentionally larger limit for sources that need it.

The hub defaults to loopback port 3218 and runs until Ctrl-C. A requested LAN listener uses `--lan --host <this-machine-ip> --port <free-port>`. Every reachable reader can read every mount, regardless of source viewer exposure or filters. Filters are reading convenience, not access control. Live source-viewer and hub HTTP readers accept only GET and HEAD, with the existing Host validation, original bytes, sandbox, and CSP. Deletion remains a local CLI operation. A hub neither grants publishing/process-control authority nor configures Tailscale Serve or boot services. Preserve source saved modes and unrelated viewers/routes. Remote sources, ingestion, cross-account access, and network replication are outside this local feature.
