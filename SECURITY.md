# Security policy

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/deveshsangwan/html-inbox/security/advisories/new). Do not include capability URLs, Cloudflare tokens, local paths, or private report contents in a public issue.

The supported security boundary is documented in [docs/threat-model.md](docs/threat-model.md). In particular:

- the local viewer must remain loopback-only;
- stored and remotely published HTML is untrusted;
- remote capability URLs are unlisted bearer links, not authentication;
- revoke does not erase older immutable Cloudflare deployment URLs.

Reports should include the affected version or commit, operating system, reproduction steps using non-sensitive sample content, and the security impact.
