---
name: html-inbox
description: Publish HTML artifacts to HTML Inbox. Use for publishing, opening or deleting documents, named library selection, a local reading hub, document appearance, viewer operation, loopback/LAN/Tailscale access, boot startup, or rejected documents.
---

# HTML Inbox

Publish a finished HTML artifact into the selected local library. `publish` stores the original bytes and starts or reuses a detached viewer. An unenrolled library returns its document URL after readiness. An enrolled library reports durable local storage separately from intended-server delivery and viewer readiness.

This skill owns publishing and live viewer operation. Cloudflare Pages hosts a separate static snapshot. When the user requests Cloudflare setup, snapshot publishing, recovery, or revocation, install the optional remote skill if it is absent:

```sh
npx skills@1.7.0 add deveshsangwan/html-inbox --skill html-inbox-remote
```

The skills installer requires Node.js 22.20.0 or newer for skill installation or updates. HTML Inbox itself, including the fallback used by an already-installed skill, requires Node.js 20 or newer.

Choose a supported agent explicitly when needed, for example by appending `--agent codex -y`. Verify that agent's installed directory contains `SKILL.md`, `references/cli-resolution.md`, `references/library-selection.md`, `references/document-appearance.md`, `assets/document-template.html`, and the bundled `scripts/windows-cli.cjs` before using it. Installer exit code zero alone does not prove every selected agent target succeeded.

Then follow the installed `html-inbox-remote` skill, or read its [repository guidance](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox-remote/SKILL.md). This skill requires neither a repository checkout nor that optional skill for live viewer operations.

## Resolve the CLI

Before running commands, follow [CLI resolution](./references/cli-resolution.md). It selects a compatible installed CLI or the pinned npm fallback and defines the `inbox` command used below. Keep that selected prefix and inbox environment for the whole operation. Version compatibility alone does not establish feature support.

## Resolve the destination

Before any library command, read [library selection and hub operation](./references/library-selection.md). Apply its capability checks, selection precedence, human terminal picker, non-interactive choice-required recovery, and output rules. It also covers `inbox inbox list --running`, default clear/reset, and explicit local hub membership with incomplete results.

Keep the resolved selector on preferences, publish, list, delete, export, remote, and viewer commands. Preserve `HTML_INBOX_NAME`, `HTML_INBOX_HOME`, `HTML_INBOX_CATALOG_HOME`, the port and Tailscale overrides, and the selected library's saved exposure. Ordinary artifact work reuses the intended library. Create or register a library, or change a default, only for that deliberate user request. Do not create a library per task or select the first or only catalog entry on the user's behalf.

## Set up appearance

During an explicit HTML Inbox setup request, offer the optional appearance choice once: **System** by default, or **Light** or **Dark**. Skipping the question keeps System. Installation and ordinary publishing continue without this question.

First check `inbox --help` for the `preferences` command. The pinned 0.5.0 fallback supports it, but an older installed 0.2.x executable may not. If absent, keep System and explain that saving a setup preference requires a CLI with `preferences` support; continue other authorized setup work. Keep the selected CLI and version pin unchanged.

When supported, inspect `inbox preferences --json`. If the selected inbox home already contains `preferences.json`, preserve its preference and skip the setup question unless the user asks to change it. Otherwise, save the chosen value, or the default when skipped:

```sh
inbox preferences --appearance system
```

Use `light` or `dark` for an explicit override. Setup is complete when the saved preference matches the choice. Later explicit preference changes use the same command. Reader appearance changes are browser-local overrides; they do not write back to this CLI preference. Selecting System in the reader follows that device's OS even when the saved setup default differs.

## Author documents

When creating or adapting an HTML document for publishing, read [document appearance](./references/document-appearance.md) and use its [self-contained template](./assets/document-template.html). Generate both light and dark styles. The viewer selects their appearance; the standalone document follows the OS. Keep intentional image, chart, and paper colors intact.

An existing finished file remains the publish source unless the user requests adaptation. Publishing does not rewrite stored HTML or convert old hardcoded colors.

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

For an unenrolled library, publication succeeds when the command exits 0 and prints its document URL. It may use loopback HTTP, a LAN interface URL, or Tailscale HTTPS. Preserve the exact reader URL, including an already exposed viewer's network URL.

Managed publication requires a CLI with the advertised `sync` commands. The published 0.5.0 fallback has no managed-sync capability; report that prerequisite rather than changing the executable, inbox or format. Enrollment is a separate opt-in operation, never a publishing prerequisite to perform automatically. Read the [managed worker and publication contract](https://github.com/deveshsangwan/html-inbox/blob/main/docs/phase2-sync/worker-operations.md) before configuring or operating managed sync.

When `publish --json` is available, use it for managed automation. Its saved result has `local.durable`, document identity, `delivery`, `worker`, `viewer.url` and `onward.awaited: false`. Human output is multiline: Saved locally, Delivery, reader URL when available, and onward information. Exit 0 means confirmed intended-server custody or an unconfigured local-only save; 2 means durable pending, 3 durable blocked, and 130 cancellation after save when that result is present. A saved result is evidence of local persistence even when delivery is nonzero. Preserve its report identity, intended target and obligations. Report the actual pending, blocked or cancelled state and verified viewer availability; continue only the authorized status, retry or recovery operation. Duplicate publication or choosing another target would create a different obligation. Exit 1 or missing saved evidence requires inspection, not an assumption that nothing was saved.

This step is complete when local persistence, delivery and viewer readiness are each known or their uncertainty is reported. Share only the returned reader URL; a missing or failed viewer has no link to invent. Pending or blocked custody is not successful delivery.

### 3. Verify the artifact

When the result contains a reader URL and visual correctness matters, open that exact URL. Check that the document shell loads, the title and type are correct, and the iframe renders the expected content. For charts, external assets, or other runtime-dependent output, also check the browser console and failed network requests. Durable storage or confirmed delivery does not prove rendering. If a managed result has no ready viewer, retain the saved report identity and report viewer unavailability; creating another publication would not repair that existing outcome.

Verification is complete when the expected content is visible without relevant console or network failures, or when the actual viewer/browser limitation is reported. Claim rendering only for observed content.

### 4. Hand off

Give the user the returned reader URL when available and identify the report, title and type. For managed publication, state durable local storage, actual delivery state and viewer readiness separately; pending, blocked or cancelled delivery is not confirmed custody. If no reader is ready, give the saved identity and that limitation without inventing a URL. Explain who can reach an available link. When the reader supports UI deletion, explain its reachable-reader authority and managed retention distinction. Mention a custom home or port only when useful. Keep private control URLs, tokens, process records and diagnostics out of reader handoffs.

The handoff is complete when the user has the actual saved/delivery outcome, an available clickable reader URL or an explicit viewer limitation, and any rendering-verification limitation. Preserve pending work for its existing target.

## Delete one document

For an authorized deletion, identify the intended inbox and document first. Use `inbox delete <document-id>` with that same selector; automated CLI deletion requires `--force`. JSON output does not imply consent.

In a live viewer with UI deletion support, **Delete** is available in each list row's three-dot menu and in document options. The modal shows the title, filename, and inbox, explains permanent deletion, and defaults to Cancel. Confirm only the authorized document. Every reachable live reader has this authority on loopback, LAN, and Tailscale, without a startup grant or separate reader login. Hub filters do not limit it.

In an unenrolled inbox, deletion removes the saved files; report a purge failure separately from removal from the live list. In a managed inbox, deleting a local original signs terminal state for its authorized copies when they reconnect. Deleting an imported copy suppresses it only in the destination inbox. Managed bodies remain retained, with no disk-reclamation or secure-erasure guarantee. Original source files, existing exports and remote snapshots remain unchanged. There is no Undo or bulk deletion. A missing or replaced source fails without recreating storage or choosing another inbox. This step is complete when the result confirms the intended deletion or suppression and any cleanup failure is reported. Static exported or hosted copies remain read-only and contain no live viewer credentials.

## Validation gate

The source must be a regular `.html` or `.htm` file containing valid UTF-8 and an explicit `<html>` tag or `<!doctype html>` declaration. The ordinary default size limit is 10 MiB. Managed bodies have a fixed 10 MiB cap; a lower input limit can restrict them further.

Blocking HTML policy errors reject publishing. These include `javascript:` or `vbscript:` URL attributes, navigation to `data:` URLs, `<meta http-equiv="refresh">`, and `<a>` or `<area>` links with non-HTTPS schemes or protocol-relative URLs. HTTPS, relative, and fragment links are allowed.

Inline scripts and the supported Tailwind browser and Mermaid v11 script entry points are allowed. Inline event handlers, `<base>`, and non-allowlisted external scripts or asset URLs produce advisory warnings. Publishing continues. The viewer CSP blocks many warned features, but its script sources are broader than the canonical entry URLs; verify the affected behavior instead of treating a warning as proof of blocking.

When input validation rejects the source before persistence, preserve the exact error, fix the named source condition, and retry the same publish contract. For other errors or a saved managed result, follow the publish gate and inspect the existing report before deciding the next operation. Preserve validation, viewer security and any rendering limitation.

When publication emits warnings, retain its saved/delivery outcome and any available reader URL, report the warnings, and verify the affected behavior when a viewer is available. Explain unsupported behavior. Changing an already saved report requires a separate authorized publication.

## Operate the viewer

`publish` normally starts or reuses the viewer. Explicit startup uses the same detached lifecycle, survives terminal closure, and returns only after private control verification confirms readiness:

```sh
inbox viewer
inbox viewer status
inbox viewer stop
```

Detachment keeps the launching process's service-manager ownership. On Linux, stopping an agent's systemd scope also stops its detached viewer. For links that must survive agent cleanup, logout, or reboot, follow the explicitly authorized [boot service workflow](#manage-boot-startup). Ordinary startup and publishing never install that service.

Starting with 0.2.2, graceful shutdown records its timestamp, viewer PID, first trigger, and cleanup completion in the existing diagnostic stream. A signal reason does not identify its sender, and a forced kill can prevent a shutdown record. Older compatible 0.2.x executables may lack these records.

Use `inbox viewer --foreground` when the user wants an attached process for debugging, containers, or an external service manager. It keeps the terminal occupied and prints its listening address to stderr. Startup failures report an error and retain private diagnostics under the selected inbox home.

First startup of a new selected library uses loopback `127.0.0.1` and port `3217`. Destination selection follows the library reference above. The last successful port, bind address, and exposure are saved inside that inbox and survive `viewer stop`. A later `viewer` or `publish` without explicit network options reuses them. `HTML_INBOX_PORT` overrides the saved port; `viewer --port` overrides that environment value. Status and stop use the same inbox and environment, without startup flags.

Before a user-requested port change, stop the verified existing viewer with `HTML_INBOX_PORT` matching its current port, or with that override unset. Confirm `stopped` before selecting the new port. Then set the override to the requested port or leave it unset so later commands use the saved port, and resolve the CLI for this new operation. Preserve that selected environment for startup, publishing, status, and stop. Otherwise a startup with `--port 4321` can succeed while status still inspects an inherited port `3217` and stop refuses the mismatch.

Use `viewer status` to inspect the verified process, mode, and reader URLs. For automation, use the capability-gated JSON commands in the library reference and inspect `state` and any `reason` from status and stop. Even a conflict or incompatibility can exit with code zero. Complete a stop only after its result and a follow-up status confirm `stopped`. A stopped or conflicting status can contain candidate URLs; share a usable URL only after successful startup or a verified running status. The CLI checks its separate private loopback control endpoint and inbox/process identity before reusing or stopping a viewer. Reader `/health` returns only anonymous `{"ok":true}`. It proves reader availability, never inbox or process ownership.

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

LAN mode trusts every reader who can reach the listener to read and permanently delete documents in the complete library. There is no reader login, password, or access token. The operating system's firewall determines reachability. Publishing, process control, and service administration remain local CLI operations.

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

The reader backend binds `127.0.0.1`. The CLI prepares and explicitly trusts the exact device hostname in its reader Host allowlist, verifies the node identity and root HTTPS proxy on port 443, then returns its reader URL. Do not invent a hostname, widen the Host allowlist, or use forwarded/Tailscale identity headers as application authorization. Reachability follows the user's tailnet policy; every reachable reader can read and permanently delete documents in the complete live library.

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

The service records absolute Node/CLI paths, inbox and network settings, and the Tailscale executable when needed. Reinstall after moving or replacing those installation paths. CLI and skill updates are separate operations. Service status checks both the manager and private viewer readiness. Uninstall stops and disables only the owned boot service and preserves documents, saved configuration, inbox identity, and logs. Successful shutdown removes the matching active process record and any verified owned-route journal. `viewer stop` does not remove boot configuration; use service uninstall to prevent future boot startup.

## Security boundary

The viewer stores each document's original HTML unchanged. It renders that HTML on a dedicated path inside a sandboxed iframe with a Content Security Policy; it does not sanitize the stored file. Do not present an accepted document as safe to open outside the viewer. Live deletion requires a process-scoped CSRF token and matching Origin, retains Host validation, and uses `frame-ancestors 'none'` on live shells. These checks protect requests from other origins while every reachable reader retains deletion authority. Publishing and lifecycle control have no reader HTTP endpoints.

When changing implementation or security policy rather than operating the CLI, first read the [architecture](https://github.com/deveshsangwan/html-inbox/blob/main/docs/architecture.md) and [threat model](https://github.com/deveshsangwan/html-inbox/blob/main/docs/threat-model.md).
