# Composite session-capacity test budget

This gate authorizes one test-only correction for hosted Ubuntu Node 20 at published HEAD `01657ea6fd6dcb1d4c4f3f5ed4233828ab135f27`, source 164 files, aggregate `03951da690ff22fe34e4b5773f5911c30f6697ebce7d3d8c19b9587117aa9de7`. It is disjoint from the publication-inspection writer. No production change is authorized here.

## Evidence and decision

Hosted run 40127377963/job 120971588647 cancels the repeated multiroute push/pull case at its 30000 ms outer watchdog. The hosted per-pass trace is absent; its actual cause remains unassigned. The original failure stays failed.

The unchanged exact Node 20 case passed locally in 18.15 seconds. Controlled pacing of actual fsync calls on only the owned synthetic stores reproduces outer cancellation after 30.01 seconds, with 19 route completions and continuing protocol progress. An explicitly observation-only outer override then completes all 40 route passes and original assertions in 75.55 seconds. Maximum individual reconciliation is 5.36 seconds, inside its unchanged 10-second bound. Native fsync succeeds throughout; pacing also affects watcher/interleaving counts and is not a calibrated replay of CI disk latency. Natural native fsync was only a small fraction of local elapsed time, so no natural slow-fsync attribution is established.

With completion withheld, the unchanged session-zero assertion fails in 1.47 seconds. This demonstrates sensitivity to the retention mechanism even with a larger outer watchdog; it is not a rerun of historical production code. The controlled mechanism is sufficient evidence for a fixture-budget correction, not proof that no hosted product defect is possible.

The test performs ten publications and twenty independently bounded reconciliation calls over two routes in both directions. The approved contracts impose no 30-second throughput SLO on this composite fixture. Its outer test watchdog is distinct from a real foreground upload deadline. The coordinator explicitly authorizes changing ONLY that outer watchdog to 120000 ms, with progress diagnostics. This provides about 44 seconds of margin over the observed controlled completion while remaining finite. It is an empirical fixture guard, not a product performance promise. Healthy runs incur no additional delay.

## Frozen scope and preservation

One isolated writer owns only `packages/cli/src/sync-review-regressions.test.ts`, applying the exact proposed patch `/tmp/html-inbox-session-diagnosis-3elbnxsy/proposed-test-only.patch`, SHA256 `8e04fe2edd85adf58b71d54fa3d58dda829f9c15a519515aa61dec49d0f359a4`.

Keep all ten distinct publications, two approved routes, both push and pull, all forty route passes, confirmed results, per-iteration zero-session assertions and final ten-document assertion. Keep actual durable I/O, normal TLS verification, the 10000 ms reconciliation deadline, default 5000 ms request bound and 60000 ms lease. No production deadline, retry policy, worker/watch behavior, concurrency setting, fixture deletion rule or other test timeout changes. Do not skip tests, reduce work, synthesize receipts, disable watchers or turn the historical failure green by relabeling it.

Add only the proposed reason comment and monotonic phase progress diagnostics: iteration, push/pull duration and elapsed time, request counts and session counts. Diagnostics disclose no payload, token or private key. Preserve every previous fault and negative assertion in the file. The separate publication-inspection workstream and all other source/tests/helpers/docs are excluded.

## Applied-patch verification

Read and acknowledge this gate and original complete report before writing. The prior JavaScript observation did not typecheck or execute the unapplied TypeScript patch. Apply it in the app-owned isolated checkout at the exact committed baseline; do not alter parent source or switch shared worktrees.

Typecheck/build the actual patch. Run the selected case and the entire containing review-regression suite on Node 20.20.2 and a qualified Node 24 runtime. Repeat the controlled owned-fsync pacing against the ACTUAL compiled 120000 ms test with all diagnostic outer overrides disabled. Require all forty real route passes, unchanged individual deadlines, exact byte/custody and zero-session/resource checks. Retain the original 30000 ms controlled red and label the earlier override observation separately. Re-run the completion-withheld negative under the actual patched test; it must still fail the original assertion promptly, not wait for lease expiry. Prove fault hits and distinguish missing hooks from success.

Retain exact commands, versions, timestamps, exits, counts, log hashes, all failures and the original hosted causal limit. Inspect full tracked/untracked changes and source hashes. Stop/reap retained children, close actual handles/listeners, rebind exact captured ports, remove synthetic stores/trust/dependencies/build/environment resources, and leave unrelated sentinels untouched. Report source-writing terminal with a one-file delta and complete receipts. Parent integrates with the disjoint publication fix, runs complete combined checks and two fresh focused confirmations, then publishes a non-rewriting follow-up. No merge, deployment, blind hosted rerun or interim physical-QA SHA.
