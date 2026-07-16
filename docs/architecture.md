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

The provider-independent export layout is:

```text
index.html
__html-inbox/ownership.json
i/<capability>/
  index.html
  snapshot-manifest.json
  security-headers.json
  assets/viewer.css
  assets/viewer.js
  documents/<id>/
    index.html
    content/index.html
```

The root page contains no capability path. The owner marker contains only a schema version and opaque owner UUID. The manifest records sorted file digests and an aggregate snapshot hash without local paths. Original document bytes are copied to `content/index.html`; generated shell pages continue to embed them in sandboxed iframes.

`security-headers.json` lives behind the capability path so the generic static output has no predictable file that discloses the bearer link. It is an adapter input rather than a file browsers consume. It describes common, root, shell, and document policies without provider routing syntax. A provider adapter must apply them to every corresponding route alias and must fail rather than publish without equivalent headers.

The Cloudflare Pages adapter translates those policies into a compact `_headers` file in a disposable copy of the snapshot. The copy is deployed from its own root with Wrangler Direct Upload, then removed whether deployment succeeds or fails. The provider-neutral snapshot is never modified. A global common rule combines with separate root, inbox-shell, document-shell, and document-content rules so the content CSP never merges with the stricter shell CSP.

Wrangler is invoked as an argument array through an exact version pin. The Cloudflare account is selected with `CLOUDFLARE_ACCOUNT_ID`; API tokens remain inherited process credentials and are never command arguments, persisted state, or error output. The adapter validates the current Direct Upload limits (20,000 files and 25 MiB per file) and `_headers` limits (100 rules and 2,000 characters per line) before invoking Wrangler.

Wrangler's immutable deployment URL is the deployment receipt. The canonical project hostname is derived only when that receipt contains the expected deployment-hash prefix, which accounts for Pages assigning a globally unique subdomain different from the requested project name. A caller may describe that hostname as current production only after verifying it deployed the project's configured production branch. Callers must preserve the immutable URL for recovery and avoid presenting it as revocable.

Export writes a private sibling staging directory, moves a recognized prior export to a backup, and installs the complete snapshot with same-filesystem renames. A failed install restores the backup, but the output path may be briefly absent between renames. Unrecognized directories are never replaced. Static export does not mutate the local library and does not own provider credentials or deployment state.

The stable remote target is the Cloudflare account ID plus project name, never an inferred hostname. Remote configuration, the active operation, receipts, and operation-scoped snapshots live in private files under `<HTML_INBOX_HOME>/remote`. One atomic mutation lock prevents concurrent remote writers; a stale lock is recoverable because durable intent is stored separately.

Publish and revoke write intent before invoking the adapter and attach the first 160 bits of the snapshot digest as Cloudflare commit metadata. If the process loses the deploy response, reconciliation lists deployment history and looks for that digest before retrying. A received deployment URL is checkpointed into the operation before the main state is finalized. Finalization is idempotent if a process exits between the state rename and operation cleanup.

Revoke rotates the state to a new undisclosed capability and deploys an empty inbox there. The old production capability path is absent from the replacement snapshot. A later publish uses the rotated capability, so revocation never restores a previously shared link accidentally. Unlisted capability URLs are bearer links, not authentication, and older immutable deployment URLs remain a separate history-pruning concern.
