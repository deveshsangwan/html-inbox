# Named inboxes and a local reading hub

Home, Development, and Office can be independent libraries with separate documents, viewer ports, preferences, exports, and exposure settings. Naming a library records its existing location. It does not move or combine documents.

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

`inbox list --json` reports private local locations and verified viewer state. Stopped libraries stay registered. Missing, conflicting, and incompatible libraries remain visible. Running state comes from the private lifecycle checks, never anonymous reader health or catalog URLs.

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
4. Legacy `~/.html-inbox` when no selection or default is configured.

An explicit selection overrides the entire environment selection tier. A name and home supplied together in one tier must identify the same registered location. Unknown names, missing registered homes, invalid identities, and invalid defaults fail without falling back. Explicit homes must be absolute. Relative `HTML_INBOX_HOME` retains its legacy interpretation relative to the command's working directory. There is no mutable current or last-used inbox and no project binding in this version.

For a thread that should always publish to Development, bind its process environment:

```sh
export HTML_INBOX_NAME=development
```

Keep that environment or explicit selector for the whole operation. Named receipts go to stderr, preserving URL-only stdout for `publish` and viewer startup. `publish --json` returns a receipt with the resolved inbox, home, and URL. Viewer status includes the configured name, and newly started viewers show it in the heading.

An optional default affects unbound future operations:

```sh
html-inbox inbox default home
html-inbox inbox default --clear
```

Library ports still need to differ. Configure a new viewer on a free port explicitly, then ordinary publishes reuse its saved configuration:

```sh
html-inbox viewer --inbox development --port 4321
```

If another library owns a listener, startup refuses it. Stop a verified viewer before changing its existing exposure, port, or host. Naming a library never changes saved exposure. Existing viewers keep the heading loaded when they started; restart through the normal verified lifecycle to load a newly configured name.

Service administration uses the catalog of the account running the CLI. With elevated `--user` operations, prefer an explicit absolute `--home` resolved as the normal user before elevation. Unconfigured legacy service commands retain their normal-user home behavior. Boot definitions retain their existing fixed service names; named libraries do not add multiple boot-service administration.

## Read selected libraries together

Create a separate trusted local hub config with explicit mounts:

```sh
html-inbox hub init --config /absolute/path/to/reading-hub.json \
  --name "My reports" --inbox home --inbox development
html-inbox hub --config /absolute/path/to/reading-hub.json --port 4322
```

`hub init` refuses to replace an existing config. It captures each selected library's canonical home and expected UUID. Adding another catalog entry or changing a default does not change hub membership. Review a new configuration deliberately when membership should change.

The hub serves one combined list and search over all selected inboxes, with inbox badges and a source filter. Document links contain the source name plus original document ID, so identical IDs in different libraries remain distinct. Content routes return the original bytes through the existing sandbox and CSP. Standalone viewer and export URLs retain their existing forms.

Source viewers may be stopped. The hub reads existing files directly without creating directories, changing permission modes, writing preferences, or copying runtime records. A missing source never becomes a new empty library. Unavailable or mismatched sources produce an incomplete-results notice while healthy sources remain readable. Reader output contains selected source names and availability, without catalog paths, control endpoints, or detailed filesystem errors.

A corrupt committed record makes its source unavailable rather than presenting a partial source as complete. Hub content reads use `HTML_INBOX_MAX_BYTES`, default 10 MiB per document. Set the same larger limit when reading libraries that were intentionally published with a larger limit. These source results are a reading view, not an authoritative inventory for deleting or replicating documents.

The hub runs in the foreground until Ctrl-C. Its default listener is loopback port 3218. Multiple hubs and standalone viewers can run on distinct listeners. A hub does not choose publication destinations or own the mounted libraries' lifecycle.

LAN exposure is a separate explicit choice:

```sh
html-inbox hub --config /absolute/path/to/reading-hub.json --lan --host 192.168.1.20 --port 4322
```

Everyone who reaches that hub can read every selected library, even if its standalone viewer is stopped or private. Filtering is reading convenience, not access control. This version does not configure Tailscale Serve or boot services for hubs. Existing Tailscale routes and source viewers' saved modes remain independent.

Only libraries accessible to the same OS account on the same machine are supported. Network replication, other accounts, remote ingestion, and migration of historical fragments are outside this version.
