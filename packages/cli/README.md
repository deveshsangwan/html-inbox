# HTML Inbox

HTML Inbox stores generated HTML reports in a local library, previews them through a loopback-only sandboxed viewer, and can publish complete unlisted snapshots to a user-owned Cloudflare Pages project.

The library defaults to `~/.html-inbox`; set `HTML_INBOX_HOME` to choose another location. On POSIX filesystems that enforce Unix permissions, the CLI creates and tightens managed directories to `0700` and files to `0600`. On Windows, privacy relies on existing and inherited filesystem ACLs. The CLI does not install or verify owner-only Windows ACLs. Use a protected local user directory and restrict access throughout its subtree, including remote-state files containing bearer capabilities. See the [Windows storage prerequisites](https://github.com/deveshsangwan/html-inbox/blob/main/docs/threat-model.md#windows-storage-prerequisites) before storing sensitive content. Exports and temporary credential logs need protected locations too.

Install once for regular use:

```sh
npm install --global html-inbox
html-inbox --help
```

Or run it without a global install:

```sh
npx html-inbox --help
```

The full setup, security model, static export format, and remote publishing workflow are documented in the [project repository](https://github.com/deveshsangwan/html-inbox#readme).

Unlisted remote URLs are bearer links, not authentication. Anyone with a capability URL can read and reshare that snapshot.
