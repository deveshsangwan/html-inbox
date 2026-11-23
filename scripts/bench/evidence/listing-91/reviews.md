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

## Follow-up, 23 November 2026

Production `backend.ts` is unchanged in this follow-up. Its SHA-256 still equals the `a71a57af…` fingerprint. The text above remains the historical disposition for `427942f`. `post-review-fingerprints.json` still records the formatted `52cdb70` test file; the regression tests below supersede that file entry.

Council round 1 reviewed `3a61d7c`: Claude Opus 5.5 at high effort scored 8.0/10 and GPT-6.2 Sol at high effort scored 9.0/10. Neither found a production defect. Both reported that the first cross-listing test accepted either sibling error and left queueing and draining to scheduling. Sol reported that tie order depended on the filesystem returning records in seed order. Opus reported that the drain assertion could not fail for the failing listing, and that early rejection escaped the first test in about one run in eight. The regression tests now cover:

- **Shared bound and tie order.** Three backends list 96 records. `readdir` returns them in an explicit order that is neither ascending nor descending. The first enumerated record's read cannot finish until a later record with the same timestamp has been read by all three listings, so within every listing a later tied record completes first. Results must match the enumeration order, and aggregate active metadata reads stay between two and eight.
- **Failure across listings.** The failing listing holds all eight permits before a second listing starts, and the second listing must make no metadata read until a permit is released. One failing-listing worker finishes, claims another record and queues behind the second listing. Two distinct errors are then released in a fixed order. The failed listing must reject with the first error object and have no reads in flight at the moment it settles. The queued worker must skip its read after receiving a permit, which leaves exactly eight failing-listing reads. The second listing's home also has an explicit enumeration, and that listing must return every record in that order. Two further listings of that home then enumerate together, so their sixteen workers request permits in one turn. Exactly eight record directories may begin hardening before any is released. A leaked permit admits fewer and a permit released twice admits more.
- **FIFO admission.** One listing holds all eight permits while two single-record listings queue in a known order. With one permit circulating, the earlier listing must settle first. A LIFO queue serves the later listing first.
- **Thrown `undefined`.** A warning callback that throws `undefined` while a malformed record is being reported must make the listing reject with exactly `undefined`.
- **Unchanged earlier coverage:** hardening-sibling drain, corruption, missing, symlink, unsafe-entry and permission behaviour, and records removed after enumeration.

Council round 2 reviewed `0ec8db6`. GPT-6.2 Sol at high effort scored 9.0/10, again with no production defect. It found that the cross-listing test still assumed the healthy home enumerated in seed order, that the late tied read relied on timing, that the reproduction note understated checkout writes, and that the earlier note about `undefined` was too broad. A filesystem rejection caught by `readMetadata` does become a `TypeError` when `.code` is read, but a warning callback that throws `undefined` reaches the worker unchanged. The tests and README now cover those points. The Claude Opus 5.5 round-2 run failed on a provider rate limit before reporting, so that round has no Opus score.

Mutants of a compiled copy were each run three times on Node 24.19.0. Each of these failed at least one test every run:

- no post-acquire guard;
- keeping the last error;
- leaking a permit after failure;
- placing results in completion order;
- per-listing instead of shared permits;
- serialising whole listings;
- rejecting before workers drain;
- treating an `undefined` rejection as success;
- dropping the hardening-sibling drain.

Council round 3 reviewed `41482fb`. GPT-6.2 Sol at high effort scored 9.2/10 and Claude Opus 5.5 at high effort scored 9.0/10. Neither found a production defect. Opus found that a permit released twice on the error or skip path survived every test, because each check after a failure ran one listing at a time. It also noted that FIFO order could be tested cheaply. Sol found that the README attributed HTTP memory to allocations the companion never broke down, and that a 20 ms sleep could be a single event-loop turn. Opus noted that the direct-mode `output_hash` and `candidate_diff` look more meaningful than they are. The tests and README now cover those points.

After the round-3 fixes, mutants of a compiled copy were again each run three times on Node 24.19.0. Each of these failed at least one test every run, so no listed mutant survives:

- the mutants listed above;
- releasing a permit twice on the skip path;
- releasing a permit twice on the error path;
- serving waiters LIFO instead of FIFO.

Council round 4 reviewed `6832f50`. Claude Opus 5.5 at high effort scored 9.2/10 and GPT-6.2 Sol at high effort scored 9.1/10. Neither found a production defect. The round-4 follow-up makes these changes:

- **Failing-home enumeration.** Sol showed that the queued-worker assertion depended on the failing home's directory order. If `.staging` came ninth, a worker that ignored the failure returned at the unsafe-ID guard without a counted read. The failing home now lists a real record ninth.
- **Runner cleanup.** Sol found that `listing.py` created the fixture directory before the protected block that removes it. The environment capture now runs inside that block. A successful run is unaffected, and both recorded runs report successful cleanup. `listing.py` therefore no longer matches `post-review-fingerprints.json`; the recorded samples came from the earlier runner.
- **NCC wording.** At Sol's request, the integration receipt now says the remediation left the observed cache bytes in place, rather than that no cache was rewritten. `tool_identity_exact=false` is unchanged.
- **Timeouts and corruption cases.** Following Opus, every listing test has a timeout. The corruption test also covers a metadata ID that does not match its directory and a symlinked `index.html`.
- **README.** The README notes that a failed listing's waiting worker must still receive a permit before the listing rejects. It corrects two rounded percentages, 14.1% and 7.3%, from the raw samples.

Opus's mutant without the loop's `!hasFailed` guard survives and is accepted as equivalent. The post-acquire check still prevents every read; the only cost is one permit acquisition and release per remaining entry after a failure.
