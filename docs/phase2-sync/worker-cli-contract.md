# Worker and CLI integration contract

Coordinator decisions from read-only task `phase2-worker-cli-contract-20261024-a`, accepted before worker implementation. The protocol writer remains the only source writer until its phase is terminal. Recheck its final interface guide before dispatching the worker writer. This contract preserves the approved proposal, `architecture.md` and `protocol-contract.md`.

## Commands

Ordinary sync commands use existing inbox selection and `--json`. Configuration/enrollment require an existing registered named inbox. Offline maintenance has a separate explicit-home path that does not probe copied endpoints.

```text
sync enroll --inbox <name> --yes
sync configure --inbox <name> --config <absolute-runtime-json>
sync status [--document <local-id>]
sync mapping add --config <absolute-mapping-json>
sync mapping remove <route-uuid> --revision <current>
sync mapping reconnect <route-uuid> --revision <current> --config <absolute-json>
sync target set <destination-uuid> --peer <peer-uuid>
sync target clear
sync run [--route <uuid>]
sync retry --route <uuid>
sync pause
sync resume
sync worker enable
sync worker start [--foreground]
sync worker startup
sync worker status
sync worker stop
sync worker disable
sync worker wake
sync worker supervisor render --platform <systemd|launchd> --user <normal-user>
sync worker supervisor status --definition <absolute-definition>
sync restore inspect --home <canonical-home>
sync restore quarantine --home <canonical-home> --expect-inbox <uuid> --yes
sync fork --home <canonical-home> --expect-inbox <uuid> --yes
publish <existing-options> [--wait-ms <ms>] [--request-timeout-ms <ms>]
  [--target-inbox <uuid> --target-peer <uuid>]
```

Use discriminated parsed commands, validated numeric bounds and existing selection extraction; do not pass raw flag dictionaries into implementation. Mapping input supplies expected current revision and scope. The store supplies next revision, reconnecting state and cleared error. A user cannot set active state in a configuration file. Each endpoint resolves and validates its own named inbox UUID locally. Source/destination names and audience are displayed, never merge keys. Unverified audience information is explicitly unknown.

Enable persists enablement and attempts verified startup. Startup failure still reports enabled true. Start requires enablement. Startup starts enabled workers and otherwise returns a successful skipped result. Stop stops the current process; later authorized work/publish may restart an enabled worker. Disable persists enabled false before stopping. Neither detaches mappings. Status/render/inspection/maintenance never start workers.

Pause persistently stops every locally initiated replication operation, including pull, retry, holdings and probes. Authorized incoming pushes may still be accepted and queue onward work. Display that distinction. Resume restores scheduling; explicit retry clears retry-blocked work. Run makes one bounded pass through the owned runtime, or a temporary runtime holding the same exclusive ownership. There is never a second concurrent scheduler for one inbox.

## Durable local configuration and status

Private runtime configuration is bound to inbox UUID and canonical home/device/inode anchor, and replaced under store serialization. It contains schema version, intended target `{peerId,destinationInboxId}` or null, optional listener `{host,port,tlsRef}`, foreground/request/reconciliation timings, opaque credential reference to canonical absolute file mappings, explicit CA references with null meaning system trust, and server TLS certificate/key file references. Validate unknown input once, reject unknown fields, bound reads and check ownership/regular-file/link/private-key permissions. Credentials and private keys never appear in argv, status, logs, mapping JSON or supervisor definitions.

The worker's own immediate-peer UUID is its local inbox UUID. This is a fixed per-inbox identity convention, exposed as `peerId` in local status and used consistently by both ingestion and reconciliation. Remote peer and destination bindings remain separately validated fields even when their UUID values coincide. A fresh fork changes the local peer identity together with the inbox identity and clears copied runtime authority. No additional machine discovery or peer-identity file is needed.

Configuration performs no pairing, reachability-based authorization, service installation, firewall/Tailscale setup or trust discovery. Both endpoints receive explicitly approved matching route configurations separately. Runtime references are never taken from wire paths.

Defaults and bounds: foreground wait 30,000 ms within 100–300,000; absolute request deadline 5,000 ms within 100–30,000 and shortened to remaining budget; periodic reconciliation 30,000 ms within 1,000–300,000; pass deadline 60,000 ms; one outgoing transfer; transient backoff 1 second to 5 minutes plus jitter; 20 consecutive transient failures persist blocked state. Follow protocol resource limits and preserve attempts/errors on repeated holdings observations.

Status shows selected inbox/name/home, enabled, verified running or unknown, process state, retry pause, ingestion disabled/listening/failed, intended target, boot-supervision observation and setup reasons. Per-route fields include revision/state/target, terminal-history readiness separately from fully reconciled checkpoint, pending/blocked/detached counts, attempts, next retry and last error. A persisted bootSupervised boolean is not evidence of current supervision. Narrow locked enabled/pause/run-result mutations must replace whole-object worker updates that can overwrite concurrent changes.

## Owned worker lifetime

Use separate private startup lock, lifetime ownership lock, record and log under the selected sync area. Never reuse viewer records, locks, ports, control tokens, service names or Tailscale journals. The runtime record binds schema, inbox/home anchor/incarnation, process identity/random ownership token, PID/process-start identity, loopback control origin/token, start time and config revision.

Control binds an ephemeral 127.0.0.1 port, validates its origin before contact, and uses a private random header token. It provides status, bounded run/wake, ticket cancellation, route quiescence and stop only. Mutations bind expected process ID, inbox and incarnation. Ingestion exposes only the HTTPS replication protocol; peer sync credentials never authorize administration.

Detached startup uses a known child, private handshake and finite readiness deadline, then disconnects/unrefs. Readiness proves ownership, identity, configuration, control and configured ingestion listeners. The child owns the lifetime lock. Conclusive dead-owner checks and ownership recheck permit recovery; unknown/live records block and PID reuse never authorizes killing the replacement process.

Stop uses authenticated control, stops admission, aborts current requests, closes listeners, finishes bookkeeping and removes only owned records. Never signal a saved PID as fallback. Startup code may terminate only a child it just created and still owns. Viewer shutdown leaves worker/ingestion intact.

Startup, explicit wake, delayed execution after suspend and observed network recovery trigger catch-up. Compare wall and monotonic progress for scheduling gaps, run an independent periodic pass, and coalesce triggers. Every pass examines all eligible outbound current inventories even with no pending outbox and independently reconciles inbound mappings. Preserve persistent blocked/backoff state.

## Boot supervision

Render templates to stdout only, named with inbox UUID. Invoke absolute Node and CLI paths with `sync worker start --foreground --home <canonical-home>`. Systemd uses a normal user/group, explicit environment/working directory, UMask 0077, Restart on failure, bounded restart/stop and multi-user startup. LaunchDaemon uses normal UserName, explicit arguments/environment, RunAtLoad, unsuccessful-exit restart, throttle, bounded shutdown and private logging. A LaunchAgent means login startup, not reboot supervision.

Document installation/inspection/removal without executing them. Existing viewer service commands stay independent. Boot supervision is true only when exact definition, manager enablement/registration and verified matching process are observed. Rendering, enablement and detached startup alone leave setup required. Unknown manager state stays unknown. Development tests use recording manager commands and an owned fixture supervisor; no live service-manager calls or installations are authorized here.

## Managed publication and cancellation

Preserve unenrolled publication behavior. Managed publication validates input/target, then atomically saves original, descriptor, obligations and that publication's intended target. Later target-setting changes cannot rewrite the publication intent. Pin target by peer plus destination UUID, never alias/URL/route order. Several approved routes to that target can satisfy one server-custody promise. Removing a route never selects another server; no authorized route to the intended target is visibly blocked.

Begin the overall foreground deadline after durable local commit. Include worker startup, scheduling, request and receipt persistence. Use the actual owned protocol runtime. Viewer startup/reuse remains, but any viewer error is separate from the saved publication and cannot extend the delivery deadline or erase the saved result.

Managed JSON emits one final object with command/schema, document local/canonical identity/fingerprint, durable-local/queued state, viewer URL/state/error, delivery state/target/reason/receipt/cancelled/retries-enabled, worker enablement/running/boot/setup state, and onward not-awaited. Progress/warnings use stderr. Plain output explicitly says saved locally and pending/blocked/confirmed for the named intended target.

Exits: 0 for valid committed intended-server custody or explicitly unconfigured local-only save; 2 for durable local delivery pending; 3 for durable local delivery blocked; 1 for validation/persistence/queue/uncertain durability errors; 130 for SIGINT after durable save, after printing the saved/pending result. Suppressed/superseded/terminal dispositions, readiness and HTTP acceptance do not confirm live body custody. Intended-server confirmation never implies onward completion.

Timeout/SIGINT cancels the foreground ticket/current attempt where possible, preserves report and durable obligations, and does not consume transient-failure allowance or pause future retries. Independent shared background work can continue. An uncertain remote commit resolves idempotently; completed remote commits cannot be undone.

## Removal and reconnect

All production network attempts belong to the exclusive runtime. Remove stops route admission, durably revokes current revision, invalidates sessions/transfers, aborts/drains bounded current attempts, and reports success only after local quiescence. If drain fails, report removed true/quiesced false with blocked/error exit. Retain detached copies and terminal history. No old-revision starts, polls, retries, wake probes or deletion-only grants survive restart or explicit retry.

Explicit reconnect revalidates identities/scope under a fresh matching revision on both endpoints. Reject mismatched revisions with setup guidance, never advance from remote observation. Use the protocol terminal-first handshake and distinct full-reconciliation checkpoint, including for new route IDs referencing retained copies. Incomplete/untrusted history stays blocked without guessed deletion.

## Enrollment and offline identity maintenance

Keep viewer protocol version 3 for compatible control behavior. Add optional health capabilities for managed ledger schema 1 and dynamic format switching, plus locally anchored runtime evidence needed for ownership. Missing capability means unsupported for enrollment. Acquire viewer-start exclusion and prove same-home local ownership before any enrollment probe or migration write. A copied/old/unanchored ambiguous record must not be contacted to discover its owner. A verified capable running viewer can remain; an old/unverified viewer blocks enrollment before intent/barrier. Do not globally reject old viewers for unenrolled libraries. Document that undiscoverable unsupported readers/mutators must be stopped/upgraded before enrollment.

Before any managed lifecycle operation, check local marker/ledger/home anchor/reader identity before credential resolution, peer/control probes or service management, including direct viewer helpers, raw-home selection and service paths. Recognize a managed format barrier with missing/corrupt ledger as unsafe; do not fall back to ordinary endpoint contact.

Offline inspect/quarantine/fork requires canonical home and expected old UUID. Treat copied runtime records as untrusted data. Never contact or stop original processes through copied records. Prove same-home runtimes quiescent and hold lifecycle/start exclusions for an in-place identity change; live/unknown ambiguous ownership blocks. Quarantine disables signing/workers/grants/receipts/checkpoints; clear copied runtime references, intended target and control records before any startup. Fork creates fresh future UUID/epoch while retaining inherited identities/tombstones as detached imports.

Catalog identity replacement is an explicit recoverable compare-and-replace of only the expected name/home/old UUID. Persist transition intent and finish only that recorded transition after interruption. Existing registration cannot repair a duplicate binding by guessing. Unexplained mismatch blocks. Trusted recovery of old owner history remains unavailable; fresh fork is the supported continuation. An indistinguishable full restore cannot be automatically detected.

## Acceptance

Use actual CLI and worker subprocesses, real protocol handlers/client/store, synthetic loopback HTTPS, temporary homes/catalogs/credentials and owned fault proxies. Prove worker survives publisher/viewer exit; source/relay restart; timeout/SIGINT/lost ACK queued recovery; fixture supervisor restart; injected/controlled scheduling gaps and simulated disconnect recovery; empty-outbox repair and blocked-state preservation; removed route zero starts across every endpoint after fence/timer/wake/retry/restart; tombstone-first reconnect; intended-target/duplicate-route behavior; old viewer blocked before migration versus capable viewer surviving enrollment; copied records causing zero original-process control/signals; safe dead/PID-reused/malformed owner handling; interrupted fork/catalog transition and inherited export restrictions; all children reaped and listener ports released.

These are synthetic/local proof obligations. No actual OS suspend/reboot, real two-host LAN/Tailscale, production supervision, pairing or deployment is authorized or established.
