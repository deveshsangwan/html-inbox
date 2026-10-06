---
name: html-inbox
description: Publish HTML artifacts to HTML Inbox. Use when the user wants to publish or open a document, operate its background viewer, choose loopback, LAN, or Tailscale reader access, manage boot startup, or diagnose a rejected document.
---

# HTML Inbox

Publish a finished HTML artifact into the local private document library. `publish` stores the original bytes, starts or reuses a detached viewer, and returns its document URL after the CLI verifies readiness.

This skill owns publishing and live viewer operation. Cloudflare Pages hosts a separate static snapshot. When the user requests Cloudflare setup, snapshot publishing, recovery, or revocation, install the optional remote skill if it is absent:

```sh
npx skills add deveshsangwan/html-inbox --skill html-inbox-remote
```

The current `skills@1.7.0` installer requires Node.js 22.20.0 or newer for skill installation or updates. HTML Inbox itself, including the fallback used by an already-installed skill, requires Node.js 20 or newer.

Choose a supported agent explicitly when needed, for example by appending `--agent codex -y`. Verify that agent's installed directory contains `SKILL.md`, `references/cli-resolution.md`, and the bundled `scripts/windows-cli.cjs` before using it. Installer exit code zero alone does not prove every selected agent target succeeded.

Then follow the installed `html-inbox-remote` skill, or read its [repository guidance](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox-remote/SKILL.md). This skill requires neither a repository checkout nor that optional skill for live viewer operations.

## Resolve the CLI

Before running commands, follow [CLI resolution](./references/cli-resolution.md). It selects a compatible installed CLI or the pinned npm fallback and defines the `inbox` command used below. Keep that selected prefix and inbox environment for the whole operation.

## Publish

### 1. Fix the publish contract

Identify the final `.html` or `.htm` file, a human-readable title, and a short type. Common types are `report`, `note`, `dashboard`, and `other`, but the CLI accepts any non-empty type.

If the user asked to create and publish an artifact, finish the artifact first. Do not use HTML Inbox as the authoring format or silently replace the source after review.

This step is complete when the exact source path, title, and type are known and the source needs no further edits.

### 2. Cross the publish gate

Run:

```sh
inbox publish ./report.html --title "SvelteKit Migration Report" --type report
```

Quote paths and metadata when they contain shell-significant characters. Keep the selected `HTML_INBOX_HOME`, `HTML_INBOX_PORT`, and `HTML_INBOX_TAILSCALE_COMMAND` unchanged throughout the operation. Ordinary publishing preserves the inbox's saved port and exposure. Choose a different library or port only for a user-requested change or a verified port conflict.

Publishing is complete only when the command exits successfully and prints a document URL. It may be loopback HTTP, a LAN interface URL, or Tailscale HTTPS, depending on the active configuration. Use that exact printed URL, including when publishing into an already exposed viewer. Do not construct a URL after a failed command or replace an exposed URL with localhost.

### 3. Verify the artifact

Open the printed URL when visual correctness matters. Check that the document shell loads, the title and type are correct, and the iframe renders the expected content. For charts, external assets, or other runtime-dependent output, also check the browser console and failed network requests; publish success proves storage, not rendering.

Verification is complete when the expected content is visible without relevant console or network failures. If browser verification is unavailable, report that limitation instead of claiming the artifact rendered correctly.

### 4. Hand off

Give the user the printed document URL and identify the published title and type. Explain who can reach it for the selected mode. Mention a custom home or port only when it helps the user operate their inbox. Share only reader URLs; keep private control URLs, tokens, process records, and diagnostics out of reader handoffs.

The handoff is complete when the user has a clickable URL and any verification limitation is explicit.

## Validation gate

The source must be a regular `.html` or `.htm` file containing valid UTF-8 and an explicit `<html>` tag or `<!doctype html>` declaration. The default size limit is 10 MiB.

Blocking HTML policy errors reject publishing. These include `javascript:` or `vbscript:` URL attributes, navigation to `data:` URLs, `<meta http-equiv="refresh">`, and `<a>` or `<area>` links with non-HTTPS schemes or protocol-relative URLs. HTTPS, relative, and fragment links are allowed.

Inline scripts and the supported Tailwind browser and Mermaid v11 script entry points are allowed. Inline event handlers, `<base>`, and non-allowlisted external scripts or asset URLs produce advisory warnings. Publishing continues, and the viewer CSP blocks the warned features.

When publishing fails, preserve the exact error, fix the named condition in the source, and retry the same publish contract. Do not bypass validation, weaken viewer security, or claim that a CDN works without rendering it in the viewer.

When publishing succeeds with warnings, preserve the printed URL, report the warnings, and verify the affected behavior in the viewer. Replace any required blocked feature with supported markup before republishing.

## Operate the viewer

`publish` normally starts or reuses the viewer. Explicit startup uses the same detached lifecycle, survives terminal closure, and returns only after private control verification confirms readiness:

```sh
inbox viewer
inbox viewer status
inbox viewer stop
```

Use `inbox viewer --foreground` when the user wants an attached process for debugging, containers, or an external service manager. It keeps the terminal occupied and prints its listening address to stderr. Startup failures report an error and retain private diagnostics under the selected inbox home.

First startup uses `~/.html-inbox`, loopback `127.0.0.1`, and port `3217`. `HTML_INBOX_HOME` selects the library for every command. The last successful port, bind address, and exposure are saved inside that inbox and survive `viewer stop`. A later `viewer` or `publish` without explicit network options reuses them. `HTML_INBOX_PORT` overrides the saved port; `viewer --port` overrides that environment value. Status and stop use the same inbox and environment, without startup flags.

Before a user-requested port change, stop the verified existing viewer with `HTML_INBOX_PORT` matching its current port, or with that override unset. Confirm `stopped` before selecting the new port. Then set the override to the requested port or leave it unset so later commands use the saved port, and resolve the CLI for this new operation. Preserve that selected environment for startup, publishing, status, and stop. Otherwise a startup with `--port 4321` can succeed while status still inspects an inherited port `3217` and stop refuses the mismatch.

Use `viewer status` to inspect the verified process, mode, and reader URLs. Inspect the JSON `state` and any `reason` from status and stop, since even a conflict or incompatibility can exit with code zero. Complete a stop only after its result and a follow-up status confirm `stopped`. A stopped or conflicting status can contain candidate URLs; share a usable URL only after successful startup or a verified running status. The CLI checks its separate private loopback control endpoint and inbox/process identity before reusing or stopping a viewer. Reader `/health` returns only anonymous `{"ok":true}`. It proves reader availability, never inbox or process ownership.

If the CLI reports another inbox on the requested port, choose another port and preserve that process. For an incompatible older viewer, stop it using its original executable before retrying the selected CLI. If it has already exited, the [older-viewer recovery guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md#diagnostics-and-removal) permits removal of only stale `viewer.json` after proving that the recorded process is gone and its port unused. Keep documents, saved configuration, and other private records. Never signal an unverified PID or delete records to bypass ownership checks.

## Choose reader access

Network exposure requires an explicit user choice. Keep an existing saved mode during ordinary publishing or startup. Stop the verified viewer before changing its mode, port, or bind address. `--loopback`, `--lan`, and `--tailscale` are mutually exclusive.

### Loopback

Loopback readers run on the same machine. To return an exposed viewer to loopback after the user requests it:

```sh
inbox viewer stop
inbox viewer --loopback
```

### LAN

LAN mode trusts every reader who can reach the listener. There is no reader login, password, or token. All reachable readers can read the complete library; the operating system's firewall determines reachability. Publishing, deletion, process control, and service administration remain local CLI operations.

After the user chooses LAN access, use a host IP that belongs to this machine:

```sh
inbox viewer --lan --host 192.168.1.20 --port 4321
```

Replace the example IP with the intended interface address. First LAN startup, or a switch from another mode, defaults to `0.0.0.0` when `--host` is omitted. An inbox already configured for LAN keeps its saved host, even with an explicit `--lan`. If the user requests all IPv4 interfaces, specify `--host 0.0.0.0` after stopping the viewer. The CLI prints concrete interface URLs; use those rather than inventing a browser URL with a wildcard address.

### Tailscale HTTPS Serve

Before enabling Tailscale, read the [Tailscale operations and recovery guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/tailscale.md). Use an existing installed and signed-in client with an online, unexpired node, MagicDNS, HTTPS certificates for its exact device hostname, and the already-enabled `https` capability. The normal viewer user needs permission to manage Serve through that daemon. HTML Inbox does not install or log into Tailscale, grant operator permission, change tailnet policy, enable Funnel, or accept setup/consent prompts.

After the user chooses live tailnet reader access:

```sh
inbox viewer --tailscale
```

The reader backend binds `127.0.0.1`. The CLI prepares and explicitly trusts the exact device hostname in its reader Host allowlist, verifies the node identity and root HTTPS proxy on port 443, then returns its reader URL. Do not invent a hostname, widen the Host allowlist, or use forwarded/Tailscale identity headers as application authorization. Reachability follows the user's tailnet policy; readers can read the complete live library.

An unrelated existing HTTPS root remains unchanged and causes a conflict. Preserve it, report the conflicting hostname/route, and have the user choose loopback/LAN, a different node, or explicitly arrange that route's relocation before retrying. Reserved reader routes, an incompatible listener, or unsafe Serve/Funnel configuration can also block startup. Preserve unrelated mounts, ports, named Services, and foreground configurations.

Use `inbox viewer stop` for verified cleanup. The CLI removes only its owned root route, checks that unrelated configuration survived, and then clears its ownership journal. If ownership, node identity, or permissions cannot be verified, preserve the journal and report the failure. Restore the connection or permissions and retry stop using the full recovery guide. Never run a global Serve reset or remove another service to make startup succeed.

Direct access through a Tailscale interface IP is a separate explicit IP-bound HTTP viewer. For that user-selected mode, use `inbox viewer --lan --host <this-node-tailscale-ip>` after stopping the current viewer. It has LAN's reachable-reader trust boundary and does not configure HTTPS Serve or produce a `https://...ts.net` URL.

## Manage boot startup

Service administration is a separate, explicit user-requested operation. Before installing, updating, or removing it, read the [full systemd and LaunchDaemon guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md#start-at-boot). Linux uses a systemd system service; macOS uses a LaunchDaemon. Both run before login as the selected normal user. Install and uninstall require administrator privileges; ordinary viewer and publish commands do not install boot configuration, and the CLI never invokes sudo itself.

Install Node and HTML Inbox at stable paths first. Use the normal account's validated Node binary and installed CLI entry, replacing the absolute paths and user below. A temporary npx cache or disposable checkout is unsuitable for a persistent service. Stop an existing detached viewer for that inbox before installation.

```sh
sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service install --user alice --loopback --port 3217
inbox viewer service status
sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service uninstall --user alice
```

Run ordinary status as the selected normal user and select that user's inbox. For a custom library, preserve the same absolute `HTML_INBOX_HOME` during installation, status, and removal as shown in the full guide. The explicit `--loopback` example chooses loopback; choose LAN or Tailscale options only when the user requests that exposure. Omitting networking options preserves saved settings.

The service records absolute Node/CLI paths, inbox and network settings, and the Tailscale executable when needed. Reinstall after moving or replacing those installation paths. CLI and skill updates are separate operations. Service status checks both the manager and private viewer readiness. Uninstall stops and disables only the owned boot service and preserves documents and private state. `viewer stop` does not remove boot configuration; use service uninstall to prevent future boot startup.

## Security boundary

The viewer stores each document's original HTML unchanged. It renders that HTML on a dedicated path inside a sandboxed iframe with a Content Security Policy; it does not sanitize the stored file. Do not present an accepted document as safe to open outside the viewer. Reader HTTP routes stay read-only in every mode.

When changing implementation or security policy rather than operating the CLI, first read the [architecture](https://github.com/deveshsangwan/html-inbox/blob/main/docs/architecture.md) and [threat model](https://github.com/deveshsangwan/html-inbox/blob/main/docs/threat-model.md).
