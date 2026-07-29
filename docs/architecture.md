# HTML Inbox Architecture

Phase 1 is a local-first inbox for trusted users publishing untrusted HTML. Documents may use the official Tailwind browser CDN or Mermaid v11 CDN so reports can stay small instead of embedding generated CSS and JavaScript.

## Command

```sh
html-inbox publish ./report.html --title "SvelteKit Migration Report" --type report
```

`publish` validates the file, stores the original HTML unchanged, writes metadata, and makes it visible in the local viewer.

## Storage

Default home:

```text
~/.html-inbox
```

Override with:

```sh
HTML_INBOX_HOME=/path/to/inbox
```

Document layout:

```text
documents/<id>/index.html
documents/<id>/metadata.json
```

`index.html` is the original uploaded HTML bytes. `metadata.json` holds the generated id, title, type, publish time, and source file name.

New records include a storage schema version. Legacy records without the field are read as schema version 1. Publishing writes and validates both files in the private `documents/.staging/<id>` area, then makes the complete record visible with one same-filesystem directory rename. Interrupted staging records are never listed. A corrupt committed record is skipped with a diagnostic instead of breaking the rest of the library.

## Backend

Keep the backend abstraction to four operations:

- `publish(input)`
- `listDocuments()`
- `getDocument(id)`
- `deleteDocument(id)`

Deletion first renames a committed document into the private trash area so it disappears from the library atomically, then removes the trash record. Search is a server-rendered filter over title, type, and source file name. There is no update, sync, tags, auth, or database layer in the local product.

## Viewer

The viewer binds `127.0.0.1:3217` by default.

The local HTTP interface accepts only the expected loopback `Host` values. Its health response contains an opaque, per-home instance identity and a viewer protocol version; it never exposes the absolute inbox path. Managed directories are owner-only and managed files are owner-readable and owner-writable.

Use `HTML_INBOX_PORT` when the port is taken:

```sh
HTML_INBOX_PORT=4321 html-inbox viewer
```

The CLI exposes viewer status and stop commands. Before spawning a detached viewer, it probes the requested loopback port so a non-HTML-Inbox listener produces a direct port-conflict error instead of a generic startup timeout.

The health check is the source of truth for whether the viewer is ready. CLI output should be based on the health check, not process startup alone. A viewer can be reused only when both its protocol version and opaque instance identity match.

Documents render through a viewer-owned path inside a sandboxed iframe. The app shell lists documents and opens one document at a time; raw files are never rendered directly into the shell DOM.

## Validation

HTML is untrusted by default. Phase 1 uses cheap validation before storage:

- allow scripts, but only allow external script entry URLs for Tailwind's browser build and Mermaid v11
- reject inline event handlers such as `onclick`
- reject other external asset URLs

Validation is a gate, not a sanitizer. Accepted HTML is still rendered only in the sandboxed viewer path. The iframe enables scripts without `allow-same-origin`, so documents receive an opaque origin and cannot access the viewer DOM or same-origin storage. Its CSP permits inline document configuration and the allowlisted CDN script paths while continuing to block connections, frames, forms, objects, and non-data image, media, and font loads.

Input is bounded before reading. HTML files default to a 10 MiB limit, configurable through `HTML_INBOX_MAX_BYTES`, and metadata fields have explicit length limits.

Supported CDN entry URLs are deliberately limited to the canonical major-version URLs:

- `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4`
- `https://cdn.tailwindcss.com` (including its official plugin query)
- `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs`

Mermaid's CSP source includes its `dist/` subtree because the entry module loads diagram chunks from that directory. Opening a document that uses a CDN makes a remote request, but the viewer's `no-referrer` policy does not disclose its local document URL. Add another CDN or major version only by changing both validation and the document CSP and adding an accept/reject check.

## Remote publishing

Remote publishing follows [ADR 0001](adr/0001-static-remote-inbox.md). The local library remains the only mutable source of truth. A provider-independent module generates a complete static snapshot under a 128-bit capability path, and a deployment workflow sends that immutable snapshot through a Cloudflare Pages adapter. Administration remains local and the root of the deployed site does not list inboxes.

The stable remote target is the Cloudflare account ID plus project name, never an inferred hostname. Remote operations journal intent before deployment, checkpoint the deployment receipt, and expose incomplete work for reconciliation. Unlisted capability URLs are bearer links, not authentication.
