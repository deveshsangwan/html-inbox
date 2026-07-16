# ADR 0001: Publish remote inboxes as static snapshots

Status: accepted

## Context

HTML Inbox currently has one trusted local operator, untrusted stored HTML, a private filesystem library, and a loopback-only viewer. The remote goal is to make selected inbox snapshots reachable from another machine without turning the local viewer into an internet-facing administration server.

A remotely reachable server would need authentication, authorization, tenant isolation, mutation auditing, CSRF protection, rate limiting, durable storage, and an operational security model. None of those capabilities are needed to publish static reports.

[Pagecast](https://github.com/Amal-David/pagecast) demonstrates the useful product split: administration and source files remain local, while complete static output is deployed to infrastructure owned by the user. HTML Inbox will adopt that split while keeping a smaller feature surface.

## Decision

### Local ownership

The local library remains the only source of truth and the only mutable document store. The CLI is the only remote-publishing administrator. The loopback viewer is never exposed to a LAN, VPN, container wildcard mapping, tunnel, or public listener.

### Provider-independent snapshot

A snapshot module will materialize a complete static site into a new output directory. Its interface accepts a local document source, an output location, and an inbox capability. It returns a manifest and content hash after validating the finished tree. Callers do not construct individual remote files or routes.

The snapshot contains:

- a non-listing root page
- one inbox at `/i/<capability>/`
- document shells and original document content below that inbox path
- static viewer assets and security-header configuration
- a versioned manifest with no local filesystem paths

Snapshots are immutable inputs to deployment. Updating the remote inbox means generating and deploying a new complete snapshot; remote files are never incrementally edited.

### URL and access model

The inbox capability contains 128 random bits encoded for URLs. The Pages root does not link to or enumerate inboxes. Knowing `https://<project>/i/<capability>/` grants access to the complete published inbox snapshot.

The capability is unlisted, not private and not authenticated. Anyone who receives it can read and reshare it. It must not appear in telemetry, logs emitted by default, repository files, or public manifests. Password protection and organizational access control are separate future features.

### First deployment adapter

Cloudflare Pages is the first production deployment adapter. The stable target identity is:

```text
ProjectRef { accountId, projectName }
```

Hostnames and deployment URLs are deployment metadata, not target identity. The adapter invokes a pinned Wrangler version and returns a normalized deployment receipt. Tests use a recording adapter at the same seam; provider-specific command execution does not leak into the snapshot module or workflow.

### Ownership and adoption

Remote state records a random local owner identity and the exact `ProjectRef`. A generated remote ownership marker contains only the owner identity and schema version. It contains no local path, account ID, token, or document metadata.

HTML Inbox may create a new target or reuse a target carrying the expected marker. Managing an existing unmarked or differently marked project requires an explicit adoption flag because a Pages deployment replaces that project's contents.

### Local state and operation journal

Remote configuration, secrets, receipts, and operation records live below the private HTML Inbox home, never in the current repository. Writes use private files and atomic replacement.

A deployment workflow owns these steps:

1. Resolve the explicit `ProjectRef`.
2. Generate and validate a complete snapshot.
3. Write durable deployment intent before the first remote side effect.
4. Ask the deployment adapter to publish the snapshot.
5. Checkpoint the returned deployment ID and URL.
6. Finalize local remote state and clear the completed operation.

If a process exits or a network response is ambiguous, `remote status` reports the incomplete operation. A later reconcile command checks remote deployment history before retrying. Local state must never claim a remote deployment succeeded without a receipt.

### Revoke semantics

Revocation deploys a complete replacement snapshot without the inbox capability route. It does not guarantee removal of older immutable Cloudflare deployment URLs. The CLI must state this and provide or document a deployment-history pruning step before describing sensitive content as inaccessible.

## Module seams

- The snapshot module is deep: one export interface hides route layout, HTML rendering, assets, headers, manifest construction, validation, and atomic output replacement.
- The remote workflow module is deep: one deploy/revoke/status interface hides target resolution, journaling, receipts, and reconciliation.
- The deployment port is a real seam with two adapters: pinned Wrangler in production and a recording adapter in tests.
- Local storage remains concrete. Remote publishing does not add a second document-storage adapter or writer.

## Consequences

Benefits:

- No remotely exposed administration process
- Hosting output can be tested without Cloudflare credentials
- Other static providers can be added without changing snapshot behavior
- A deploy is an atomic whole-site replacement from the recipient's perspective
- Local and remote failure states remain explicit

Costs:

- Updating one document redeploys the complete snapshot
- The capability URL grants access to every document in that snapshot
- Revocation cannot erase immutable historical deployment URLs automatically
- Cloudflare authentication and deployment availability remain external dependencies

## Deferred

- Password protection, Cloudflare Access, and per-recipient authorization
- Expiry, vanity links, redirects, and multiple inbox capabilities
- Analytics, reactions, Workers, KV, and D1
- Markdown, directory publishing, build-command execution, and auto-sync
- Browser mutation routes, remote editing, background services, MCP, and extensions
- Multi-user or organization-hosted administration
