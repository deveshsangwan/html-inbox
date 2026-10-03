# HTML Inbox Threat Model

Phase 1 protects the local viewer and local machine from untrusted HTML reports.

## Assumptions

- The user running the CLI is trusted.
- Published HTML is untrusted.
- The inbox is local-only by default.
- Explicit LAN exposure trusts all readers who can reach the port; explicit Tailscale exposure trusts readers allowed by the user's tailnet policy. Either exposes the complete live library.
- Storage is on the user's filesystem under `~/.html-inbox` unless `HTML_INBOX_HOME` is set.
- The filesystem enforces Unix permission modes on POSIX, or the user has restricted Windows ACLs throughout the storage subtree as described below.

## Main Risks

- Stored HTML script escapes its isolated document frame.
- Inline handlers run during render.
- External assets leak data or track opens.
- A document escapes into the app shell DOM.
- A weak viewer response policy allows unexpected network, script, or framing behavior.
- An allowlisted CDN is compromised or serves an incompatible update within an allowed major version.
- An allowlisted CDN observes the user's IP address and that its resource was requested.
- A followed external link observes the visitor's IP address or attempts to navigate outside the document frame.
- Document script consumes excessive CPU or memory inside its frame.
- A browser reaches loopback data through an attacker-controlled Host header.
- Another local operating-system account reads or changes inbox files because filesystem permissions or Windows ACLs allow access.
- An accidental or maliciously large document exhausts memory or disk during publish.
- A crash leaves a partially written record that appears in the library.

## Phase 1 Controls

- Store the original HTML unchanged at `documents/<id>/index.html`.
- Store metadata separately at `documents/<id>/metadata.json`.
- Validate published HTML in two tiers. See "Publish-time validation tiers" below.
- Render documents through a dedicated viewer path inside an iframe sandboxed with only `allow-scripts`. Omitting `allow-same-origin` gives the document an opaque origin and prevents access to the viewer DOM and same-origin storage. Omitting popup and top-navigation permissions keeps links in the current frame and blocks `_blank` targets.
- Use strict CSP on viewer responses. Document responses allow inline scripts plus the narrow CDN script paths required by Tailwind and Mermaid, block inline script attributes, and keep `connect-src`, frames, forms, objects, and non-data images, media, and fonts blocked. Default navigations to `no-referrer`.
- Bind the viewer to `127.0.0.1`, default port `3217`, unless LAN exposure is explicitly selected. Tailscale Serve uses a loopback backend.
- Reject requests whose `Host` is outside the allowlist derived from the selected listening addresses and exact trusted tailnet hostname. Ignore forwarding and identity headers for authorization.
- On POSIX filesystems that enforce Unix permissions, create managed directories with `0700` and files with `0600`, and tighten existing managed paths when they are accessed. On Windows, rely on the user-provided filesystem ACLs described below.
- Keep identity-bearing health on a separate loopback control endpoint recorded in protected local storage. Reader health returns only an anonymous success response. Control health never exposes the absolute inbox path.
- Reject oversized input before reading it and bound all user-controlled metadata fields.
- Stage and validate a complete record before making it visible with an atomic directory rename.
- Keep deletion in the CLI, require confirmation by default, and atomically move a record out of the live library before removing its files.
- Validate the configured listening IP and port at the boundary. Report usable addresses rather than wildcard browser URLs.
- Treat verified local control health as the readiness signal, and verify the HTTPS Serve route before reporting Tailscale readiness.

## Live self-hosting

LAN mode has no password or reader access token. Every device that can reach the listener can browse metadata, search, and open every stored document. HTTP transport on the LAN does not encrypt the traffic. The operator chooses the listening interface and firewall policy. Host validation limits accepted request authorities; it does not authenticate a reader or prevent an allowed reader from sharing content.

Tailscale mode delegates encrypted transport and reader access to the existing signed-in Tailscale client, HTTPS Serve, and tailnet policy. HTML Inbox accepts only the exact trusted tailnet hostname and its configured loopback authorities. Client-supplied forwarding and Tailscale identity headers grant no access. It checks existing Serve/Funnel settings before changes, refuses conflicting routes, and never enables Funnel or changes tailnet access rules. Cleanup verifies the journaled node and exact owned route before scoped removal. Configuration drift or unavailable clients leave the journal for deliberate recovery rather than deleting unrelated services.

Publishing, deletion, startup, and stop remain local CLI operations. The exposed reader has no administration endpoints. Private process records and startup logs follow the same filesystem protections as documents. Boot services are installed explicitly with administrator privileges, run the viewer as a normal user, and refuse unrelated definitions. A privileged administrator or another process running as the same user remains trusted.

## Storage privacy

On POSIX, the CLI uses Node's filesystem `mode` options and `chmod` to set managed directories to `0700`, giving the owner read, write, and traversal access, and files to `0600`, giving the owner read and write access. Group and other permission bits are cleared. Existing managed paths are tightened when accessed. The CLI does not change ownership, encrypt files, or protect against processes running as the same user or privileged administrators. A filesystem that ignores Unix permission modes cannot provide this POSIX guarantee.

On Windows, Node's `chmod` changes only the write permission and does not distinguish owner, group, and other users. Directory creation modes are unsupported. These calls do not install an owner-only Windows discretionary access control list, or DACL. See [Node's file modes](https://nodejs.org/api/fs.html#file-modes) and [directory creation options](https://nodejs.org/api/fs.html#fspromisesmkdirpath-options).

Windows checks each file or directory's DACL for access. New files and directories inherit ACLs from their parent, while existing or moved files can retain different permissions. Restricting only the inbox root does not repair permissive child ACLs. The CLI neither audits nor repairs Windows ACLs and does not warn or fail when other accounts can access storage. Privacy on Windows is a prerequisite the user must establish. See Microsoft's [file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).

### Windows storage prerequisites

1. Choose a [local NTFS directory](https://learn.microsoft.com/en-us/windows-server/storage/file-server/ntfs-overview) under your user profile, such as the default `%USERPROFILE%\.html-inbox` or `%LOCALAPPDATA%\html-inbox` for a custom `HTML_INBOX_HOME`. Check its permissions before use. A location under your profile is a starting point, not proof of restricted access. Avoid public, shared, network, or synced locations for sensitive content.
2. Create the chosen directory before the first publish or `remote init`. In File Explorer, open its Properties, then Security, then Advanced. Keep access for your own account and trusted system or administrator accounts only. Remove grants to other users and broad groups such as Everyone, Users, or Authenticated Users. If those grants are inherited from a permissive parent, disable inheritance for this directory, convert inherited entries to explicit entries, and remove the unwanted grants. Give your account Full control with scope "This folder, subfolders and files" so new paths inherit the restrictions.
3. Inspect existing files and subdirectories too. Remove permissive explicit grants and repair disabled inheritance so the restricted directory permissions apply throughout the subtree. Recheck after moving or restoring an inbox. Protect `remote\state.json`, `remote\operation.json`, and `remote\work` as carefully as documents. State and operation records contain bearer capabilities; snapshots can contain the complete report library. Cloudflare tokens are not stored in these records.
4. Protect separate export locations and their parent directories, where sibling staging and backup directories are created. Remote publishing also uses the operating system's temporary directory for short-lived Wrangler credential logs. On Windows, that directory and its new children must have restricted ACLs too. Cleanup after a command does not protect a file while it exists.

After selecting and protecting a custom home, set it for the PowerShell session and inspect its DACLs:

```powershell
$env:HTML_INBOX_HOME = Join-Path $env:LOCALAPPDATA 'html-inbox'
icacls "$env:HTML_INBOX_HOME"
icacls "$env:HTML_INBOX_HOME" /T
```

Use the same inspection with the actual default or custom path if it differs. Check every reported path and resolve inspection errors before using sensitive data. The output should grant access only to your account and trusted system or administrator accounts. `icacls /verify` checks ACL structure, not confidentiality. Displaying ACLs or granting yourself access does not remove other users' grants. See Microsoft's [icacls reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls) for display, inheritance, and permission options.

## Publish-time Validation Tiers

`validateHtml` is neither a full security boundary nor pure lint. It is split
explicitly, because a single tier misrepresents what it can enforce.

**The runtime is the primary control.** A document is arbitrary agent-generated
HTML and may contain arbitrary inline script — `script-src 'unsafe-inline'`
permits it by design, so Tailwind and Mermaid work. What contains that script is
the opaque-origin sandboxed frame plus the document CSP, not the validator.
Static string checks over HTML are bypassable by construction: an exfiltration
URL assembled by concatenation cannot be seen by any string matcher. Treating
such checks as a boundary would be false assurance.

**Tier 1 — blocking validation.** Reserved for literal markup the sandbox and
CSP do not close:

- `javascript:` and `vbscript:` URLs in any URL-bearing attribute. CSP permits
  these because `script-src` includes `'unsafe-inline'`, and the sandbox does
  not stop them.
- `data:` URLs in a navigable attribute, which hand the visitor a document the
  author fully controls.
- Anchor navigation outside `https:`, relative, and fragment URLs.
- `<meta http-equiv="refresh">`. CSP has no directive governing navigation,
  and `sandbox="allow-scripts"` permits a frame to navigate itself. Rejecting
  the feature avoids duplicating the browser's permissive refresh parser.

**Tier 2 — advisory lint (reported, never blocks).** Conditions the runtime
already fails closed. They are surfaced because a silently blocked resource is a
confusing broken document, not because they are attacks:

- Inline event handlers, blocked by `script-src-attr 'none'`.
- Non-allowlisted external assets, blocked by `default-src 'none'` and the
  `data:`-only media directives.
- Non-allowlisted external script sources, blocked by `script-src`.
- Non-allowlisted external URLs in script bodies. Advisory only — string
  concatenation defeats the check. `connect-src 'none'` blocks direct fetches,
  but not navigation of the document frame.
- `<base>`, blocked by `base-uri 'none'`.

**Detection integrity.** Tier 1 depends on correctly identifying which tag an
attribute belongs to, so tags are parsed with an HTML5 parser that handles quoted
attribute values and raw-text elements. A backwards search for `<` and `>` cannot do this: a `>`
inside an earlier attribute hides the tag, which previously let
`<a title=">" href="javascript:alert(1)">` publish. Attribute values are also
entity-decoded and stripped of embedded control characters before the scheme is
read, because the HTML parser does both before the URL parser runs.
The `http-equiv` pragma is also entity-decoded before comparison.

**Residual risk.** Allowed inline script can navigate its own preview frame and
put document contents or the current capability URL into the destination URL.
Author markup or script can also override the response's default referrer
policy. Static validation cannot reliably prevent either behavior. A document
opened directly from disk — an exported snapshot file loaded over `file://`
rather than served — also carries no CSP, so every Tier 2 condition becomes
live. Tier 2 is a statement about the served runtime only.

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
- Apply default `no-referrer`, restrictive CSP, and content-type headers to generated static pages.
- Treat the account ID and project name as explicit target identity. Require deliberate adoption of every existing remote project during setup; the export ownership marker is not remote authentication.
- Journal intent before deployment, checkpoint receipts, and reconcile ambiguous operations against deployment history before retrying.
- Keep remote state in local files protected by POSIX `0600` modes or the restricted Windows ACLs required above. Inherit credentials from Wrangler's own login store or the process environment; never pass tokens as command arguments or include them in state, snapshots, or error output.
- State clearly that an unlisted URL is not private and that historical deployments may need pruning after revoke.

The first remote release does not claim recipient authentication, guaranteed erasure, secret-link confidentiality after sharing, containment of navigation by allowed document scripts, protection from malicious allowlisted CDN code, or isolation between multiple remote users.
