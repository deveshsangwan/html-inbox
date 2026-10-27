Independent focused review of the PR79 hosted-CI follow-up. Terminal verdict: ACCEPT.

Both current corrections are accepted. I found no blocking Critical, High, Medium or Low defect in their implementation or necessary interactions. One nonblocking documentation Suggestion is recorded below. This is a new independent Codex review, without delegation. It preserves the earlier whole-change reviews and does not claim a fresh exhaustive review of phase 2, hosted-green status, physical acceptance, or production readiness.

The reviewed checkout is `/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync`, branch `feat/phase2-sync`, HEAD/base `01657ea6fd6dcb1d4c4f3f5ed4233828ab135f27`. The entire follow-up remains uncommitted, including all new files, with an empty index. The original whole-change review base remains `b843e126fdb10f7038e9305c6791707bcfee9ff5`.

I inspected the complete 918-line `git diff HEAD`, full current production publication module, complete new 347-line inspection test, the session-test change and its actual fixture/reconciliation/completion dependencies, and every relevant untracked file in the 13-file manifest. I read the complete approved proposal and nine required contracts, frozen architecture, relevant storage/protocol/worker interfaces and operations, acceptance, follow-up/handoff/commit sequence, both latest complete R4 reports, and the retained earlier findings, responses and qualifications. I parsed the full verification JSON and inspected the current changed records. The author handoffs, causal notes, inspection notes, session applied-patch probe and retained diagnostic evidence were reviewed as supplied evidence, not treated as my own executions. No author/reviewer conversation was inherited or consulted.

Publication inspection finding: RESOLVED.

The correction at `packages/cli/src/sync-publication.ts:138-194` catches only the existing deadline/abort/cancel classification at the individual custody lookup. A short unavailable lookup no longer escapes past the snapshot-derived diagnosis and impersonates expiry of the complete foreground wait. `matchingRoutes(current)` uses the same validated snapshot cut as worker, route retry and outbox inspection. It still filters outbound routes by the publication's intended peer/destination, active/reconnecting state and origin/epoch permission.

Fallback item metadata is restricted by exact route ID/revision, canonical origin pair and publication fingerprint at lines 175-178. It cannot borrow a different publication, old revision or unrelated target. A successful status takes precedence over fallback metadata. `isCommitted` from an in-budget successful current `deliveryStatus` remains the only confirmation branch, at lines 170-172. A confirmed metadata entry by itself never produces a returned receipt or confirmed success. Acknowledged suppression/deletion/supersession can explain a block and remains distinct from committed live-body custody.

The aggregation preserves permanent item blocks, persisted blocked retries and permanent route failures. History-only waiting stays retryable only when neither permanent guard applies. A blocked route does not defeat another eligible route to the same target; a genuine committed result wins. No authorized route still means the explicit no-route block. Unknown or unreadable metadata does not invent pause, block or custody. Nondeadline errors still propagate; the unchanged error predicate is not broadened. The initial/final outer fallbacks distinguish inspection unavailability from actual overall expiry.

The configured overall wait, 250 ms finish reserve, per-route 200 ms lookup, 150 ms cancellation and status/viewer bounds remain. Once a bound has elapsed, further routes can contribute metadata diagnoses without starting another custody lookup. True overall expiry remains finite pending/deadline in the absence of a stronger validated result. There is no new retry loop, scheduling policy, persistence operation, public API, wire/schema change or storage authority.

Existing genuine-confirmation optimization, late SIGINT normalization and attempted-versus-acknowledged exact-ticket cancellation are intact. Cancellation still latches before its await, happens at most once for this publication's own ticket, preserves saved data/retries, and cannot undo remote custody. My 55-case executions on both pinned runtimes include all 26 finalization cases, all 11 original publication cases and all 18 new inspection cases. They exercise actual native lock deadlines, first/final inspections, permanent and transient diagnoses, alternative route precedence, error identity, total expiry, real HTTPS custody and acknowledged suppression, and the prior cancellation/held-ACK interactions. No passing claim rests on ping, readiness or metadata custody.

Session-capacity finding: ACCEPT the explicitly authorized test-budget correction.

At `packages/cli/src/sync-review-regressions.test.ts:202-230`, only this composite case's outer watchdog changes from 30 to 120 seconds. The reason comment and monotonic phase diagnostics explain and expose the accumulated work. All ten distinct publications, two approved routes, push and pull, forty route passes, confirmed assertions, per-iteration zero-session assertions and final ten-document assertion remain. The fixture still supplies a 10-second reconciliation deadline. The five-second default request bound, sixty-second lease, normal TLS, durable I/O and authorization watchers are unchanged.

This is a finite observation budget for twenty bounded calls, supported by the frozen gate. It is not a new product latency guarantee or a change to the thirty-second foreground publication wait. The original session-retention regression still fails immediately at the first zero-session assertion instead of being hidden by the longer watchdog or lease expiry. My independent preload withheld exactly four actual manifest-completion calls before transport, returned no synthetic receipt/success, and the unchanged assertion failed with `2 !== 0` in 2691.919 ms. The child exited 1 with one expected failure; nine name-filter exclusions are not pass credit.

Both positive session executions completed the actual compiled case with all twenty progress diagnostics and zero sessions. Node20's instrumented run overlapped the separate focused review run and took 30.864 seconds inside the case, maximum reconciliation 2.907 seconds. Node24.21 took 15.787 seconds, maximum reconciliation 1.238 seconds. These observations are not benchmarks or an explanation of the hosted cancellation.

I inspected the supplied pacing probe. It requires the actual compiled 120-second case, rejects the old diagnostic outer override, delays only the owned synthetic stores' real `FileHandle.sync` calls and then invokes native sync, retains the original assertions and adds exact-byte/record/receipt checks. The supplied actual-patch 70.225-second positive and 1.508-second negative therefore have useful authority. I did not rerun pacing or calibrate it to hosted I/O. The earlier 75.55-second override remains observation-only. Both original hosted actors and the natural hosted lock/latency stage remain unknown.

Full rubric coverage within this corrective scope:

- Functional correctness and missed requirements: both gates are implemented without dropping the original nine contracts or six acceptance groups. Actual push, independent repair pull, durable worker lifetime and current-holdings repair remain in their existing authorities. The changes alter diagnosis and one fixture observation budget, not the replication contract.
- Edge cases and failure handling: reviewed initial/final lookup expiry, exhausted bounds, snapshot failure, EIO identity, permanent/transient/history/suppressed outcomes, local-only/no-route behavior, competing eligible routes, cancellation and finalization. Supplied and independently run tests distinguish actual faults, negative controls and missing-hook failure.
- Security and data integrity: no TLS bypass, weaker file guard, owner/PID guess, inbound path, implicit grant, secret logging or export permission is added. Exact snapshot/key/fingerprint checks limit diagnosis. Only the current store receipt path can confirm custody. Tombstones, canonical metadata and byte verification are unchanged.
- Concurrency: one coherent metadata cut replaces the former independent route snapshot. Snapshot staleness can affect an unconfirmed diagnosis but cannot establish custody or mutate authorization. Current store/request authorization remains authoritative. Cancellation, receiver commit, session completion and worker/viewer lifetime interactions retain their earlier guards.
- Assumptions: neither controlled mechanism nor local green identifies an original hosted actor. A paused/disabled diagnosis does not promise scheduling. Acknowledged suppression is not live-body custody. No physical or cross-host conclusion follows from loopback fixtures.
- Structure and separation: the private publication inspector owns this reporting decision and reuses existing keys/policy. The store retains the single mutation/commit authority. No speculative adapter, scheduler or second mutable owner is introduced. Catching the per-route subdeadline is smaller and safer than weakening deadlines or skipping final custody checks.
- Repository conventions and TypeScript: purpose names, reason comments, semantic paragraphs and isolated exits are retained. Types are inferred locally; the optional validated snapshot and delivery result are useful boundaries. No new `any`, non-null assertion or suppression was found. The new tests use native path separators and existing fixtures.
- Test quality and gaps: all old assertions and tests remain, and the new cases hold real ownership locks rather than merely returning fabricated timeout strings. Real custody/suppression controls prove the receipt distinction. The negative completion test remains sensitive. I did not execute every unchanged phase-2 suite or add a stress matrix. Fingerprint/revision rejection is assessed through the direct guards and ledger validation, without a new forged-snapshot test.
- Backward compatibility and simpler alternatives: ordinary libraries, reader/list/search/CSP/sandbox/export, viewer/service ownership and managed schemas are untouched. Keeping a private metadata fallback and one explicitly gated test budget is justified. A cached receipt, broad catch, timeout increase in production, or repeated rerun would have weaker evidence or broader effects.

Necessary prior findings remain fixed, not waived. The unchanged store validates and serializes durable catalog intent, current origin/redistribution scope and atomic revision fences. Its current receipt predicate, retry policy, signed terminal history, detach/reconnect and restore/fork guards are still used. The unchanged worker/storage paths retain fatal-cause preservation, descriptor disposal, inbound drainage, typed reaper failures, verified ledger replacement and current eligible-route credentials. The new tests reuse the accepted retained-runner stop/reap/recover fixture boundary. That boundary is not a general live-backup API. I retain prior review credit for unchanged paths instead of claiming to have independently rerun them all.

Suggestion S1, nonblocking documentation count.

Location: `docs/phase2-sync/verification-qa.json:27470`. `hostedCI01657Followup.cleanup.newRuntimeCompileCacheEntries` is 6. The detailed final receipt's map has six root buckets, but its entry counts are 555, 0, 0, 0, 0, 0. The follow-up prose correctly says 555. This is directly reproduced in `supplied-evidence-audit.json`, not an inferred runtime fault. Impact is an inconsistent machine-readable cleanup count only. Minimal correction: use 555 for the entry count, or name 6 as the root-bucket count and retain 555 separately. It does not affect acceptance of either code/test correction.

Supplied broad evidence was audited, not rerun.

All 50 immutable artifact sizes/hashes, all 564 current/historical log hashes and all 328 compiled hashes match at start and finish. All 290 adopted PIDs in the two parent outer audits are absent. The supplied unchanged full `pnpm verify` on exact Node24.21.0 exits 0 in 291.836611 seconds: unit 1011/1010 pass/1 Windows skip, skills 50/48/2 Windows skips, browser 23/22/1 optional CDN skip, site 9/9. Total 1093/1089 pass/4 skips with no failures, cancellations or todo, plus 14-page integrity and package smoke. Complete compiled Node20 units exit 0 in 304.789743 seconds, 1011/1010/1 Windows skip. Counts overlap. The IPv6 SAN test passes on exact 24.21.0.

Parent log hashes are `72c1cc036d022bfcf9bd5aa3c30c039fa045d19668ba3424438464136fbf4544` and `f29a6b1d7af2fa0ae49e265fc3ec4d2f3c53724834c0fe4c0b802d170234370e`. The original hosted logs remain `a2f64a7e624cc5f913f0903bd885d6ebd4c5eed3982a0ccd1d6853cf74792513` and `34fa3a56841ece6926b14ae606907c3b98ffb73715fc7eddcee0af06c21340ae`. I read their full bytes and extracted runtime/failure context into `hosted-log-excerpts.json`. Their failures remain the 30040.903162 ms outer cancellation and actual `foreground-deadline` versus expected `retries-paused`. No later green reclassifies either original failure.

Initial and final pins match.

The review manifest SHA256 remains `4982cb598c13487af0c7b8b4fc756b34f741edc3455d5be1165c00dd13cc7ada`. All 13 file lengths/hashes and exact status match. Index is empty and its bytes remain `7a2413a352f6eb2e68cefe71c18f9492f0c611e648d295c57921cce13b0e3b0d`. All 165 source files and exact membership match aggregate `4fd87ba653c147d464d75083ed5531f962c001feebe55e0a4ed7eb468190c91b`; the repository and scratch source lists are identical. All 328 compiled files match manifest `ef54dda93eb87c95be580c670b862eadc961e464e06132d89760b0f4b2bcb727`. All 320 current tracked/untracked nonignored file entries match my initial inventory. The parent's 319-file inventory refers to its earlier check interval before the final handoff document. `git diff HEAD --check` exits 0. The approved proposal and both current gate hashes match the user pins. `initial-pin.json`, `final-pin.json` and `verify-pin.py` retain reproducible evidence.

Cleanup and restrictions.

The five valid invocations used fresh private HOME/USERPROFILE/XDG/catalog/TMP/ZDOTDIR/PATH and compile-cache-disabled environments, direct real runtime binaries, my own concurrent subreaper and an observation preload. Existing compiled modules were read only. The five valid invocations retained 486 unique direct/fixture/adopted PIDs; 56 adopted descendants were reaped while tests ran. Including the invalid initial runner, all 507 captured PIDs are absent. All 210 distinct captured literal 127.0.0.1 endpoints, including fixture port probes, were rebound/listened/closed in the final audit. This is the captured set, not a host-global inventory.

Actual new inspection tests assert native EBADF before fixture teardown and zero emergency handle leaks. The observation preload reports zero captured open FileHandles at normal process exits. All private environments, stores, catalogs and temporary TLS/signing material were removed after settlement, with no owned live environment references. Original sentinels remained unchanged. No inherited runtime cache or foreign fixture was removed. The last audit found 246 inaccessible unrelated proc environment directories, so no host-global absence claim is made.

The initial review-runner failure is retained, with no pass credit. My first subreaper incorrectly deferred adopted-child reaping until the test runner exited. Two finalization cleanup hooks saw zombie runtime PIDs; I terminated only the verified owned finalization test process, then retained the 32-test/29-pass/3-fail invalid log. The wrapper exited 1 at its residue assertion. Log SHA256 is `9df2bec49d06f21f9230dd0b5e24ec5d1c6a7dc1450e185ec9bf9169f8a3e523`. The logfile creation timestamp is 2026-10-24T21:16:34.214309886Z; it is not presented as a captured process-start timestamp. `invalid-runner-note.json` records the owned SIGTERM and qualification; `invalid-publication2421.json` records absent PIDs, exact rebinds and removal of its interrupted fixtures. I corrected only my external runner and then ran the valid focused checks with concurrent reaping. No repository test, deadline or assertion was changed to obtain green.

No source/docs/build/index/dependency mutation, install, rebuild, broad rerun, delegation, author coordinator wrapper, other worktree, live store, LAN/Tailscale/wildcard listener, real credential access, security/network change, Mac/Fleet action, commit, push, public comment, watch, merge or deployment occurred. Harness-required app-local PR79 registration was made; the final list confirms it is linked and watching=false. No Claude or cross-provider review is claimed.

Remaining limits are unchanged: unknown locks/interrupted reapers may block, macOS null-start/PID ambiguity is conservative, pre-install candidates can accumulate, general reclamation and trusted old-owner recovery are unavailable, hostile same-account replacement is outside the existing contract, and indistinguishable same-anchor restores cannot be detected. Managed schema 2 requires coordinated versions and POSIX opt-in; ordinary portable behavior retains its historical creation window. Native Mac/Windows, exact Node20.0, real three-device network/viewer acceptance, sleep/boot/power loss and live privileged manager/supervisor transitions remain unproven. Physical QA stays parked at d3eaaf9. This review releases no candidate SHA. Parent must read both terminal reviews and owns subsequent triage, commits, publication/checks and physical handoff.

Exact independent execution receipts follow. Commands use the frozen compiled bytes and the external runner linked in this directory. Positive counts overlap the supplied checks and are not added to them.

focused2421

```sh
python3 /tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/run-focused.py focused2421 /tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap --test-concurrency=1 packages/cli/dist/sync-publication-inspection.test.js packages/cli/dist/sync-publication.test.js packages/cli/dist/sync-finalization-lifecycle.test.js
```

UTC 2026-10-24T21:18:46.389350+00:00 to 2026-10-24T21:19:52.840505+00:00. Runtime v24.21.0. Elapsed 66.45114317908883 seconds. Child exit 0. Counts {"tests": 55, "pass": 55, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log SHA256 `43446490ce5cd10b83a5ed75551700a5736b3bccd1872ead64c6b66fe4a11fc4`. Exact environment/resources are in [focused2421.json](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/focused2421.json); log [focused2421.log](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/focused2421.log).

focused20

```sh
python3 /tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/run-focused.py focused20 /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap --test-concurrency=1 packages/cli/dist/sync-publication-inspection.test.js packages/cli/dist/sync-publication.test.js packages/cli/dist/sync-finalization-lifecycle.test.js
```

UTC 2026-10-24T21:20:04.812914+00:00 to 2026-10-24T21:21:16.827912+00:00. Runtime v20.20.2. Elapsed 72.01497978903353 seconds. Child exit 0. Counts {"tests": 55, "pass": 55, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log SHA256 `845cb960091542cc76e366bb3cb254184985a168c901d035b8ea72f5a54731db`. Exact environment/resources are in [focused20.json](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/focused20.json); log [focused20.log](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/focused20.log).

sessions20

```sh
python3 /tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/run-focused.py sessions20 /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap --test-name-pattern '^successful push and pull sessions release capacity across more than eight multiroute passes$' packages/cli/dist/sync-review-regressions.test.js
```

UTC 2026-10-24T21:19:19.488147+00:00 to 2026-10-24T21:19:50.680744+00:00. Runtime v20.20.2. Elapsed 31.192581144161522 seconds. Child exit 0. Counts {"tests": 10, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 9, "todo": 0}. Log SHA256 `0ffdd107dbc72f97cad13aff301a14842b292d16a268382df0e7f0ea4d90ebda`. Exact environment/resources are in [sessions20.json](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/sessions20.json); log [sessions20.log](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/sessions20.log).

sessions2421

```sh
python3 /tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/run-focused.py sessions2421 /tmp/html-inbox-hosted-node2421-oz5llfie/runtime/node_modules/node-linux-x64/bin/node --test --test-reporter=tap --test-name-pattern '^successful push and pull sessions release capacity across more than eight multiroute passes$' packages/cli/dist/sync-review-regressions.test.js
```

UTC 2026-10-24T21:20:53.586645+00:00 to 2026-10-24T21:21:09.668968+00:00. Runtime v24.21.0. Elapsed 16.082314589992166 seconds. Child exit 0. Counts {"tests": 1, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log SHA256 `0683b5439c552fa72ff340dbe1d1579cc0890642a1df74c7a821af85d2751dcf`. Exact environment/resources are in [sessions2421.json](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/sessions2421.json); log [sessions2421.log](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/sessions2421.log).

negative20

```sh
python3 /tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/run-focused.py negative20 /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node --test --test-reporter=tap --test-name-pattern '^successful push and pull sessions release capacity across more than eight multiroute passes$' packages/cli/dist/sync-review-regressions.test.js
```

UTC 2026-10-24T21:20:05.966592+00:00 to 2026-10-24T21:20:08.894871+00:00. Runtime v20.20.2. Elapsed 2.9282655538991094 seconds. Child exit 1. Counts {"tests": 10, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 9, "todo": 0}. Log SHA256 `0a05eda22aeef2d3815a3c7e97a7f2faf1422567718dca2f57dec664978284e6`. Exact environment/resources are in [negative20.json](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/negative20.json); log [negative20.log](/tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/negative20.log).

Runtime binary SHA256 values: Node24.21.0 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`; Node20.20.2 `6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd`.

Final audit command: `python3 /tmp/html-inbox-independent-sol-hosted-review-5lqhkfw6/verify-pin.py`, exit 0. This report and all receipts are outside the repository.
