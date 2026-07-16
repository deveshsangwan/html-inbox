# HTML Inbox Threat Model

Phase 1 protects the local viewer and local machine from untrusted HTML reports.

## Assumptions

- The user running the CLI is trusted.
- Published HTML is untrusted.
- The inbox is local-only by default.
- Storage is on the user's filesystem under `~/.html-inbox` unless `HTML_INBOX_HOME` is set.

## Main Risks

- Stored HTML script escapes its isolated document frame.
- Inline handlers run during render.
- External assets leak data or track opens.
- A document escapes into the app shell DOM.
- A weak viewer response policy allows unexpected network, script, or framing behavior.
- An allowlisted CDN is compromised or serves an incompatible update within an allowed major version.
- An allowlisted CDN observes the user's IP address and that its resource was requested.
- Document script consumes excessive CPU or memory inside its frame.
- A browser reaches loopback data through an attacker-controlled Host header.
- Another local operating-system account reads inbox files created with permissive modes.
- An accidental or maliciously large document exhausts memory or disk during publish.
- A crash leaves a partially written record that appears in the library.

## Phase 1 Controls

- Store the original HTML unchanged at `documents/<id>/index.html`.
- Store metadata separately at `documents/<id>/metadata.json`.
- Reject inline event handlers and external URLs except the canonical Tailwind browser and Mermaid v11 script entries during publish.
- Render documents through a dedicated viewer path inside an iframe sandboxed with only `allow-scripts`. Omitting `allow-same-origin` gives the document an opaque origin and prevents access to the viewer DOM and same-origin storage.
- Use strict CSP on viewer responses. Document responses allow inline scripts plus the narrow CDN script paths required by Tailwind and Mermaid; `connect-src`, frames, forms, objects, and non-data images, media, and fonts remain blocked.
- Bind the viewer to `127.0.0.1`, default port `3217`.
- Reject requests whose `Host` is not the expected loopback host and active port.
- Create managed directories as owner-only (`0700`) and files as owner-readable/writable (`0600`), and tighten existing managed paths when they are accessed.
- Return an opaque instance identity and protocol version from health checks instead of the absolute inbox path.
- Reject oversized input before reading it and bound all user-controlled metadata fields.
- Stage and validate a complete record before making it visible with an atomic directory rename.
- Keep deletion in the CLI, require confirmation by default, and atomically move a record out of the live library before removing its files.
- Allow `HTML_INBOX_PORT` only as a local port escape hatch.
- Treat the health check as the only readiness signal.

## Out Of Scope

- Multi-user auth
- Remotely exposed administration or dynamic document storage
- Sync
- HTML rewriting or sanitization
- Fine-grained permissions
- Malware scanning
- Protection against in-frame CPU or memory exhaustion
- Offline rendering or vendoring of CDN dependencies

Add those only when the product stops being local-first single-user software. Static remote snapshots are covered by the extension below.

## Remote snapshot extension

Remote publishing extends the model without exposing the local viewer. The relevant additional risks are:

- Anyone with the inbox capability can read and reshare the complete published snapshot.
- A capability leaks through copied URLs, recipient browser history, referrers, screenshots, or third-party logging.
- A deployment accidentally replaces an unrelated Cloudflare Pages project.
- A remote deployment succeeds but the response is lost, leaving local and remote state ambiguous.
- Revocation removes the production route while an older immutable deployment URL remains reachable.
- Exported manifests or pages leak local paths, Cloudflare credentials, account identifiers, or unpublished document metadata.

Controls:

- Generate 128 random capability bits and publish no inbox listing at the Pages root.
- Apply `no-referrer`, restrictive CSP, and content-type headers to generated static pages.
- Treat the account ID and project name as explicit target identity and require ownership-marker verification or deliberate adoption.
- Journal intent before deployment, checkpoint receipts, and reconcile ambiguous operations against deployment history before retrying.
- Keep remote state in owner-only local files. Inherit credentials from Wrangler's own login store or the process environment; never pass tokens as command arguments or include them in state, snapshots, or error output.
- State clearly that an unlisted URL is not private and that historical deployments may need pruning after revoke.

The first remote release does not claim recipient authentication, guaranteed erasure, secret-link confidentiality after sharing, protection from malicious allowlisted CDN code, or isolation between multiple remote users.
