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

## Phase 1 Controls

- Store the original HTML unchanged at `documents/<id>/index.html`.
- Store metadata separately at `documents/<id>/metadata.json`.
- Reject inline event handlers and external URLs except the canonical Tailwind browser and Mermaid v11 script entries during publish.
- Render documents through a dedicated viewer path inside an iframe sandboxed with only `allow-scripts`. Omitting `allow-same-origin` gives the document an opaque origin and prevents access to the viewer DOM and same-origin storage.
- Use strict CSP on viewer responses. Document responses allow inline scripts plus the narrow CDN script paths required by Tailwind and Mermaid; `connect-src`, frames, forms, objects, and non-data images, media, and fonts remain blocked.
- Bind the viewer to `127.0.0.1`, default port `3217`.
- Allow `HTML_INBOX_PORT` only as a local port escape hatch.
- Treat the health check as the only readiness signal.

## Out Of Scope

- Multi-user auth
- Remote hosting
- Sync
- HTML rewriting or sanitization
- Fine-grained permissions
- Malware scanning
- Protection against in-frame CPU or memory exhaustion
- Offline rendering or vendoring of CDN dependencies

Add those only when the product stops being local-first single-user software.
