# HTML Inbox

HTML Inbox stores generated HTML reports in a private local library, previews them through a loopback-only sandboxed viewer, and can publish complete unlisted snapshots to a user-owned Cloudflare Pages project.

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
