# Security policy

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/deveshsangwan/html-inbox/security/advisories/new). Do not include capability URLs, Cloudflare tokens, local paths, or private report contents in a public issue.

The supported security boundary is documented in [docs/threat-model.md](docs/threat-model.md). In particular:

- the local viewer must remain loopback-only;
- stored and remotely published HTML is untrusted;
- remote capability URLs are unlisted bearer links, not authentication;
- revoke does not erase older immutable Cloudflare deployment URLs.

Local storage privacy depends on the filesystem. On POSIX filesystems that enforce Unix permissions, the CLI creates and tightens managed directories to `0700` and files to `0600`. On Windows, it relies on existing and inherited filesystem ACLs and does not install or verify owner-only access. A protected `HTML_INBOX_HOME` and restricted ACLs throughout its subtree are prerequisites, including for remote state containing bearer capabilities. Export locations and the temporary directory used for credential logs require the same protection. Follow the [Windows storage prerequisites](docs/threat-model.md#windows-storage-prerequisites). These protections do not isolate data from processes running as the same user or privileged administrators.

Reports should include the affected version or commit, operating system, reproduction steps using non-sensitive sample content, and the security impact.
