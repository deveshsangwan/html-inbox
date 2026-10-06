---
name: html-inbox-remote
description: Deploy HTML Inbox snapshots to Cloudflare Pages. Use when the user wants to configure, publish, inspect, recover, or revoke a remote inbox.
---

# Remote HTML Inbox

Operate a Cloudflare Pages static snapshot of the local HTML Inbox. The local library remains the document source of truth; this skill never edits stored documents. Local publishing or deletion changes the live library, while Cloudflare changes only after a successful remote snapshot operation.

Live Tailscale access uses the local viewer through HTTPS Serve and follows tailnet policy. It does not upload a Cloudflare snapshot or use a Cloudflare capability link. Choose the requested sharing model before acting. This remote skill works independently for Cloudflare operations. If the user instead wants local publishing, background viewer operation, LAN, or live Tailscale access, install the optional main skill if absent:

```sh
npx skills add deveshsangwan/html-inbox --skill html-inbox
```

The current `skills@1.7.0` installer requires Node.js 22.20.0 or newer for skill installation or updates. HTML Inbox itself, including the fallback used by an already-installed skill, requires Node.js 20 or newer.

Choose a supported agent explicitly when needed, for example by appending `--agent codex -y`. Verify that agent's installed directory contains `SKILL.md`, `references/cli-resolution.md`, and the bundled `scripts/windows-cli.cjs` before using it. Installer exit code zero alone does not prove every selected agent target succeeded.

Then follow the installed `html-inbox` skill, or read its [repository guidance](https://github.com/deveshsangwan/html-inbox/blob/main/skills/html-inbox/SKILL.md). Neither skill requires a checkout or an installed sibling to read its linked resources.

## Resolve the CLI

Before running commands, follow [CLI resolution](./references/cli-resolution.md). It selects a compatible installed CLI or the pinned npm fallback and defines the `inbox` command used below. Keep that selected prefix and inbox environment for the whole operation.

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

## Publish a snapshot

Run `inbox remote status` first. Use the same selected CLI and `HTML_INBOX_HOME` throughout the operation, preserving existing port, exposure, and Tailscale settings. Cloudflare operations do not require starting or reconfiguring the live viewer. If setup is missing, use the setup branch; if an operation is pending, use the recovery branch before publishing.

Publish the complete current library:

```sh
inbox remote publish
```

Treat the printed production capability URL as authoritative. Open it when browser verification is available, check the library search and at least one document, and report any verification limitation. Do not construct a URL after a failed command.

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

In an interactive terminal, omit `--yes` to confirm at the prompt. If the command preserves intent or loses its response, run `inbox remote reconcile` instead of issuing another revoke.

Revocation is complete when status reports the new empty production deployment and the previously shared capability is absent from the production site. State that historical deployment URLs may still exist.

## Security boundary

A remote capability URL is an unlisted bearer link, not authentication. Anyone who receives it can read and reshare the complete snapshot. Reveal the exact printed production reader URL only in the direct user handoff, and never claim revocation deleted Cloudflare deployment history. Keep private viewer control URLs, tokens, process records, and remote state out of reader handoffs. Report browser rendering only for checks actually performed.

When the user is migrating an existing library or needs the full operational caveats, read the [remote migration guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/remote-migration.md) before acting.
