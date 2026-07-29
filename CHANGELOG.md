# Changelog

All notable changes to HTML Inbox will be documented here.

## 0.1.0 - Unreleased

- Added a private local HTML library with atomic bounded storage, search, deletion, and viewer lifecycle controls.
- Isolated untrusted documents in sandboxed iframes with restrictive route-specific Content Security Policies.
- Added deterministic provider-independent static snapshot export under 128-bit bearer capability paths.
- Added a pinned Cloudflare Pages Direct Upload adapter with compact `_headers` policy translation and upload-limit validation.
- Added durable remote init, publish, status, reconcile, and capability-rotating revoke workflows.
- Added CI, installed-package smoke tests, a self-contained ncc bundle, documentation, threat model, and MIT license.
