# Independent reviews and findings disposition

Both fresh reviewers inspected the same frozen head `ac2b3b7993b893ac914a241d839c83331183679c` against `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. The execution slot was explicitly released before either review started. Neither reviewer installed, built, ran suites, benchmarked or started services. No implementation conversation was inherited. Both received the complete issue, contract, supplied standards, diff, committed evidence and full rubric.

The rubric covered correctness, missed requirements, edge/failure handling, security/data integrity, concurrency, assumptions, structure/separation, consistency, test gaps, backwards compatibility and simpler alternatives. The Sol assignment emphasized functionality/specification; Claude emphasized quality/standards. Both independently returned all three verdicts.

| Reviewer | Exact settings | Functionality | Code quality | Performance evidence |
| --- | --- | --- | --- | --- |
| Sol | provider `codex`, driver `codex`, model `gpt-6.1-sol`, `reasoningEffort=high` | PASS | PASS with optional teardown hardening | PASS |
| Claude | provider `claudeAgent`, driver `claudeAgent`, model `claude-sonnet-5-5`, `effort=medium` | PASS | PASS with optional nits | PASS |

Neither reported a material blocker or an unmet issue-specific acceptance criterion. The measured production source remains `8ae19fd9c746d335b0fbf0c8ca6e21ada1dd9f80`; `git diff --quiet 8ae19fd ac2b3b7 -- packages/cli/src` exited 0. The final receipt commit adds documentation only and does not change production, tests, runner, artifacts or numeric evidence. No heavy work resumed after slot release.

## Sol functionality review

Sol recalculated every min/median/max from all 1,200 timed samples, checked cell counts and exact stdout/stderr/exit agreement, and verified log hashes, installed fingerprints, tarball hashes and rebuilt candidate JS hashes. It inspected the entire diff and confirmed unchanged handler/helper bodies, help text, parser fallback and private entry gates. It found the module split proportionate to the measured benefit.

One Low finding at `scripts/package-smoke.mjs:327` is accepted as optional follow-up, not fixed in this patch. If worker disable itself rejects, later cleanup checks are skipped and the outer fixture cleanup can remove runtime evidence while leaving a detached process. A future failure-path hardening should retain verified worker identity, attempt independent identity-checked cleanup, and preserve the fixture when shutdown cannot be confirmed. It requires targeted failure injection and fresh execution qualification; it is not a documentation-only change. The released slot is not reused for that work. Successful receipts verify shutdown and PID/record cleanup, so this does not invalidate the measured or behavior results. The residual test-harness risk remains explicitly disclosed for root disposition.

Sol's limits were read-only inspection and evidence calculations, with no independent runtime execution. Linux receipts do not establish macOS/Windows or modern forward-port qualification. Its incidental description of source-test differences between the measured and review pins is not used as a provenance claim: the exact git comparison above shows no `packages/cli/src` differences.

## Claude quality review

Claude independently recomputed all summaries from the raw rows, found n=20 in every cell, and confirmed reported medians, spreads, deltas and MiB conversions. It checked the move, parser bypass, private gates and emitted chunk listing. It judged the change proportionate and found no policy, compatibility or structural blocker.

1. **Low, proposed IPC timing hazard: rejected on direct installed-runtime evidence.** At `index.ts:61-65`, Claude suggested that a request arriving before the deletion worker's message listener would be lost. Both installed Node 20.20.2 and 24.19.0 embed an `internal/child_process` `emit(event, message, handle)` function that queues ordinary messages in `target.channel[kPendingMessages]` when no listener exists. Its `newListener` callback drains that queue through `process.nextTick`. The claim that these runtimes do not buffer such messages is incorrect. This was verified through each binary's `process.binding("natives")["internal/child_process"]`, not inferred from promise ordering. Packaged immediate-spawn IPC deletion also passed. No comment encoding an incorrect first-event-loop-poll constraint is added. Future runtime/ESM forward-port qualification remains separate.

2. **Low, cleanup receipt scope: clarified; independent census claim rejected.** `startup.py:134` emits `children_reaped=True` only after every successful sample passes its `finally` block's `child.wait()`. This is a success-path postcondition about direct children, not an independent process-tree census. It does not prove aggregate descendant reaping. The report now makes that distinction explicit. Dedicated companion failure/timeout tests remain optional follow-up; the recorded two cleanup tests are clearly identified as the inherited #89 runner tests.

3. **Low, identical three-line package logs: documentation clarification accepted.** Runtime identity is recorded by exact commands in `verification.json` and the separate runtime environments. The identical smoke text alone cannot identify which Node ran. No log output is fabricated or regenerated after the slot release.

4. **Low, hygiene and re-exports: deferred or retained deliberately.** Two whitespace nits are cosmetic. `USAGE` and `VIEWER_OWNER_PREFLIGHT` re-exports preserve existing module exports; they are retained rather than removed for test-only cleanup. Neither issue affects the frozen artifact or was a material review finding.

5. **Suggestion, named help/version predicates: declined.** The bounded direct checks are used once each. Parser-equivalence tests cover the aliases and fallback. Adding helpers or broadening parser changes would add indirection without measured benefit.

6. **Suggestion, splitting command formatters from runners: deferred.** The faithful move keeps this patch reviewable and narrow. Claude explicitly required no action in this PR. Further command modularization needs its own evidence and scope.

7. **Low, catalog isolation, root skip and masking cleanup errors: explanation accepted, optional hardening deferred.** The new managed-worker qualification requires a synthetic catalog; isolation prevents touching real catalog state and follows the fixture requirement. The selected-owner success case requires a non-root owner and skips when run as root. Both local runtime runs used uid 1001, so this case executed. Root-run CI would not prove it. A failing cleanup assertion can mask an earlier error, which is a diagnostic limitation and overlaps Sol's optional teardown finding. Successful checks are not inferred from this failure path.

8. **Low, measurement scope gaps: explicitly accepted as limitations.** The timed `error` cell is invalid option `--version --json`, not unknown-command startup. Unknown commands are behavioral corpus coverage only. This deviates from the plan's broad phrase "invalid-command startup" and does not affect the preselected primary help/version operations. Only empty-list ordinary startup was timed. Publish and detached-launch behavior were qualified, but their latency was not measured. The disclosed list CPU/elapsed increases, size costs, warm-cache conditions and absence of p95/large-library/daemon claims remain.

Claude did not rerun checks. It only grepped/tailed the full source logs, inspected the build manifest's top-level keys and did not independently rehash the final rebuild. Those limits remain part of its verdict. Sol separately performed the artifact/log hash checks.

## Remaining gates

No material review finding remains unresolved. The optional failure-path teardown risk and cosmetic/structural suggestions are recorded above. Final required CI and root readiness remain authoritative; the PR stays draft. No watch, merge, release or forward-port action was performed.
