# Changelog

All notable changes to HTML Inbox will be documented here.

## 0.6.0 - 2026-10-28

- Add opt-in POSIX managed inbox enrollment with signed origin history, explicit authenticated HTTPS routes, intended-server custody receipts, push, pull and approved relay.
- Run synchronization in an independently owned worker with durable obligations, bounded retries/backoff, explicit pause/retry, credential freshness and sanitized fatal-stop reporting. Viewer shutdown does not stop synchronization. Boot supervision remains a manual operator operation.
- Distinguish durable local publication from delivery and viewer readiness. Managed human output is multiline; JSON has `local.durable`, `delivery`, `worker` and `viewer.url`. Exit 2 means durable pending, 3 durable blocked, and 130 cancellation after save when a saved result is present. Saved work and its intended target remain intact.
- Sign terminal deletion for managed local originals and suppress imported copies only in their destination. Retain payload bodies with no disk-reclamation or secure-erasure guarantee. Preserve ordinary unenrolled purge behavior and existing static copies.
- Restrict public static/cloud exports to eligible local originals, excluding synced imports, detached imports and fork-inherited originals. Reading or relaying a copy grants no public republication authority.
- Bind managed writers to canonical home, filesystem identity and inbox UUID; publish ownership atomically, check stale ledger generations safely, drain admitted mutations/watchers before shutdown, and preserve unsafe/unknown authority failures.
- Support explicit copied-home quarantine and fork while retaining provenance. Keep reader deletion, sandbox/CSP, named selection, Tailscale route ownership and ordinary Windows behavior.
- Use bounded native HTTP for private viewer health, including rejected HTTP upgrades, and wait within the existing deadline for direct Windows portable-reaper read-open denial. Preserve other operational and compound cleanup errors.
- Correct public output, export, deletion, migration and release guidance. Both skills accept installed stable 0.6.x and retain a published, verified 0.5.0 preparation fallback, which has no managed-sync commands.

### Upgrade to 0.6.0

Ordinary installation does not enroll a library. Read the [opt-in migration and rollback limits](docs/named-inboxes.md#upgrade-to-060) before `sync enroll`. Stop older writers/readers through their original executable and make a quiescent backup, including the independent worker and mounted hubs. Managed enrollment is POSIX-only. Ownership schema 2 and managed ledger schema 1 require coordinated CLI/writer/worker compatibility; viewer control protocol 3 alone is insufficient.

There is no in-place downgrade or unenroll operation. An older runtime must not write an enrolled home. Keep an offline pre-enrollment backup for an explicit rollback. Copied or restored homes can require quarantine and a fresh fork; inherited reports remain detached imports. Trusted old-owner recovery, general orphan/body reclamation, indistinguishable restore detection and universal power-loss recovery are not provided. Explicit routes, credentials, TLS and manual supervision remain operator responsibilities.

The final focused physical follow-up passed 257/257 application checks on the preceding exact e42f2f5 head. Its original observer-wrapper failures remain separately qualified; the full transport/crash/liveness matrix was not repeated. Earlier failed and interrupted receipts remain historical evidence. Final 0.6.0 source verification and independent documentation reviews are recorded in the release audit.

## 0.5.0 - 2026-10-25

- Add permanent single-document deletion to live list-row menus and document options, with a confirmation naming the title, filename, and inbox and defaulting to Cancel. There is no Undo or bulk deletion.
- Give every reachable live loopback, LAN, Tailscale, and hub reader deletion authority. Hub readers can delete from every mounted inbox, regardless of filters or standalone viewer exposure. Publishing, process control, and hub membership remain local CLI operations.
- Protect live requests with process-scoped CSRF tokens, matching Origin, Host validation, and `frame-ancestors 'none'`. Preserve the original document sandbox, CSP, and bytes.
- Bind hub deletion to each captured canonical root, inbox UUID, and filesystem identity. Revalidate the source and use a root-bound helper and per-document lock; fail on unavailable or replaced sources without creating storage or choosing another target.
- Remove the record from the live library before purging its files, and report a cleanup failure accurately when the record is already absent. Preserve original source files and existing exports and remote snapshots. Static copies remain read-only and contain no live deletion controls or viewer credentials.
- Retain 0.4.0 copy controls and their selectable-text fallback, named inbox and JSON behavior, Windows catalog locks, and shutdown diagnostics. Accept stable installed 0.5.x CLIs in both skills, alongside 0.2.x through 0.4.x, with the published and verified 0.4.0 fallback.

### Upgrade to 0.5.0

This is a permission change for live readers upgrading from 0.2.x, 0.3.x, or 0.4.x. After restart on 0.5.0, every reachable reader can permanently delete documents on every live exposure and every hub mount. Deletion is always available, and filters do not limit its authority. Before an authorized upgrade, review saved exposure and frozen hub membership to understand who gains deletion authority. See the [upgrade instructions](docs/named-inboxes.md#upgrade-to-050).

Stop old viewers with their original verified CLI and the same library binding, and confirm shutdown before installing the update. Use Ctrl-C for foreground viewers and hubs. Retain the old executable until shutdown is verified; follow the existing service update workflow for boot installations. Versions 0.2.x through 0.5.x share private control protocol 3, but installing an executable does not reload a running viewer. Stored documents, preferences, and saved exposure persist. Publishing and process control stay in the CLI. Original source files and existing static copies remain unchanged, and static snapshots stay read-only.

Package publication and upgrading a running installation are separate operations. The skills keep their fallback pinned to published 0.4.0, which includes reader copying and named inboxes but has no UI deletion.

## 0.4.0 - 2026-10-25

- Add Viewer options → Copy content for saved document text, selected passages in the dialog, and individual preformatted code blocks as plain text.
- Preserve parsed code whitespace and useful paragraph, list, table-cell/row, and line-break boundaries. Explain that saved extraction can differ from live or CSS-hidden content.
- Keep native preview Copy available and provide selectable text when automatic clipboard access is unavailable or denied, including ordinary HTTP LAN readers.
- Share bounded parse5 extraction across read-only local and source-qualified hub resources and new static snapshots. Preserve original HTML bytes, document sandbox/CSP, source isolation, and preview state.
- Include each static document's copy JSON in the hashed inventory and apply its JSON response type. Each document adds one upload file against provider limits.
- Accept stable installed 0.4.x CLIs in both skills, retaining earlier supported lines and the already-published 0.3.0 npm fallback.
- Retry unlinked catalog metadata observed during atomic default replacement while preserving regular-file, hardlink, and read-only safety checks.

### Upgrade to 0.4.0

No additional CLI, permission, or control-protocol migration is required from 0.3.x. The 0.3.0 explicit JSON and library-selection requirements remain in effect. Versions 0.2.x, 0.3.x, and 0.4.x share private control protocol 3. Restart an existing viewer through its verified lifecycle after an authorized CLI update to load the copy interface; installing a new executable does not reload a running viewer. Stored documents and saved exposure remain unchanged. Stop a 0.1.x viewer with its original executable before upgrading.

Existing static deployments retain their previous interface until their owner regenerates and publishes a snapshot. New snapshots contain a sibling `copy.json` per document, so libraries reach provider file limits sooner. Copying changes the reader's clipboard, not an inbox. The hub and exposed browser readers remain read-only. HTML source, Markdown, rich HTML, live rendered extraction, browser deletion, and inbox replication are not added by this release.

## 0.3.0 - 2026-10-25

- Add intentionally named independent inboxes with a private per-user catalog, in-place registration, explicit creation, and durable location/identity validation.
- Resolve a library once per operation using explicit selectors, process-bound environment, then an optional configured default. There is no shared current or last-used inbox.
- Offer a one-operation terminal picker when named inboxes exist without a binding or default. Scripts and JSON mode fail with selector guidance instead of prompting; an empty catalog retains legacy first-use behavior.
- Use readable viewer, service, catalog, and document-list output by default, preserve machine-readable schemas with `--json`, and add `inbox list --running` for privately verified registered viewers.
- Add an optional local read-only hub with explicit source membership, combined list/search, inbox filters and source-qualified document links. Stopped libraries remain readable; unavailable sources produce incomplete results without changing source paths, permissions, identities, or original bytes.
- Retry Windows catalog-lock creation while a prior lock is pending deletion, bounded by the existing acquisition deadline; retain permanent permission errors.
- Update documentation and both skills for the human and agent workflows. Skill resolvers accept stable installed 0.2.x and 0.3.x executables and retain a published 0.2.2 fallback with feature-specific capability checks.

### Upgrade to 0.3.0

Automation parsing `viewer status`, `viewer stop`, or `viewer service` output must add `--json` after upgrading. JSON mode never confirms a destructive operation: deletion still requires `--force`, and remote revocation requires `--yes`. Plain publishing and viewer/hub startup retain URL-only stdout.

Once named inboxes are registered, unbound automation needs `--inbox NAME`, an absolute `--home PATH`, a consistent `HTML_INBOX_NAME` / `HTML_INBOX_HOME` binding, or an intentionally configured default. Without any named entries, the legacy `~/.html-inbox` behavior remains. Terminal picks affect only that operation and do not save a default. Existing homes can be registered in place; no document move, merge, or automatic import occurs.

Catalog, picker, and hub inspection validate existing roots and identities without repairing permissions or creating missing paths. Make selected sources readable to the same OS account and retain protected local storage; Windows privacy still depends on owner-restricted ACLs. Ordinary owned-library writes retain their managed-directory/file permission behavior. Every reachable hub reader can read every explicitly mounted source; filters do not restrict access. Reading membership never changes publishing destinations or auto-adds new libraries.

The private control protocol remains compatible with 0.2.x. Restart an existing viewer through the normal verified lifecycle after updating to load the new interface and code; stored documents and saved exposure remain intact. Stop a 0.1.0 viewer with its original executable before upgrading. Update CLI and skills separately. This release covers one machine and OS account; it adds no reader mutations, library copying, or network replication.

## 0.2.2 - 2026-10-25

- Record timestamped shutdown requests and completion with the viewer PID and first trigger, preserving serialized startup and cleanup.
- Clarify external script warnings so they do not promise blocking for noncanonical URLs inside permitted CSP sources. Validation rules and runtime security policy are unchanged.
- Explain why detached viewers remain owned by a launching systemd scope and point persistent reader links to the existing explicit boot service workflow.
- Preserve the original failure and attempt every cleanup stage in the synthetic scope test harness, including setup failures, with manager-free regression coverage in CI.

The CLI and process-control protocol are unchanged. After updating, restart an existing 0.2.x viewer to load the new diagnostics; stored documents and saved exposure settings persist. Persistent service installation remains an explicit administrator operation. Stop viewers started by 0.1.0 with their original executable before upgrading.

## 0.2.1 - 2026-10-20

- Replace stacked viewer headers with a compact toolbar and responsive inbox list on mobile and desktop.
- Add Hide frame and Show frame controls that preserve document scroll and interactive state.
- Follow System appearance by default with saved Light and Dark browser overrides and an optional setup default through the new `preferences` command.
- Keep theme-aware documents in sync with the viewer, fix transparent dark document backgrounds, and provide a reusable dual-theme skill template and examples.
- Keep documents readable when the saved appearance file is invalid, logging the error and using System without overwriting the file.

Restart a running viewer to load the new interface. Version 0.2.x viewers keep the same process-control protocol and preserve stored documents. Stop a viewer started by 0.1.0 with its original executable before upgrading.

## 0.2.0 - 2026-10-04

- Start or reuse a background viewer from both `viewer` and `publish`, with `--foreground` for debugging and service managers.
- Add explicit LAN access with configurable IP addresses and ports, current network URLs, and strict Host validation.
- Add HTTPS access through an existing Tailscale Serve client, with verified route ownership and scoped cleanup that preserves unrelated services.
- Add boot service installation, removal, and status for Linux systemd system services and macOS LaunchDaemons, running as a selected normal user before login.
- Keep reader health anonymous and verify process management through a private loopback control endpoint.
- Improve concurrent startup, failed-child cleanup, shutdown, private diagnostics, and service privilege boundaries across supported platforms.
- Replace the source-checkout landing page with npm-first installation and a complete documentation website.
- Add a GitHub Actions trusted-publishing workflow for subsequent npm releases.

Stop any viewer started by version 0.1.0 before upgrading. The private process-control protocol changed, and version 0.2.0 refuses to signal an older process it cannot verify. Inbox documents are preserved.

## 0.1.0 - 2026-10-04

- Added a private local HTML library with atomic bounded storage, search, deletion, and viewer lifecycle controls.
- Isolated untrusted documents in sandboxed iframes with restrictive route-specific Content Security Policies.
- Added deterministic provider-independent static snapshot export under 128-bit bearer capability paths.
- Added a pinned Cloudflare Pages Direct Upload adapter with compact `_headers` policy translation and upload-limit validation.
- Added durable remote init, publish, status, reconcile, and capability-rotating revoke workflows.
- Added npm-first user documentation and separate local and remote operation skills.
- Added CI, installed-package smoke tests, a self-contained ncc bundle, documentation, threat model, and MIT license.

- Replaced incomplete self-check execution with independently cleaned-up tests and real-browser checks.
- Validated saved remote operations and deployment snapshots; use Cloudflare API metadata for reliable recovery.
- Consolidated document modules, adopted HTML5 parsing, and reduced duplicate file reads and CLI wrappers.
- Added process-specific viewer shutdown checks and consistent local/static search.
