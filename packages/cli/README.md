# HTML Inbox

Name independent local libraries with `inbox create` or `inbox register`, select one with `--inbox`, and optionally read an explicit set through `hub`. See [named inboxes and local reading](https://github.com/deveshsangwan/html-inbox/blob/main/docs/named-inboxes.md) for routing, membership, and exposure rules. Older CLI releases lack these commands; check `--help` before using them.

HTML Inbox stores generated HTML reports in a local library, previews them through a sandboxed viewer, and can publish complete unlisted snapshots to a user-owned Cloudflare Pages project. The live viewer listens on loopback by default.

The library defaults to `~/.html-inbox`; set `HTML_INBOX_HOME` to choose another location. On POSIX filesystems that enforce Unix permissions, the CLI creates and tightens managed directories to `0700` and files to `0600`. On Windows, privacy relies on existing and inherited filesystem ACLs. The CLI does not install or verify owner-only Windows ACLs. Use a protected local user directory and restrict access throughout its subtree, including remote-state files containing bearer capabilities. See the [Windows storage prerequisites](https://github.com/deveshsangwan/html-inbox/blob/main/docs/threat-model.md#windows-storage-prerequisites) before storing sensitive content. Exports and temporary credential logs need protected locations too.

## Set up your agent

Install the main skill for agent publishing and viewer operation. The current skills CLI requires Node.js 22.20.0 or newer and npm for installation and updates:

```sh
npx skills add deveshsangwan/html-inbox --skill html-inbox -g
```

A skill supplies agent instructions; this npm package supplies the executable. The installers are independent. Adding a skill does not install a global CLI, and installing the CLI does not add a skill.

On first use, the skill reuses a working, stable `html-inbox` 0.2.x executable or uses its tested, version-pinned npm fallback for the operation. The [CLI resolution reference](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/references/cli-resolution.md) records the current pin. It preserves your inbox home, port, saved viewer exposure, and Tailscale executable override. The HTML Inbox runtime requires Node.js 20 or newer. The fallback needs npm and registry access or a cached package.

`-g` installs for your user across projects. Omit it for the current project. Choose an agent interactively or add `--agent codex` or `--agent claude-code`:

```sh
npx skills add deveshsangwan/html-inbox --skill html-inbox --agent codex
npx skills add deveshsangwan/html-inbox --list
```

`--list` shows the repository's available skills without installing them. The optional Cloudflare skill installs separately:

```sh
npx skills add deveshsangwan/html-inbox --skill html-inbox-remote -g
```

The main skill handles the live viewer, LAN, Tailscale, and boot services. The remote skill handles Cloudflare Pages static snapshots, recovery, and revocation. Neither skill requires the other to be installed. See [agent setup](https://deveshsangwan.github.io/html-inbox/docs/agent-setup.html) and the [official skills CLI](https://github.com/vercel-labs/skills#readme).

## Install the CLI for terminal use

Node.js 20 or newer is required. Install once for regular use:

```sh
npm install --global html-inbox
html-inbox --help
```

Or run it without a global install:

```sh
npx html-inbox --help
```

You can add a skill later with the commands above. Read the [documentation website](https://deveshsangwan.github.io/html-inbox/docs/) for installation, publishing, self-hosting, static sharing, command reference, and troubleshooting. Source and maintainer guides are in the [project repository](https://github.com/deveshsangwan/html-inbox#readme).

## Update skills and the CLI

Skill updates and npm package updates are separate. Update the global main skill by name:

```sh
npx skills update html-inbox -g
```

For project scope, run `npx skills update html-inbox -p` from that project. Substitute `html-inbox-remote` to update the optional Cloudflare skill. Omitting the name updates all skills in the selected scope. Interactive `npx skills update` without scope flags prompts for scope; `skills check` is an update alias, not a read-only check.

You can also rerun the original `skills add` command with the same scope and agent selection. Refresh the whole skill, including its bundled references and scripts. The npm fallback remains pinned until updated skill instructions change it.

Before changing CLI versions, stop an older viewer with the executable that started it. The new CLI refuses unverified older process records. Confirm the viewer has stopped before installing the new version:

```sh
html-inbox viewer stop
npm install --global html-inbox@latest
html-inbox --version
html-inbox viewer
```

Stop an old foreground viewer with Ctrl-C. Reinstall boot services after Node or CLI updates so they capture the correct executable paths. See [service updates](https://deveshsangwan.github.io/html-inbox/docs/boot-services.html#updating). Your documents and saved exposure settings persist.

## Use the viewer

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

Explicit `viewer service install`, `viewer service uninstall`, and `viewer service status` commands manage boot startup on Linux systemd and macOS LaunchDaemons. Installation and removal require administrator privileges, but the viewer runs as a selected normal user before login. See [service setup](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md) for user selection, custom homes, and persisted executable paths. Boot services require deliberately installed Node and CLI executables at stable absolute paths; an npm cache entry from the skill fallback is not a durable installation. Removing a service preserves documents.

## Reading documents and appearance

The inbox has a compact searchable list. Documents open beneath a slim toolbar on mobile and desktop. **Hide frame** gives the document the available browser area; the small **Show frame** button restores the toolbar. The iframe remains mounted, preserving document state and scroll. Document metadata is available in the details menu.

Appearance defaults to **System**, with **Light** and **Dark** overrides in the reader. The selected appearance applies to the inbox, frame, and documents that support it. Browser choices persist on that origin and device; they do not write to the CLI's preferences or sync across devices. Selecting System follows the reader's OS.

Set the initial appearance for readers without a browser override:

```sh
html-inbox preferences --appearance system
html-inbox preferences --appearance dark
html-inbox preferences --json
```

The saved default lives in `<HTML_INBOX_HOME>/preferences.json`, or `~/.html-inbox/preferences.json` with the default home. Static exports capture it when created. Explicit agent setup offers this choice once and can be skipped; ordinary publishing never waits for an appearance question. Older CLIs, including 0.2.0, lack `preferences`; the skill checks command support before using it.

New documents generated with the skill include light and dark styles and follow viewer appearance, with an OS fallback when opened standalone. Existing HTML remains unchanged; hardcoded colors may need adaptation. Intentional white paper previews and chart or image colors stay authored. See the [document appearance contract](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/references/document-appearance.md) and [reusable template](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/assets/document-template.html).

Unlisted remote URLs are bearer links, not authentication. Anyone with a capability URL can read and reshare that snapshot.
