# Named inboxes and a local reading hub

Home, Development, and Office can be independent libraries with separate documents, viewer ports, preferences, exports, and exposure settings. Naming a library records its existing location. It does not move or combine documents.

This page describes unreleased named-inbox and hub work, including live single-document deletion and the revised terminal choice and output behavior. The published `html-inbox@0.2.1` package lacks these features. Check the actual executable's `--help` for the commands and flags you need, and the running viewer for **Delete...**; a source checkout can report the same version with different capabilities. Reading these docs or updating a skill does not install or deploy a CLI.

## Name libraries deliberately

Register an existing home in place, or create a new library explicitly:

```sh
html-inbox inbox register home --home /absolute/path/to/existing-inbox
html-inbox inbox create development --home /absolute/path/to/development-inbox
html-inbox inbox create office --home /absolute/path/to/office-inbox
html-inbox inbox list
```

Names use 1-63 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit. Windows reserved filenames are rejected. Each name binds a canonical absolute directory and its persisted `instance-id` UUID. Parent directory aliases resolve to the same location; managed home leaf symlinks are rejected. A copied UUID at another location does not make that directory the registered library. Missing paths and changed identities require deliberate local repair rather than automatic adoption.

Registration preserves existing records and creates an identity for an existing legacy library when needed. Creation initializes a new root; unknown names during ordinary use never create libraries. The private catalog lives at `~/.config/html-inbox`, independent of the selected library. `HTML_INBOX_CATALOG_HOME` selects another catalog, for example for tests. POSIX permissions protect catalog files; Windows requires owner-restricted ACLs as described in the [threat model](threat-model.md#windows-storage-prerequisites).

Registration requires an existing valid identity or a regular `documents/` directory. It checks library markers without scanning every stored report. Concurrent registrations serialize their name, root, and UUID claims and publish complete per-name records exclusively. If an interrupted writer leaves `registration.lock`, later writes fail after a bounded wait with recovery instructions. Stop every registration writer before removing only that stale lock. Catalog reads remain available.

`inbox list` shows a human-readable table of names, viewer states, and running reader URLs. `inbox list --json` preserves the machine-readable result fields, including local locations. Stopped libraries stay registered. Missing, conflicting, and incompatible libraries remain visible.

To list only registered libraries with verified running viewers:

```sh
html-inbox inbox list --running
html-inbox inbox list --running --json
```

Running state comes from private lifecycle checks, never anonymous reader health or catalog URLs. Libraries that have not been registered are not auto-discovered. `--running` filters viewer state; it does not choose a publishing destination.

## Select a publishing destination

Every library command accepts `--inbox NAME` or `--home ABSOLUTE_PATH`, including publish, list, preferences, delete, export, remote operations, viewer status/stop, and service administration:

```sh
html-inbox publish ./report.html --title "Build report" --type report --inbox development
html-inbox list --inbox development --json
html-inbox viewer status --inbox development
html-inbox preferences --inbox office --appearance dark
```

The CLI resolves selection once per operation, in this order:

1. Explicit `--inbox` / `--home` options.
2. Process-bound `HTML_INBOX_NAME` / existing `HTML_INBOX_HOME`.
3. The configured default name.
4. With no binding or default, a human terminal choice if the catalog has entries; legacy `~/.html-inbox` only when there are no registered entries.

An explicit selection overrides the entire environment selection tier. A name and home supplied together in one tier must identify the same registered location. Unknown names, missing registered homes, invalid identities, and invalid selected defaults fail without falling back. Explicitly or process-bound operations do not read an unused default. Explicit homes must be absolute. Relative `HTML_INBOX_HOME` retains its legacy interpretation relative to the command's working directory. There is no mutable current or last-used inbox and no project binding in this version.

### Choose once in a human terminal

When the catalog has entries and no binding or default applies, a picker appears only when stdin, stdout, and stderr are all TTYs and `--json` is absent. Type an exact inbox name or `#N` for a displayed row, such as `#2`, to choose that inbox for this operation. Numeric names remain exact names, so `123` chooses an inbox named `123`; a row choice uses the `#` prefix. Use `:q`, Ctrl-C, or EOF to cancel without running the operation. Even a single registered entry requires a choice. The pick never changes a default or saves a current inbox.

Pipelines and redirecting any individual stream, including stdin, stdout, or stderr, disable the picker. Non-TTY callers and `--json` never prompt. An unbound operation fails with available names and explicit `--inbox` guidance on stderr, leaving stdout empty. Agents and scripts should use their intended explicit selector, process binding, or configured default. If the destination is unknown, ask the user which library to use before retrying. Do not select an arbitrary entry or create a new library for each task.

Missing, conflicting, or incompatible library roots remain visible but cannot be picked. Valid stopped libraries are selectable. A valid library whose viewer is conflicting or incompatible can still be chosen for read-only operations such as document listing. Startup and stop retain their private ownership checks; picker selection cannot authorize controlling an unverified viewer.

Selection uses one catalog snapshot. After a terminal wait, the CLI revalidates the captured canonical home and expected UUID rather than re-reading the name to retarget the operation. A changed identity fails. Picker inspection does not create missing libraries, change source permissions, or grant reader network authority.

With no registered entries, legacy-home first use keeps its existing behavior. Once `~/.html-inbox` is registered, it follows the same selection and identity rules as every other named entry. A missing or replaced registered home fails instead of becoming a new library.

### Bind agents and scripts explicitly

For a thread that should always publish to Development, bind its process environment:

```sh
export HTML_INBOX_NAME=development
```

In PowerShell, use `$env:HTML_INBOX_NAME = 'development'`. Keep that environment or explicit selector for the whole operation, including preferences, publish, export, remote operations, and viewer status/stop. Preserve any same-tier home binding consistently.

Human status, catalog, and document-list output uses text or tables. Opt into `--json` to retain the existing result fields and schemas for automation:

```sh
html-inbox viewer status --inbox development --json
html-inbox viewer stop --inbox development --json
```

Check help for each command and flag before using them with an older CLI. Legacy viewer status/stop and service commands already output JSON without `--json`; do not pass a new flag to them. Check service JSON flags independently of viewer JSON flags, and the running-only filter independently of named commands. The picker and revised flags require actual capability checks rather than a package-version assumption. If the required feature is absent, report its availability and preserve the intended destination. A missing capability does not authorize an upgrade or a publish into another home.

JSON mode also suppresses destructive confirmation prompts. It does not imply approval: automated CLI deletion still requires `--force`, and remote revocation still requires `--yes`.

Named context and picker text go to stderr, preserving URL-only stdout for plain `publish`, detached viewer startup, and hub startup. `publish --json` returns the existing receipt with `url`, `inbox`, and `home`. Viewer status includes the configured name, and newly started viewers show it in the heading. Share the exact verified reader URL, keeping catalog paths and private control details local.

An optional default affects unbound future operations:

```sh
html-inbox inbox default home
html-inbox inbox default --clear
```

Setting a default changes future unbound operations only. Clearing it restores the one-operation picker in eligible terminals, or choice-required failure for automation, when entries remain. Legacy-home first use applies only with no entries. If the default is malformed, stale, or unavailable, clear it or set a healthy named inbox again as a deliberate repair. Explicit or process-bound operations can still target a healthy library while recovering the default. Picking another library never performs this repair implicitly.

Library ports still need to differ. Configure a new viewer on a free port explicitly, then ordinary publishes reuse its saved configuration:

```sh
html-inbox viewer --inbox development --port 4321
```

If another library owns a listener, startup refuses it. Stop a verified viewer before changing its existing exposure, port, or host. Naming a library never changes saved exposure. Existing viewers keep the heading loaded when they started; restart through the normal verified lifecycle to load a newly configured name.

Service administration uses the catalog of the account running the CLI. With elevated `--user` operations, prefer an explicit absolute `--home` resolved as the normal user before elevation. Unconfigured legacy service commands retain their normal-user home behavior. Boot definitions retain their existing fixed service names; named libraries do not add multiple boot-service administration.

A saved service may still reference an older CLI. The revised service-status check requests JSON first, then retries without `--json` only for the exact parser error `Unknown option '--json'`. Both attempts retain the existing normal-user privilege drop. Other errors remain failures; this compatibility retry does not change service executables or ownership checks.

## Read selected libraries together

Create a separate trusted local hub config with explicit mounts:

```sh
html-inbox hub init --config /absolute/path/to/reading-hub.json \
  --name "My reports" --inbox home --inbox development
html-inbox hub --config /absolute/path/to/reading-hub.json --port 4322
```

`hub init` refuses to replace an existing config. It captures each selected library's canonical home and expected UUID. Adding another catalog entry or changing a default does not change hub membership. Review a new configuration deliberately when membership should change.

The hub serves one combined list and search over all selected inboxes, with inbox badges and a source filter. Document links contain the source name plus original document ID, so identical IDs in different libraries remain distinct. Content routes return the original bytes through the existing sandbox and CSP. Standalone viewer and export URLs retain their existing forms.

Every reachable live hub reader can permanently delete individual documents from every mounted inbox. Choose **Delete...** on a list row or in document options. The modal shows the title, filename, and source inbox, explains permanent deletion, and defaults to Cancel. There is no Undo or bulk deletion. The original source file, existing exports, and remote snapshots remain unchanged. Static exported or hosted snapshots are read-only independent copies with no live viewer credentials.

Source viewers may be stopped. The hub reads existing files directly without creating directories, changing permission modes, writing preferences, or copying runtime records. Each source has an explicitly bound deletion writer for its captured canonical root, expected UUID, and filesystem identity, under the same OS account. It revalidates that binding before deleting, rather than resolving a mutable catalog name or accepting a target path from the browser. A missing or replaced source fails without creating a new library or targeting another source.

Unavailable or mismatched sources produce an incomplete-results notice while healthy sources remain readable. Reader output contains selected source names and availability, without catalog paths, control endpoints, or detailed filesystem errors. The foreground hub writes source names and detailed failure causes to stderr for operator diagnosis. Deletion renames a record out of its source library before purging it. If purge fails, the record is already absent and the cleanup failure is reported.

A corrupt committed record makes its source unavailable rather than presenting a partial source as complete. Hub content reads use `HTML_INBOX_MAX_BYTES`, default 10 MiB per document. Set the same larger limit when reading libraries that were intentionally published with a larger limit. An incomplete result is not a complete inventory for cleanup or replication; deletion of a specific document still validates its bound source and document identity.

The hub runs in the foreground until Ctrl-C. Its default listener is loopback port 3218. Multiple hubs and standalone viewers can run on distinct listeners. A hub does not choose publication destinations or own the mounted libraries' lifecycle.

LAN exposure is a separate explicit choice:

```sh
html-inbox hub --config /absolute/path/to/reading-hub.json --lan --host 192.168.1.20 --port 4322
```

Everyone who reaches that hub can read and delete documents in every selected library, even if its standalone viewer is stopped or private. Filtering is reading convenience, not access control. Deletion is enabled by default without a startup grant, login, or network-mode restriction. The owner's chosen network determines reader trust. Host validation, a process-scoped CSRF token and matching Origin, and live-shell `frame-ancestors 'none'` protect deletion requests without adding reader roles. Publishing, membership changes, process control, and service administration remain local operations.

This version does not configure Tailscale Serve or boot services for hubs. Existing Tailscale routes and source viewers' saved modes remain independent. If a live hub is reachable through an owner-configured route, its readers have the same deletion authority as readers on loopback or LAN.

Only libraries accessible to the same OS account on the same machine are supported. Network replication, other accounts, remote ingestion, and migration of historical fragments are outside this version.
