# Changelog

All notable changes to HTML Inbox will be documented here.

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
