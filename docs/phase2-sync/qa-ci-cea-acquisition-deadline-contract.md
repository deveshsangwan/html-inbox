# Local queue expiry at initial client admission

Frozen coordinator contract, 2026-10-25. Starting commit is `cea30b48cbef814511e2eedfc83d1793bc011354`. This author owns only `packages/cli/src/sync-files.ts`, `sync-client.ts`, and new `sync-acquisition-deadline.test.ts`. A uniquely named test-only child requires a recorded need. Parent owns documentation, integration, combined checks and two fresh reviews. Gate A's cancellation correction is disjoint and must remain unchanged.

The controlled #505 trigger expires while the initial client request waits in the same-process store queue. No filesystem acquisition, attempt registration, credential resolution or HTTPS request has begun for that invocation. The historical hosted contender and all other hosted causes remain unassigned.

Export `StoreLockQueueDeadlineError extends Error` with the existing fixed `Managed store lock deadline exceeded` message. Construct it only in `withStoreLock`'s existing local `Promise.race` timer. Preserve the queue chain, timer calculation, finally, function signatures, filesystem ownership and cleanup exactly. This marker conveys queue provenance and is not globally retryable.

In `SyncClient.request`, catch only the initial `store.openRouteAttempt` rejection. Rethrow every value unchanged except a top-level instance of that marker. For that marker, first preserve an already-aborted caller signal's existing reason; otherwise throw existing `SyncProtocolError(503, "local-acquisition-deadline")` with the exact marker assigned as its cause. Keep this catch outside later communication and response consumption. Do not change `SyncProtocolError`'s constructor.

Do not edit the shared failure classifier or remote error allowlist. No message/name matching, structural lookalikes, nested-cause or AggregateError traversal. Raw markers outside this one catch remain blocked. Filesystem acquisition deadlines, prechecks, protected operations, failed close/disposal/release, watcher/recovery/staging and later `startCommunication` remain excluded. Do not broaden abort normalization for unrelated failures.

Existing route validation, authorization, pause/revoke/quarantine, bounded retry/backoff/attempt limits, explicit retry reset, canonical identity and durable custody remain authoritative. No schema, wire, credential, API option, deadline extension or new retry loop. Production changes outside the two named files require a new gate.

Write the regression before production edits. Preserve all original #505 assertions and 100 ms request / 300 ms pass bounds. Prove exactly one actual queue hold, remaining whole-pass time, zero credential/request starts, no late execution of the expired callback, unchanged source bytes and no invented custody. Inspect the exact typed cause at the real public client boundary. A zero-hold control must complete real verified HTTPS and subsequent receipt-backed custody.

Negative controls must distinguish later communication acquisition, raw filesystem deadlines, actual I/O/cleanup failures, unsafe authority and aggregates from this marker. Use existing meaningful ownership, portable, storage, shutdown and failure suites where they already prove those paths. A missed fault is not a passing control. Preserve exact error identity or aggregate members. Cover explicit abort with time remaining and genuine whole-pass expiry independently.

Prove actual worker route backoff persists through wake/restart, finite attempt-limit blocking requires explicit reset, and contention removal plus authorized retry yields real idempotent custody. Keep item versus route retry and reconnecting history distinctions. Do not fabricate an eligible live item or receipt in the original reconnecting fixture.

Run final typecheck/build and containing/appropriate affected suites on exact Node 20.20.2 and 24.21.0 using identical final bytes, then inspect the complete tracked/untracked change. Use an owned isolated bounded runner and `flock -w 45 -E 75 /tmp/html-inbox-qa-history-amcemjlx/cea-diagnostic-runtime/runtime.lock` for setup, build and runtime. Exit 75 is admission failure, not a test verdict; stop and report rather than loop. No root test wrapper, public fault switch, global process signals, real inbox/service or network/security setting changes. Preserve all earlier failed/invalid receipts and cleanup exact owned resources.

This closes only the proven pre-ownership queue trigger. It supplies no filesystem contention taxonomy, general attempt-quiescence guarantee, native hosted cause, physical acceptance or released SHA.
