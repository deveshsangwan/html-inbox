Read-only diagnosis of HTML Inbox PR79's repeated push/pull session case is terminal. No repository source, existing test, assertion, configured deadline, index or parent checkout was edited. The proposed patch exists outside the repository only.

The demonstrated finding is a cumulative outer-watchdog budget failure under controlled real fixture I/O pacing, with continuing protocol progress. This supports a narrow test-budget proposal. It does NOT prove that I/O pacing, slow fsync, or resource contention caused the original hosted cancellation. The hosted log contains no per-pass trace, so its exact causal actor remains unknown. No production liveness defect was reproduced on this current source.

App binding and source authority were verified before installation/build and at terminal handoff. Project root is /home/agent/programming/html-inbox; this app-owned checkout/cwd is /home/agent/.t3/worktrees/html-inbox/t3-0154af5e, branch t3/diagnose-sync-session-timeout, HEAD 01657ea6fd6dcb1d4c4f3f5ed4233828ab135f27. Initial and final git status, including all untracked files, are empty. Index SHA256 remains cb43e5764e78e664e72b26c21fc999ad845186d4338a4d8a324f71a0530349f4. Every one of the 164 source hashes and exact source membership matches docs/phase2-sync/tested-source-qa.sha256, aggregate 03951da690ff22fe34e4b5773f5911c30f6697ebce7d3d8c19b9587117aa9de7. No borrowed source copies or worktree switch occurred.

The original failed event is run40127377963/job120971588647, verify (ubuntu-latest,20), test557. The supplied complete log remains /tmp/html-inbox-ci-01657ea-e8_8857h/ubuntu20-job.log, SHA256 a2f64a7e624cc5f913f0903bd885d6ebd4c5eed3982a0ccd1d6853cf74792513. It records testTimeoutFailure at 30040.903162ms against the 30000ms case watchdog, total993/pass990/fail0/cancelled1/skip2. Later cases run. The missing baseline CLI and Windows taskkill skips do not explain this cancellation. Hosted test runtime is20.20.2; hosted build setup24.21.0. Local compilation used installed24.19.0 and pinned tsc-rs0.7.0; test20 used the exact authorized20.20.2 binary. No exact24.21.0 build-runtime reproduction is claimed.

I read the approved proposal, nine required contracts, architecture, protocol/storage interfaces, current correction gates, qa-followup, qa-corrective-handoff and both r4 reports. The architecture's default30-second foreground upload wait is a product-operation setting. This regression performs ten publications and twenty independently10-second-bounded f.run calls, covering forty route passes, on persistent listeners. No approved contract imposes a30-second total throughput SLO on that composite fixture. Its purpose is sustained session release and successful custody/dedup across more than eight passes in BOTH directions.

The ranked predictions were frozen before tests. H1 predicts cumulative legitimate I/O can exhaust the outer30 seconds while each protocol pass progresses and stays inside its original bound. H2 predicts a specific session/lock/pass stalls or leaks. H3 predicts a change under representative parallel-test contention or scheduling. Three capped natural runs preceded pacing; there was no loop until green.

Natural current-source evidence:
- Uninstrumented exact Node20 case passed in18148.825766ms, suite elapsed18270.942425ms. This is the tight existing red-capable command, without a deadline change or fixture reduction.
- Instrumented Node20 passed in21434.385936ms. All40 route completions succeeded, with180 actual client operations,20 holdings queries,80 source-listener requests and100 receiver-listener requests. Ten exact payloads,10 canonical records,20 receiver receipts and20 confirmed committed source obligations were checked. Native owned fsync succeeded17828 times, total703.826729ms, maximum12.649290ms. Maximum observed client operation181.879681ms. At completion both servers had sessions/transfers/sockets/activeRequests/activeTransfers0, no active attempts/operations, and0 tracked open FileHandles.
- Instrumented Node24 passed in14493.404148ms, with the same40 completions/180 operations/20 holdings/10 exact payloads/10 canonical records/20 receipts/20 confirmed obligations and zero residual counters. Native fsync16582 successes,total518.255680ms,max10.823949ms. Twenty two-route reconciliations completed; maximum1062.786659ms. Maximum client operation77.701821ms.

Natural fsync was a small fraction of elapsed time. These measurements contradict an assertion that slow native fsync was already demonstrated locally. The fixture also performs extensive ownership validation, metadata I/O and real50ms authorization watcher work. Those watchers were never disabled. Logging adds overhead, and the instrumented runs are observations rather than benchmarks.

Controlled mechanism evidence:
- A preload delays ONLY actual FileHandle.sync calls for the two synthetic stores under that run's private TMPDIR by a requested1ms, then invokes the unchanged native sync and returns its actual result or error. TLS files, foreign paths, production state and other processes are untouched. It does not alter stat results, successful receipts, protocol replies, application code, watchers, iteration count, routes or documents.
- paced20-red retained the exact30000ms case watchdog. It cancelled at30009.740030ms, with testTimeoutFailure, exit1, fail0/cancelled1. It had19 successful completion calls,10 holdings observations, four complete iterations and a fifth in pull. The last heartbeat still showed actual work, not eight occupied sessions: one current source session,0 receiver sessions,0 active server requests and a pending client manifest operation. Completed two-route calls were all confirmed, maximum4074.978169ms; maximum client operation399.784982ms. Native fsync reported0 errors. This is the same failure class as hosted, under a controlled cause, not a reconstruction of its unknown actor.
- paced20-observation-only is explicitly NOT an accepted unchanged-test green. Only this exact case's outer watchdog was replaced in memory with120000ms, outside the repository, to observe the otherwise identical paced execution. The original30-second red remains intact. The f.run deadline stayed10000ms; default request bound stayed5000ms; normal certificate verification stayed enabled. It completed in75550.886363ms, with all original checks and the additional exact-byte/custody checks. All40 route completions and all20 two-route reconciliations succeeded; maximum run5356.994143ms, maximum client operation391.651969ms. Final state again has ten exact payloads,10 canonical records,20 receiver receipts,20 committed source obligations and zero sessions/requests/transfers/sockets/attempts/tracked operations/FileHandles.
- The observation reached actual native sync23526 times with0 native errors,total3003.919527ms,max24.312444ms. Exactly23526 delay hits added26376.224008ms of measured timer waiting. It acquired2574 locks, versus1760 in instrumented natural20, while the existing watcher machinery continued normally. Max wait until protected lock operation173.850165ms. This metric includes queueing AND durable acquisition, not pure queue wait. Summed lock waits overlap and must not be added as a wall-clock breakdown. Pacing also changes watcher/interleaving work; it is not a calibrated disk-latency replay.

Per-iteration progress and every measured reconciliation, request, lock and fsync are retained as metadata in *.trace.jsonl and summaries.json. No token, signing key or payload content is logged. Actual payload equality checks run against the real managed-store API and original test input. The original bytes are not retained in diagnostics.

Regression sensitivity remains strong. In completion-loss-negative20, the diagnostic preload rejects four attempted completion operations before transport, without fabricating success or receipts. Real current push and pull still execute. The unchanged session-zero assertion fails after the FIRST iteration in1471.457295ms with actual2/expected0, exit1. Both listeners had two retained sessions before teardown. This simulates the former missing-completion retention mechanism; it is not a rerun of historical production source and does not claim a new ninth-request capacity failure. A larger outer budget cannot conceal that immediate assertion failure. The historical original report/probe was read for context only, never executed against its hardcoded parent checkout.

Hypothesis disposition:
- H1: demonstrated as a sufficient mechanism under controlled fixture I/O pacing. The outer watchdog can reject a fully progressing, individually bounded composite test. Native CI fsync latency and the hosted failure's sole cause remain unknown.
- H2: not reproduced. Natural and observed paced executions finish all40 passes without persistent session/attempt/lock/handle leakage. This does not rule out an unobserved hosted liveness failure.
- H3: unresolved. No representative concurrent-suite run or host stress was added. The controlled mechanism and negative control are enough to make the scoped proposal; expanding the matrix would not recover the missing hosted trace. CI scheduling/CPU/I/O contention is plausible but unassigned.

Precise minimal proposal for the parent's NEW frozen test gate: apply proposed-test-only.patch ONLY after parent review. It changes this one composite case's outer timeout30000 ->120000ms, adds a reason comment and20 metadata-only monotonic push/pull progress diagnostics. It preserves ten distinct publications, two approved routes in each direction, all40 route passes, all confirmed/session-zero/final-count assertions, the10000ms reconciliation bound,5000ms request default,60-second session lease, actual durable I/O and normal TLS verification. No production change is proposed. The120-second number is an empirical fixture guard, giving about44.45seconds/59percent margin over the75.55-second controlled full completion. It is not a new product SLO or a promise that every filesystem workload fits. It costs no additional wait on green runs. A genuine failed/aborted10-second pass still fails its confirmed assertion, and missing release fails sessions0 immediately. Each pass is much shorter than the60-second lease, so lease expiry does not substitute for completion at the existing per-iteration assertion.

The added diagnostics make any later host run reviewable by reporting last completed phase, monotonic elapsed/duration, requests and session counts. They do not pretend to reveal the already-failed run. The patch is unapplied and was NOT typechecked or runtime-tested as TypeScript. The parent's gate must validate the final exact patch, containing suites and required broad checks. It should retain this original hosted red and all diagnostic reds; no blind rerun or physical-QA release is recommended. Production changes require a concrete new contract if a later trace identifies a product defect.

Dependencies/build ran in this checkout only under my own HOME/USERPROFILE/XDG/TMP/ZDOTDIR/catalog/npm/pnpm locations and a Python Linux child subreaper. One initial build invocation used the wrong compiler entry filename and failed MODULE_NOT_FOUND before compilation; its receipt is preserved as a preparation failure. The corrected compiler entry built all326 output files successfully. It is separate from product test evidence. No coordinator cwd wrapper, delegation, commit, staging, push, PR operation/comment/watch, live store/service, other host/Mac/Fleet, LAN/Tailscale, privileged settings or security/network configuration access occurred.

Terminal cleanup completed at2026-10-24T20:16:14.517556Z. Thirteen recorded runner/test PIDs are absent; wrapper adopted-child sets are empty because test-owned subprocesses were reaped internally. Ten distinct captured127.0.0.1 ports were rebound/listened/closed successfully. Original fixture cleanup additionally checks exact listener closure/rebind, including the first uninstrumented run whose port numbers were not independently logged. Instrumented terminal states show0 tracked native FileHandles and only stdio Socket handles. No host-global FD/process assertion is made. All owned stores, signing/TLS material, isolated environment trees, installed dependencies, pnpm store and generated dist are removed. The unrelated sentinel is unchanged. Final source membership/hashes, index, branch/head, full tracked/untracked status and git diff HEAD --check pass. Scratch scripts, metadata logs, receipts and proposed patch remain outside the repo.

No real LAN/Tailscale, nativeMac/Windows, physical power loss/restart/sleep or production readiness is claimed. Root owns fixes, checks, reviews, follow-up commits and the eventual one immutable physical-QA head.

Exact commands and receipts follow. Counts are the selected invocation's TAP counts, not full-suite totals. Node20 emits9 name-filter skips for unmatched cases; Node24 omits them and reports1 selected case. These are distinct from the hosted runner's two real environment/platform skips.

dependencies
argv: ["pnpm", "install", "--frozen-lockfile", "--store-dir", "/tmp/html-inbox-session-diagnosis-3elbnxsy/pnpm-store"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:07:42.603275+00:00 -> 2026-10-24T20:07:48.244170+00:00
exit: 0; elapsed seconds: 5.60347384493798; case ms: None; counts: {}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/dependencies.log
SHA256: 8866ef59579585f549ef9316a4bc749995871f8ee329596135bc64bade65f527

build
argv: ["node", "node_modules/tsc-rs/bin/tsc-rs.js", "-p", "packages/cli/tsconfig.json"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:07:55.562331+00:00 -> 2026-10-24T20:07:55.603782+00:00
exit: 1; elapsed seconds: 0.04107181914150715; case ms: None; counts: {}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/build.log
SHA256: 9e7f810b1fe9b8fb162d47e65f388fe8e4cb6a88b1dd1408dbe38fe320fd2522

build-corrected
argv: ["node", "node_modules/tsc-rs/bin/tsc-rs", "-p", "packages/cli/tsconfig.json"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:08:05.115643+00:00 -> 2026-10-24T20:08:05.539740+00:00
exit: 0; elapsed seconds: 0.4237076248973608; case ms: None; counts: {}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/build-corrected.log
SHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

exact20-1
argv: ["/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node", "--test", "--test-reporter=tap", "--test-name-pattern", "^successful push and pull sessions release capacity across more than eight multiroute passes$", "packages/cli/dist/sync-review-regressions.test.js"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:08:09.683870+00:00 -> 2026-10-24T20:08:28.008615+00:00
exit: 0; elapsed seconds: 18.324369255453348; case ms: 18148.825766; counts: {"tests": 10, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 9, "todo": 0}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/exact20-1.log
SHA256: f90f0c669595520b59e7dd74fb04d82b3a276f367aab434b5590d0a643d7ddc9

instrument20-natural
argv: ["/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node", "--require", "/tmp/html-inbox-session-diagnosis-3elbnxsy/probe.cjs", "--test", "--test-reporter=tap", "--test-name-pattern", "^successful push and pull sessions release capacity across more than eight multiroute passes$", "packages/cli/dist/sync-review-regressions.test.js"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:09:23.156115+00:00 -> 2026-10-24T20:09:44.823411+00:00
exit: 0; elapsed seconds: 21.666275401599705; case ms: 21434.385936; counts: {"tests": 10, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 9, "todo": 0}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/instrument20-natural.log
SHA256: 092976495f43e3f9cab4f35afa79853d7bef656bdfd7de9cd74209bfadb24927

instrument24-natural
argv: ["node", "--require", "/tmp/html-inbox-session-diagnosis-3elbnxsy/probe.cjs", "--test", "--test-reporter=tap", "--test-name-pattern", "^successful push and pull sessions release capacity across more than eight multiroute passes$", "packages/cli/dist/sync-review-regressions.test.js"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:10:28.932824+00:00 -> 2026-10-24T20:10:43.640731+00:00
exit: 0; elapsed seconds: 14.707522983662784; case ms: 14493.404148; counts: {"tests": 1, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/instrument24-natural.log
SHA256: bd0b2d96527a30c670cb45b2f1c7831e173aae94cb0d2eb267118b61ffbbcb80

paced20-red
argv: ["/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node", "--require", "/tmp/html-inbox-session-diagnosis-3elbnxsy/probe.cjs", "--test", "--test-reporter=tap", "--test-name-pattern", "^successful push and pull sessions release capacity across more than eight multiroute passes$", "packages/cli/dist/sync-review-regressions.test.js"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:11:24.398187+00:00 -> 2026-10-24T20:11:54.635198+00:00
exit: 1; elapsed seconds: 30.2365282792598; case ms: 30009.74003; counts: {"tests": 10, "pass": 0, "fail": 0, "cancelled": 1, "skipped": 9, "todo": 0}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/paced20-red.log
SHA256: 0ae2d4f4920b09ebaa7cd017c2250374e22d36c80570c3689ed1a29b11b7b7a5

paced20-observation-only
argv: ["/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node", "--require", "/tmp/html-inbox-session-diagnosis-3elbnxsy/probe.cjs", "--test", "--test-reporter=tap", "--test-name-pattern", "^successful push and pull sessions release capacity across more than eight multiroute passes$", "packages/cli/dist/sync-review-regressions.test.js"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:12:21.230136+00:00 -> 2026-10-24T20:13:36.990977+00:00
exit: 0; elapsed seconds: 75.76046000327915; case ms: 75550.886363; counts: {"tests": 10, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 9, "todo": 0}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/paced20-observation-only.log
SHA256: 020b8fc0b909eaf67d64af3b282f30ddcbfb20c6f3f8bcbef31f2f2449bb4a61

completion-loss-negative20
argv: ["/tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node", "--require", "/tmp/html-inbox-session-diagnosis-3elbnxsy/probe.cjs", "--test", "--test-reporter=tap", "--test-name-pattern", "^successful push and pull sessions release capacity across more than eight multiroute passes$", "packages/cli/dist/sync-review-regressions.test.js"]
cwd: /home/agent/.t3/worktrees/html-inbox/t3-0154af5e
UTC: 2026-10-24T20:14:11.212264+00:00 -> 2026-10-24T20:14:12.901471+00:00
exit: 1; elapsed seconds: 1.6888195294886827; case ms: 1471.457295; counts: {"tests": 10, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 9, "todo": 0}
log: /tmp/html-inbox-session-diagnosis-3elbnxsy/completion-loss-negative20.log
SHA256: aabc55f77736c68a84834aab3435383c985cd9792c26582d4a058b89262b73b4

All trace/phase summaries are in summaries.json; all exact environment/PID details are in commands-and-results.json and the individual command receipts. Initial and final audits are initial.json/final-audit.json. probe.cjs instruments module exports and the selected compiled case in memory; repository files stay unchanged. Paced/negative run probe/config bytes were saved before execution. The first natural20 probe revision is explicitly marked reconstructed from the authored edits; its runtime trace is original. The natural24 revision is the identical later probe, before pacing configuration.

Proposed patch SHA256: 8e04fe2edd85adf58b71d54fa3d58dda829f9c15a519515aa61dec49d0f359a4
