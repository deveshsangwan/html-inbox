# HTML Inbox

HTML Inbox stores generated HTML reports in a local library, previews them through a sandboxed viewer, and can publish complete unlisted snapshots to a user-owned Cloudflare Pages project. The live viewer listens on loopback by default.

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

Read the [documentation website](https://deveshsangwan.github.io/html-inbox/docs/) for installation, publishing, self-hosting, static sharing, command reference, and troubleshooting. Source and maintainer guides are in the [project repository](https://github.com/deveshsangwan/html-inbox#readme).

Start or reuse a background viewer, inspect it, and stop it:

```sh
html-inbox viewer
html-inbox viewer status
html-inbox viewer stop
```

Startup waits for verified readiness. Use `--foreground` for debugging, containers, or service managers. Publishing starts or reuses the same viewer and prints its document URL.

Stop an older viewer before upgrading. The new private control protocol refuses unverified older process records.

Explicit self-hosting modes serve the complete live inbox for reading and searching:

```sh
html-inbox viewer --lan --host 192.168.1.20 --port 4321
html-inbox viewer --tailscale
```

LAN mode trusts everyone who can reach the port, with no login or reader token. Tailscale mode uses an already installed and connected Tailscale client, HTTPS Serve, and your tailnet access policy. MagicDNS and HTTPS must be available. The backend stays on loopback. HTML Inbox refuses conflicting Serve/Funnel settings, preserves unrelated services, and removes only its verified owned route. Publishing, deletion, and viewer management remain local CLI operations.

`--loopback`, `--lan`, and `--tailscale` are mutually exclusive. Commands without explicit networking options reuse the saved configuration. Stop an exposed viewer, then start with `--loopback` to return to local access. `--port` overrides `HTML_INBOX_PORT`; `HTML_INBOX_HOME` selects the library. Use `HTML_INBOX_TAILSCALE_COMMAND` to select an existing Tailscale executable when needed.

Explicit `viewer service install`, `viewer service uninstall`, and `viewer service status` commands manage boot startup on Linux systemd and macOS LaunchDaemons. Installation and removal require administrator privileges, but the viewer runs as a selected normal user before login. See [service setup](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md) for user selection, custom homes, and persisted executable paths. Removing a service preserves documents.

Unlisted remote URLs are bearer links, not authentication. Anyone with a capability URL can read and reshare that snapshot.
