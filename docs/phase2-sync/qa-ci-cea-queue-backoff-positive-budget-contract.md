# Positive worker backoff pass budget

This gate supersedes only the positive worker-scenario pass budget in the earlier queue acquisition and observation gates. It authorizes a test correction, not a production deadline or cancellation change.

The completed observation author captured one natural instrumented Node24 failure. The real 300ms pass timer fired while attempt close drained; the route result was correctly `aborted/local-acquisition-deadline`. The strict assertion failed after 342ms. The source diagnostic's completion margin alone cannot locate result selection, but the accompanying native trace does. The original combined-run cause remains unknown. External instrumentation has measured overhead; no zero-overhead equivalence is claimed.

The positive worker scenario must demonstrate initial 100ms queue expiry while its enclosing pass remains live through release, bookkeeping, watcher close and final snapshot. Sharing a 300ms envelope with the separate whole-pass-expiry negative conflates those contracts. Authorize one fixed 1000ms positive worker pass budget. This provides bounded capacity for the observed completion path and its controlled 110ms delay. It is not a guarantee against arbitrary OS stalls, and it may not be increased again under this gate.

## Exact source scope

Own only `packages/cli/src/sync-acquisition-deadline.test.ts`. Start from the author's observation source at `/home/agent/.t3/worktrees/html-inbox/t3-b151001e/packages/cli/src/sync-acquisition-deadline.test.ts`, SHA-256 `a250b081b9e4e683003963c20ac644a5b5a9e1f911359c7a41be8d643d155f47`. Its complete 169-source aggregate is `d60436cc3613876f04aff29a6d461ee6631284b9cb646886cab78e6cfae4ce5c`; its 336 compiled aggregate is `9d8410bd2f1a9f184f36613a63148e18736d9dd0ebcd358b6e529da506f124a0`. Parent still has the earlier source; do not refresh away the owned observations.

Introduce one local `queuePassMs = 1000` for `runWorkerScenario`. Use it only for the configured worker's positive `passMs` and the default ticket pass duration. Keep requestMs at 100 and the real holder at 140. Preserve the prior bounded observations. A short comment should distinguish the queue-expiry positive from the whole-pass-expiry negative without claiming deterministic scheduling.

Keep every assertion, all twenty retry attempts, restart/backoff suppression, finite-limit blocking, explicit reset, actual verified HTTPS custody and idempotency unchanged. No new application call, wait, retry, readiness preparation or fault seam. Preserve the direct initial client 100/300ms regression and the explicit reconciliation 100/300ms whole-pass-expiry negative with its 340ms holder. Preserve raw/later/unsafe/filesystem/aggregate classifications and cancellation priority. Positive custody retains its existing 5000/30000ms budgets. Child, retained-child and parent watchdogs remain 35/40/45 seconds. No production, other test, shared fixture, runtime-record, runner or concurrency edit.

Return both the minimal delta against the authored observation source and the complete one-file delta against the parent's `fb9b5da57f33450997881995d71941e266fed2c3bbe344708835cbd37ee914f5` source view. Preserve failed source and command receipts. This does not retroactively make them green.

## Validation

Read and hash this gate before source edits. Save binary index and all bytes/modes/absences first. Use the same isolated workstream, clean private environment, exact Node24.21.0 and Node20.20.2, shared bounded runtime mutex and established direct-child subreaper. No installation, new persistent trust, host changes or parent runtime mutation.

Typecheck and build both engines on identical final bytes. Only the owned test JavaScript may change from the observation baseline; the other 335 outputs must match. Run the complete containing file once on Node24, then once on Node20. These two containing runs use no external Node preload; ordinary source diagnostics and the existing supervisor remain. Stop subsequent commands on an unexpected failure.

Then run two registered actual-source probes on Node24 using the existing genuine final-snapshot read-result boundary at attempt six:

1. Hold the same completed native result for the original 110ms. This previously exhausted the 300ms pass. Require one hold/release, a still-live 1000ms pass through result selection, and every original retry-limit/reset/receipt/idempotency assertion to pass.
2. Hold that result for a fixed 1100ms. Require the real 1000ms pass timer to fire, zero requests for that queue attempt, `aborted/local-acquisition-deadline`, and failure at the unchanged strict `pending` assertion. Retain this expected exit 1. A missed hold or a different failure is not a valid negative.

Private helper changes are limited to project/evidence paths, the two fixed hold durations and corresponding explicit expected outcomes. Record exact diffs and hashes. No production hook, fake result, clock substitution, request timeout change, broad override or source-body transformation. Preserve the five original negative cases, including the genuine 300ms whole-pass expiry, in both containing runs.

No full units, broad verification, Node20 controlled expansion, stress, cap, natural rerun or further budget adjustment in the author. Preserve all 428 observation, 403 diagnostic and 65 combined artifacts. Retain pre-target helper failures separately; compiler, unexpected target, missed hook, admission or cleanup failure stops the series. Cleanup scoped owned actors/listeners/handles/stores/credentials/dependencies/dist, restore nonowned states and report actual index preservation. Parent owns integration, required combined checks and two new independent reviews. No commit, push, QA SHA or publication.
