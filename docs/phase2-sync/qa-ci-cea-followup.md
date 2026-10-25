# Response to the cea30b4 hosted failures

This follow-up records the correction reviewed against `cea30b48cbef814511e2eedfc83d1793bc011354` for stacked PR79. Full Node24.21 verification and complete Node20.20.2 units passed on source169 `4967ad40861e64dfe33932a3383216c47b25a978f49ec736dd2dd15c792a5eba`. Both fresh independent reviewers accepted the complete 98-file correction. The nonblocking stale-summary suggestion is resolved without code changes. Earlier in-progress stages below are historical; [current verification](qa-ci-cea-current-verification.md) identifies the tested source and review evidence. Hosted checks on the replacement PR head and physical acceptance remain pending. Physical QA stays parked at `d3eaaf9` until one exact hosted-green head is released.

## What failed

Workflow run `40144853504` failed three jobs. Their full logs and bounded failure blocks remain recorded in `verification-qa.json`.

- Native Windows/Node24.22.1 passed the nine HTTPS fixture children, then failed the parent test's late numeric-PID absence assertion. Browser stages were not reached.
- Ubuntu/Node24.21.0 passed units and browser isolation. The static viewer counted zero rows after Back reached the expected URL.
- Ubuntu/Node20.20.2 reported ten failures and one cancellation across eight sync suites. The individual stages are preserved below. No common hosted actor is established.

## Corrections and evidence

| Boundary | Correction | Verified author evidence |
| --- | --- | --- |
| Windows fixture child identity | Use retained child close status, closed IPC and released listener instead of a later numeric-PID lookup | Complete suite 10/10 on both runtimes and patched-source sentinel control. Native Windows actor remains unknown. |
| Static viewer Back navigation | Wait for DOMContentLoaded after URL equality, then retain the strict two-row assertion | Both containing suites passed, held-response control passed and a permanently wrong response still failed `0 !== 2`. |
| #505 already-aborted reporting | Keep explicit route fences first, then cancellation, then cached permanent error | Containing 61/61 on both runtimes, real held-lock original case and ledger/zero-communication controls. |
| Initial client local queue expiry | Translate a typed queue-only expiry before initial attempt admission into existing bounded retry handling | 303 overlapping checks on each runtime, real pre-fix reds, boundary negatives, persistent worker retry limit/reset and real idempotent custody. |
| #490 shared staging pairs | Prepare the 16 real offers before starting partial uploads with live deadlines | Containing 31/31 on both runtimes and actual patched-source setup-hold control. All quota, ownership, no-custody and cleanup assertions remain. |
| #592 outgoing source lifetime | Own the source reconciliation in a retained child, reap it before public recovery and root removal | Containing 66/66 on both runtimes and actual source-watcher controls. Receiver apply/close authority stays in the parent. |
| #687 interrupted request before pin admission | Fail explicitly if the real request settles before the pin producer is reached, inside cleanup coverage | Early-pin reds fail in under one second; matching controls retain all original pin, late-handle, zero-receipt and fresh-admission assertions. |
| #746 history-fixture foreground work | Move avoidable source-worker status CLI work before publication; retain the actual blocked-history barrier and receiver startup | Containing4/4 passed each runtime. Under matched stable retry state, sender receipts were observed at1686ms/1311ms; old-order and overbudget controls still failed the unchanged foreground-success assertion. |

The queue marker is constructed only by the existing same-process queue timer. Its selected client catch does not include filesystem acquisition, later communication admission, protected work, recovery or cleanup. Unrelated errors and aggregates retain their identity. The remote error allowlist does not accept the local code. All existing deadlines and retry limits remain unchanged.

The worker test advances idle scheduling time between completed passes for attempts 2 through 20. Each failure still uses a real queue hold and real request/pass timers. Initial wake/restart suppression uses actual wall time. This is durable scheduling evidence, not forty minutes of elapsed native backoff. Subsequent custody uses the ordinary positive-control bounds and actual TLS, body bytes and receipts.

The failed history control is retained as a real failed positive. Its pre-commit status hold allowed four unavailable-peer attempts; next eligibility was +7413ms after publication, beyond the five-second wait. Receiver custody at +768ms did not create a sender receipt. Foreground tickets preserve route backoff. No production bypass or receipt shortcut is authorized. The completed outside-repository comparison uses actual pause/quiescence to keep retry state constant during the status delay, and requires already elapsed unblocked eligibility before restoring scheduling. Both prepared positives passed all original assertions; the old-order red and both overbudget negatives still returned pending/exit2/null sender receipt. No pause guard was added to repository source. This is a declared control precondition, not evidence that arbitrary backoff guarantees foreground success.

## Remaining failure distinctions

| Original case | Boundary that failed | Current disposition |
| --- | --- | --- |
| #524 lost readiness ACK | Receiver history-checkpoint count was zero before the fault-hit assertion | Controlled early identity expiry reproduces that assertion. No lost ACK or hosted actor is established from the original result. |
| #578 periodic sessions | Composite request/session/idle predicate | The failed component is unknown. No longer observation budget is authorized. |
| #584 committed ACK/revocation | Held ACK setup was not reached | The original run did not exercise the intended external-revoker ordering. |
| #591 terminal shutdown timeout | Initial positive live confirmation | The failure preceded deletion, interception and close. No setup policy changed. |
| #593 body shutdown timeout | Real body EOF/admission hold was not reached | The original run did not prove the intended retained-authority scenario. No setup policy changed. |
| #690 credential rotation | Initial target control/run aborted before rotation | The failed control operation and ticket/protocol stage remain unassigned. |

Selected local passes do not erase these hosted reds. Controlled holds prove sufficient mechanisms and assertion sensitivity; they do not identify uncaptured hosted latency or establish merge-tree/image equivalence.

## Validation and release gate

Each author used an isolated project worktree, exact Node20.20.2 and24.21.0, synthetic stores and bounded loopback resources. Runtime checks were scheduled sequentially under a shared advisory mutex. An admission timeout is not a test result. Name-filter exclusions and overlapping tests receive no distinct coverage credit.

All earlier failed tests, invalid observers, missed fault hooks and runner corrections remain qualified in the complete reports. The shutdown author's first containing attempt had fourteen cleanup-hook failures; individual causes were not serialized by TAP. Correcting the external runner's live adoption reaping produced final 66/66 without source, deadline or concurrency changes. Its first source-watcher observer also failed at an overly early registry boundary; the final controls inspect the authorized recovery/removal boundary and retain the earlier observation.

Author checks are not the final combined root result. Parent integration receipts and exact source pins are in `verification-qa.json`; `tested-source-qa.sha256` continues to name the last combined-tested snapshot until the new combined run completes. Two fresh independent full-rubric reviews must then inspect one final pin. Published hosted checks must pass before one immutable full SHA is released to physical QA. No merge or deployment is authorized.

Native Windows/macOS acceptance, actual corrected-head three-device LAN/Tailscale testing, exact Node20.0, privileged managers, sleep/boot and physical power loss remain unproven by these local checks. Existing ownership, restore, reclamation and manual supervision limitations remain unchanged.

## First integrated combined result

Exact Node24.21.0 typecheck/build passed, then units reported1026tests/1020pass/4fail/1cancel/1Windows-onlyskip. Skills/browser/site/package smoke were not reached. Three finalization cases missed their hold or required deadline margin; another missed run-ACK/completion setup. Pagination hit its30-second case watchdog. These are retained local combined failures, not new hosted results. All167source hashes and371input hashes remained unchanged, and the expected332compiled outputs were recorded. No blind rerun or Node20 result is claimed.

The finalization and pagination diagnostics use separate app-bound checkouts with exact borrowed source snapshots, restored after use. Finalization has the first bounded runtime slot; pagination must wait. Each must produce a tight actual-stage red/control or a precise missing discriminator before any correction gate. No source edits, deadline increases, assertion weakening or wider matrix is authorized by diagnosis.


## Follow-up preparation and budget evidence

The genuine source viewer now starts and verifies readiness before publication in the six completion cases. Worker identities, due routes, empty prepublication custody and zero tickets are required. The publisher still performs real viewer reuse, worker verification, TLS/history, transfer and custody inside the original five-second foreground bound. All139original assertions and all timing margins remain. A controlled4100ms reader-bind callback hold passed on the prepared fixture and failed the original cold fixture; the2800ms margin and5200ms missing-marker negatives still failed. This removes a demonstrated setup responsibility without identifying the original actor.

The pagination zero-delay control completed all129publications and original metadata assertions in5.024s. Added250ms callbacks after actual durable seed commits exhausted the unchanged30s watchdog after95returned publications and96durable barriers, before identity began. A late ENOENT after teardown is recorded separately. One120s observation-only private case guard now tests whether the same paced arm can complete every original assertion; it changes no protocol/request/session/lock limit and authorizes no repository timeout patch. Neither result identifies the original combined actor.


The single paced private observation finished in41.856s, with129returned seed publications and every original protocol outcome/negative. Parent verified86artifacts/sevencommandlogs/23scoped identities absent/twoexactrebinds. This supports a coordinator-approved one-file aggregate120s budget plus stage diagnostics, now under author validation. The request5000ms/session60000ms and all protocol/security assertions remain. The new source patch is not integrated or combined-tested yet. Original actors remain unknown.


The pagination author typecheck/build passed and complete TAP showed39passes, but its private process sampler raised ProcessLookupError before finalwaitpid. That supervised command remains failed; Node20 and the actual patched paced arm did not run. Cleanup checked284identities absent/64capturedendpoints rebound. Parent inspected and integrated the frozen patch for a new established-runner validation, without claiming the author gate complete. The full containing files on both runtimes and paced arm must pass before a second combined attempt.


## Second integrated combined result

Established-runner checks passed both39-case protocol suites and the actual patched250ms paced case with all129seed sequences/all11protocoloutcomes. FullNode24.21verify also passed units1025/1026,skills48/50,browser22/23,site9/9 with documentedskips and integrity/package smoke. FullNode20units failed two cases: clock-skew cleanup ENOTEMPTY in source/sync, and the linked pending-publication cut at setRetryPaused with a lock deadline. Original actors remain unassigned. Two new residual roots containing32entries are retained untouched; cleanup is incomplete. Parent verified150immutableartifacts/sixoriginalreceipts/source167 and the recorded PID absence.

Clock cleanup diagnosis has the first bounded runtime slot. A separate linked-cut diagnosis may prepare read-only but its runtime remains held. No new source correction, blind combined rerun, fresh review or QA SHA is authorized before those results. All preceding failures and runner qualifications remain.


## Current combined result and review gate

The final169-source correction passed unchanged fullNode24.21verification and completeNode20.20.2units. Each engine reports1051units/1050pass/oneWindows-onlyskip. Fullverification totals1133tests/1129pass/fourdocumentedskips/zero failures or cancellations, plus14-pageintegrity and package smoke. Current source andcompiled manifests and exact evidence are in [current verification](qa-ci-cea-current-verification.md). The old165source manifest is retained as tested-source-qa-ci190.sha256; tested-source-qa.sha256 now names the current169 tested files.

The watcherclose owns and joins admitted checks. A separate one-file positivebackoff fixture uses a fixed1s enclosingpass around its100ms queueexpiry; strict300ms wholepass negatives remain. Earlier combined, author, invalidhelper and expectedred results remain preserved. The exact historical hosted actors, setup stages listed in the Ubuntu20 follow-up and nativeWindows cause remain unassigned. Local green does not erase those limits or establish hostedimage/mergetree equivalence.

Both fresh independent full-rubric reviews accepted the complete 98-file working-tree correction against CEA on one fixed pin. Parent read both reports, verified their evidence and resolved the sole nonblocking stale-summary suggestion without changing code. Hosted checks on the resulting committed SHA must pass before releasing one exact head to physical QA. No merge, deployment or native acceptance is claimed.
