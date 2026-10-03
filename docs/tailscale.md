# Tailscale viewer integration

HTML Inbox uses an existing installed, signed-in Tailscale CLI. It never installs a client, logs in, changes access policy, enables Funnel, or resets Serve configuration. Reader access follows the user's tailnet policy. Publishing, deletion and process control stay in the local CLI.

Before using explicit Tailscale exposure, the node must be running, online and unexpired. Its connected tailnet must have MagicDNS enabled and HTTPS certificates available for its exact device hostname. The normal user running HTML Inbox needs permission to manage Serve through the existing daemon. If permission is denied, ask the server administrator to grant that user operator access. HTML Inbox never runs sudo. See the official [Serve guide](https://tailscale.com/docs/features/tailscale-serve) and [HTTPS prerequisites](https://tailscale.com/docs/how-to/set-up-https-certificates).

The connected node must also advertise its already-enabled `https` capability in `Self.CapMap`. The current CLI checks that capability before its feature-consent flow. HTML Inbox refuses startup if it is absent, even if a certificate domain appears in status, so the integration cannot start that consent flow.

The reader binds to `127.0.0.1`. Serve terminates tailnet HTTPS on the connected node's hostname at port 443 and proxies the root route to the reader's loopback port. HTML Inbox verifies the node ID, device hostname, HTTPS listener and exact proxy target before returning `https://device.tailnet.ts.net`. It does not parse the human-readable URL printed by the CLI.

The HTTP foundation must allow the exact prepared hostname, ignore forwarded and Tailscale identity headers for authorization, and return only `{"ok":true}` from the reader's `/health`. Identity belongs to the separate private loopback control endpoint. The module checks reader health with both the tailnet Host and a loopback Host before configuring Serve. A reader exposing process or inbox identity fails this check.

## Worker contract

`packages/cli/src/viewer-tailscale.ts` exports these public boundaries:

```typescript
interface TailscaleViewerOptions {
  home: string;
  backendPort: number;
  instanceId: string;
  processId: string;
}

interface PreparedTailscale extends TailscaleViewerOptions {
  nodeId: string;
  hostname: string;
  url: string;
  executable: string;
}

interface TailscaleCommandOptions {
  executable?: string;
  timeoutMs?: number;
}
```

1. Create the persisted inbox instance UUID and a fresh viewer process UUID.
2. Call `prepareTailscale(options, command?)`. It inspects identity, prerequisites and the full existing Serve/Funnel configuration without changing Tailscale. Port zero is allowed for this preflight.
3. Start the loopback reader and separate private control listener with `prepared.hostname` in the reader's Host allowlist.
4. Call `startTailscale({...prepared, backendPort: actualPort}, command?)`. The actual backend port must be nonzero. Report readiness only after this call succeeds.
5. Save the public URL and absolute `prepared.executable` in the lifecycle's private configuration. Restore that executable through `HTML_INBOX_TAILSCALE_COMMAND` in detached workers and boot services. An explicit command option takes precedence; otherwise preparation uses that environment variable or the existing `PATH`.
6. On startup failure or shutdown, close both HTTP listeners and call `cleanupTailscale(home, {instanceId, processId}, command?)`. Surface failures and preserve the ownership journal for recovery.

`getTailscaleStatus(home, command?)` returns mapping state `running`, `stopped`, `drift` or `unavailable`. Only a verified active mapping returns a public URL. `running` describes the mapping, so the lifecycle must also verify its private control endpoint before reporting a running viewer. A pending startup, changed route or mismatched node is never reported as a usable URL.

The lifecycle must check retained ownership even when the next startup requests loopback or LAN exposure. A stale mapping can still proxy the same backend port. Require verified cleanup before changing exposure or reusing that port. The lifecycle owns its home/process lock and authoritative process identity.

## Ownership and recovery

The private `tailscale-serve.json` journal has mode `0600` in the `0700` inbox home. It stores the connected node ID, exact hostname, root mount, HTTPS port, loopback proxy, absolute executable and inbox/process UUIDs. Startup writes a pending journal before its mutation and marks it active only after verification. Repeated starts reuse only a route that exactly matches a valid journal for the same inbox and backend port. A matching target without a journal is still somebody else's configuration.

Startup preserves unrelated path mounts, ports, named Services and foreground configurations. An occupied root route, TCP/HTTP listener on 443, foreground listener on 443, Funnel configuration on 443 or shared hostname listener causes refusal. Malformed JSON or an unknown routing field also causes refusal. Existing Funnel access on other ports remains unchanged.

On the reader's hostname and port 443, mounts at or below `/assets` and `/documents`, and mounts matching `/health`, conflict with the reader. This includes trailing-slash and cleaned path aliases. Serve checks exact paths before walking cleaned parent paths, with both trailing-slash and plain mounts, so `/documents/` can intercept every document and `/assets/viewer.js/` can intercept the viewer script. The root alias `//` also takes precedence over `/` during that parent walk. Startup checks these conflicts during preflight, immediately before mutation and afterward. Mount keys are not URL-decoded. Separate namespaces such as `/assets-other`, `/documents-archive` and `/metrics`, and descendants such as `/health/details`, remain untouched, as do mounts on other ports and named Services.

Cleanup first checks the journal, expected process owner, connected node and live route. Its only mutation is:

```text
tailscale serve --bg --yes --https=443 --set-path=/ off
```

The explicit root path is essential. Omitting `--set-path` can remove every path mount on that host and port. Cleanup verifies route removal and preservation of the rest of the configuration before deleting the journal. It never runs `serve reset`, `funnel`, `set-raw`, `set-config` or `clear`. If the route already disappeared, it clears the journal without a Tailscale mutation. If exact root ownership, connected node identity or Serve/Funnel listener safety cannot be verified, it leaves the journal and reports the reason.

An external mount that shadows a reader route makes status report `drift` without a URL and blocks startup. Cleanup can still remove the exactly verified owned root route while preserving that external mount. Reader-route availability and cleanup ownership are separate checks; move the conflicting mount manually before starting the viewer again.

Retry `viewer stop` after restoring the existing client connection or permissions. Inspect `tailscale serve status --json` and the private journal when recovering drift. Do not use a global reset. A failed startup attempts the same verified, scoped cleanup; if it cannot verify ownership, it leaves the pending journal and reports both failures.

Mutations use a private temporary node lock shared across inbox homes for the same normal user. Another HTML Inbox operation receives a retry error instead of racing a root claim. A crashed operation can leave this lock directory. Inspect its `owner.json`, confirm that PID has exited, and remove only the named stale directory. External CLI changes can still happen between inspections. Tailscale's own configuration update uses an ETag, and HTML Inbox verifies the full unrelated configuration afterward; it cannot make separate CLI invocations into one atomic transaction.

SIGKILL during a command is an explicit recovery limit. The worker cannot release its temporary lock, so parent rollback may preserve a pending journal and report the stale lock instead of removing the route automatically. First confirm that the worker and its command process group have exited, then remove only the identified lock directory and retry `viewer stop`. The module never kills a PID from a stale record and does not reclaim locks automatically. This avoids a recovery race that could remove another process's new lock. Normal exceptions and graceful shutdown release the lock and attempt scoped cleanup.

## CLI assumptions and verification

The implementation follows the official [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve) and current Tailscale source inspected on 2026-10-04 at commit [`9128778b6515f32e13d92e7380044fe025f9b08e`](https://github.com/tailscale/tailscale/commit/9128778b6515f32e13d92e7380044fe025f9b08e), dated 2026-10-02:

- [`cmd/tailscale/cli/serve_v2.go`](https://github.com/tailscale/tailscale/blob/9128778b6515f32e13d92e7380044fe025f9b08e/cmd/tailscale/cli/serve_v2.go) defines `serve status --json`, `--bg`, `--yes`, `--https`, `--set-path`, route updates and scoped `off` behavior.
- [`ipn/serve.go`](https://github.com/tailscale/tailscale/blob/9128778b6515f32e13d92e7380044fe025f9b08e/ipn/serve.go) defines `TCP`, `Web`, `AllowFunnel`, `Foreground` and `Services`, including handler JSON and removal behavior.
- [`ipn/ipnlocal/serve.go`](https://github.com/tailscale/tailscale/blob/9128778b6515f32e13d92e7380044fe025f9b08e/ipn/ipnlocal/serve.go) defines `getServeHandler`: exact request paths take precedence, followed by cleaned trailing-slash and plain ancestor mounts. Recording regressions cover reserved reader mounts, canonical aliases, status drift and cleanup that preserves external shadow mounts.
- [`ipn/ipnstate/ipnstate.go`](https://github.com/tailscale/tailscale/blob/9128778b6515f32e13d92e7380044fe025f9b08e/ipn/ipnstate/ipnstate.go) defines `BackendState`, `Self.ID`, `Self.DNSName`, `Self.Online`, `CurrentTailnet.MagicDNSEnabled`, `MagicDNSSuffix` and `CertDomains`.
- [`cmd/tailscale/cli/serve_legacy.go`](https://github.com/tailscale/tailscale/blob/9128778b6515f32e13d92e7380044fe025f9b08e/cmd/tailscale/cli/serve_legacy.go) still implements JSON status and the feature-consent check. [`tailcfg/nodecap/nodecap.go`](https://github.com/tailscale/tailscale/blob/9128778b6515f32e13d92e7380044fe025f9b08e/tailcfg/nodecap/nodecap.go) defines the `https` capability key.

Compatibility is based on these command and JSON contracts, with no hardcoded v1.96.5 minimum. The Serve syntax changed in v1.52. Unsupported flags or JSON produce an actionable error, and the integration will not silently adopt a different schema. Commands execute directly with closed stdin, bounded output and a timeout. No setup or consent prompt is accepted.

Recording-executable tests model the reviewed source's JSON and mutation behavior using temporary homes and local HTTP readers. They never invoke the real Tailscale executable. Real tailnet access, certificate issuance, operator permissions and boot ordering require an opt-in check on a configured host and remain unverified by those tests.
