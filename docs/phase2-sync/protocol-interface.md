# HTTPS protocol and reconciliation interface

These transport and one-pass reconciliation modules are used by the owned worker described in worker-interface.md. No listener, worker or route starts when these modules are imported.

## Worker entry points

```ts
const server = createSyncIngestionServer({
  store, peerId, key, cert,
  credentials: route => ({ token: configuredToken, ca: configuredPrivateCa }),
  host: configuredLiteralAddress,
  port: configuredPort,
});
const { url } = await server.start();

const result = await reconcileSyncRoutes({
  store, peerId,
  credentials: route => ({ token: configuredToken, ca: configuredPrivateCa }),
  routeIds: approvedRouteIds,
  signal,
  deadlineMs: 30_000,
});

await server.close();
```

Imports are `sync-http-server`, `sync-reconciliation`, and `sync-store` under `packages/cli/src`. The server returns `start()`, `close()` and synchronous `status()`. Starting twice or starting after close fails. Closing stops admission, destroys owned sockets, clears sessions/transfers and waits for admitted handler promises. Successful close means an admitted mutation cannot commit afterward. The existing `requestMs` bounds drainage; expiry rejects close, so the worker retains lifetime ownership evidence. Completed remote commits remain committed. Repeated calls share the same close outcome.

An initiated native listener bind also belongs to shutdown. A second pending start rejects without another listen call. If close wins, start rejects as closed after binding settles, and successful close leaves no listener. A native bind error remains the start caller's original error. The same `requestMs` bounds pending binding and handler drainage; a timed-out close stays rejected even if its observed cleanup finishes later.

The body GET handler still detaches an unfinished read-only pin when its response closes. That pin cleans its own handle without sending late bytes. Shutdown waits for the handler, rather than the detached pin. Unexpected handler cleanup rejection is observed and preserved as a shutdown failure. Status contains listening state, URL, active session/transfer/socket counts, cached-cut bytes and request/body counters.

Server host configuration accepts an explicit literal unicast IPv4 or IPv6 address. Its default is `127.0.0.1`. It rejects unspecified/wildcard, multicast, limited-broadcast and hostname bindings. There is no interface discovery or fallback. LAN/Tailscale binding and TLS/credential provisioning must be deliberately configured by the later owner. Development fixtures bind only `127.0.0.1` or `::1`. Non-loopback configuration tests construct servers without calling `start()`.

The credential resolver is synchronous and receives a validated local route. Resolve its opaque `credentialRef` and `tlsTrustRef` from trusted configuration before returning token and CA bytes. Tokens are canonical base64url strings containing 32 to 96 random bytes. An omitted CA uses ordinary system trust. Every real sync HTTPS request explicitly sets `rejectUnauthorized: true`, so an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot disable verification. Neither module reads credential files, logs credentials, changes trust settings, follows redirects, provisions grants or pairs peers.

`reconcileSyncRoutes` requires 1 to 128 distinct explicit route IDs. It runs routes sequentially and attempts each eligible outgoing obligation once. It does not enable a worker or schedule future runs. Default absolute request deadline is five seconds, whole pass deadline thirty seconds, manifest lease sixty seconds. Validated options include `requestMs`, `deadlineMs`, absolute `deadlineAt`, `signal`, `retryMinMs`, `retryMaxMs` and `maxAttempts`. A caller may inject `random()` for deterministic jitter tests. Requests include DNS/TCP/TLS, headers and response consumption in their deadline. The server separately bounds TLS, headers, idle time, whole socket lifetime, request count and body-transfer count.

The result contains `routes` and network counters. Each route result reports `status`, `historyReady`, `fullyReconciled`, transferred/confirmed/pending/blocked counts and a safe error code. Outbound `confirmed` means its current obligations have acknowledged dispositions, which can include deletion or suppression. It does not mean every body was stored or every onward destination received it. Pull reports full completion only after every cut item has durable applicable state.

For a foreground upload, use `await store.deliveryStatus(routeId, originInboxId, originDocumentId)`. Only `isCommitted === true`, backed by the returned exact current committed receipt, permits a body-synced result. `suppressed`, `deleted`, `superseded`, pending, blocked and detached remain distinct. Historical receipts alone are insufficient. A later holdings observation of body loss or changed incarnation makes repair pending again. A local cancellation preserves the report and durable obligation and cannot undo a completed remote commit.

Periodic worker calls must include active outbound routes even when the outbox is empty, and independently reconcile approved inbound routes. Respect the worker's persistent enabled/retry-pause settings when deciding whether to invoke a pass. Outgoing attempts, backoff, persistent errors and blocked obligations live in the ledger. Polling holdings preserves them. `store.retry(auth)` is the explicit operation that clears blocked or delayed pending attempts; it does not activate an untrusted history cut. Detached and blocked route configurations remain silent. Reconfiguration requires a fresh revision and starts reconnecting.

## Local route setup

An outgoing source route and the receiver's incoming grant share route ID/revision, source/destination UUIDs and exact origin grants. Directions differ. Each pins the other endpoint's immediate peer ID and HTTPS origin. The source UUID is the relay's local inbox for onward routes; `allowedOrigins` still pins the original inbox, epoch and Ed25519 key with explicit redistribution and complete-history delegation. No request selects a local path or named inbox.

Both endpoints must already be enrolled stores for existing inboxes. `configureRoute` always starts a new or revised enabled route reconnecting, even when its input says active. Renames cannot substitute for UUID identity. Revocation fences request creation under the shared lock, aborts registered same-process attempts, detects cross-process revocation during bounded attempts and rechecks receiver authorization before commit. Old sessions cannot authorize a request after revision, peer, target or storage-incarnation changes.

## Wire and history

`sync-wire.ts` exports the strict envelope parsers, bounds, `BINDING_HEADER`, `opaqueToken`, `createEvidence`, and fingerprint/scope helpers. Protected requests carry `Authorization: Bearer TOKEN` and the base64url JSON `x-html-inbox-sync` header with exactly `protocolVersion`, `routeId`, `revision`, `callerPeerId`, `targetPeerId`, `sourceInboxId`, `destinationInboxId`, and `callerStorageIncarnation`.

Only the fixed identity, manifest, holdings, offer and body paths exist under `/sync/v1`. Authentication happens before protected error details or payload consumption. JSON is UTF-8, fields are exact, all request bodies have Content-Length, and compression/transfer encodings are rejected. The `SyncClient` lower-level interface is available for protocol tests; normal worker code should use `reconcileSyncRoutes`.

Push obtains the receiver's challenge before capturing a current source cut. It posts ordered pages and validates a readiness ACK against its locally pending nonce and retained issued evidence, then offers records and PUTs original bytes. There is no callback to the source listener. Independent pull obtains a current source cut, verifies all pages and terminal state, completes inbound history, submits the ACK, and fetches missing bodies. Both body paths call `ManagedSyncStore.applyStream`.

`completeInventory` is inbound-only and stores terminal-history readiness in `historyCheckpoints`. `activateOutbound` validates the authenticated readiness ACK against the locally retained issued evidence and expected ACK nonce. It changes outgoing readiness only. It creates no incoming contribution, custody receipt or inventory checkpoint. `completeReconciliation` checks every item before writing the separate `checkpoints` full-completion map. Item receipts and enumeration never advance full completion. These store operations are for trusted protocol code, which must supply locally pending challenges rather than copy a remote nonce into the expected-proof argument.

`observeOutboundState` accepts a verified terminal state for an existing immutable outgoing canonical record. It derives onward work without incoming membership or owner events. A state unexpectedly ahead of local owner history quarantines the owner. `pinOutgoing` accepts an expected fingerprint and checks it under the mutation lock before returning owned bytes. `holdingsCut` obtains incarnation, signed state, availability, suppression and relevant historical receipts from one locked durability-established cut, without opening HTML.

The schema adds `historyCheckpoints`. Reading a pre-protocol storage snapshot moves its old checkpoints into history readiness and clears full completion. New outbox entries carry `receiptDisposition`; older entries lacking this field cannot independently prove foreground committed status until reconciliation records a current receipt. These are additive compatibility rules for the uncommitted storage implementation.

## Adversarial test fixture

Use `createSyncHttpsCredentials(t)` and `startSyncHttpsProxy(t, options)` from `sync-https-fixtures.ts` for synthetic trusted/rogue/wrong-host/expired certificates and actual child-process fault proxies. Those helpers reject non-loopback origins. LAN/Tailscale fixture profiles label synthetic loopback paths and do not prove real infrastructure behavior.

`startSyncApplication(t, { home, peerId, keyPath, certPath, token, port?, requestMs?, leaseMs? })` in `sync-protocol-fixture.ts` starts the actual application handler/store in a child process. The helper binds loopback explicitly, uses synthetic HOME/config paths, and exports `url`, `pid`, `messages`, `waitFor`, `command`, and `stop`. Pass an object exposing `after` and `diagnostic`. Cleanup reaps the child, checks PID disappearance and rebinds the exact released port.

Commands are `{type:"status"}`, `{type:"arm",event:StorageEvent}`, `{type:"arm-stage-lease-gap"}`, `{type:"release"}`, `{type:"revoke",routeId,revision}`, `{type:"fail-directory-sync"}`, and `{type:"stop"}`. `arm` pauses the next exact storage barrier and emits `{type:"fault",event,hits:1}`. `arm-stage-lease-gap` pauses at an actual directory flush only when a durable stage lease exists before its paired stage file. Quota tests assert exactly one such pause, prove the lease-only window, and then await complete lease/stage pairs. This is a child-fixture IPC operation, with no ingestion or production CLI endpoint. `release` resumes a pause. `fail-directory-sync` causes one actual ledger-directory FileHandle.sync call to reject after the next ledger rename and emits `{type:"fsync-failed",hits:1}`. `stop(true)` kills and reaps for crash cases. Restart against the same synthetic home and port to test recovery. Never pass a production home or credentials to these fixtures.

## Limits

General retained-body reclamation and trusted owner-recovery tooling remain deferred. Staging cleanup removes only normally failed/unused owned stages or leases with conclusive dead ownership under the shared lock. Unknown/live leases and uncertain/referenced final bodies are retained. The engine serializes routes and body transfers; it does not implement byte-range resume or delta feeds. Sessions are process-local and expire, so restart requires a fresh challenge/cut. The reconciler sends the authenticated manifest operation `{op:"complete",sessionId}` after push and pull to release cached inventory. A failed or cancelled completion retains only the bounded lease. Session slots are reserved before inventory reads, and busy pagination/body leases cannot be purged or completed concurrently. Eight genuinely active sessions remain the limit; temporary admission returns `503 session-capacity` and uses finite durable backoff. Per-inventory/body byte and schema quotas remain hard failures. No real LAN/Tailscale listener, host power loss, OS suspend/resume or production provisioning has been tested by this phase.

The client reads error envelopes through a 1024-byte bound and accepts exactly one `error` field with a recognized code and matching HTTP status. Only authenticated `409 trusted-history-unavailable` is a history wait. It spends no transport attempts and is periodically rechecked for independent pull as well as local terminal-first forwarding. Authorization errors, invalid envelopes, invalid history, and hard quotas remain blocked. `sync-failure.ts` defines this finite classification; the reconciler, route retry policy and worker use its shared meaning.

The server may emit the one generic `503 request-capacity` admission result before authentication. It reads no route/document state, grants no session and commits nothing. Actual authentication failures retain uniform `403 unauthorized`. Interrupted error-body consumption is a transient `response-truncated`, bounded by the same absolute request/pass deadlines; partial remote text never supplies history or retry meaning. Completed malformed, unknown, oversized or status-inconsistent envelopes remain blocked.

An outgoing body observes response closure before awaiting its pin. A preclosed response begins no pin; disconnect, route cancellation or server close releases the HTTP request, busy session and registered attempt even while the existing bounded read-only pin waits for storage. That store operation closes its own file handle when it finishes; its late result cannot send bytes or create a receipt. Genuine active responses retain their busy cut until response closure, including past lease expiry. Interrupted body sessions are discarded; successful multibody pulls retain their cut for remaining requests and authenticated completion. These paths use direct response/abort events and the existing store, with no additional scheduler or storage authority.

`sync-ledger-policy.ts` contains deterministic scope, pinned epoch/key, current receipt, forwarding, outbox, revision-fence and retry decisions over validated ledgers. The store retains the single private recovery/mutation/commit authority and shared apply implementation. Holdings checks the shared source-or-redistribution predicate before looking up any identity and validates retained state against its pinned epoch/key before returning a live or terminal descriptor. Revision fencing retires contributions/outbox and clears retry bindings atomically; only a durable commit invalidates registered attempts.
