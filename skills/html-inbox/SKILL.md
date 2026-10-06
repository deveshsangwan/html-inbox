---
name: html-inbox
description: Publish HTML artifacts to the local HTML Inbox. Use when the user wants to publish or open an HTML file in HTML Inbox, operate its localhost viewer, or diagnose a rejected document.
---

# HTML Inbox

Publish a finished HTML artifact into the local private document library. `publish` stores the original bytes, starts or reuses the localhost viewer, and prints the document URL.

This skill owns local publishing and viewer operation. For Cloudflare setup, remote publishing, recovery, or revocation, use [`html-inbox-remote`](../html-inbox-remote/SKILL.md).

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

Quote paths and metadata when they contain shell-significant characters. Preserve inherited `HTML_INBOX_HOME` and `HTML_INBOX_PORT`. Set or change either only when the user requested another library or port.

Publishing is complete only when the command exits successfully and prints a URL such as `http://127.0.0.1:3217/documents/<id>`. Treat that printed URL as authoritative; do not construct or report one after a failed command.

### 3. Verify the artifact

Open the printed URL when visual correctness matters. Check that the document shell loads, the title and type are correct, and the iframe renders the expected content. For charts, external assets, or other runtime-dependent output, also check the browser console and failed network requests; publish success proves storage, not rendering.

Verification is complete when the expected content is visible without relevant console or network failures. If browser verification is unavailable, report that limitation instead of claiming the artifact rendered correctly.

### 4. Hand off

Give the user the printed document URL and identify the published title and type. Mention a custom home or port only when one was used.

The handoff is complete when the user has a clickable URL and any verification limitation is explicit.

## Validation gate

The source must be a regular `.html` or `.htm` file containing valid UTF-8 and an explicit `<html>` tag or `<!doctype html>` declaration. The default size limit is 10 MiB.

Blocking HTML policy errors reject publishing. These include `javascript:` or `vbscript:` URL attributes, navigation to `data:` URLs, `<meta http-equiv="refresh">`, and `<a>` or `<area>` links with non-HTTPS schemes or protocol-relative URLs. HTTPS, relative, and fragment links are allowed.

Inline scripts and the supported Tailwind browser and Mermaid v11 script entry points are allowed. Inline event handlers, `<base>`, and non-allowlisted external scripts or asset URLs produce advisory warnings. Publishing continues, and the viewer CSP blocks the warned features.

When publishing fails, preserve the exact error, fix the named condition in the source, and retry the same publish contract. Do not bypass validation, weaken viewer security, or claim that a CDN works without rendering it in the viewer.

When publishing succeeds with warnings, preserve the printed URL, report the warnings, and verify the affected behavior in the viewer. Replace any required blocked feature with supported markup before republishing.

## Operate the viewer

`publish` normally starts or reuses the viewer. Start it directly only when the user wants a long-running viewer process or when diagnosing startup:

```sh
inbox viewer
```

Defaults and overrides:

- Viewer: `http://127.0.0.1:3217`
- Health check: `http://127.0.0.1:3217/health`
- Library: `~/.html-inbox`
- Override library: `HTML_INBOX_HOME=/path/to/inbox`
- Override port: `HTML_INBOX_PORT=4321`

If a healthy viewer on the requested port uses a different library, choose another port rather than stopping or reusing an unrelated process. The health response is the readiness signal; process creation alone is not.

## Security boundary

The local viewer is loopback-only and stores each document's original HTML unchanged. It renders that HTML on a dedicated path inside a sandboxed iframe with a Content Security Policy; it does not sanitize the stored file. Do not present an accepted document as safe to open outside the viewer.

When changing implementation or security policy rather than operating the CLI, first read [`docs/architecture.md`](../../docs/architecture.md) and [`docs/threat-model.md`](../../docs/threat-model.md).
