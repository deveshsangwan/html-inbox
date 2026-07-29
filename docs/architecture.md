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

## Backend

Keep the backend abstraction to three operations:

- `publish(input)`
- `listDocuments()`
- `getDocument(id)`

No update/delete, search, sync, tags, auth, or database layer in Phase 1.

## Viewer

The viewer binds `127.0.0.1:3217` by default.

The local HTTP interface accepts only the expected loopback `Host` values. Its health response contains an opaque, per-home instance identity and a viewer protocol version; it never exposes the absolute inbox path. Managed directories are owner-only and managed files are owner-readable and owner-writable.

Use `HTML_INBOX_PORT` when the port is taken:

```sh
HTML_INBOX_PORT=4321 html-inbox viewer
```

The health check is the source of truth for whether the viewer is ready. CLI output should be based on the health check, not process startup alone. A viewer can be reused only when both its protocol version and opaque instance identity match.

Documents render through a viewer-owned path inside a sandboxed iframe. The app shell lists documents and opens one document at a time; raw files are never rendered directly into the shell DOM.

## Validation

HTML is untrusted by default. Phase 1 uses cheap validation before storage:

- allow scripts, but only allow external script entry URLs for Tailwind's browser build and Mermaid v11
- reject inline event handlers such as `onclick`
- reject other external asset URLs

Validation is a gate, not a sanitizer. Accepted HTML is still rendered only in the sandboxed viewer path. The iframe enables scripts without `allow-same-origin`, so documents receive an opaque origin and cannot access the viewer DOM or same-origin storage. Its CSP permits inline document configuration and the allowlisted CDN script paths while continuing to block connections, frames, forms, objects, and non-data image, media, and font loads.

Supported CDN entry URLs are deliberately limited to the canonical major-version URLs:

- `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4`
- `https://cdn.tailwindcss.com` (including its official plugin query)
- `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs`

Mermaid's CSP source includes its `dist/` subtree because the entry module loads diagram chunks from that directory. Opening a document that uses a CDN makes a remote request, but the viewer's `no-referrer` policy does not disclose its local document URL. Add another CDN or major version only by changing both validation and the document CSP and adding an accept/reject check.
