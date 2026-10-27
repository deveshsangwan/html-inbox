CHANGES REQUIRED.

Both targeted mechanisms have substantial fixes, but the publication correction leaves one Medium reporting gap in the same short-inspection versus overall-deadline contract. The session-capacity budget correction is accepted. There is also one Low error in the structured evidence summary. I found no Critical or High issue in this focused review, and no demonstrated data loss, false committed custody, authorization bypass or unsafe resource reclamation.

This is a NEW independent read-only corrective review of the complete 13-file hosted-CI follow-up and its necessary interactions. It preserves the original whole-change reviews and later accepted corrections. It is not a fresh exhaustive phase2 review or physical acceptance. I used no delegation, implementation, rebuild, install, parent coordinator wrapper, public comment, monitoring, commit, push, merge or deployment. I read retained review reports as task evidence rather than inheriting an author/reviewer conversation. This reviewer used Codex; no Claude or cross-provider claim is made.

Review root: /home/agent/.t3/worktrees/html-inbox/feat-phase2-sync
Branch: feat/phase2-sync
HEAD and review base: 01657ea6fd6dcb1d4c4f3f5ed4233828ab135f27
Original whole-change base: b843e126fdb10f7038e9305c6791707bcfee9ff5
Scratch report and receipts: /tmp/html-inbox-pr79-astra-review-tuo4_1zs
PR79 is app-locally registered, with watching=false. No other PR was linked.

1. Medium: an unavailable final custody inspection still impersonates overall expiry after an early worker-start failure.

Location: packages/cli/src/sync-publication.ts:193. Necessary interactions are the preserved worker catch at :95 and final pending normalization at :123-124.

When the worker is enabled and unpaused, the first delivery inspection can return ordinary pending while trusted history is still needed. If ensureOwnedSyncWorker rejects before ticket dispatch, the existing catch records worker-or-foreground-deadline and moves to the unconfirmed final inspection. If that final deliveryStatus now exhausts its real 200 ms lock deadline, the new catch converts it to null. With a retryable current item and no permanent route block, inspectDelivery returns pending with reason null because the overall deadline has not expired. The outer final normalization then assigns foreground-deadline unconditionally. The earlier worker diagnosis and the fact that custody inspection was unavailable are lost.

Independent expected-correct probes fail on BOTH exact Node20.20.2 and Node24.21.0 against the frozen compiled files. Each uses an actual registered/enrolled synthetic store, real durable publication and actual managed mutation-lock contention at only the second lookup. The existing worker-start boundary deliberately rejects before any ticket dispatch; viewer/status boundaries are substituted. There is exactly one startup rejection, two deliveryStatus calls, one real lock hold and one native lock-deadline rejection. The actual overall budget stays 30000 ms. At the failing assertion, 29734 ms remain on Node20 and 29756 ms on Node24.21.0. Both return pending/exit2/reason foreground-deadline/retriesEnabled true/null receipt.

Before the expected-result assertion, the strengthened probes verify exact saved bytes, one canonical record, zero receipts and history checkpoints, enabled/unpaused worker state, unchanged route revision/null route error, and nonretired outbox work with attempts zero. No worker-control call or real worker startup occurs. The test has a 5000 ms outer bound and finishes in about half a second. This is a controlled production-inspection reproduction with a simulated startup rejection, not evidence that this startup path or contender caused the historical hosted failure. The initial two failing probes are retained separately; the later proof pair adds durable-state checks before the same failing expectation and changes no production bytes.

Failure excerpt:
  error: '200ms lookup failure must not impersonate overall expiry after early startup failure'
  actual: 'foreground-deadline'
  operator: 'notStrictEqual'
  starts=1, lookupCalls=2, lockHits=1, deadlines=1, exactBytes=true

Impact: the publication result still falsely reports a thirty-second foreground expiry after a subsecond execution on a normal startup-error path. This violates the frozen gate's instruction to separate unavailable short custody inspection from true overall expiry. It can misdirect users and consumers diagnosing pending delivery. No false success or persisted scheduling mutation is demonstrated. This is an unclosed part of the corrective contract, not a claim that the patch newly introduced the old final normalization.

Minimal correction: retain the unavailable-inspection observation through aggregation when no stronger current pause/disable/permanent/disposition diagnosis or actual custody exists, and emit delivery-inspection-unavailable while the overall budget remains. Preserve genuine total-expiry foreground-deadline behavior and all existing cancellation/confirmation precedence. Do not restore a blanket change to final normalization that breaks the earlier exhausted-history case. Add this enabled/unpaused early-startup-failure plus final-real-lock-timeout regression to the dedicated suite. No worker/store/protocol/public API change or enlarged deadline is needed.

Reproducers: enabled-unavailable.test.cjs and run-last-proof.py. Receipts: node20-enabled-unavailable-proof.json and node2421-enabled-unavailable-proof.json. Both actual child exits are 1, each 1 test/0 pass/1 failure/0 cancelled/0 skipped. Exact runtime paths, UTC times, commands and SHA256 values are appended below.

2. Low: the structured cleanup summary counts map keys instead of cache entries.

Location: docs/phase2-sync/verification-qa.json:27470, hostedCI01657Followup.cleanup.newRuntimeCompileCacheEntries.

The value is 6. The immutable terminal-receipt-final.json field of the same name is a map with six directory keys, but its values contain 555 entries in the temporary directory and zero in the other five directories. sum(len(entries) for entries in map.values()) is 555. The prose qa-hosted-ci-followup.md correctly reports 555. This is directly reproduced in cache-count-discrepancy.json, not an inference about residual processes or fixture leakage.

Impact: machine-readable consumers receive a wrong retained-cache count, although the full receipt and prose preserve the true evidence. Minimal correction: use 555 for the entry count. If six roots are also useful, give that quantity a separately named field. Do not delete the retained cache or rewrite historical logs to match the erroneous summary. This Low issue does not undermine the supplied test results or establish a resource leak.

Disposition of current finding 1, paused-history publication classification: PARTIALLY RESOLVED. The demonstrated original paused/disabled/permanent-block/suppression cases pass and the implementation direction is sound. The additional transient case above prevents full acceptance of the frozen publication gate.

The private inspector reads one validated current snapshot, passes it to matchingRoutes, and binds fallback items by route ID/revision, canonical origin key and publication fingerprint. Permanent route errors without routeRetries are considered only when custody is unavailable; persisted route retry blocks are retained. Trusted-history waiting remains retryable unless stronger permanent evidence exists. An eligible authorized route prevents a different blocked route from deciding the result. Scope-excluded routes do not participate. The metadata fallback cannot return confirmed: only successful current deliveryStatus.isCommitted within the bound returns a receipt. An acknowledged suppressed disposition can diagnose blocked without claiming intended-server live custody. Nondeadline inspection errors preserve identity. There is no new durable mutation, retry reset, cancellation loop or scheduler.

The unchanged 200 ms per-route lookup, finish reserve up to 250 ms, 150 ms cancellation, overall deadline and viewer/status bounds remain. Genuine confirmation still skips redundant final inspection. SIGINT normalization remains after final awaited operations, and the exact submitted-but-unacknowledged own ticket is still eligible for at-most-once best-effort cancellation. The 26 existing finalization cases pass on both runtimes, including real held control ACK and post-custody HTTPS completion. My additional late-cancel/double-timeout probe passes. Thus the new finding is a reason-classification gap, not reopening the previous ticket-authority or final-cancellation findings.

Disposition of current finding 2, composite session-capacity test budget: ACCEPT.

The delta changes one outer test timeout from 30000 to 120000 ms and adds a reason comment plus monotonic progress diagnostics. All ten publications, two routes, both directions, twenty reconciliation calls and forty route passes remain. Every original confirmed result, per-iteration source/destination sessions-zero assertion and final document-count assertion remains. The fixture still uses real TLS/store I/O, the same 10000 ms pass bound, default 5000 ms request bound and 60000 ms session lease. It neither changes production latency nor turns a failed pass into success.

The accepted gate supplies a finite empirical observation budget for a composite test with no approved thirty-second throughput SLO. Its actual-patch paced run completes in 70.225 seconds, with a maximum 4.614-second reconciliation. The previous observation-only override is correctly separated. I inspected the diagnosis, applied report, exact source patch and retained failures, and independently ran the unchanged compiled case on both runtimes. Each emits twenty phase diagnostics and passes. I also wrote an independent completion-withholding preload: exactly four manifest completion operations reject before transport, with no fabricated success or receipt. Under the actual 120000 ms test the ORIGINAL sessions-zero assertion fails with 2 !== 0 after the first iteration, in about 1.9 seconds. The outer watchdog cannot conceal this regression, and lease expiry is not used to obtain green.

The historical Ubuntu20 actor, filesystem latency and scheduler cause remain unassigned. Natural local fsync was a small part of elapsed time. Pacing establishes a sufficient mechanism and exercises the applied budget; it is not calibrated CI replay or proof that no unobserved hosted product defect exists. I did not repeat the long pacing run or a broad verification matrix.

Full rubric assessment for BOTH fixes:

- Functional correctness: the pause/disable/permanent/suppression and custody corrections work in their tested paths. The remaining transient reporting defect is finding 1. The test-budget change preserves the tested behavior.
- Missed requirements: the nine required contracts, six design contracts and six acceptance groups remain authoritative. Finding 1 is a missing branch of the explicit short-inspection contract. No additional change to actual push, independent repair pull, UUID mapping, canonical identity, signed deletion, relay cycles, silent detach, terminal-first reconnect, current-holdings repair, restore quarantine/fork or ordinary reader/export compatibility is warranted by this delta.
- Edge cases and failure handling: reviewed first/final unavailable lookups, unavailable whole metadata, EIO identity, transient history, item/route/permanent retry blocks, alternate route precedence, suppression, real expiry, actual custody and cancellation. Five additional boundary probes pass on exact Node24.21.0, including both lookups unavailable, metadata snapshot unavailable without invented pause, nondeadline snapshot EIO, late cancellation, and a real deletion producing a different current fingerprint whose blocked obligation must not diagnose the original publication.
- Security and data integrity: no expanded route, origin, target, credential, TLS, private-file, signature, export or owner authority. Unavailable metadata creates no receipt, body availability or deletion authority. Current-custody and acknowledged-suppression tests verify actual receiver state and bytes. The session diagnostics contain only progress counters and timing.
- Concurrency: the snapshot provides one consistent metadata cut and exact key bindings. Custody remains independently checked under the store's existing authority. This is a point-in-time diagnostic, not a lock held across the entire publication. Original ticket attempt/ACK/cancellation distinctions and retained-runner/teardown boundaries remain. Existing current-status success takes precedence over stale fallback metadata. The extra different-fingerprint probe verifies fallback rejection after an actual signed state change.
- Assumptions: the two hosted actors remain unknown. Neither local passing results nor controlled faults assign their historical cause. The 120-second fixture budget is an observation limit, not a production performance promise. Snapshot metadata is never perpetual custody.
- Structure and separation: only private publication inspection/fallback and its imports change in production. Existing pure ledger-key and route-policy helpers are reused. One store mutation/recovery/commit authority remains justified; there is no new competing persistence layer, public seam or generic failure framework.
- Repository conventions: the changed code uses purpose-revealing local names, useful boundary types, inferred locals and narrowing, with no new any, non-null assertion or suppression. The reason comments describe actual constraints. No style-only finding is being presented as a blocker.
- Test quality and gaps: the new eighteen cases use real short lock deadlines, generous remaining actual budget, saved data, exact hooks, no-custody and no-unexpected-start assertions. Real TLS positive custody/suppression controls prevent metadata-only success claims. Existing tests stay unchanged except the explicitly gated composite budget. The remaining enabled/transient path needs the regression in finding 1. Filters in my selected capacity commands are reported as exclusions, not extra passes.
- Backward compatibility and lifecycle: no schema, wire, public API, runtime record, request deadline, worker scheduling or installed-service change. Managed POSIX/schema2 coordinated-upgrade limits remain. The durable worker remains independent of publisher/viewer lifetime, and ordinary portable behavior is unaffected. This focused review retains prior whole-change evidence for unchanged library, list/search/CSP/sandbox/export and service behavior.
- Simpler safer alternatives: the private snapshot diagnostic is smaller than changing store/worker/protocol semantics or adding retries. Skipping final unconfirmed lookup would lose real custody validation. Enlarging a production deadline, clearing blocks or weakening test assertions would not fix the remaining reporting path. The scoped test budget is preferable to deleting iterations, directions or session assertions.

Scope and evidence read:

I inspected full git diff HEAD, status/index, all eight untracked files and all thirteen manifest files, including the production delta, entire dedicated test, complete selected session case/fixture and structured verification changes. The full diff is retained as full.diff. I read the full approved proposal and frozen gates, required contracts, relevant architecture/storage/protocol/worker interfaces and operations, acceptance, ledger/followup and current handoffs. I read both latest review-qa-r4 reports in full, the complete review triage, prior review findings/dispositions and relevant corrective history. Older review reports and receipt fields were indexed and consulted for interactions; I do not claim to have re-executed or freshly reviewed every unchanged phase2 line or every historical appendix.

All 564 supplied current/historical log hashes match. All 50 immutable combined-check artifacts match sizes/hashes. All 290 parent-recorded adopted PIDs are absent. The supplied broad checks remain supplied evidence: exact Node24.21.0 pnpm verify exit0, 1093 total/1089 pass/four documented skips, and exact Node20.20.2 compiled units exit0, 1011 total/1010 pass/one Windows skip. Typecheck/build, fourteen-page integrity and package smoke passed in the supplied run. I did not rebuild or rerun broad checks. The IPv6 SAN test passed on exact24.21.0. Node24.19 results are not relabeled as24.21.0.

Original hosted logs retain their failures: Ubuntu24 job120971588798 expected retries-paused but got foreground-deadline at642.154095ms; Ubuntu20 job120971588647 has testTimeoutFailure at30040.903162ms. Their SHA256 values remain34fa3a56841ece6926b14ae606907c3b98ffb73715fc7eddcee0af06c21340ae and a2f64a7e624cc5f913f0903bd885d6ebd4c5eed3982a0ccd1d6853cf74792513. No new probe identifies the original hosted contender or inspection stage.

The initial independent 55-case attempt was INVALID verification infrastructure. My first wrapper deferred adopted-child reaping until the test parent exited. The first lifecycle fixture therefore timed out waiting for process disappearance and reported Worker fixture cleanup failed. I stopped the owned attempt with SIGTERM to its verified direct Node PID3983841, preserved the failed log/receipt and original wrapper, and fixed only the outside-repository wrapper to reap adopted zombies concurrently. No assertion or product file changed. The valid 55-case commands then pass on both runtimes. The failed attempt receives no passing credit, and later green does not erase it. Its scratch resources and adopted processes were settled and removed. The report does not claim a complete original failure matrix from that interrupted attempt.

Independent passing coverage is 55 publication/finalization cases on each runtime, one selected capacity case on each, and five supplemental boundaries on24.21.0. The negative completion-withholding command is deliberately exit1, not a positive pass. The remaining publication defect fails one expected-correct case on each runtime, retained both before and after strengthening pre-assertion evidence. These counts overlap supplied checks and are not added to broad totals. Node20 selected capacity/negative commands exclude nine other file cases by name; Node24 omits unmatched cases. No source check was altered to obtain green.

Initial and final pin checks agree. All13 changed/untracked hashes, lengths and exact status match manifest SHA2564982cb598c13487af0c7b8b4fc756b34f741edc3455d5be1165c00dd13cc7ada. All165source hashes match aggregate4fd87ba653c147d464d75083ed5531f962c001feebe55e0a4ed7eb468190c91b and the two source manifests are identical. All328compiled hashes match the supplied checkpoint. HEAD/branch, complete diff, status and index bytes stay unchanged; the index is empty and git diff HEAD --check exits0. Full initial status is initial-pins.json; final status, per-file results and cleanup are final-pins-and-cleanup.json.

Cleanup is scoped to my runs. All91 recorded direct/test/adopted PIDs are absent; both valid publication runs each reap28 adopted children. All210 distinct captured literal127.0.0.1 endpoints rebound and closed at final audit. Permanent fixtures also exercise their existing exact PID/port and native FileHandle cleanup assertions. All eleven private HOME/USERPROFILE/XDG/TMP/catalog/ZDOTDIR environment trees, synthetic stores and trust material are removed. The invalid first attempt's known retained TLS/store files were removed only after its owned processes settled. No pre-existing runtime cache, unknown store, foreign process or unrelated fixture was removed. Readable /proc FD scans found no reference to my private environments. The first cleanup audit had248 inaccessible unrelated FD directories and the terminal audit had245, so there is no host-global FD claim. Process exit closes any remaining process-local handles. Scripts and metadata receipts remain outside the repository.

Remaining limits are unchanged: unknown locks/interrupted .reap, macOS null-start/PID ambiguity, orphan candidate accumulation, hostile same-account path replacement, no general reclamation or trusted old-owner recovery, indistinguishable same-anchor restores, coordinated managed-schema2 upgrade, managed POSIX-only opt-in and ordinary portable creation-window behavior. Native Mac/Windows, real three-device LAN/Tailscale, OS sleep/boot, physical power loss and privileged supervisor transitions remain unproven here. Manual boot-supervision setup remains required. Physical QA stays parked atd3eaaf9; this report releases no SHA.

Parent action: address the Medium publication gap and Low receipt count after BOTH independent terminal reports are read. Preserve the accepted session-budget patch, original red logs, deadlines, custody/cancellation tests and prior whole-change reviews. The parent owns any edits, checks, subsequent confirmation and publication. This review is terminal and leaves the freeze intact.

Exact independent command receipts. All commands ran in the review root stated above. Per-command JSON records the complete private environment and scoped cleanup. The driver commands were python3 run.py, run-extra.py, run-last.py and run-last-proof.py at this scratch path. run-v1.py retains the initial defective wrapper. No parent wrapper was called.

node20-capacity
/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap --test-name-pattern '^successful push and pull sessions release capacity across more than eight multiroute passes$' packages/cli/dist/sync-review-regressions.test.js
Runtime v20.20.2; binary SHA256 6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd
UTC 2026-10-24T21:19:05.351306+00:00 -> 2026-10-24T21:19:33.567210+00:00
Exit 0; elapsed seconds 28.215904240496457; counts {"tests": 10, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 9, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node20-capacity.log
SHA256 cf8c24928b87742963b07db37abea0546f7fbcafcafe571df1e392ede602dd4f

node20-completion-negative
/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --require /tmp/html-inbox-pr79-astra-review-tuo4_1zs/withhold-completion.cjs --test --test-reporter=tap --test-name-pattern '^successful push and pull sessions release capacity across more than eight multiroute passes$' packages/cli/dist/sync-review-regressions.test.js
Runtime v20.20.2; binary SHA256 6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd
UTC 2026-10-24T21:20:25.848844+00:00 -> 2026-10-24T21:20:28.022767+00:00
Exit 1; elapsed seconds 2.1739235129207373; counts {"tests": 10, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 9, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node20-completion-negative.log
SHA256 8e8ee571baab60f6b2db756401cf7a6b486d25158a9e1baac229bfcf8740b10a

node20-enabled-unavailable-proof
/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap /tmp/html-inbox-pr79-astra-review-tuo4_1zs/enabled-unavailable.test.cjs
Runtime v20.20.2; binary SHA256 6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd
UTC 2026-10-24T21:22:42.826983+00:00 -> 2026-10-24T21:22:43.418719+00:00
Exit 1; elapsed seconds 0.5917251454666257; counts {"tests": 1, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node20-enabled-unavailable-proof.log
SHA256 e03f6fabb3bb1ad06d59fabb5cc8b5cb2c47142eddee697531ca38c9c1f3fae9

node20-enabled-unavailable
/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap /tmp/html-inbox-pr79-astra-review-tuo4_1zs/enabled-unavailable.test.cjs
Runtime v20.20.2; binary SHA256 6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd
UTC 2026-10-24T21:22:01.999952+00:00 -> 2026-10-24T21:22:02.551272+00:00
Exit 1; elapsed seconds 0.5513043887913227; counts {"tests": 1, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node20-enabled-unavailable.log
SHA256 75eeda6fd35b42e04082ee5bc9b7ab8fca49738c133439003de3be9972c4e861

node20-publication-v2
/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap --test-concurrency=1 packages/cli/dist/sync-publication-inspection.test.js packages/cli/dist/sync-publication.test.js packages/cli/dist/sync-finalization-lifecycle.test.js
Runtime v20.20.2; binary SHA256 6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd
UTC 2026-10-24T21:17:56.293240+00:00 -> 2026-10-24T21:19:05.005074+00:00
Exit 0; elapsed seconds 68.7118328800425; counts {"tests": 55, "pass": 55, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node20-publication-v2.log
SHA256 e4d76ecf0f3fe9db570ceb1eb38516363ee78946fd4fb2fefb7e58d947e66b0b

node20-publication
/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap --test-concurrency=1 packages/cli/dist/sync-publication-inspection.test.js packages/cli/dist/sync-publication.test.js packages/cli/dist/sync-finalization-lifecycle.test.js
Runtime v20.20.2; binary SHA256 6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd
UTC 2026-10-24T21:16:30.840001+00:00 -> 2026-10-24T21:17:37.085045+00:00
Exit 1; elapsed seconds 66.24505294393748; counts {}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node20-publication.log
SHA256 6fdf7cf3e974fea42564b43d4a30f851b9dc932ec720bff88334654e10e666fc

node2421-boundaries
/tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap /tmp/html-inbox-pr79-astra-review-tuo4_1zs/boundaries.test.cjs
Runtime v24.21.0; binary SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
UTC 2026-10-24T21:20:23.045115+00:00 -> 2026-10-24T21:20:25.375292+00:00
Exit 0; elapsed seconds 2.330161241814494; counts {"tests": 5, "pass": 5, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node2421-boundaries.log
SHA256 2506f4ab41d797421a6bb8d6295ed02aee2e9dd461a51cf658f4e26873e27d24

node2421-capacity
/tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap --test-name-pattern '^successful push and pull sessions release capacity across more than eight multiroute passes$' packages/cli/dist/sync-review-regressions.test.js
Runtime v24.21.0; binary SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
UTC 2026-10-24T21:20:39.951619+00:00 -> 2026-10-24T21:20:56.759905+00:00
Exit 0; elapsed seconds 16.80828562937677; counts {"tests": 1, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node2421-capacity.log
SHA256 44e96f072d06318ba8fae52babb87929eb5e88f21f564fa9e2c10781acfb3102

node2421-enabled-unavailable-proof
/tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap /tmp/html-inbox-pr79-astra-review-tuo4_1zs/enabled-unavailable.test.cjs
Runtime v24.21.0; binary SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
UTC 2026-10-24T21:22:43.685383+00:00 -> 2026-10-24T21:22:44.260443+00:00
Exit 1; elapsed seconds 0.575062028132379; counts {"tests": 1, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node2421-enabled-unavailable-proof.log
SHA256 1cae26c38646678f0b207f13d14adb29cd1897d21e17779902c151d7424ed2ce

node2421-enabled-unavailable
/tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap /tmp/html-inbox-pr79-astra-review-tuo4_1zs/enabled-unavailable.test.cjs
Runtime v24.21.0; binary SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
UTC 2026-10-24T21:22:02.813770+00:00 -> 2026-10-24T21:22:03.344277+00:00
Exit 1; elapsed seconds 0.5305095687508583; counts {"tests": 1, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node2421-enabled-unavailable.log
SHA256 06db5c5f77ac05f2ad2d295f6991eef21ba6e858ca8ca360b0bb1f2481edcb6f

node2421-publication-v2
/tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap --test-concurrency=1 packages/cli/dist/sync-publication-inspection.test.js packages/cli/dist/sync-publication.test.js packages/cli/dist/sync-finalization-lifecycle.test.js
Runtime v24.21.0; binary SHA256 7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c
UTC 2026-10-24T21:19:33.878833+00:00 -> 2026-10-24T21:20:39.597605+00:00
Exit 0; elapsed seconds 65.71877229213715; counts {"tests": 55, "pass": 55, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
Log /tmp/html-inbox-pr79-astra-review-tuo4_1zs/node2421-publication-v2.log
SHA256 e7ed912db97b8badc936755e4da2d62c1444fe71c957bb332430398e4c0baba8

Evidence scripts SHA256
2b94a8c12d351798041aab1baea8754b7c308d9674fd1a2d0368d0e219c5cb9d  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/run.py
8b311ff0a87a55183a4cb8852c0b7a899e26a6aa24129ce9370d76b61c79d08e  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/run-v1.py
581f49fd33edcf5f1b7f43a849436f11319ccb3b11118c229bb680433f9dd2c6  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/resources.cjs
b2cc5a9e9ac5a0084e0b5f317eca954c29f1b26ef4c649348bc140311ad35be1  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/boundaries.test.cjs
75b8bf1f249a40dae07d87e3c17cd0ffcb4d6741c0195c84579e70206523d64c  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/withhold-completion.cjs
6db87fb2c094d959a260215e08784b13278a65e0e8fecae1220b25a25713a223  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/enabled-unavailable-initial.test.cjs
131e305c7c7c37f139d107740e58a2bab445d07e9b647c0d4e1af727c4870f68  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/enabled-unavailable.test.cjs
53642f2bb13a4382d7d619d36aaff7510b7f9f0ba0dcf87be1f20267ae9ab0bb  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/run-extra.py
c23976361c8ed8d2e907e6f2e71606c41687fba2e08061e8f15ac34db8816c85  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/run-last.py
70df4647ecd25e6a5dbdd7b193253977af54737c65af00c8b53727c8d231d89d  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/run-last-proof.py
0a7002acd988a36a407c743e6921ce2fb2e19a50051d9755f3edf69e0006df16  /tmp/html-inbox-pr79-astra-review-tuo4_1zs/audit.py
