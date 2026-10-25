# HTML Inbox

Version 0.5.0 adds permanent single-document deletion for every reachable live viewer and hub reader. UI deletion requires a running 0.5.x reader. Version 0.4.0 includes reader copying, and 0.3.0 introduced named independent libraries and local hubs. See [named inboxes and local reading](https://github.com/deveshsangwan/html-inbox/blob/main/docs/named-inboxes.md) for selection, source membership, and exposure rules. Check the executable's `--help` and the running reader for actual capabilities. Updating a skill does not update the CLI or a running viewer.

HTML Inbox stores generated HTML reports in a local library, previews them through a sandboxed viewer, and can publish complete unlisted snapshots to a user-owned Cloudflare Pages project. The live viewer listens on loopback by default.

Library commands choose explicit `--inbox` / absolute `--home`, then process `HTML_INBOX_NAME` / `HTML_INBOX_HOME`, then a configured default. Without a binding or default, registered entries require a choice by exact name or `#N` row for that operation, with stdin, stdout, and stderr all attached to TTYs. Redirecting any one of those streams disables the picker. Pipelines, non-TTY callers, and `--json` fail with names and explicit-selector guidance on stderr, leaving stdout empty. Even one entry requires a choice; no choice changes a default or current inbox. With no registered entries, legacy first use at `~/.html-inbox` remains. `HTML_INBOX_HOME` also works with the legacy fallback.

Human status, catalog, and document lists use text or tables. Use advertised `--json` flags for automation and `html-inbox inbox list --running [--json]` for registered, verified running viewers. Check running-only, viewer JSON, and service JSON support separately. Unregistered libraries are not auto-discovered. Plain publish, detached viewer startup, and hub startup keep URL-only stdout. In 0.3.0, viewer status/stop and service commands print readable text by default; add `--json` in scripts that previously parsed their default JSON. Published 0.2.x commands emit JSON without that flag; check help before adding it to an older executable. JSON never prompts; CLI deletion still requires `--force` and remote revocation `--yes`.

On POSIX filesystems that enforce Unix permissions, ordinary library operations create and tighten managed directories to `0700` and files to `0600`. Catalog inspection, picker reads, and hub source reads do not repair source permissions. On Windows, privacy relies on existing and inherited filesystem ACLs. The CLI does not install or verify owner-only Windows ACLs. Use a protected local user directory and restrict access throughout its subtree, including remote-state files containing bearer capabilities. See the [Windows storage prerequisites](https://github.com/deveshsangwan/html-inbox/blob/main/docs/threat-model.md#windows-storage-prerequisites) before storing sensitive content. Exports and temporary credential logs need protected locations too.

## Set up your agent

Install the main skill for agent publishing and viewer operation. The current skills CLI requires Node.js 22.20.0 or newer and npm for installation and updates:

```sh
npx skills add deveshsangwan/html-inbox --skill html-inbox -g
```

A skill supplies agent instructions; this npm package supplies the executable. The installers are independent. Adding a skill does not install a global CLI, and installing the CLI does not add a skill.

On first use, the skill reuses a working, stable `html-inbox` 0.2.x, 0.3.x, 0.4.x, or 0.5.x executable or uses its tested, version-pinned npm fallback for the operation. The tested fallback is the published `npx --yes html-inbox@0.4.0`; it includes named selection, the picker, hubs, and reader copying, but has no UI deletion. The [CLI resolution reference](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/references/cli-resolution.md) defines the exact acceptance rules and pin. It preserves your inbox selection, catalog, port, saved viewer exposure, and Tailscale executable override. It checks actual command support before using newer features and reports unavailable capabilities without changing your destination or upgrading the pin. The HTML Inbox runtime requires Node.js 20 or newer. The fallback needs npm and registry access or a cached package.

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

Upgrading from 0.2.x, 0.3.x, or 0.4.x to 0.5.0 changes live reader permissions. After an authorized update and restart, every reachable loopback, LAN, and Tailscale reader can permanently delete individual documents. Every live hub reader can delete from all mounted inboxes, including stopped or privately served sources; filters do not limit authority. Deletion is always available in 0.5.x. Publishing, process control, and hub membership stay in the local CLI. Original source files and existing static copies remain unchanged, and static snapshots remain read-only.

Before an authorized upgrade, review saved exposure and frozen hub membership because these determine who gains deletion authority. Stop each old viewer with the executable that started it and the same inbox binding, then confirm shutdown through status. Use Ctrl-C for foreground viewers and hubs. Keep the old executable until shutdown is verified, then upgrade and restart the intended viewers and hubs. Existing session authorization covers these steps when it includes the permission change.

Versions 0.2.x through 0.5.x share private control protocol 3. Compatible running viewers keep their loaded code until restarted. The 0.5.0 update preserves stored documents and saved exposure. Existing static readers gain 0.4.0 copy controls only through owner-controlled snapshot regeneration and publishing.

For the 0.3 upgrade, add `--json` to viewer status/stop and service commands used by automation. Once catalog entries exist, bind unbound jobs with `--inbox`, absolute `--home`, `HTML_INBOX_NAME` / `HTML_INBOX_HOME`, or a deliberate default. With no entries, legacy home selection remains. The [named-inbox migration guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/named-inboxes.md#upgrade-from-02x) covers the change.

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

Detachment does not escape an agent's systemd scope or provide automatic restart. Use an explicit [boot service](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md#start-at-boot) for links that must survive agent cleanup, logout, or reboot. Graceful shutdown diagnostics include the timestamp, PID, and shutdown reason in `viewer.log`, foreground stderr, or the service journal.

Versions 0.2.x, 0.3.x, 0.4.x, and 0.5.x share private control protocol 3. Stop a viewer started by 0.1.0 with its original executable before upgrading; newer CLIs refuse incompatible or unverified process records. Restart an existing compatible viewer after updating to load the new code and reader controls.

Explicit self-hosting modes serve the complete live inbox for reading and searching:

```sh
html-inbox viewer --lan --host 192.168.1.20 --port 4321
html-inbox viewer --tailscale
```

LAN mode trusts everyone who can reach the port, with no login or reader token. First LAN startup or a switch from another mode binds `0.0.0.0` without `--host`; existing LAN configuration retains its saved host, including with explicit `--lan`. Tailscale mode uses an already installed and connected Tailscale client, HTTPS Serve, and your tailnet access policy. MagicDNS and HTTPS must be available. The backend stays on loopback. HTML Inbox refuses conflicting Serve/Funnel settings, preserves unrelated services, and removes only its verified owned route. Every reachable live reader can read and permanently delete individual documents, including on loopback. Deletion needs no startup grant or separate login. Publishing and viewer management remain local CLI operations.

Choose **Delete** from a live document's three-dot menu in the list or its document options. The confirmation shows its title, filename, and inbox, defaults to Cancel, and explains that deletion is permanent. A hub deletes from the document's original mounted inbox, bound to its captured canonical root, UUID, and filesystem identity under the same OS account. Filters do not limit deletion authority. There is no Undo or bulk deletion. The original source file, existing exports, and remote snapshots remain unchanged. Static exported and hosted copies are read-only and contain no live viewer credentials.

For an inbox enrolled in managed sync, deleting an original also propagates deletion to its authorized copies when they reconnect. Deleting a received copy hides it only in the selected inbox. Saved bytes remain retained, so managed deletion does not free disk space. Existing exports and hosted snapshots stay independent.

`--loopback`, `--lan`, and `--tailscale` are mutually exclusive. Commands without explicit networking options reuse the saved configuration. Stop an exposed viewer, then start with `--loopback` to return to local access. `--port` overrides `HTML_INBOX_PORT`; `HTML_INBOX_HOME` selects the library. Use `HTML_INBOX_TAILSCALE_COMMAND` to select an existing Tailscale executable when needed.

Explicit `viewer service install`, `viewer service uninstall`, and `viewer service status` commands manage boot startup on Linux systemd and macOS LaunchDaemons. Installation and removal require administrator privileges, but the viewer runs as a selected normal user before login. See [service setup](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md) for user selection, custom homes, and persisted executable paths. Boot services require deliberately installed Node and CLI executables at stable absolute paths; an npm cache entry from the skill fallback is not a durable installation. Removing a service preserves documents.

## Reading documents and appearance

The inbox has a compact searchable list. Documents open beneath a slim toolbar on mobile and desktop. **Hide frame** gives the document the available browser area; the small **Show frame** button restores the toolbar. The iframe remains mounted, preserving document state and scroll. Document metadata is available in the details menu.

Choose **Viewer options → Copy content...** to copy saved **Document text** or individual **Code blocks** as plain text. Use **Copy all**, select a portion and choose **Copy selection**, or pick a numbered code block. Code indentation, tabs, and trailing whitespace are preserved after normal HTML parsing. The preview stays loaded while the dialog is open.

Copy text comes from the saved HTML, so scripted changes, edited form values, and chart visuals may be missing; CSS-hidden text can remain. To copy a selection from the current preview, use the browser's keyboard, context menu, or touch Copy. When automatic copying is unavailable or denied, use **Select all** in the dialog and your device's Copy command. This fallback also supports ordinary HTTP LAN readers. Copying changes only the reader's clipboard, and works in named viewers, the live hub, and newly generated static snapshots.

If text stays fully selected after **Select all**, close and reopen the dialog before selecting a smaller portion.

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
