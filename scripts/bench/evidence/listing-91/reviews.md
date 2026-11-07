# Independent reviews and disposition

Both fresh reviews inspected the same frozen commit `427942f72a2f7187d6840d7d058357d32e0a51df` against immediate parent `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Both briefs supplied the complete issue, contract, diff, raw evidence paths and full rubric, and requested independent functionality, quality and performance-evidence verdicts. Spec/standards labels set emphasis without narrowing scope. Neither reviewer mutated files or ran heavy work.

| Reviewer | Functionality | Quality | Performance evidence | Material blockers |
|---|---|---|---|---|
| Codex gpt-6.1-sol, reasoningEffort high | PASS | PASS | PASS within documented scope | None |
| Claude Code claude-sonnet-5-5, effort medium | No blocker found | No blocking breach; low findings below | Valid with documented caveats | None |

Sol independently recomputed every min/median/max for all 54 groups from 162 final raw samples; checked output hashes, exact adversarial equivalence, all 196 compiled-file hashes per variant, runtime/script fingerprints, selected-eight source/compiled correspondence and the 17 successful check logs. Sonnet checked the selected source/compiled hashes and summarized results, and explicitly did not independently decompress raw samples/check logs or rerun them. The latter is a review limitation, not a claim of duplicate raw-data verification.

## Standards axis

1. **Low, compact helper layout, `backend-listing.test.ts:15`, `listing.cjs:14`, `listing.py:22`. Accepted in part.** Expanded the fixture fields and result literal, and separated setup, build, measurement, error and recording steps with semantic paragraphs. The post-review changes in those three files alter whitespace only. Declined extracting more functions solely to shorten this scoped companion; its build/run/cleanup phases are already separated, and no new reusable boundary is needed.
2. **Low, index claim before slot acquisition, `backend.ts:127`. Rejected as a standards breach or defect.** A worker claims its unique index synchronously before yielding, then waits for admission. The index is claimed, not lost. After a fatal error the listing returns no partial result, so abandoned claims cannot omit a successful record. Acquisition stays outside the try/finally so an unacquired slot cannot be released. Existing guards express the behavior; no production comment or mechanism was added.
3. **Low heuristic, move global limit into another module, `backend.ts:18`. Rejected.** The state belongs to this one ordinary-listing operation and must be shared across backend instances. A separate module would retain the same global state while adding an interface and file. The user requested a local implementation without a concurrency framework. Filesystem mocks test externally visible aggregate reads and failures rather than exposing private semaphore internals.
4. **Suggestion, combine `hasFailed` and `firstError`, `backend.ts:123`. Rejected.** JavaScript permits throwing undefined. The boolean intentionally distinguishes no failure from an undefined rejection and preserves that exact thrown value. A wrapper could encode the same distinction, but does not fix a defect or simplify this loop enough to justify churn.
5. **Suggestion, indexed null array/filter, `backend.ts:121`. No change requested or needed.** The reviewer explicitly considered this acceptable. Indexed slots retain stable tie order; result memory scaling is documented.
6. **Suggestion, remove 32-reader reproduction/source patching, `listing.py:36`. Rejected; interruption limitation accepted.** Reproducing both parameters against the pinned parent is an explicit requirement. Removing this companion would make the decision harder to reproduce. The narrow runner restores source in finally, creates no checkout and never changes the parent branch. SIGKILL/host failure can bypass finally, so repeat it only from a clean committed worktree. If interrupted that way, inspect the source diff and restore `packages/cli/src/backend.ts` from that pinned commit before continuing. The raw measured artifacts remain intact. No general runner abstraction was introduced.

## Spec axis

Sol reported no material findings and one optional test suggestion at `backend-listing.test.ts:28`: combine a failing listing with another listing's queued workers and distinguish sibling errors. **Deferred as optional coverage, not an observed defect.** Existing tests cover shared admission across three instances, fatal-error draining, permission propagation, recovery after failure and held hardening siblings. Inspection establishes FIFO slot transfer and per-list failure state; the reviewer found no defect. The combined scenario would add useful protection but is not needed to resolve a correctness finding. No additional test/build or review was started while another issue owns the heavy-work slot.

## Post-review verification and remaining gates

The formatting follow-up leaves production `backend.ts` byte-identical to the reviewed/measured eight-reader source. Non-whitespace content of all three formatted files is identical to the reviewed commit; Python ASTs are identical. `node --check scripts/bench/listing.cjs` and `git diff --check` pass. This is not a new implementation or material fix, so no extra review or sustained measurement was requested.

`fingerprints.json` identifies the measured/reviewed versions. `post-review-fingerprints.json` identifies the three formatted files. Historical raw data and manifests were not rewritten. The recorded full suites ran on the frozen review revision; final-head CI must qualify this formatting/documentation follow-up. No local heavy work ran after the slot release.

Root audit and required final-head CI remain separate gates. PR #116 remains draft. No merge, watch, release or publication was performed.
