# HTML Inbox Architecture

Phase 1 is a local-first inbox for trusted users publishing untrusted HTML.

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

Use `HTML_INBOX_PORT` when the port is taken:

```sh
HTML_INBOX_PORT=4321 html-inbox viewer
```

The health check is the source of truth for whether the viewer is ready. CLI output should be based on the health check, not process startup alone.

Documents render through a viewer-owned path inside a sandboxed iframe. The app shell lists documents and opens one document at a time; raw files are never rendered directly into the shell DOM.

## Validation

HTML is untrusted by default. Phase 1 uses cheap validation before storage:

- reject `<script>` tags
- reject inline event handlers such as `onclick`
- reject external asset URLs

Validation is a gate, not a sanitizer. Accepted HTML is still rendered only in the sandboxed viewer path with strict CSP.
