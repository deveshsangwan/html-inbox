# HTML Inbox Threat Model

Phase 1 protects the local viewer and local machine from untrusted HTML reports.

## Assumptions

- The user running the CLI is trusted.
- Published HTML is untrusted.
- The inbox is local-only by default.
- Storage is on the user's filesystem under `~/.html-inbox` unless `HTML_INBOX_HOME` is set.

## Main Risks

- Stored HTML executes script in the viewer.
- Inline handlers run during render.
- External assets leak data or track opens.
- A document escapes into the app shell DOM.
- A weak viewer response policy allows unexpected network, script, or framing behavior.

## Phase 1 Controls

- Store the original HTML unchanged at `documents/<id>/index.html`.
- Store metadata separately at `documents/<id>/metadata.json`.
- Reject scripts, inline event handlers, and external asset URLs during publish.
- Render documents through a dedicated viewer path inside a sandboxed iframe.
- Use strict CSP on viewer responses.
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

Add those only when the product stops being local-first single-user software.
