---
name: html-inbox-remote
description: Deploy HTML Inbox snapshots to Cloudflare Pages. Use when the user wants to configure, publish, inspect, recover, or revoke a remote inbox.
---

# Remote HTML Inbox

Operate the remote static snapshot of the local HTML Inbox. The local library remains the document source of truth; this skill never edits stored documents. Use [`html-inbox`](../html-inbox/SKILL.md) when the request is only to publish a document locally or operate the localhost viewer.

## Choose the operation

Classify the request as setup, publish, inspect or recover, or revoke. Do not run a different remote mutation because it seems like a useful follow-up.

This step is complete when exactly one operation below matches the user's request.

## Set up a target

Confirm the Cloudflare account ID and Pages project name. Do not invent either value. Authenticate through Wrangler browser login or an inherited `CLOUDFLARE_API_TOKEN`; never ask the user to paste a token into chat or put it in a command argument.

Run:

```sh
html-inbox remote init \
  --account <cloudflare-account-id> \
  --project <pages-project-name>
```

Prefer a dedicated project. If the project already exists, stop and explain that `--adopt` authorizes HTML Inbox to replace its complete deployed contents. Use `--adopt` only after the user explicitly chooses that project.

Setup is complete when `remote init` succeeds and `html-inbox remote status` reports the intended account and project with no pending operation.

## Publish a snapshot

Run `html-inbox remote status` first. If setup is missing, use the setup branch; if an operation is pending, use the recovery branch before publishing.

Publish the complete current library:

```sh
html-inbox remote publish
```

Treat the printed production capability URL as authoritative. Open it when browser verification is available, check the library search and at least one document, and report any verification limitation. Do not construct a URL after a failed command.

Publishing is complete when the command records a successful deployment, prints the production capability URL, and the expected snapshot has been verified or the verification limitation is explicit.

## Inspect or recover

Inspect without mutation:

```sh
html-inbox remote status
```

When status reports preserved intent, an ambiguous deployment, or another pending operation, reconcile before retrying anything:

```sh
html-inbox remote reconcile
```

Reconciliation checks Cloudflare deployment history for the recorded snapshot digest and avoids a duplicate deployment when the earlier request succeeded remotely.

Recovery is complete when status reports no pending operation and its local receipt agrees with the resolved Cloudflare deployment.

## Revoke the production capability

Revoke only when the user explicitly asks to withdraw the currently shared production route. Explain first that revocation replaces the production snapshot and rotates its capability, but cannot erase older immutable Cloudflare deployment URLs.

Run:

```sh
html-inbox remote revoke
```

Use `--yes` only for an already-authorized non-interactive revoke. If the command preserves intent or loses its response, run `html-inbox remote reconcile` instead of issuing another revoke.

Revocation is complete when status reports the new empty production deployment and the previously shared capability is absent from the production site. State that historical deployment URLs may still exist.

## Security boundary

A remote capability URL is an unlisted bearer link, not authentication. Anyone who receives it can read and reshare the complete snapshot. Reveal it only in the direct user handoff, and never claim revocation deleted Cloudflare deployment history.

When the user is migrating an existing library or needs the full operational caveats, read [`docs/remote-migration.md`](../../docs/remote-migration.md) before acting.
