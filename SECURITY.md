# Security policy

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/deveshsangwan/html-inbox/security/advisories/new). Do not include capability URLs, Cloudflare or sync credentials, origin signing keys, TLS private keys, local paths, or private report contents in a public issue.

The supported security boundary is documented in [docs/threat-model.md](docs/threat-model.md). In particular:

- the live viewer defaults to loopback; the owner explicitly selects LAN or Tailscale exposure and trusts everyone who can reach it to read and permanently delete documents;
- every reachable live hub reader can read and delete documents in every mounted inbox, regardless of filters or standalone viewer exposure;
- deletion requires a process-scoped CSRF token and matching Origin, while Host validation and `frame-ancestors 'none'` protect the live shell;
- publishing and process control remain private local operations, with no reader HTTP endpoints;
- stored and remotely published HTML is untrusted;
- static exported and hosted snapshots are read-only independent copies of eligible local originals, excluding synced imports, detached imports and fork-inherited originals, with no live viewer credentials;
- remote capability URLs are unlisted bearer links, not authentication;
- revoke does not erase older immutable Cloudflare deployment URLs.

Live deletion needs no startup grant, reader login, or network-mode restriction. A hub binds each source's deletion writer to its captured canonical root, durable inbox UUID, and filesystem identity for the same OS account. A missing or replaced source fails without recreating storage or selecting another target. The original document sandbox and content CSP remain in force. Unenrolled deletion removes the record from the live library before purging its files; a purge failure is reported even though the record is already absent. Managed original deletion signs terminal state for authorized copies on reconnection; imported deletion is destination-local suppression. Managed bodies remain retained, with no disk reclamation or secure-erasure guarantee. Original source files and existing snapshots remain unchanged.

Managed synchronization is an explicit POSIX-only per-inbox format upgrade. Dedicated HTTPS ingestion uses operator-configured routes, revisions, peer/destination UUIDs, origin-key grants, credentials and TLS. Reader reachability and Tailscale reader Serve settings grant no replication authority. Private control remains separate from ingestion and public readers. There is no automatic pairing, certificate bypass or firewall configuration. Stop every independent worker, writer, viewer and mounted hub before a consistent backup. Coordinate ownership schema 2 and managed ledger schema 1 across runtimes. Follow [migration, restore quarantine and rollback limits](docs/named-inboxes.md#upgrade-to-060); never infer removal authority from a missing body, lock age or copied PID. Trusted old-owner recovery and general retained-body/orphan reclamation are not provided.

Local storage privacy depends on the filesystem. On POSIX filesystems that enforce Unix permissions, the CLI creates and tightens managed directories to `0700` and files to `0600`. On Windows, it relies on existing and inherited filesystem ACLs and does not install or verify owner-only access. A protected `HTML_INBOX_HOME` and restricted ACLs throughout its subtree are prerequisites, including for remote state containing bearer capabilities. Export locations and the temporary directory used for credential logs require the same protection. Follow the [Windows storage prerequisites](docs/threat-model.md#windows-storage-prerequisites). These protections do not isolate data from processes running as the same user or privileged administrators.

Reports should include the affected version or commit, operating system, reproduction steps using non-sensitive sample content, and the security impact.
