# PR #124 description history

The PR #124 description as it stood on 2026-11-23 before the council rewrite, preserved verbatim. It records the status handoffs for heads up to `7abbb18`. Current status lives in the PR description.

---

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

## CURRENT STATUS: scoped ready-for-review handoff

Exact head `7abbb185c785792901f8993c766fed66c8f6f077`, base `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. The root accepts readiness for the published, bounded acknowledgement optimization and evidence scope. This is a review handoff; no merge, release or issue closure.

**Current normal CI is accepted.** [Verify run 42680164272, attempt 2](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272) completed successfully at this exact head. The final table has 16 successful workflow jobs; the rollup has 16 successful check runs plus CodeRabbit success and one `Macroscope - Correctness Check` skip: 18 non-failing entries, not 18 executed tests. Exactly one rerun of the original failed Windows Source job was requested. [Windows job 129380176137](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129380176137) passed on Node 24.22.2: 1,270 tests, 426 passed, 844 skipped, none failed/cancelled. The concurrent public-deleter test passed. [Verify job 129381064763](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129381064763) passed its aggregate comparison. The other 14 leaf successes were carried forward, not rerun; the Linux20 shard's decoded log is byte-identical to its retained first-attempt log.

**Both independent reviews are accepted within their recorded scope.** Codex `gpt-6.1-sol` with `reasoningEffort=high`: functionality PASS, code quality PASS, validation/performance PASS for bounded claims. Claude Agent `claude-sonnet-5-5` with `effort=medium`: functionality PASS with nonblocking findings, quality PASS with suggestions, validation/performance PASS for the preselected claim. These reviews inspected `7c427ce`; the later three-document observer/mechanism clarification and narrow returned-recovery diagnostic received direct root review. Do not attribute those later lines to the earlier reviewers. Sonnet's acceptance includes the explicit historical-prose exception: root verified body aliases and read one 1,309-character historical pending-status paragraph. This is not a claim that the reviewer independently read every historical prose byte, nor a union of incomplete reviews. Prior incomplete reports remain incomplete and preserved.

**Claim and limits remain unchanged.** Repeated b249 n=3 and separate original610 n=1 evidence support reduced source noop logical ledger replacement bytes and commits, with completed custody/equivalence and bounded 129-record page controls. The 203-to-3 source commit change also removes 200 awaited observer stats; timed snapshots/equivalence and observer overhead are not isolated. The fixtures do not separately measure mutating multi-receipt batch throughput. Initial CPU, Node24 initial end-RSS, bundle and receiver-byte observations retain their individual costs and limits. The per-page replacement-count regression assertion and other Low/Suggestion findings remain nonblocking follow-ups.

**Historical failures are preserved, not explained by green CI.** The [first Windows deletion EPERM](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129372222807), c8 recovery failure, and e017/887 failures retain unresolved causes. No flake, baseline-reproduction, native-cause or global candidate-exoneration claim. The current Linux length-recovery case passed without a mismatch tag; unused diagnostic/controller failure, interruption and adversarial branches remain unqualified. Recorded process identities are sampled; raw-index acceptance is semantic. The local qualified outputs remain unchanged, including the two stale diagnostic test JS files; hosted CI built the committed source.

The source is clean and frozen, all granted local work is released, and original logs, receipts, reviews, findings and earlier status bodies remain intact. Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

<details>
<summary>Historical PR status, full prior reports and receipts — preserved verbatim</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

## CURRENT STATUS: one Windows rerun requested; first-attempt failure retained

Head `7abbb185c785792901f8993c766fed66c8f6f077`, base `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`, DRAFT. Run42680164272 attempt1 has finished: all14 other leaf jobs succeeded, Windows Source failed, and [Verify job129378541269](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129378541269) failed only its all-groups-success comparison. Verify adds no independent application defect; no dependency mapping is inferred from the RESULTS string.

Root read the [Ubuntu20 shard2/2 log](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129372222712):893 tests,891 passed,2 skipped,0 failed/cancelled. The length recovery case passed as test524,1642.719346ms, on test20.20.2 after build24.22.2. No recovery diagnostic tag appeared. This is current hosted success for that case, not an explanation of c8's original pending recovery or failure-branch qualification.

The remaining leaf failure is [Windows Source's concurrent deletion rename EPERM](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129372222807), preserved with full first-attempt log/source comparisons. No native cause, flaky-test or baseline-exoneration claim. Root requested EXACTLY ONE rerun of that failed Windows job on unchanged7ab; the GitHub API accepted the request. Other successful leaf jobs were not manually rerun. Any dependent Verify scheduling is GitHub-owned. The job retains its original20-minute cap, tests and assertions. No repeated retry loop or automatic further retry is authorized.

There is no connected Windows execution environment for a local focused reproduction. This bounded hosted repetition is one further observation; a pass will not erase or explain the first failure. Full receipts: `artifacts/performance-issues-2026-11-07/issue97-ci-7abbb18-verify129378541269`, result SHA256 `d0048d90027e6017e91edb24f021b3fa5ed3c81073e6017b46419bb367a5414e`, repeat decision `004c9a66c2aeba8069285e104c1e5c2662ea63011a087d82dd0d2c65caf48a12`.

Both independent reviews and scoped measurements remain accepted separately. Source/output/tool bytes unchanged, no local runtime or new reviewer; LOCAL free. Keep draft while the existing watch awaits this single Windows repetition and the root's readiness disposition. Historical c8/e017/887 and shared Windows observations remain unwaived. No merge/release/issue closure.

<details>
<summary>First-attempt Windows triage and complete prior PR history, preserved verbatim</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

## CURRENT STATUS: Windows deletion CI failure; remaining jobs pending

Head `7abbb185c785792901f8993c766fed66c8f6f077`, exact base `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. Keep DRAFT. [Source Windows24 job129372222807](https://github.com/deveshsangwan/html-inbox/actions/runs/42680164272/job/129372222807), run42680164272 attempt1, passed install, typecheck and build on Node24.22.2, then failed test74, `independent public deleters coordinate real child processes`. It reported native `EPERM` renaming a document directory into `documents/.trash`, after301.9692ms. Unit totals:1270 tests,425 passed,1 failed,844 skipped,0 cancelled. Later harness/package/cleanup/website steps were skipped.

The new length-recovery diagnostic test was explicitly skipped on Windows. This job neither executes that diagnostic nor resolves the earlier c8 Linux recovery failure. The concurrent deletion test launches four independent public deleters; its Promise.all rejected before the one-result/three-null/empty-trash assertions. The log does not identify a conflicting handle, lock owner, permission condition or native cause.

The same named rename-EPERM observation was retained earlier on PR121 at8f212d3/job128904503689. The deletion test, worker, public API and protocol bytes match actual610 and immediateb249. CI merge744fd29f8ac275d8accf1fb9d61039fb358d54f7 has no file changes versus7ab. These identity and symptom matches are not baseline reproduction, proof of one shared cause, or candidate exoneration.

Original decoded logs, step/job/run snapshots, source comparisons and receipt are retained at `artifacts/performance-issues-2026-11-07/issue97-ci-7abbb18-run42680164272`, receipt SHA256 `fc5db62e3182747fa09e4c13f4120b987d64fc5a482d0fbb672d9d7537ce1cef`. The first job snapshot still has running/queued jobs; no final workflow outcome or current Ubuntu recovery result is inferred.

Both completed independent reviews and scoped performance evidence remain accepted separately. No source change, local runtime, workflow retry or additional reviewer from this event. LOCAL free; existing watch retained. Current CI remains an unmet readiness gate. Historical causes remain unresolved, and merging/releasing remain separate actions.

<details>
<summary>Prior diagnostic publication status and full PR history, preserved verbatim</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

## CURRENT STATUS: recovery diagnostic published; normal CI pending

Head `7abbb185c785792901f8993c766fed66c8f6f077`, exact base `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. Keep DRAFT. Both renewed independent reviews remain accepted for their recorded source/evidence scopes at 7c427ce. This follow-up changes one test-only diagnostic and three evidence/status documents; production, benchmark harness and all 393 qualified generated files are unchanged.

The [c8 Source Ubuntu20 failure](https://github.com/deveshsangwan/html-inbox/actions/runs/42674717480/job/129352829725) remains unexplained: the length identity case returned recovery status `pending` where the original assertion requires `confirmed`. Verify failed only its aggregate comparison. One bounded unchanged-source local attempt passed the focused case and the original default-concurrency shard, 891 passed and 2 skipped. This is nonreproduction, not hosted clearance. Local build Node 24.19.0 differs from hosted build 24.22.2; both tested on 20.20.2.

The new `issue97-recovery-result-v1` diagnostic attempts one bounded, sanitized line only on the length recovery mismatch, using the same already-returned result. It adds no request, await, retry or deadline change. The strict assertion remains authoritative in finally. The pinned native compiler noEmit check passed; there was no local test execution after this edit and its failure branches remain unqualified. [Full result, exact command/log hashes and diagnostic limits](https://github.com/deveshsangwan/html-inbox/blob/7abbb185c785792901f8993c766fed66c8f6f077/scripts/bench/evidence/issue-97-recovery-c8.md).

The original local receipt and both restoration audits remain immutable. All qualified outputs, source except the one approved test, tools and runtimes were verified. LOCAL is free. Historical c8/e017/887 failures and prior incomplete reviews remain recorded without cause or flake waivers. The successful renewed reviews and accepted b249 n3 / actual610 n1 / 129 controls remain separate from this CI diagnosis.

New-head normal CI is pending actual watcher evidence. No workflow retry, merge, release or issue closure. The existing watch continues. Final scoped readiness awaits current-head CI and disposition of any new failure.

<details>
<summary>Prior c8 CI triage and complete earlier PR history, preserved verbatim</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

## CURRENT STATUS: normal CI red; bounded recovery reproduction started

Head c8baba7cfeaabe200deca00e4bcdcbb701476ba7, exact base b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad. Keep DRAFT. Both renewed independent reviews remain accepted for the unchanged reviewed code and scoped evidence; the latest commit changes only three Markdown files. Current normal CI is a separate unmet gate.

[Verify run42674717480 attempt1](https://github.com/deveshsangwan/html-inbox/actions/runs/42674717480) failed. [Source Ubuntu20 shard2/2 job129352829725](https://github.com/deveshsangwan/html-inbox/actions/runs/42674717480/job/129352829725) built successfully, then ran tests on exact Node20.20.2 after build Node24.22.2. TAP reports893 tests,890 passed,1 failed,2 skipped,0 cancelled. Fourteen other leaf jobs succeeded. Verify's aggregate shell comparison also failed and adds no separate application defect.

The failed case is `actual client rejects length identity response and leaves recoverable work`. Its recovery assertion at source sync-protocol-faults.test.ts:357, compiled354:26, expected `confirmed` but received `pending`, after3013.009022ms. The original negative-pass custody/receipt/outbox checks, receiver request count1, faultProof and explicit store.retry completed before this assertion. The later receiver document-count assertion was unreached. The recovery result's error and counters were not printed; no overall test timeout or cause is established. There were no receiver-count mismatch diagnostic tags.

This differs from the old887 headers failure at the initial receiver request count. Historical887/e017 causes remain unresolved. CI mergece5113ad38e1c54459c324636fac9742e99b1acb has no file changes versus c8; source identity is not baseline reproduction or exoneration. Hosted teardown reports the failed fixture's proxy/application children reaped and ports rebound, not an independent remote audit.

Root has authorized one bounded local sequence on unchanged source: current build, focused exact20 length case, then the original default-concurrency shard if the focused case passes. It stops at the first failure/cap, retains original results and restores the393 qualified outputs. No assertion/deadline relaxation, blind CI retry, production patch, benchmark, or additional review is part of this sequence. Passing locally would be nonreproduction, not clearance of this hosted failure.

The immutable decoded log and receipt are retained under issue97-ci-c8baba7-run42674717480. Source receipt SHA2567cb363bec17971d66334fe7c073e5a0bf46d66603b439584b3295940ea9fa7eb; decoded log SHA2561922f9343bc686c7695510036bfd9078846ab0f7e625e642e0e8324470a9814e. Root work order SHA2565805b76822c39eb3fd358a646490643c35108f61a08c246e62d07ac9c43917fa. This CI result does not erase accepted correctness, measurements or completed reviews. Readiness remains withheld; no merge, release or issue closure.

<details>
<summary>Prior current status, review dispositions and history preserved verbatim</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

Acknowledgements validate bounded batches under the existing mutation lock and atomically persist accepted receipts with matching obligation confirmation. Exact replays retain fresh binding checks while avoiding ledger replacements. Holdings use page batches; offers retain singleton progress.

## CURRENT STATUS: independent reviews accepted; documentation-head CI pending

Current head c8baba7cfeaabe200deca00e4bcdcbb701476ba7, base b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad. PR remains DRAFT and unmerged while the new head's normal CI runs. Both independent reviews inspected the same code pin, 7c427ce0e5b5d8037cea38fb03cdca1b9945377c. The current commit changes only three Markdown files, +18/-4, to clarify measured mechanisms, observer overhead and historical status. Production, tests, harness, all 393 qualified outputs, 1784 tool files and both exact runtimes are unchanged. No new local runtime, benchmark or CI retry ran.

The user-authorized renewed reviews are complete and root has verified and dispositioned their results:

| Independent reviewer | Functionality/spec | Code quality | Validation/performance |
| --- | --- | --- | --- |
| codex / gpt-6.1-sol / reasoningEffort high | PASS | PASS | PASS within stated scope |
| claudeAgent / claude-sonnet-5-5 / effort medium | PASS | PASS with suggestions | PASS for the preselected scoped claim |

Sol resolved all 250 required entries, 223 distinct contents and 70 checkpoints. Sonnet's fresh completion resolved the substantive source, contracts, tests, harness, both controllers, shared engine and data review; all 250 ledger entries are resolved. Root preserves a narrow historical-status prose exception: some nested historical bodies were checked through structure and exact aliases, and one 1309-character prior pending-status paragraph was read by root, not independently in full by Sonnet. Root does not assign its own reading to the reviewer or claim every duplicate prose byte received a literal independent read. Bulk maps and structured evidence were analysed as complete data. The original incomplete R1/R2 and first renewed Sonnet return remain incomplete; complementary partial reviews were not combined into a pass.

Both reviewers independently recomputed the b249 n3 and actual610 n1 data. No confirmed blocking defect or required implementation/requalification change was found. The narrow per-page ledger-replacement regression assertion remains a nonblocking test suggestion. Direct atomic batch/replay tests and real reconciliation paths already exist; those scopes are distinct from that suggested assertion. Other Low/Suggestion findings and rejected overclaims are preserved in root's individual dispositions.

The three documentation changes resolve the accepted wording findings. Noop100's 203 versus 3 source commits also mean 200 fewer awaited observer stats between rename and directory fsync. Timings include snapshots and equivalence checks; observation overhead's size and net effect were not isolated. Source-derived commit accounting is consistent with replay skipping for noop and one atomic commit instead of two for singleton initial/repair acknowledgements. These fixtures do not separately measure the throughput benefit of a mutating multi-receipt batch or a simpler alternative implementation.

The accepted primary remains logical source replacement bytes: b249 n3 has 53,632,600 -> 792,609 on every pair of each exact runtime, with 203 -> 3 commits. The actual610 n1 result remains separate. All raw observations, null denominators, initial CPU increases, Node24 initial end-RSS +34,390,016 / +18.75363%, bundle cost, timing limits and 129 behavior-only controls remain intact in the [b249 report](https://github.com/deveshsangwan/html-inbox/blob/c8baba7cfeaabe200deca00e4bcdcbb701476ba7/scripts/bench/evidence/issue-97-untraced-v2/README.md) and [actual610 report](https://github.com/deveshsangwan/html-inbox/blob/c8baba7cfeaabe200deca00e4bcdcbb701476ba7/scripts/bench/evidence/issue-97-combined610-v1/README.md).

Normal CI is accepted for reviewed 7c only: run42634627216 attempt1, all16 workflow jobs successful;18 nonfailing rollup entries include CodeRabbit success and Macroscope skipped, not18 executed tests. This does not establish CI success for c8baba7cfeaabe200deca00e4bcdcbb701476ba7. Historical e017/887 failure causes remain unresolved; neither current green nor the reviews qualify unused diagnostic/controller branches. Root will assess the new head's event-driven CI before scoped readiness. No merge, release or issue closure is authorized.

Full independent reports and coverage ledgers are retained in root's renewed-review artifacts. Sol report SHA256 c44571c7191a09e893f26f2278cb4ad731fd20bdff57285b6be8bdc3e404a70c; Sonnet completion report SHA256 2807c3a79ca88ad30d3ee869a8762839a738bc1965500f92ad5d68c1fce26660. Root combined disposition SHA256 ea1e340185078b76457b1b7cec6dc6ca02d2fecda5bfc966b9a341c1c6b786bb. Earlier review and root reports remain unchanged.

<details>
<summary>Prior PR status and complete history, preserved verbatim</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

Acknowledgements validate bounded batches under the existing mutation lock and atomically persist accepted receipts with matching obligation confirmation. Exact replays retain fresh binding checks while avoiding ledger replacements. The implementation, accepted evidence and limits remain unchanged.

## CURRENT STATUS: user-authorized renewed reviews running

Frozen clean head 7c427ce0e5b5d8037cea38fb03cdca1b9945377c, exact base b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad; PR remains DRAFT and unmerged. Production/test/harness/evidence inputs, qualified outputs and accepted correctness/measurement results are unchanged.

The user explicitly asked: "can you restart that if it failed? and continue forward". This supersedes the historical two-round ceiling only. Root has already launched exactly two NEW independent full-rubric R3 reviews at this same pin:

- codex/gpt-6.1-sol, reasoningEffort high.
- claudeAgent/claude-sonnet-5-5, effort medium.

Renewed review results are pending. Root directly owns completion wakes and assessment. The renewed scope uses bounded reading batches and persistent per-file/category checkpoints; each reviewer must cover the full rubric and all three verdicts. No duplicate dispatch, reviewer restart/message/poll or replacement is part of this metadata update.

R1 and R2 terminal reports remain preserved as INCOMPLETE; no subset approval or union of partial coverage is promoted. Their accessible-input execution failures did not establish a new product or arithmetic defect. Earlier "no third round until user decision" wording below is historical and is now superseded by the quoted user direction. Required completed independent review gates and finding dispositions are still pending; this is not readiness or approval.

Current-head normal CI remains accepted at exact7c: Verify42634627216 attempt1 succeeded with all16 workflow jobs successful. The18 nonfailing rollup entries include16 workflow successes, CodeRabbit success and Macroscope skipped; they are not18 executed passing tests. Historical e017/887 failures and causes remain unexplained; current CI success does not qualify unused diagnostic branches or establish a cause.

All accepted b249 repeated and actual610 scoped measurement results, costs, instrumentation limits, raw data and prior failure histories remain intact in the [reports](https://github.com/deveshsangwan/html-inbox/blob/7c427ce0e5b5d8037cea38fb03cdca1b9945377c/scripts/bench/evidence/issue-97-plan.md). No source/tracked change, push, local runtime, CI query/retry or new watch follows from this update. Keep draft until root verifies the required review gates and dispositions. No merge, release or issue-closure authority.

<details>
<summary>Prior R2/current-status history preserved verbatim; its review-round ceiling is superseded only by the explicit user restart</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

Acknowledgements now validate batches of1–128 under the existing mutation lock and atomically persist accepted receipts with matching obligation confirmations. Exact already-applied receipts avoid replacement after fresh authority and binding checks. Holdings batches at the existing page boundary; offers retain singleton partial progress. Existing durability, validation, storage/wire and Node20-compatible0.7 policy remain unchanged.

## Current status

Final review freeze: 7c427ce0e5b5d8037cea38fb03cdca1b9945377c, exact base b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad on reviewed [PR120](https://github.com/deveshsangwan/html-inbox/pull/120). Production remains a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a. Root's latest commit changes only the two evidence READMEs, +5/-1; source/tests/harness/393 outputs/tools/runtimes/raw archives are unchanged. Tested original610 checkout remains a5d99a0fb587db4bbaae12d874ed14a615b25390; b249 repeated measurements ran at e0171fc548d449eb1de1e76975155fb699449d79.

The [b249 n3 report and129 controls](https://github.com/deveshsangwan/html-inbox/blob/7c427ce0e5b5d8037cea38fb03cdca1b9945377c/scripts/bench/evidence/issue-97-untraced-v2/README.md) and [separate actual610 n1 report](https://github.com/deveshsangwan/html-inbox/blob/7c427ce0e5b5d8037cea38fb03cdca1b9945377c/scripts/bench/evidence/issue-97-combined610-v1/README.md) retain accepted raw arithmetic, all costs and limits. Actual610 noop100 source logical replacements53,634,224 ->792,624 bytes and203 ->3 commits on both exact runtimes. Node24 initial END RSS +34,390,016/+18.75363%, slight initial CPU increases and bundle +2,386 bytes remain disclosed. No practical initial/count0 gain, repeated610 spread, pooling or physical-drive claim.

Both reports now explicitly state that operation wall/CPU includes source/receiver snapshots and per-record equivalence assertions under the same harness for both roles. This is reconciliation plus validation; the overhead's effect on paired changes was not isolated or assumed conservative. For the actual610 run, saved before/after/owner-observed raw-index hashes MATCH. Acceptance remains semantic-index based, without a universal raw-byte identity or cause claim. Earlier differing-index observations stay separate.

Both R1 delegates completed with mandatory inputs UNREAD, so BOTH full review gates remain INCOMPLETE. Sol returned conditional functionality/code quality and blocked full validation while its full arithmetic checks agreed. Sonnet returned conditional functionality/validation and a code-quality PASS only for its inspected subset. Partial coverage is not combined into completed independent gates. Sonnet's broad no-null-denominator count100 statement is corrected additively:92 actual610 and275 b249 zero-parent supporting metric pairs correctly have null relative changes. Original reviews and data remain immutable. Root considers its reconciliation page-boundary regression-test suggestion nonblocking given accepted actual129 controls and direct atomicity/bounds/fault tests; final reviewers must assess that independently.

Both SECOND/FINAL-R2 delegate tasks have returned terminal reports at this frozen head: codex/gpt-6.1-sol reasoningEffort high and claudeAgent/claude-sonnet-5-5 effort medium. Neither satisfies the required complete independent review gate. Both return functionality CONDITIONAL, code quality CONDITIONAL and validation/performance BLOCK for the full gate. All inputs were accessible; both explicitly admit incomplete mandatory substantive coverage. This is a review execution/validation failure, not proof of a new product defect or arithmetic error. No union of partial coverage, subset-PASS promotion, third round, replacement or helper review.

Sol reports complete prescribed production/test/harness/engine source coverage with no confirmed defect, but leaves mandatory complete status/diff, logs, spreads, archives, provenance/closure/maps and structured controller evidence incomplete. Sonnet leaves broader mandatory source/evidence inputs unread. Existing accepted b249 n3/129 controls and actual610 n1 arithmetic/costs retain their scoped credit. Both original R1/R2 reports and owner/root dispositions remain immutable. Root owns the blocked final-review/readiness disposition; this PR remains DRAFT.

Verified finding limits remain explicit: the missing per-page commit-count CI assertion is a nonblocking regression-test opportunity, while existing tests do exercise the indirect holdings acknowledgement path. The stat-at-each-ledger-renamed observer performs200 fewer source stat calls for noop203->3 replacements; this unisolated timing overhead may contribute to the observed latency gap, and its size is unmeasured. Logical byte/commit primary observations remain valid. No inode-reuse/native cause is established for old hosted failures, no safety guard is relaxed, and no diagnostic refactor/source/runtime change was made.

Root accepted CURRENT7c normal CI from [Verify run42634627216, attempt1](https://github.com/deveshsangwan/html-inbox/actions/runs/42634627216): all16 workflow jobs completed successfully. The18 nonfailing rollup entries are16 workflow successes, one additional CodeRabbit success status and one Macroscope skipped check; they are not18 executed passing tests. Root receipt SHA256 a613e57675478d1f683b9a3e831c8b8c70ea0e9f469c0dc6461095e8c5a4c952. No job logs, patch-runtime inference, workflow retry, local runtime or new watcher. This fact arrived AFTER final-R2 dispatch: exact reviewer inputs stay frozen, no restart/message/additional review; final review disposition will attach it as subsequent evidence. Historical e01724.22.2 startup-reader and887 headers failures remain unexplained. Local24.19.0 nonreproduction and accepted performance evidence do not clear them. Current393 R2 outputs still have only the two diagnostic testJS stale against later TS, other391 unchanged. Accepted original correctness is178 pass on each exact20.20.2/24.19.0. Compiler-only/serial-pass/unobserved diagnostic branch limits and all historical stops remain intact. Keep draft; current-head normal CI is accepted, while complete final-R2 review dispositions and root readiness remain separate. No merge/release, CI retry or LOCAL execution.

<details>
<summary>Prior c1d publication status preserved verbatim as history</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

Acknowledging a receipt previously replaced the full ledger twice, including exact replays. Batches of 1–128 now validate every binding under the existing mutation lock and atomically persist accepted receipts with matching obligation confirmations. Exact already-applied receipts skip replacement after fresh authority, route/revision, receiver, fingerprint, disposition and current storage-incarnation checks. Holdings batches at the existing page boundary; offers retain singleton partial-progress handling. Invalid batches persist no partial changes. Fsync, uncertain-outcome fencing, recovery, engine and wire/storage policy stay unchanged.

## Current status

Frozen publication head: c1d4a1c5d2222301c376ba83767b252f8fa4eab6; immediate base b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad on reviewed [PR120](https://github.com/deveshsangwan/html-inbox/pull/120), Node20-compatible 0.7 line. This commit changes docs/evidence only. Production remains a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a. Actual original610 measurement ran at clean a5d99a0fb587db4bbaae12d874ed14a615b25390; immediate-b249 repeated measurement ran at e0171fc548d449eb1de1e76975155fb699449d79. No issue95/96 source is imported.

Root accepts the bounded [actual original610 comparison](https://github.com/deveshsangwan/html-inbox/blob/c1d4a1c5d2222301c376ba83767b252f8fa4eab6/scripts/bench/evidence/issue-97-combined610-v1/README.md), one actual610/candidate pair per exact20.20.2 and24.19.0, separately from [b249 n3 repeatability and129 controls](https://github.com/deveshsangwan/html-inbox/blob/c1d4a1c5d2222301c376ba83767b252f8fa4eab6/scripts/bench/evidence/issue-97-untraced-v2/README.md). Actual610 noop100 source logical replacement bytes53,634,224 ->792,624, -98.52216749%, commits203 ->3 on both runtimes, zero noop body work. All6 native commands/4 invocations/8 outer/44 operations completed; all10 paired wire/body/transfer controls matched. Every one of422 operation metric pairs and20 outer metric pairs agrees exactly between owner and root. Safe durable archive includes every original runner file and command log plus full controllers/maps/provenance/decisions/release proof. No repeated610 spread, p95, pooling or physical-drive claim.

Important actual610 cost: Node24 initial END RSS183,377,920 ->217,767,936 bytes, +34,390,016/+18.75363%, distinct from LOWER whole100 PEAK RSS256,080 ->242,984 KiB. Initial CPU increased slightly on both runtimes. No practical initial/count0 speedup is established. Bundle +2,386 bytes/+0.1870533%. Receiver bytes equal in THIS dataset; prior b249 noop +3 bytes stays separate. N1 noop latency20 -81.18761%,24 -78.48828% is descriptive. All costs and raw values remain in the linked report. Root accepted timely LOCAL release and exact normal-path restoration; raw-index equality remains semantic only.

## CI and remaining gates

Final publication-head normal CI is pending actual owner watch evidence. The e017 hosted24.22.2 startup-reader failure and old887 headers failure remain unresolved; local24.19.0 selected50 and default-concurrency454 passes are nonreproduction, not CI clearance or cause/exoneration evidence. The exact protocol and fatal failure-only diagnostic TS remain present. Their runtime mismatch/error paths are unqualified; the fatal diagnostic has compiler-only root credit. Current393 R2 outputs are unchanged, both diagnostic testJS stale against TS, other391 unchanged. Peer measurements did not load those test files; normal CI rebuilds them.

Accepted R2 correctness is178 pass on EACH exact20.20.2/24.19.0 with the same a3e emitted bytes. Historical R1/both120s stops/traced timings/V1 mode stop and1.876329s release limit/V2 serial pass/raw-index and shared limitations remain preserved below and in the reports. Every traced timing stays gain-ineligible;1.9GB remains an estimate.

The next authorized action is exactly two fresh independent read-only full-rubric reviews on this frozen head/base: codex/gpt-6.1-sol reasoningEffort high and claudeAgent/claude-sonnet-5-5 effort medium. Both get identical full inputs, independently check primary arithmetic/supporting costs for both studies and129 controls, and enumerate mandatory read/unread coverage before ALL THREE functionality, code-quality and validation/performance verdicts. Dispatch/result receipts will be recorded separately; no review gate is claimed passed. No new tests/build/application/helper agents/browser/retry. Final-head CI, reviewer findings/dispositions and root readiness decision remain open. Keep draft; no merge/release or automatic closure.

<details>
<summary>Prior a5 publication description preserved verbatim as historical status</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

Acknowledging a receipt replaced the full ledger twice, including on exact replays. Batches of 1–128 validate all bindings under the existing mutation lock and atomically persist receipt evidence with matching obligation confirmations. Exact already-applied receipts skip replacement after fresh authority, route/revision, receiver, fingerprint, disposition and current storage-incarnation checks. Holdings batches at the existing page boundary; offers keep singleton partial progress. Invalid batches persist no partial changes. Fsync, uncertain-outcome fencing, recovery, engines and wire/storage schemas remain unchanged.

## Current status

Publication head a5d99a0fb587db4bbaae12d874ed14a615b25390, measured head e0171fc548d449eb1de1e76975155fb699449d79, production a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a. Base remains reviewed [PR120](https://github.com/deveshsangwan/html-inbox/pull/120), exact b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad, compatible0.7. No issue95/96 source is imported. This one coherent publication carries accepted measurement data and the exact approved existing-fatal-test observation. New-head NORMAL CI is pending actual owner watch events; no workflow retry was requested.

Root ACCEPTS scoped immediate-b249 practical benefit: preselected source-peer noop100 logical replacement bytes53,632,600 ->792,609 and commits203 ->3 in all three pairs on EACH exact Node20.20.2/24.19.0,98.522% fewer logical bytes. Noop/repair latency improves in every pair; initial/empty latency gain is unproven. Both roles/exact runtimes complete129 two-page controls, one pair each and control-only. All21 commands/16 invocations/28 outer/156 operation rows completed, all36 paired wire/body/transfer vectors matched. [Complete report, original raw archive, every paired change/spread, costs and root decisions](https://github.com/deveshsangwan/html-inbox/blob/a5d99a0fb587db4bbaae12d874ed14a615b25390/scripts/bench/evidence/issue-97-untraced-v2/README.md). Bundle +1,835 bytes, receiver noop +3 bytes and source empty noop +6 bytes remain disclosed; no physical-device/p95/significance or universal nonregression claim.

Original610 combined comparison, current/final CI disposition and two fresh same-pin full-rubric SolHigh/Sonnet5.5Medium reviews remain OPEN. Each reviewer must return functionality, code-quality and validation verdicts. None has launched. Keep draft; no readiness/merge/release conversion.

## CI failure and exact diagnostic

The [e017 Source Ubuntu24 shard1/2 failure](https://github.com/deveshsangwan/html-inbox/actions/runs/42542109540/job/128919107872) remains RED and unexplained: actual24.22.2,453pass/1fail of454. “actual detached worker captures the sanitized fatal diagnostic in its private log” throws “Managed ledger must have exactly one link” during post-readiness ownership/status startup, BEFORE intentional symlink injection and fatal-log assertions. Numeric metadata/cause were not observed;14 leaf jobs passed and Verify is aggregate-only. Root's50 selected fresh24.19.0 passes and454-test default-concurrency24.19.0 pass are nonreproduction, not flake/base/candidate exoneration or CI clearance. The old887 headers failure remains separate and unresolved.

Only existing sync-worker-fatal.test.ts changes in this publication, exact SHA2561fa6bb902f7d32ac0edf4f15ebd6f3286ae34fff92a1324e85d5718fc629ad99, mode0664. The nonasync parent lstat observer calls the original once with identical this/arguments and returns its original promise/value/error. It observes only existing fixture-ledger bigint lookups during original startup, retains last8 completion-order bounded metadata and restores the exact descriptor before one failure-only <=4096B tagged line. No extra stat/await/retry/poll/timer, production instrumentation, safety guard, assertion or deadline change. Original startup rejection survives new synchronous restore/format/write errors. Promise-handler scheduling/rejection-handledness effects remain; no internal callsite/native-cause proof. Synchronous catches do not guarantee async stream-error/flush handling; absent output is inconclusive.

Root performed ONE pinned native tsc-rs0.7 noEmit compiler-only check over197 copied sources with the proposed target/baseconfig, nativeexit0. It imported/executed no application/test and changed no tracked/generated bytes. Result SHA2561be0392459b5e9751d2e3c998fb2ca60c2448a8e96703c00faf475a7e5d10d3b and exact source review are archived. All observer/mismatch/cap/restoration/error runtime paths remain unqualified. No further owner compiler/build/test/application/reviewer ran. Current393 R2 outputs remain exact: protocol diagnostic testJS was stale already; fatal diagnostic testJS is now ALSO stale versus TS, other391 unchanged. Normal CI rebuilds these test sources.

## Existing correctness, evidence and remaining scope

Accepted R2 correctness passed178 tests on EACH exact20.20.2/24.19.0 using identical a3e emitted bytes. Earlier identity-response local V2 passed9 selected/22 filter skips with zero mismatch tags, which qualifies no unobserved diagnostic failure branch. [Original V1 mode stop/V2 serial pass, hosted887 failure, receipts, audits and limits](https://github.com/deveshsangwan/html-inbox/blob/e0171fc548d449eb1de1e76975155fb699449d79/scripts/bench/evidence/issue-97-identity-diagnostic-v1/README.md) remain intact. Both original120s stops and traced logical/control samples stay immutable; every traced timing remains gain-ineligible,1.9GB remains an estimate.

V2 measurement source A1/A2 used complete owned-prefix preservation and one parent-bundle window for seven enumerated NCC data caches. Four data values changed and were preserved/frozen; all other1777 tool pins/runtimes remained strict. Candidate544tracked/593owned/393current+saved restored; semantic index equality only. Native exit0 and timely explicit LOCAL release independently accepted with103 recorded PID/start identities/51groups absent. Initial owner audit metadata-parser stop, root data-reader corrections and sampled-process/native cleanup limits are preserved. Old measurement-v1 remains tied887, UNGRANTED and untouched; v2 grant was consumed once, never rebound.

Source-only610 assessment finds reusable clean196source/390dist+bundle anchors,25 internal peer modules and159 external package files equal to b249 on actual scoped paths. This is static evidence, not retrospective610 execution. Smallest proposal is one fresh610/candidate count0,100 control pair per exact runtime, with existing b249n3 separately labeled; no new adapter/execution/slot is authorized. Root controls that distinct gate and shared reader diagnosis.

<details>
<summary>Prior e017 description preserved verbatim as historical status</summary>

Related to [#97](https://github.com/deveshsangwan/html-inbox/issues/97).

Acknowledging a receipt replaced the full ledger twice, including on exact replays. This change validates batches of 1–128 receipts under the existing mutation lock and atomically persists receipt evidence with matching obligation confirmations. Exact already-applied receipts skip replacement after fresh authority, route/revision, receiver, fingerprint, disposition and current storage-incarnation checks. Holdings batches at the existing page boundary; offers retain singleton partial-progress handling. Invalid batches persist no partial changes. Existing fsync, uncertain-outcome fencing, recovery, engines and wire/storage schemas remain unchanged.

Current source/evidence pin: e0171fc548d449eb1de1e76975155fb699449d79. Current normal CI is RED: [run42542109540, Source Ubuntu24 shard1/2](https://github.com/deveshsangwan/html-inbox/actions/runs/42542109540/job/128919107872) reports454 tests,453 pass,1 fail,0 skip/cancel on actual Node24.22.2. The failing case is "actual detached worker captures the sanitized fatal diagnostic in its private log": "Managed ledger must have exactly one link" during startup's post-readiness ownership/status probe, BEFORE intentional symlink injection and fatal-log assertions. Link-count/inode/owner values were not printed; cause is unresolved. Fourteen leaf jobs passed; Verify failed only as the aggregate gate. This differs from the old887 headers failure, which remains separately unresolved. Relevant reader/fatal-test/records/client/lifecycle files have no source diff versus b249, without baseline execution or exoneration credit.

The acknowledgement implementation and prior accepted evidence are already present below. Progress then paused under root-owned scheduling/source holds; root owns that delay and has now resumed concrete source-only A1/A2 preparation and a bounded reproduction/control proposal. No new runtime, CI retry, source edit or measurement grant follows. Shared reader ownership remains root coordination.

The Node20-compatible0.7 change targets reviewed [PR #120](https://github.com/deveshsangwan/html-inbox/pull/120), exact base b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad. Production remains a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a. The only later application/test-source difference is sync-protocol-faults.test.ts, SHA256 d30101e59453829dcb51024ac6746b8d421e5d8033b900dc9626c66a159ca95f, local mode0664. Every other application/test/harness byte is unchanged. The current393 R2 outputs were retained untouched; ONLY dist/sync-protocol-faults.test.js is stale against this new diagnostic TS. Production/bundle and other392 emitted files match the accepted temporary diagnostic build separately. No issue95/96 source is imported.

Accepted [R2 correctness](https://github.com/deveshsangwan/html-inbox/blob/e0171fc548d449eb1de1e76975155fb699449d79/scripts/bench/evidence/issue-97-correctness.md) passed178 tests on EACH exact Node20.20.2/24.19.0 using identical emitted bytes from a3e. The separate root-granted V2 observation used HEAD887 with this exact temporary diagnostic source: all five commands exited0, exact24 built once, and exact20 serial TAP reported9 selected pass/22 filter skips/0fail/0cancel. ZERO mismatch tags were emitted. The local serial pass does not clear default-concurrency CI, identify cause, establish a flake/base failure or exonerate the candidate. Mismatch/cap/IPC-error paths remain unqualified.

The diagnostic samples the existing receiver status once and keeps the original captured-value strict1 assertion authoritative in finally. Only a mismatch adds one existing bounded proxy status IPC and at most one4096-byte tagged payload. Success adds no diagnostic await/log. Subsequent faultProof/retry assertions and request500ms/pass8000ms/test20s bounds are unchanged. Fixed safe fields exclude raw results/errors, IDs, URLs, credentials, headers, bodies and ledgers. Late proxy status and a fault-selection hit cannot prove header delivery or rescue the original receiver assertion.

The [original887 hosted leaf](https://github.com/deveshsangwan/html-inbox/actions/runs/42533920965/job/128893913453) observed receiver requests0 versus1 in the headers case. Earlier custody checks passed; faultProof/recovery were unreached, and injection/cause are unproven. V1's launcher-added0077 caused a separate operational0664-to0600 mode stop before build/tests; its original records retain release1.876329s beyond the shorter cleanup boundary, though inside fixed540. Root corrected only the inherited child mask for V2 to0002 while preserving the strict guard. V2 restored all source/393 outputs/index/tools/runtimes, with40 recorded PID/start identities including adapter/launcher and7 groups absent, and released46.135710s before the shorter boundary. No incoming-mask reconstruction or general raw-index byte restoration/equality/cause claim is made. [Original TAP, command receipts, identities/umask, audits, releases and root dispositions](https://github.com/deveshsangwan/html-inbox/blob/e0171fc548d449eb1de1e76975155fb699449d79/scripts/bench/evidence/issue-97-identity-diagnostic-v1/README.md).

Only ONE traced parent/candidate logical-byte/control comparison on exact20 is accepted: source noop53,627,119 bytes/203 commits versus792,522 bytes/3 commits, with matching wire/body controls. All traced timing remains gain-ineligible; these are logical replacement-file observations, not physical drive traffic. The issue's1.9GB example remains source-derived. R1 and both original120s stops remain separate immutable histories.

Keep draft. Remaining gates are repeated untraced exact20/24 measurements with spread, actual129 two-page qualification, original610 combined comparison, final-pin CI and two fresh same-pin Sol High/Sonnet5.5 Medium reviews after measured freeze. Each reviewer receives the FULL rubric and returns functionality, code-quality and validation verdicts; neither has launched. [Measurement v1](https://github.com/deveshsangwan/html-inbox/blob/e0171fc548d449eb1de1e76975155fb699449d79/scripts/bench/evidence/issue-97-plan.md) remains pinned887 and UNGRANTED, with A1 complete owned-entry preservation and A2 enumerated ncc-cache policy unresolved. No adapter/input rebinding, local execution, benchmark, CI retry, reviewer, readiness conversion, merge or release occurred in this publication.

</details>


</details>


</details>


</details>


</details>

</details>

</details>

</details>

</details>

</details>
