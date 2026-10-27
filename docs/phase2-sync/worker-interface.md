# Worker and CLI public test interface

This guide defines the runtime JSON and public fixture interfaces. Actual CLI, owned-worker lifetime, terminal relay and cancellation regressions run on Node 24.19.0 and Node 20.20.2. Earlier receipts are in `verification.json`, `acceptance.md` and `review-triage.md`; current QA corrections and their verification status are in `qa-followup.md`. The approved `worker-cli-contract.md` remains authoritative.

## QA worker correction interface

`startOwnedSyncWorker(home, { temporary?, testHooks?, onFatalStop? })` adds an optional no-argument `onFatalStop` notification. Its runtime return shape and `close(): Promise<void>` are unchanged. Fatal state-read, unrecoverable failure-bookkeeping and cleanup failures notify once. Observation cannot prevent shutdown; observer throws or rejected promises are handled. The reusable library does not change process exit status. Explicit close callers still receive cleanup rejection.

Shutdown attempts independent listener cleanup, stops scheduling and settles outbound work and admitted inbound mutation handlers before releasing lifetime ownership. Ingestion drainage is bounded by its existing `requestMs`; failure retains uncertain authority names while disposing the retained ownership descriptors. An unsuccessful close cannot claim quiescence. Successful authenticated stop/disable, signals, validated configuration/incarnation replacement and temporary completion stay normal. Route blocks, backoff, pause, cancellation and removal retain their existing behavior.

Fatal cleanup before readiness also notifies once and preserves both the original acquisition/preflight failure and the cleanup failure. Ordinary startup errors with successful cleanup remain ordinary errors. Observer failure cannot interrupt cleanup or change library process-exit state. The additive ownership result method `closeHandles()` closes descriptors without removing authority names; `release()` performs validated namespace release. Their coordinated outcomes prevent disposal followed by a false successful release. See [the shutdown/ownership contract](qa-shutdown-ownership-contract.md) for error and concurrency rules.

The foreground CLI maps fatal notification to exit 1 and one fixed stderr line, also captured by existing detached/supervisor logging:

```text
html-inbox: Sync worker stopped after an unrecoverable state or cleanup failure; inspect the inbox before restarting.
```

No original exception, path, stack, credential reference or control record is appended. A fatal temporary `sync run` returns its existing cancelled/error ticket shape with `worker-pass-failed`, rather than success or ordinary deadline-pending. An unsafe ledger does not receive a new persisted failure schema.

Publication finalization applies SIGINT precedence after its final viewer/status waits and any best-effort ticket cancellation, immediately before forming JSON and the exit code. Late cancellation therefore returns exit 130 with cancelled/pending/null returned receipt, while a real completed remote commit remains committed. It attempts cancellation at most once for the exact foreground ticket submitted by that publication, using the existing overall-deadline/150ms control bound. It does not cancel other tickets or background work, pause retries or erase saved data. A failed or expired cancellation remains best-effort. A validated, uninterrupted intended-server confirmation is preserved without a redundant receipt lookup.

Outgoing credentials resolve from the latest validated configuration for each currently eligible route immediately before its reconciliation. Listener startup resolution is unchanged. A token-file replacement does not clear a permanent failure; explicit retry is still required. The correction prevents a pass-wide old token from consuming a later route's explicit retry. It does not claim to fence every request already active at retry.

The separate [fatal](qa-fatal-worker-contract.md) and [credential](qa-route-credential-contract.md) gates define these corrections. [QA follow-up](qa-followup.md) records current test/review qualifications; combined verification and physical corrected-SHA acceptance are separate gates.

## Configuration

Write JSON files privately, mode 0600, at canonical absolute paths. Credentials are separate private files containing canonical base64url random tokens, never fields in mapping JSON or command arguments. The runtime configuration is committed inside the inbox ledger under its mutation lock and inherits its UUID/home/device/inode binding.

```json
{
  "schemaVersion": 1,
  "intendedTarget": {"peerId": "<receiver-inbox-uuid>", "destinationInboxId": "<receiver-inbox-uuid>"},
  "listener": {"host": "127.0.0.1", "port": 43210, "tlsRef": "server"},
  "timings": {"foregroundMs": 30000, "requestMs": 5000, "reconcileMs": 30000, "passMs": 60000},
  "credentials": {"paired": "/canonical/temp/token"},
  "trust": {"private-ca": "/canonical/temp/ca.pem", "system": null},
  "tls": {"server": {"key": "/canonical/temp/key.pem", "cert": "/canonical/temp/cert.pem"}}
}
```

All shown fields are required. Set `listener` and `intendedTarget` to null when unconfigured. Empty reference objects are valid without routes/listening. References are opaque local names. Each configured active route must resolve its credential and trust references. A listener's TLS reference must resolve locally. No input field can enable a worker or set supervision evidence. Tests bind only loopback. Explicit validated unicast LAN/Tailscale configurations can be tested without starting listeners.

Mapping input has this shape, with the existing origin grants from `sync-model.ts`:

```json
{
  "schemaVersion": 1,
  "expectedRevision": 0,
  "route": {
    "id": "<route-uuid>",
    "direction": "outbound",
    "peerId": "<immediate-peer-inbox-uuid>",
    "peerUrl": "https://127.0.0.1:43210",
    "sourceInboxId": "<source-inbox-uuid>",
    "destinationInboxId": "<destination-inbox-uuid>",
    "localInboxName": "source",
    "readerAudience": "unknown",
    "allowedOrigins": [{"inboxId":"<origin-uuid>","historyEpoch":"<origin-epoch>","publicKey":"<Ed25519-public-PEM>","completeHistory":true,"redistribute":false}],
    "credentialRef": "paired",
    "tlsTrustRef": "private-ca"
  }
}
```

An add uses expected revision zero. A reconnect names the existing ID in both file and argv, and the same expected current revision in both places. The store supplies next revision, reconnecting state and null error. Each endpoint gets its own explicit matching configuration with its own local registered name and direction. Remote audience is unknown unless independently established. The immediate local peer ID always equals that inbox's UUID. Mapping output exposes the resulting `route` with its assigned revision/state.

Run the actual CLI with `process.execPath` and absolute `packages/cli/dist/index.js`. Use isolated HOME, HTML_INBOX_CATALOG_HOME, XDG paths and explicit selection. Create a registered inbox, then enroll headlessly when no viewer runtime or service ambiguity exists. A capable viewer has local ownership evidence in viewer.json and optional protocol-3 capabilities. An older or unanchored existing viewer blocks enrollment before migration intent or endpoint contact. A verified capable running viewer may remain during enrollment. No reader must be started for enrollment or worker operation. Do not use the protocol fixture's arbitrary peer IDs with owned workers; its peer ID must be the inbox UUID.

## JSON results

Managed publication emits exactly one final JSON object on stdout. Progress goes to stderr.

```text
schemaVersion: 1
command: "publish"
inbox: {id, name, home}
document: {localId, originInboxId, originDocumentId, historyEpoch, version, fingerprint}
local: {durable: true, queued: boolean}
viewer: {url: string|null, state: "running"|"failed", error: string|null}
delivery: {
  state: "confirmed"|"pending"|"blocked"|"local-only",
  target: {peerId,destinationInboxId}|null,
  reason: string|null,
  receipt: DurableReceipt|null,
  cancelled: boolean,
  retriesEnabled: boolean
}
worker: {enabled,running,processState,retryPaused,ingestion,bootSupervised,setupReasons}
onward: {awaited:false}
```

Publish exits 0 for exact current intended-server committed custody or unconfigured local-only save, 2 for durable pending, 3 for durable blocked, 130 for SIGINT after save, and 1 for validation/persistence/uncertain errors. Viewer failure is reported independently. Only `store.deliveryStatus().isCommitted` can support confirmed delivery. Target changes after commit do not change that document's ledger publication intent.

Status uses `{schemaVersion:1,command,inbox,peerId,target,worker,routes,document}`. `document` is null without `--document`; otherwise it describes the pinned publication target and current per-route delivery. Per-route retry scheduling covers identity/manifest/pull/holdings failures even with an empty outbox. Its attempts/backoff/blocked state is persistent and separate from the per-item delivery attempts. Periodic healthy routes still check current holdings and independent pull. Wake does not reset errors or backoff; `sync retry --route` is explicit.

## Ownership and fixture seams

`startOwnedSyncWorker(home, {temporary?,testHooks?})` in `sync-worker.ts` starts the actual ingestion/reconciliation engine while holding the exclusive lifetime lock. It returns `{record,requestRun,cancel,requestWake,quiesce,status,close,tick}`. Constructor-injected hooks are `wallNow()`, `monotonicNow()` and `onEvent({type,processId})`, with ready/pass/gap/closed events. No production fault environment variable is read. Controlled gap tests can change their clocks and invoke `tick()`. Never use a second reconciler alongside the owned runtime.

A run request is `{ticketId:<uuid>,routeIds?:[<uuid>],deadlineAt:<absolute-ms>,requestMs:<100..30000>}`. The deadline also bounds queued waiting. Control polling reports queued/running/complete/cancelled tickets. Cancellation applies only to that ticket and preserves durable retries. Background wake coalesces. Pausing fences every locally initiated operation while incoming pushes remain authorized.

The detached child handshake uses the parent-child IPC channel. Foreground supervisor mode emits its public readiness/status result after runtime ownership and both configured listeners are ready. Clean up detached workers through `sync worker stop --home <canonical-home> --json` while the original synthetic home is intact. The stop path verifies local anchor, incarnation, process start identity, lock ownership and authenticated control. It never signals a saved PID. Only a fixture's directly retained ChildProcess may be signalled for a deliberate crash. Reap that child and verify the exact listener ports can be rebound. Treat copied runtime files as untrusted data; never contact their original endpoints. Remove temporary credentials after every child is stopped.

Source dependencies added by this phase include sync-runtime-config.ts, sync-lifecycle.ts, viewer-ownership.ts, sync-worker-records.ts, sync-worker.ts and sync-cli-args.ts. Additional source dependencies are sync-worker-client.ts, sync-cli.ts, sync-publication.ts, sync-enrollment.ts, sync-maintenance.ts, sync-supervisor.ts and sync-public-definition.ts. Existing modified dependency files include index.ts, cli-args.ts, publish-input.ts, sync-store.ts, sync-ledger.ts, sync-model.ts, sync-files.ts, sync-client.ts, sync-reconciliation.ts, inbox-catalog.ts, inbox-selection.ts, viewer-start-lock.ts, viewer-records.ts, viewer-http-server.ts, viewer-process.ts, viewer-server.ts, viewer-status.ts, viewer-service.ts, viewer-service-status.ts, viewer-tailscale.ts and tailscale-command.ts. Refresh the final packages/cli/src dependency snapshot from the app-bound feat-phase2-sync worktree, preserving the independent test ownership below. The complete tracked/untracked hashes and exact commands/results are recorded in /tmp/html-inbox-review-fixes-x29ef0vu for the corrective handoff; the earlier implementation checkpoint remains in /tmp/html-inbox-worker-receipts-0wf8lngb. Do not overwrite independent filenames sync-worker-faults.test.ts, sync-worker-fault-fixtures.ts, sync-identity-faults.test.ts, sync-identity-fault-child.ts, sync-protocol-faults.test.ts, sync-protocol-fault-child.ts, sync-reader-compatibility.test.ts or scripts/sync-reader-browser.test.mjs.

## Platform coverage

Managed store/protocol/storage-fault/worker positive suites explicitly skip on Windows because managed enrollment requires POSIX file/directory fsync. The portable TLS fixture suite remains active. sync-platform.test.ts exercises opt-in rejection before mutation and ordinary unenrolled publication. On Linux it simulates the Windows platform in an isolated child and labels that limitation; it is not a claim of native Windows execution.

The checked optional worker record reader uses same-handle private reads, treats ENOENT during normal removal as absent, and retries only the exact changed-during-open race within four attempts. Permission, schema, link, ownership and identity errors remain failures. This is separate from the catalog's ten-attempt zero-link retry.

Foreground viewer inspection passes its absolute deadline/cancellation through existing Tailscale recording-command paths. This changes no route ownership or commands and introduces no viewer administration endpoint. Same-home viewer shutdown retains existing verified ownership/health behavior.

Verified terminal offers drain before complete-inventory creation through the same authenticated offer/apply/receipt path. `ManagedSyncStore.pendingTerminalStates(auth)` returns only current eligible pending signed deletions, with route/revision/scope and backoff checks; it reads no HTML. `trusted-history-unavailable` identifies a live-history fence separately from storage/transport errors. Its route wait is periodic with zero transport-failure attempts; newly due terminals can pass that history-only delay. Genuine blocked/backoff entries, detached routes, pause, bad TLS/auth/scope and local validation errors retain their fences. No terminal drain activates live state or advances a complete checkpoint. Failure bookkeeping checks cancellation/deadline between durable updates.

Review corrections add sync-failure.ts and sync-ledger-policy.ts as shared deterministic dependencies, plus viewer-service-owner.ts for administrator orchestration. The owner preflight enters the CURRENT CLI bundle through a fixed internal read-only action after the existing clean-environment groups/GID/UID drop. It returns only home/UUID/managed/configuration observations, never ledger or control authority. Administrative service selection, saved configuration and independently callable service/status helpers validate as the verified selected normal account before manager/control contact; installed removal/status use the saved account only after fresh account-binding verification. Saved configuration reads are read-only. Ordinary owner-only lifecycle and private-file guards remain unchanged.

Existing catalog fork intent is validated and flushed, then its containing catalog directory is flushed under registration exclusion, before an identity callback may commit. EIO/ENOSPC retains the selected transition and prevents that callback. Audit quarantine shares the same route revision fence as revoke/restore, clears dependent retries and invalidates attempts after durable commit. Public CLI result fields and exit codes are unchanged by these corrections.

The publisher records an exact-ticket submission attempt before awaiting the control acknowledgement. On SIGINT, uncertain acknowledgement still permits the existing bounded, at-most-once cancellation for that ticket. This does not prove admission or custody. A publication that never dispatches a run requests no ticket cancellation. Successful acknowledgement remains separate for error classification.
