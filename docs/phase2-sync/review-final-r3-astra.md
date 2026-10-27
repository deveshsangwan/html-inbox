Independent final focused confirmation: CHANGES REQUIRED.

R8, R9, R10 and R12 are resolved within this review's scope. R11 fixes the supplied inner-watcher-first failure, but remains unresolved overall because a second, deterministic failure-ordering case still returns blocked after authoritative local revocation has aborted the enclosing attempt. One Medium finding follows. I found no additional security bypass, custody corruption or structural blocker in these corrections.

F1. MEDIUM: cancellation discovered during error bookkeeping does not replace the already computed blocked result.

Primary location: packages/cli/src/sync-reconciliation.ts:98 and :102. Related correction: packages/cli/src/sync-store.ts:1220. Worker consequence: packages/cli/src/sync-worker.ts:287.

Trigger: an inbound pull receives a genuine, complete 409 trusted-history-unavailable response after a separate process has durably revoked the local route, while its outer and inner 50 ms watchers have not yet observed that revocation. The client finishes consuming the error and closes the inner attempt. The reconciler computes status=blocked at line 98. Its subsequent setRouteError call at line 102 loads the validated revoked route. The new store guard correctly aborts the outer attempt and rejects the stale authorization, but the catch discards that rejection and never recomputes status. The returned result is blocked even though its outer signal is now aborted and the durable route is detached.

Observed proof: pull-revoke-error.cjs uses current compiled ManagedSyncStore, the actual HTTPS ingestion server, SyncClient, reconciler, generated trusted credentials and the existing child-process HTTPS fault proxy. A relay is explicitly authorized for an origin whose complete history it does not yet hold. The proxy holds the real server's 409 identity response. A separate, awaited Node child revokes the receiver route from revision 1 to revision 2. The probe verifies detached state on disk before releasing the response. AsyncLocalStorage limits the controlled scheduling gap to exactly the receiver's two attempt watchers; server watchers and all request/pass deadlines still run. This is an injected deterministic ordering, not a claim to have observed natural scheduler starvation.

On both Node24.19.0 and Node20.20.2 the outcome is:
  status=blocked; lastError=trusted-history-unavailable;
  outer signal aborted=true; already-completed inner signal aborted=false;
  stale setRouteError calls=1; credential resolutions=1;
  later route result=detached; later requests=0; durable route=detached.

Both final expected-correct probes exit 1 on the assertion requiring aborted. They do not exit 0 by asserting the old defect. The Node24 no-revocation control exits 0 and retains blocked/history-unavailable with both signals live and zero stale bookkeeping calls. An initial pilot withholding all three local watchers also failed, and its receipt is retained separately; the final two-runtime probe withholds only the two receiver watchers.

Impact: this violates the explicit R11 contract for an in-flight revocation result and can misreport cancellation as a blocked sync failure. The worker's existing result handler then attempts recordRouteRun for a non-aborted result; the revoked authorization rejects it, and its catch can label the ticket worker-pass-failed. That worker-ticket consequence is code inference; the independently observed failure is the reconciler result. The guard prevents a stale durable error write. No later credential lookup/network request, grant revival, body disclosure, lost report or persistent route reactivation was observed. Do not describe this finding as a durable authorization bypass or another permanent history-retry failure.

Minimal safe correction: finish failure classification after guarded bookkeeping can observe cancellation, and recheck the attempt signal before returning the route result. If the guard invalidates the attempt, return aborted and skip remaining failure bookkeeping. Retain the existing authorization rejection and genuine TLS/auth/schema/storage failure meanings. A local correction in reconciliation is sufficient; no new public API, scheduler, error hierarchy or store rewrite is warranted. Add the held-complete-error/external-revoke case alongside the existing inner-watcher-first regression and keep the unrevoked history-error control.

Disposition of the requested corrections:

- R8 RESOLVED. sync-http-server.ts:212 creates the generic capacity result before route/credential/document lookup, and :565 preserves exactly 503 request-capacity before the uniform unauthenticated mask. It establishes no session, grant or custody. The existing finite decoder/retry policy recognizes that exact code/status. Actual auth failures remain 403. The real 16-pipelined-request/held-store-lock/owned-worker regression passes on both runtimes, including autonomous custody after release and incorrect-token rejection. Hard quotas remain blocked.

- R9 RESOLVED. sync-client.ts:158 separates the bounded response-consumption try/catch from completed JSON validation. Incomplete streams become response-truncated; :187 additionally checks response.complete. Only the complete, <=1024-byte envelope reaches parseRemoteFailure at :193. Invalid content headers, chunks, oversized data, malformed/unknown/extra/status-inconsistent fields and completed authorization errors retain blocked treatment. The actual worker/proxy eight-byte truncation and completed-malformed control both pass on both runtimes. The shared typed classifier and persistent finite retry policy remain unchanged.

- R10 RESOLVED. sync-http-server.ts:443 registers close/error handling and accounts for already closed/destroyed responses before pinOutgoing. The race at :462 releases the HTTP handler independently of the bounded store pin. The inner finally removes listeners, clears busy and discards interrupted sessions; the outer finally closes the attempt and decrements activeRequests. Attempt abort is also checked immediately after listener registration at :239. Late promise rejection is observed by Promise.race, and the store retains responsibility for closing its real file handle in readHtml's finally. The five supplied body lifecycle cases pass on both runtimes: preclosed, genuine active expiry, disconnect, quiesce and server close. My independent pin-errors.cjs also injects an actual body FileHandle.read EIO before response completion and after termination, plus a controlled ServerResponse error event while pinning is delayed. Each case reports one open/one close, zero retained sessions/requests/sockets, zero receiver receipts and zero unhandled rejections on both runtimes. Late branches send no headers. The live EIO remains storage-unavailable. No cleanup event was re-emitted to make these independent probes pass.

- R11 PARTIALLY RESOLVED, UNRESOLVED overall due F1. The guard at sync-store.ts:1216-1221 correctly invalidates stale registered attempts before throwing when it observes a missing/revised/detached/blocked route. It preserves valid current revisions and does not classify current-revision identity/direction errors as revocation. The supplied actual committed-ACK/separate-revoker/outer-watcher-held regression passes on both runtimes, with aborted status, both signals cancelled, zero stale error calls, silent later starts and preserved remote custody. My independent current-attempt.cjs rejects five invalid/future/missing-route bindings while preserving two valid current attempts, and the correct binding still executes once, on both runtimes. F1 occurs when guarded failure bookkeeping is the first observer, after the reconciler has selected its result.

- R12 RESOLVED. sync-protocol-fixture.ts:136 selects an actual directory-flush event with a .stage.lease whose .stage is absent; :164 exposes it only as child-fixture IPC using the existing constructor test hook. sync-protocol-faults.test.ts:731 arms it once; the test proves exactly one fault and one durable lease/zero stages, releases in finally, then at :750 waits for complete lease/stage pairs. The delta retains all original byte/file quotas, overflow 413, aged live/unknown-start-owner retention, zero custody/final bodies and cleanup checks. Production staging limits and deadlines are unchanged. Both selected quota cases pass independently on both runtimes. Node20 reports the other 28 cases as name-filter skips; I did not rerun or claim all 30 here.

Scope and full rubric:

This is one fresh independent Codex-model focused confirmation, not another exhaustive whole-change review. I inspected all 17 paths in review-r3-corrective-files.json, their delta against the exact review-r2-source snapshot, and surrounding client/server/wire error contracts, shared failure and ledger policy, store lock/recovery/apply/pin/authorization/commit paths, staging and bounded body reads, reconciliation completion/error bookkeeping, worker scheduling/result handling and fixture ownership. The exact inspected list is saved separately. I read the full approved proposal, all nine required contracts, architecture/protocol/worker gates, current storage/protocol/worker interfaces, operations, acceptance, ledger, verification/triage, the four complete supplied prior reports and both corrective writer handoffs. Earlier findings and their accepted remedies were not silently narrowed.

- Correctness and requirements: pressure and interrupted transport now preserve autonomous push/pull recovery; history readiness remains separate from live/full reconciliation and custody. The remaining mismatch is the cancellation outcome in F1. The prior R1/R3/R5/R6 and targeted R7 resolutions are not reopened by this narrow delta.
- Failure handling and concurrency: inspected all new response lifecycle exits, preclosed/abort/error/rejection branches, bounded late pin ownership, busy expiry, session completion, shared-lock authorization and revision fencing. R12 synchronizes on the actual completed reservation pair. F1 shows that cancellation can still arrive during an awaited guard after initial classification.
- Security and data integrity: the public overload exception exposes only generic capacity. HTTPS verification, scoped route/origin/epoch/key/redistribution checks, strict complete envelopes, actual incoming-byte verification and the single atomic apply/commit authority remain in place. Partial text grants no history authority. Revoked authorization still blocks writes and later starts. No new disclosure, signature bypass or receiver-custody regression was observed.
- Assumptions: the probes use real production code with explicit fault seams. Watcher delay, response-error emission and FileHandle.read failure are controlled injections. Local proofs do not establish physical disk stalls, arbitrary loads, OS scheduling behavior or physical persistence.
- Structure and separation: under codebase-design and strict maintainability criteria, these are small corrections at the owning client/server/store seams. The shared deterministic policy/failure modules and selected-owner preflight remain intact. No generic response framework or second mutable storage authority is introduced. The store remains large, but this delta adds a narrow private guard rather than expanding its public interface. A broad split would not fix F1; final cancellation classification belongs in reconciliation.
- Conventions: changed production functions use purpose-revealing names, semantic paragraphs, bounded validation and direct existing APIs. Comments explain lifecycle/authority reasons. I found no new any, non-null assertion, suppression or cast used to evade a production contract. R12's factory-derived collection annotation is a useful test boundary, not a workaround weakening types.
- Test quality and gaps: real workers, authenticated HTTPS, actual shared locks, a separate revoker, true committed custody and real file handles make the added tests meaningful. Green inner-watcher-first coverage does not cover guarded-bookkeeping-first classification. The new F1 regression should be required. Heavy large-cut/cache-scale stress remains unestablished; the independent pin probes use small synthetic bodies.
- Backward compatibility and lifecycle: production public schemas/CLI result shapes and viewer/control/service entrypoints are unchanged by R8-R12. The server does not auto-start on import. Worker/ingestion ownership and current selected-owner validation are retained. Reader/CSP/static-export and real service-manager behavior were not retested here; this pass relies on the unchanged code and earlier accepted reviews for those areas. Server quiescence now drains interrupted body requests, while F1 leaves a misleading route outcome.
- Simpler safer alternatives: keep the existing one storage authority, shared typed decisions and direct response-event cleanup. Re-evaluate cancellation at the final result boundary. No cosmetic whole-store rewrite is requested.

Evidence and limitations:

I independently reran the compiled eight transport cases plus the one deterministic revocation case: 9/9 on Node24.19.0 and 9/9 on Node20.20.2, zero failures/skips. The selected two quota cases also pass on each runtime. Independent pin/guard probes pass on each runtime; the new F1 expected-correct probes fail on each. I did not build, run pnpm verify, rerun 334 cases or modify any repository file.

I inspected the structured supplied verification records, calculated hashes for 57 referenced logs and verified all 51 with expected log hashes, including current broad verification. Supplied current broad is 732 total/727 passed/five documented skips/zero failures, with 14 integrity pages and package smoke passing. The writer's 334/334 two-runtime checkpoint predates the two test/helper R12 changes. Updated full 30/30 protocol receipts on both runtimes and the current broad cover those changes. Counts overlap and are not summed. Failed build/fixture/intermediate broad receipts remain evidence, never acceptance.

No real two-host LAN/Tailscale, actual sleep/boot/reboot, physical power loss, native Windows/macOS, exact Node20.0 or real selected-user privilege/service-manager transition was tested. Boot supervision remains manual/uninstalled. Trusted old-owner recovery and general reclamation remain unavailable; quarantine/future-origin fork is the supported continuation. Indistinguishable same-anchor full restore cannot be detected automatically. These limits do not excuse F1 and this report does not certify production readiness.

Integrity and cleanup:

Initial and final checks verify all 99 current file hashes, 31 tracked modifications/68 untracked files, identical expected status, empty index and git diff HEAD --check exit 0. Independently comparing round2 and current gives exactly the 17 supplied corrective paths. HEAD/base remain b843e126fdb10f7038e9305c6791707bcfee9ff5 on feat/phase2-sync. Manifest SHA256 remains 411962487dad28ee7492b298c82e211e9741af0558cbc833bc851242b28e79d1. All 146 current TypeScript source hashes match aggregate 5e34357b376f5741509039d0cbe07afee621613c82b3907f33252f5accd6c6b3. Approved proposal SHA256 remains adf73962209382ca60aa96b43c2fc81def153e87e98c3232bddcd7c6e6237da5.

All listeners bound 127.0.0.1. Every owned server/proxy/control listener was closed and its exact port rebound by the fixtures/probes. The external audit records 62 distinct loopback ports across these runs. All 299 numerically recorded child/runner PIDs are absent; helper certificate commands are awaited. No owned script process or synthetic fixture home remains. All TLS/token/signing credentials were removed. The independent probes stopped listeners before removing stores. Independent F1 failure cleanup succeeds and rebinds both listener ports on every run. No unrelated process was signalled. No delegation, installed CLI/viewer, real store, live manager, actual setuid, network/security configuration, forbidden address/home, upload, grant, commit, push, PR, merge or deployment was used.

Evidence lives only in /tmp/html-inbox-r3-independent-ay7i9eew. See initial-check.json, final-check.json, cleanup-proof.json, current-source.sha256, inspected-corrective-files.json, verified-supplied-logs.json, focused24/20.json and quotas24/20.json with their audit JSONL, and command-*.json. The consolidated commands-and-results.json records read/probe argv, exit, output and elapsed time. Initial bootstrap reads and the harmless no-match rg exit are retained in tool receipts. The initial two parallel document-read receipts shared a counter filename; their full output remains in tool history and those documents were read again in bounded chunks. Probe receipts use unique timestamps.

Exact executed probe/test commands and exits, each wrapped by python3 /tmp/html-inbox-r3-independent-ay7i9eew/run.py:

timeout 25s node /tmp/html-inbox-r3-independent-ay7i9eew/pull-revoke-error.cjs
Exit 1; 0.496 seconds; receipt command-1792801694041303118.json

timeout 25s node /tmp/html-inbox-r3-independent-ay7i9eew/pull-revoke-error.cjs
Exit 1; 0.488 seconds; receipt command-1792801734052993458.json

timeout 25s /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node /tmp/html-inbox-r3-independent-ay7i9eew/pull-revoke-error.cjs
Exit 1; 0.595 seconds; receipt command-1792801734625629383.json

timeout 25s node /tmp/html-inbox-r3-independent-ay7i9eew/pull-revoke-error.cjs --control
Exit 0; 0.393 seconds; receipt command-1792801735304351527.json

python3 /tmp/html-inbox-r3-independent-ay7i9eew/tests.py focused24 node packages/cli/dist/sync-transport-lifecycle.test.js packages/cli/dist/sync-revocation-order.test.js
Exit 0; 9.425 seconds; receipt command-1792801791821323463.json

python3 /tmp/html-inbox-r3-independent-ay7i9eew/tests.py focused20 /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node packages/cli/dist/sync-transport-lifecycle.test.js packages/cli/dist/sync-revocation-order.test.js
Exit 0; 10.527 seconds; receipt command-1792801820569792297.json

python3 /tmp/html-inbox-r3-independent-ay7i9eew/tests.py quotas24 node '--test-name-pattern=real concurrent HTTPS streams share' packages/cli/dist/sync-protocol-faults.test.js
Exit 0; 5.453 seconds; receipt command-1792801859981550546.json

timeout 25s node /tmp/html-inbox-r3-independent-ay7i9eew/pin-errors.cjs
Exit 0; 1.047 seconds; receipt command-1792801886893138414.json

python3 /tmp/html-inbox-r3-independent-ay7i9eew/tests.py quotas20 /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node '--test-name-pattern=real concurrent HTTPS streams share' packages/cli/dist/sync-protocol-faults.test.js
Exit 0; 5.129 seconds; receipt command-1792801907090248879.json

timeout 25s /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node /tmp/html-inbox-r3-independent-ay7i9eew/pin-errors.cjs
Exit 0; 1.119 seconds; receipt command-1792801908261698434.json

timeout 15s node /tmp/html-inbox-r3-independent-ay7i9eew/current-attempt.cjs
Exit 0; 0.129 seconds; receipt command-1792801936979425866.json

timeout 15s /tmp/html-inbox-phase2-checks-1mpkndv5/npm-cache/_npx/ebaba8b9e55fd0a9/node_modules/node/bin/node /tmp/html-inbox-r3-independent-ay7i9eew/current-attempt.cjs
Exit 0; 0.144 seconds; receipt command-1792801937193291593.json

tests.py adds timeout 55s, --require /tmp/html-inbox-r3-independent-ay7i9eew/audit.cjs, --test and --test-concurrency=1, and a fresh isolated HOME/TMPDIR/XDG/catalog environment. The exact expanded argv and environment are in focused24.json, focused20.json, quotas24.json and quotas20.json. run.py captures every probe invocation.
