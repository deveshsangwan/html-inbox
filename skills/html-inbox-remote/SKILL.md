---
name: html-inbox-remote
description: Deploy HTML Inbox snapshots to Cloudflare Pages. Use when the user wants to configure, publish, inspect, recover, or revoke a remote inbox.
---

# Remote HTML Inbox

Operate a Cloudflare Pages static snapshot of the local HTML Inbox. The local library remains the document source of truth; this skill never edits stored documents. Local publishing or deletion changes the live library, while Cloudflare changes only after a successful remote snapshot operation.

Live Tailscale access uses the local viewer through HTTPS Serve and follows tailnet policy. It does not upload a Cloudflare snapshot or use a Cloudflare capability link. Choose the requested sharing model before acting. This remote skill works independently for Cloudflare operations. For local publishing, background viewer operation, LAN, or live Tailscale access, follow the installed main skill or read its [repository guidance](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/SKILL.md). Linked references require neither a checkout nor an installed sibling.

Install the optional main skill only when the user chooses installation:

```sh
npx skills@1.7.0 add deveshsangwan/html-inbox --skill html-inbox
```

The skills installer requires Node.js 22.20.0 or newer for skill installation or updates. HTML Inbox itself, including the fallback used by an already-installed skill, requires Node.js 20 or newer.

Choose a supported agent explicitly when needed, for example by appending `--agent codex -y`. Verify that agent's installed directory contains `SKILL.md`, `references/cli-resolution.md`, and the bundled `scripts/windows-cli.cjs` before using it. Installer exit code zero alone does not prove every selected agent target succeeded.

## Resolve the CLI

Before running commands, follow [CLI resolution](./references/cli-resolution.md). It selects a compatible installed CLI or the pinned npm fallback and defines the `inbox` command used below. Keep that selected prefix for the whole operation. The resolver inherits `HTML_INBOX_NAME`, `HTML_INBOX_HOME`, and `HTML_INBOX_CATALOG_HOME`; preserve those values, port/Tailscale overrides, authentication, and the selected library's saved viewer mode throughout checks and commands.

## Resolve the destination and capabilities

Before any remote command, read the main skill's [library selection and hub operation](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/references/library-selection.md). It defines selection precedence, root/UUID validation, human exact-name or `#N` choices, non-interactive choice-required handling, default recovery, and output compatibility. Its local hub rules apply only when the user requests combined reading; a hub never selects or combines remote publication sources.

Check the selected executable's `inbox --help` for every required command and flag. Named routing, the local read-only hub, and revised picker/output features are available starting in 0.3.0, including the published `html-inbox@0.3.0` fallback. That fallback lacks the 0.4 copy reader; check the generated snapshot for reader features. A checkout can report the same version with different capabilities. Named commands do not establish `--running` support or viewer/service JSON support; follow the linked reference's separate gates before using them.

With named routing support, use the intended explicit selector, process binding, or configured default on every remote command. Apply the linked reference's precedence and same-tier name/home agreement. A missing, conflicting, or invalid destination/default fails without fallback. Treat a choice-required error as an unresolved destination and ask which listed library the user intends; even one registered entry needs a choice. Only an empty catalog retains unbound legacy-home first use. The linked reference defines every redirected-stream and JSON case; resolve the intended destination before retrying.

Examples below use the preserved process binding or default. When using explicit selection, repeat the selector on status, init, publish, reconcile, and revoke. After help confirms both named selection and that command's JSON flag, an automation inspection can use:

```sh
inbox remote status --inbox development --json
```

With an installed legacy 0.2.x CLI, use its existing commands and the already intended `HTML_INBOX_HOME`; do not pass unsupported `--inbox` / `--home` flags. If the intended destination depends on named routing, including inherited `HTML_INBOX_NAME` or a named default, report the missing capability and stop that dependent operation. Preserve the selected executable and fallback pin. Ordinary remote work creates no task-specific library, changes no current/default inbox, and installs or upgrades nothing automatically. Default clear/reset is a separate deliberate repair, as described in the linked reference.

## Choose output for automation

Remote commands use human-readable state by default. Use `--json` only when help advertises it for the exact remote command, then parse its existing schema. `remote status --json` returns `configured`, `state`, and `operation`; init, publish, and reconcile return a remote state, while revoke returns `state`, `revokedUrl`, and `warning`. Check pending intent and the saved target as well as exit status before continuing.

On a successful publish, the human output's `Inbox:` line reports the production capability URL. The JSON state reports it at `lastDeployment.receipt.projectInboxUrl`. For status output, that state is nested under `state`. Share that URL only for a published, non-revoked state. Preserve the immutable deployment receipt for recovery and keep these remote result schemas when parsing. Plain local publish, detached viewer startup, and hub startup keep URL-only stdout as defined in the linked reference. Named context, picker text, and diagnostics go to stderr.

With revised output support, JSON mode never prompts, including destructive confirmation. It does not imply consent. Revocation still requires `--yes`, and local document deletion still requires `--force`; use either only for the authorized operation. An older installed CLI may still prompt if consent flags are omitted in a TTY, so always supply `--yes` for authorized automated revocation, with or without JSON. If a required capability is absent, report availability rather than changing the destination, executable, or output assumptions.

## Choose the operation

Classify the request as setup, publish, inspect or recover, or revoke. Do not run a different remote mutation because it seems like a useful follow-up.

This step is complete when exactly one operation below matches the user's request.

## Set up a target

Confirm the Cloudflare account ID and Pages project name. Do not invent either value. Authenticate through Wrangler browser login or an inherited `CLOUDFLARE_API_TOKEN`; never ask the user to paste a token into chat or put it in a command argument.

Run:

```sh
inbox remote init \
  --account <cloudflare-account-id> \
  --project <pages-project-name>
```

Prefer a dedicated project. If the project already exists, stop and explain that `--adopt` authorizes HTML Inbox to replace its complete deployed contents. Use `--adopt` only after the user explicitly chooses that project.

Setup is complete when `remote init` succeeds and `inbox remote status` reports the intended account and project with no pending operation.

## Snapshot appearance

With CLI 0.2.1 or newer, snapshots use the same compact document toolbar and Hide frame / Show frame controls as the live viewer. Their setup default comes from the local inbox at export time; each reader can select System, Light, or Dark in their own browser. Browser changes do not sync back to the CLI or other devices. A new export is needed to change the snapshot's saved default. A compatible 0.2.0 executable supports ordinary remote operations but lacks these appearance controls.

Remote publishing preserves original document bytes. When asked to author or adapt documents, use the main skill's [document appearance reference](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/references/document-appearance.md). Older documents with hardcoded colors need individual adaptation; the remote operation does not convert them.

## Publish a snapshot

Run `inbox remote status` first, using the selection and output rules above. Cloudflare operations do not require starting or reconfiguring the live viewer. If setup is missing, use the setup branch; if an operation is pending, use the recovery branch before publishing.

Publish the complete current library:

```sh
inbox remote publish
```

Use the production capability URL from the successful state output as described above. Open it when browser verification is available, check the library search and at least one document, and report any verification limitation. Do not construct a URL after a failed command.

Publishing is complete when the command records a successful deployment, prints the production capability URL, and the expected snapshot has been verified or the verification limitation is explicit.

## Inspect or recover

Inspect without mutation:

```sh
inbox remote status
```

When status reports preserved intent, an ambiguous deployment, or another pending operation, reconcile before retrying anything:

```sh
inbox remote reconcile
```

Reconciliation checks Cloudflare deployment history for the recorded snapshot digest and avoids a duplicate deployment when the earlier request succeeded remotely.

If reconciliation reports an abandoned mutation lock, confirm the previous command and its child processes terminated on this machine, then run `inbox remote reconcile --recover-lock` with the same inbox home. Recovery verifies the lock record and requires the recorded PID to be absent. A live or reused PID and an inconclusive process check block recovery regardless of lock age.

For an empty, partial, malformed, or incomplete record, an interrupted recovery guard, or a home shared across machines, follow [manual lock recovery](https://github.com/deveshsangwan/html-inbox/blob/main/docs/remote-migration.md#manual-lock-recovery). Keep all commands and automation using that home stopped while backing up its private remote directory and removing only the two lock paths. Preserve the state, operation journal, and snapshot. If exclusive access cannot be established, leave the locks in place and report the blocker.

If reconciliation reports that an ambiguously created project now exists, stop and explain that adopting it authorizes HTML Inbox to replace its complete deployed contents. After the user explicitly confirms that project, run `inbox remote reconcile --adopt`. Never adopt automatically or loop plain reconciliation.

Recovery is complete when status reports no pending operation and its local receipt agrees with the resolved Cloudflare deployment.

## Revoke the production capability

Revoke only when the user explicitly asks to withdraw the currently shared production route. Explain first that revocation replaces the production snapshot and rotates its capability, but cannot erase older immutable Cloudflare deployment URLs.

After the user authorizes revocation, run non-interactively:

```sh
inbox remote revoke --yes
```

A human may omit `--yes` for terminal confirmation only outside JSON mode. Agents use the explicit authorized `--yes` path. After help confirms `remote revoke --json`, machine output uses `inbox remote revoke --yes --json` with the same destination. If the command preserves intent or loses its response, run `inbox remote reconcile` instead of issuing another revoke.

Revocation is complete when status reports the new empty production deployment and the previously shared capability is absent from the production site. State that historical deployment URLs may still exist.

## Security boundary

A remote capability URL is an unlisted bearer link, not authentication. Anyone who receives it can read and reshare the complete snapshot. Reveal the exact printed production reader URL only in the direct user handoff, and never claim revocation deleted Cloudflare deployment history. Keep private viewer control URLs, tokens, process records, and remote state out of reader handoffs. Report browser rendering only for checks actually performed.

When the user is migrating an existing library or needs the full operational caveats, read the [remote migration guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/remote-migration.md) before acting.
