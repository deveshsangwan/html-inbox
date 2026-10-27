# ADR 0001: Publish remote inboxes as static snapshots

Status: accepted, with live-reader and 0.6.0 managed-sync amendments below. The original static snapshot decision remains in force for Cloudflare/public exports.

## Context

At the time of the original decision, HTML Inbox had one trusted local operator, untrusted stored HTML, a private filesystem library, and a loopback-only viewer. The remote goal was to make selected inbox snapshots reachable from another machine without turning the local viewer into an internet-facing publishing or process-management server.

A multi-user administration server would need authentication, authorization, tenant isolation, mutation auditing, CSRF protection, rate limiting, durable storage, and an operational security model. Static report hosting requires none of that server machinery. Live single-document deletion uses the narrower reachable-reader trust model recorded below.

[Pagecast](https://github.com/Amal-David/pagecast) demonstrates the useful product split: administration and source files remain local, while complete static output is deployed to infrastructure owned by the user. HTML Inbox will adopt that split while keeping a smaller feature surface.

## Decision

### Local ownership

For static/cloud publishing, the selected local library is the deployment source of truth and the CLI is the administrator. The separate managed-sync extension below governs authorized replicated stores.

The viewer remains loopback-only by default. Explicit LAN mode exposes the live library to everyone who can reach its port. Explicit Tailscale mode exposes it through HTTPS Serve under the user's tailnet policy, with a loopback backend. Every reachable live viewer or hub reader can read and permanently delete individual documents, without a startup grant, reader login, or network-mode restriction. The owner chooses the network and trusts its reachable readers with deletion. Hub source filters do not restrict authority. Publishing and process management remain local CLI operations; process health uses a separate private local control endpoint.

Each live list row's three-dot menu and document options offer Delete with a confirmation that shows title, filename, and inbox, explains permanent deletion, and defaults to Cancel. There is no Undo or bulk deletion. In unenrolled libraries the operation renames a record out before purging it, and reports cleanup failure if purge fails after the record disappears. It preserves the original source file and existing static copies. Managed retention and signed terminal state are described below.

The hub explicitly binds each local source's deletion writer to its captured canonical root, durable inbox UUID, and filesystem identity under the same OS account. It revalidates that binding before deletion. Missing, unavailable, or replaced sources fail without recreation or an alternate target. This does not grant arbitrary source mutation. Live requests require the process-scoped CSRF token and matching Origin, retain Host checks, and use `frame-ancestors 'none'` on live shells. Original document sandbox and CSP remain intact.

These live modes are independent of capability-protected static snapshots. Exported and hosted snapshots remain read-only independent copies, contain no live deletion controls or live viewer credentials, and retain their copied documents after live deletion. Snapshot deployment and revocation semantics are unchanged. See the [architecture](../architecture.md#viewer) and [threat model](../threat-model.md#live-self-hosting).

### Managed-sync amendment in 0.6.0

Explicit POSIX enrollment adds independent authenticated HTTPS replication with operator-configured routes, revisions, origin-key/epoch grants and credentials. Reader reachability, hub membership and Cloudflare capability URLs grant no replication authority. The public reader and its private control interface do not become ingestion or publishing endpoints. Static deployment remains an explicit, separate operation.

Managed original deletion signs terminal state for authorized copies on reconnection; imported deletion is destination-local suppression. Bodies remain retained, without disk reclamation or secure erasure. Public exports include eligible local originals only and exclude synced imports, detached imports and fork-inherited originals. Existing snapshots remain independent. See [managed architecture](../phase2-sync/architecture.md), [worker operations](../phase2-sync/worker-operations.md), and [migration/rollback limits](../named-inboxes.md#upgrade-to-060). The original decision and its deferred automatic Cloudflare deployment remain historical context, not a whole-product no-sync claim.

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

Hostnames and deployment URLs are deployment metadata, not target identity. The adapter invokes a pinned Wrangler version for mutations and returns a normalized deployment receipt. It reads project and deployment metadata through the Cloudflare API using credentials retrieved from Wrangler. The pinned CLI list output omits fields needed to verify production branches and reconcile operations. Tests use a recording adapter at the same seam; provider-specific command execution does not leak into the snapshot module or workflow.

### Ownership and adoption

Remote state records a random local owner identity and the exact `ProjectRef`. A generated remote ownership marker contains only the owner identity and schema version. It contains no local path, account ID, token, or document metadata.

HTML Inbox may create a new target. Managing any project that already exists requires an explicit adoption flag because a Pages deployment replaces that project's contents. The owner marker identifies locally generated exports; it is not remote authentication or proof that a remote project still belongs to this installation. After setup, the saved account ID and project name identify the authorized target.

### Local state and operation journal

Remote configuration, secrets, receipts, and operation records live below the private HTML Inbox home, never in the current repository. Writes use private files and atomic replacement.

A deployment workflow owns these steps:

1. Resolve the explicit `ProjectRef`.
2. Generate and validate a complete snapshot.
3. Write durable deployment intent before the first remote side effect.
4. Ask the deployment adapter to publish the snapshot.
5. Checkpoint the returned deployment ID and URL.
6. Finalize local remote state and clear the completed operation.

Each deployment attaches its journaled operation ID and the first 160 bits of its snapshot hash as Cloudflare commit metadata. If a process exits or a network response is ambiguous, `remote status` reports the incomplete operation. A later reconcile command checks the exact `ProjectRef` and branch deployment history for both values and adopts only that deployment's receipt before considering a retry. Local state must never claim a remote deployment succeeded without a matching receipt.

### Revoke semantics

Revocation deploys a complete replacement snapshot without the previously shared inbox capability route. The replacement contains a newly rotated, undisclosed empty capability so a later publish cannot restore the old link. Revocation does not guarantee removal of older immutable Cloudflare deployment URLs. The CLI must state this and document a deployment-history pruning step before describing sensitive content as inaccessible.

## Module seams

- The snapshot module is deep: one export interface hides route layout, HTML rendering, assets, headers, manifest construction, validation, and staged output replacement.
- The remote workflow module is deep: one deploy/revoke/status interface hides target resolution, journaling, receipts, and reconciliation.
- The deployment port is a real seam with two adapters: pinned Wrangler in production and a recording adapter in tests.
- Local storage remains concrete. Remote publishing does not add a second document-storage adapter or writer.

## Consequences

Benefits:

- Static hosting requires no live publishing or process-management server
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
- Browser publishing, remote editing, MCP, and extensions
- Multi-user or organization-hosted administration

## References

- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages custom headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/)
- [Pagecast](https://github.com/Amal-David/pagecast), particularly its pinned Wrangler gateway, explicit `ProjectRef`, immutable deployment warning, and local operation-journal boundary
