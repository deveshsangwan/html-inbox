# Changelog

All notable changes to HTML Inbox will be documented here.

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
