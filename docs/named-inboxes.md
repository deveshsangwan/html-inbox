# Named inboxes and a local reading hub

Home, Development, and Office can be independent libraries with separate documents, viewer ports, preferences, exports, and exposure settings. Naming a library records its existing location. It does not move or combine documents.

Named inboxes, the terminal picker, readable command output, and local hubs are available in 0.3.0. The published `html-inbox@0.5.0` skill fallback supports these features, copying and live-reader deletion, but no managed sync. Version 0.5.0 adds permanent single-document deletion for all reachable live readers. UI deletion requires a running supporting reader, including 0.5.x and 0.6.x. Check the actual executable's `--help` for the commands and flags you need; help is authoritative for a source checkout or older executable. Reading these docs or updating a skill does not install or deploy a CLI.

## Upgrade to 0.6.0

Installing 0.6.0 preserves ordinary unenrolled libraries and does not enroll, connect or supervise them. Managed sync is a separate per-inbox format upgrade on supported local POSIX filesystems on Linux/macOS. Ordinary Windows libraries remain supported; managed Windows enrollment is rejected before mutation. Every live reader still has the deletion authority introduced in 0.5.0.

Before enrollment, review the intended named home and UUID, stop older writers and readers with their original executable, and verify shutdown. Include hubs mounting that inbox and undiscoverable automation. Enrollment can retain a verified capable viewer only under the [enrollment contract](phase2-sync/worker-operations.md); an older or ambiguous reader blocks migration. Stop and join the independent sync worker, every viewer, mounted hub and writer before making a consistent backup. Reader shutdown alone leaves the worker running.

```sh
html-inbox sync enroll --inbox research --yes --json
```

Run this only for an authorized format upgrade. Enrolled storage uses a regular-file legacy barrier, managed ledger schema 1 and ownership schema 2. These schema numbers describe different interfaces. Coordinate all CLI, writer and worker versions against those interfaces; shared viewer control protocol 3 does not prove managed-format compatibility. Use the same new runtime for ordinary writes and independent workers after enrollment. Publication alone does not install or upgrade any running process.

Routes, approved origin scopes, peer and destination UUIDs, credentials, CA files and TLS keys must be configured explicitly at the endpoints. There is no automatic pairing, certificate discovery, firewall/Tailscale change or service installation. A detached worker is not boot supervision; the operator must review and install the separate supervisor definition deliberately. See [worker operations](phase2-sync/worker-operations.md) and the exact [runtime and mapping formats](phase2-sync/worker-interface.md).

Managed publishing preserves a durable local report and its intended-server obligation even when delivery is pending, blocked or cancelled. JSON `local.durable`, `delivery`, `worker` and `viewer.url` separate those outcomes; nonzero delivery status does not authorize another publish or destination. Deleting a local original signs terminal state for authorized copies when they reconnect. Deleting an imported copy suppresses it only locally. Bodies remain retained: there is no disk-reclamation, general orphan cleanup or secure-erasure guarantee. Static/cloud exports include eligible local originals only; synced, detached and fork-inherited reports remain excluded.

There is no in-place downgrade or unenroll command. An older CLI must not write an enrolled home. Keep a quiescent pre-enrollment backup if offline rollback is needed, and preserve post-enrollment work separately before choosing that rollback. Copied, moved or restored managed homes can enter quarantine; inspect them and use explicit quarantine/fork with the expected old UUID. A fork creates a new identity for future originals while inherited records remain detached imports. Trusted old-owner recovery and indistinguishable full-restore detection are not provided. Read the [restore and fork procedure](phase2-sync/worker-operations.md#offline-copies-restore-quarantine-and-fork), rather than deleting barriers or ownership records to force an older runtime through.

## Upgrade to 0.5.0

Upgrading a 0.2.x, 0.3.x, or 0.4.x live reader to 0.5.0 changes permissions on restart. Every reachable loopback, LAN, and Tailscale reader can permanently delete individual documents. Every live hub reader gains deletion authority over every mounted inbox, including stopped or privately served sources. Filters do not restrict it. Deletion is always available in 0.5.x. Publishing, process control, exposure changes, and hub membership remain local CLI operations. Original source files and existing exports or remote snapshots remain unchanged; static copies remain read-only.

Before an authorized upgrade, review saved exposure and the hub's frozen name/home/UUID membership to understand who gains deletion authority. Stop each old viewer with its original executable and the same inbox binding. Inspect status to verify shutdown, using `--json` only when that executable supports it. Stop foreground viewers and hubs with Ctrl-C. Retain the old installation until shutdown is confirmed, then upgrade and restart the intended viewers and hubs. Existing session authorization covers these steps when it includes the permission change. For boot services, follow the [service update instructions](../site/docs/boot-services.html#updating) with the same intended account, home, and exposure.

Versions 0.2.x through 0.6.x share private control protocol 3. Updating an executable does not reload compatible running viewers. Restart each authorized viewer and hub to load 0.5.0. The skill fallback remains pinned to published 0.5.0 with deletion but no managed sync. Package publication does not upgrade a running installation.

## Upgrade from 0.2.x

Before upgrading, stop the old viewer with the executable that started it and confirm shutdown. Stop a foreground viewer with Ctrl-C. For a boot service, uninstall with the old stable installation, update, and reinstall with the same intended home and exposure. See [service updates](../site/docs/boot-services.html#updating). Versions 0.2.x, 0.3.x, 0.4.x, 0.5.x, and 0.6.x share private control protocol 3. Restart compatible viewers to load the new code and named headings; 0.1.0 viewers still need their original executable for shutdown. Documents, preferences, and saved exposure remain in place.

Update human and agent automation deliberately:

- Add `--json` to viewer status/stop and service commands when parsing output. Plain status, catalog, and document lists are readable text or tables in 0.3.0. Unenrolled plain publish and detached viewer startup retain URL-only stdout; `publish --json` adds a structured receipt.
- Keep an explicit `--inbox`, absolute `--home`, process environment binding, or configured default across every command in a job. Registering even one library makes unbound automation fail instead of silently using the legacy home. Redirected streams and JSON mode never open the picker.
- With no registered entries and no binding or default, legacy `~/.html-inbox` behavior remains. To name that existing library, register its absolute path in place, then update jobs to select it. Registration does not move documents or change saved network exposure.
- Skill updates and CLI updates remain independent. The skill accepts stable installed 0.2.x, 0.3.x, 0.4.x, 0.5.x, and 0.6.x executables, with exact rules in the [CLI resolution reference](../skills/html-inbox/references/cli-resolution.md). Its fallback stays on published `html-inbox@0.5.0` until deliberately changed. Check actual help before using named selection, running-only filtering, publish JSON, viewer JSON, or service JSON. Missing capabilities never authorize publishing into another home or silently upgrading the pin.

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

`inbox list` inspects the catalog and source lifecycle read-only, without creating missing paths, tightening permissions, refreshing saved LAN URLs, or repairing records. It shows a human-readable table of names, viewer states, and running reader URLs. `inbox list --json` preserves the machine-readable result fields, including local locations. Stopped libraries stay registered. Missing, conflicting, and incompatible libraries remain visible.

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

In 0.3.0, viewer status/stop and service commands use readable text by default. Add `--json` when updating scripts that parsed their 0.2.x default JSON. Check help before using a flag with an older CLI. Published 0.2.x viewer status/stop and service commands output JSON without `--json`; do not pass that unsupported flag to them. Check service JSON flags independently of viewer JSON flags, and the running-only filter independently of named commands. The picker and revised flags require actual capability checks rather than a package-version assumption. If the required feature is absent, report its availability and preserve the intended destination. A missing capability does not authorize an upgrade or a publish into another home.

JSON mode also suppresses destructive confirmation prompts. It does not imply approval: automated CLI deletion still requires `--force`, and remote revocation still requires `--yes`.

Named context and picker text go to stderr. Unenrolled plain `publish`, detached viewer startup and hub startup keep URL-only stdout. Unenrolled `publish --json` returns `url`, `inbox` and `home`. Managed publication reports durable local storage, intended-server delivery and viewer readiness separately; JSON uses `viewer.url` and includes `local.durable`, document identity, delivery, worker and onward state. Exit 0 is confirmed or unconfigured local-only, 2 durable pending, 3 durable blocked, and 130 cancellation after save when a saved result is present. Preserve the report, intended target and obligations; do not duplicate-publish or choose a new destination because delivery is nonzero. Exit 1 or missing saved evidence requires inspection of persistence uncertainty before retrying. Viewer status includes the configured name. Share only the actual reader URL and keep private control details local.

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

`hub init` requires an existing canonical parent directory for its absolute config path and refuses to replace an existing config. Protect that file and its parent because it contains local source paths. Configurations accept 1-128 explicit sources with unique names, homes, and UUIDs. It captures each selected library's canonical home and expected UUID. Adding another catalog entry or changing a default does not change hub membership. Review a new configuration deliberately when membership should change.

The hub serves one combined list and search over all selected inboxes, with inbox badges and a source filter. Document links contain the source name plus original document ID, so identical IDs in different libraries remain distinct. Content routes return the original bytes through the existing sandbox and CSP. Standalone viewer and export URLs retain their existing forms.

Every reachable live hub reader can permanently delete individual documents from every mounted inbox. Choose **Delete** in a list row's three-dot menu or in document options. The modal shows the title, filename, and source inbox, explains permanent deletion, and defaults to Cancel. There is no Undo or bulk deletion. The original source file, existing exports, and remote snapshots remain unchanged. Static exported or hosted snapshots are read-only independent copies with no live viewer credentials.

For an inbox enrolled in managed sync, deleting an original also propagates deletion to its authorized copies when they reconnect. Deleting a received copy hides it only in the selected inbox. Saved bytes remain retained, so managed deletion does not free disk space. Existing exports and hosted snapshots stay independent.

Source viewers may be stopped. The hub reads existing files directly without creating directories, changing permission modes, writing preferences, or copying runtime records. Each source has an explicitly bound deletion writer for its captured canonical root, expected UUID, and filesystem identity, under the same OS account. It revalidates that binding before deleting, rather than resolving a mutable catalog name or accepting a target path from the browser. A missing or replaced source fails without creating a new library or targeting another source.

Unavailable or mismatched sources produce an incomplete-results notice while healthy sources remain readable. Reader output contains selected source names and availability, without catalog paths, control endpoints, or detailed filesystem errors. The foreground hub writes source names and detailed failure causes to stderr for operator diagnosis. Unenrolled deletion renames a record out before purging its files; a purge failure is reported after that record is absent. Managed deletion signs origin terminal state or suppresses an imported copy locally while retaining bodies, as described above.

For unenrolled inboxes, deletion uses a short-lived Node helper whose working directory is the captured source root, with relative mutation paths. Private per-document locks coordinate CLI, standalone viewer, and hub deletions. An interrupted operation can leave a `documents/.trash/.delete-<sha256(id)>.lock` file, or quarantined document data after removal. No stale lock is removed automatically. Stop HTML Inbox viewers, hubs, and CLI deletion commands that can write to the affected inbox, confirm no deletion is running, then remove only the lock named in private diagnostics and retry. Preserve other trash and source files; a partially purged record is not a restorable backup.

A corrupt committed record makes its source unavailable rather than presenting a partial source as complete. Hub content reads use `HTML_INBOX_MAX_BYTES`, default 10 MiB per document. Set the same larger limit when reading ordinary libraries intentionally published with a larger input limit. This setting cannot raise managed storage's fixed 10 MiB body cap or the separate 10 MiB encoded copy-JSON cap. An incomplete result is not a complete inventory for cleanup or replication; deletion of a specific document still validates its bound source and document identity.

The hub runs in the foreground until Ctrl-C. Its default listener is loopback port 3218. Multiple hubs and standalone viewers can run on distinct listeners. A hub does not choose publication destinations or own the mounted libraries' lifecycle.

LAN exposure is a separate explicit choice:

```sh
html-inbox hub --config /absolute/path/to/reading-hub.json --lan --host 192.168.1.20 --port 4322
```

Everyone who reaches that hub can read and delete documents in every selected library, even if its standalone viewer is stopped or private. Filtering is reading convenience, not access control. Deletion is enabled by default without a startup grant, login, or network-mode restriction. The owner's chosen network determines reader trust. Host validation, a process-scoped CSRF token and matching Origin, and live-shell `frame-ancestors 'none'` protect deletion requests without adding reader roles. Publishing, membership changes, process control, and service administration remain local operations.

This version does not configure Tailscale Serve or boot services for hubs. Existing Tailscale routes and source viewers' saved modes remain independent. If a live hub is reachable through an owner-configured route, its readers have the same deletion authority as readers on loopback or LAN.

The local hub supports only libraries accessible to the same OS account on the same machine. On POSIX, source directories and files must belong to the current account. Windows source checks do not establish ACL privacy; protect source trees, the catalog, and hub config under the [Windows storage prerequisites](threat-model.md#windows-storage-prerequisites). Network replication, other accounts, remote ingestion, and migration of historical fragments are outside the local hub. [Opt-in managed sync](#upgrade-to-060) provides separate replication through explicitly authorized routes.
