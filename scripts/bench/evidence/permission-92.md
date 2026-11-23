# Redundant permission repair investigation

Issue: https://github.com/deveshsangwan/html-inbox/issues/92

The original investigation inspected immediate parent
`52cdb70cc4a504fa8b983e6cdbcb23432d295592`. Draft PR #118 targets
`perf/91-listing`. Its reviewed merge base is
`bf80f9fa4815376f1771c3a6cb78d5ed19231ad2`; the
[integration receipt](permission-92/integration-2026-11-15.md) records that
merge and its scoped requalification. Any later parent pin is recorded at the
end of this report. `packages/cli/src/private-storage.ts` is
byte-identical at 52cdb70, bf80f9f and `610c931` (the stack's pre-#89
baseline and an ancestor of bf80f9f), so the experiment below still applies
to the current base. Inherited listing, storage-policy and
runtime changes are outside this investigation's diff.

## Decision

NO-GO. The controlled adversarial comparison shows that the mode-only shortcut
changes observable missing-path and replacement behavior on Node 20.20.2 and
Node 24.19.0. Issue #92 requires that path replacement and error behavior do
not weaken. This decision takes that criterion strictly, so the shortcut fails
it.
There is no production change or claimed performance improvement. Performance
experiments stopped at the failed correctness gate. This is a contract rejection,
not a finding that chmod elision is fast or slow; its benefit remains unquantified.

Both `hardenPrivateFile` and `hardenPrivateDirectory` currently inspect the path
with `lstat`, reject unexpected types and symlinks, then call path-based `chmod`.
Skipping that call when the inspected mode is already private changes observable
behavior at these controlled interleavings:

1. Remove the inspected object after the real `lstat` completes, before the helper
   resumes. The current chmod should report `ENOENT`; the shortcut would return
   successfully using the earlier stat.
2. Replace the inspected object with a loose-mode object of the same type at that
   point. The current chmod should repair the replacement; the shortcut would
   leave the replacement loose.

These are timing-sensitive differences, not lost lasting guarantees. Neither
version keeps a path private after the helper returns, since a same-user actor
can remove or loosen it afterwards. The shortcut moves the moment the helper
observes the path from `chmod` back to `lstat`. Callers still see the
difference. Listing classifies documents as complete, incomplete or missing
from `ENOENT` in `hardenDocument` (`packages/cli/src/backend.ts`), and the
post-write hardening in `writePrivateFile` and `writeAtomicPrivateJson`
reports it. The pre-write calls swallow `ENOENT`, so those two paths behave the
same.

A second, untested reason points the same way. On POSIX, `chmod` by a
non-owner without `CAP_FOWNER` fails with `EPERM`. A private-mode object owned
by another user, for example one left by an earlier privileged run, therefore
makes the current helper reject with `EPERM`. The shortcut would return
successfully, and later reads or writes might fail with `EACCES` instead.
Issue #92 asks that ownership behavior stay unchanged. This is analysis only;
no foreign-owner or privileged run was made. It applies to the mode-only
candidate: a variant that also required the current user's uid would remove
the `EPERM` difference, but not the two timing cases.

Any design that skips `chmod` because of an earlier `lstat` changes these
interleavings, because the skipped call is what observes the path last. On the
current path-based design, issue #92's first criterion (avoid redundant
`chmod`) and second criterion (do not weaken replacement or error behavior)
therefore cannot both be met.

`packages/cli/src/private-storage.test.ts` adds these cases for files and
directories. In every recorded comparison, all four cases pass on baseline and
fail on the temporary shortcut under both runtimes. The test revisions that ran
are named with each run below. They describe specific observable interleavings
in the current path-based implementation, not a claim that path-based chmod is
race-free. These are characterization tests; a descriptor-based design would
require a deliberately reviewed contract change. Adding another lstat would
move the interval in which replacement can occur. Descriptor-based identity and
storage-ownership changes require separate review and are outside this
compatibility optimization.

Windows production behavior remains unchanged. POSIX mode-repair assertions are
skipped on Windows. chmod is not owner-only ACL enforcement. Read-only source
and catalog behavior, the eight shared listing read slots and sibling draining
remain unchanged.

## Reproduce and evidence

The test/report sources were first pinned at
`4a3d85a5812a21f5b742cdc51cc069d713b6739f`, and the comparison runner
was pinned and executed at `a8ea2d19458a492e228c86a8b2bbcd9fe3f5a99b`.
Production source is identical to immediate parent
`52cdb70cc4a504fa8b983e6cdbcb23432d295592` throughout the shipped diff.

Use a clean, disposable checkout with no concurrent builds or Git writes.
The runner's first `pnpm build` deletes and regenerates `packages/cli/dist`, so
afterwards the checkout holds a fresh baseline build, not the previous one.
pnpm must not need an install, because the runner's builds have no TTY; an
implicit install attempt aborted in that situation during integration R2.
From the repository root, using Node 24.19.0 and pnpm 11.7.0 for build tooling:

```sh
pnpm install --frozen-lockfile
python3 scripts/bench/permissions.py --out artifacts/permission-92/comparison --node20 /absolute/node20 --node24 /absolute/node24
```

Run the comparison on POSIX storage. Choose a fresh output directory. The
current runner checks that `--node20` and `--node24` report those major
versions and refuses unstaged or staged edits to `private-storage.ts`, builds the
unchanged source and requires all four named tests to pass on both runtimes
before changing production source. It records the temporary candidate source
and diff, builds it, and requires exit 1 with each named test failing for its
expected reason: `Missing expected rejection` for both removals and
`511 !== 384` or `511 !== 448` for the replacements. It then restores the
original source in `finally`, rebuilds, and verifies source and every compiled
artifact hash equal the baseline hashes. No real libraries are opened. Test
fixtures use the existing `temporaryHome` cleanup helper.
`scripts/bench/test_permissions.py` checks these TAP checks against the
archived logs and five negative controls. It also drives the comparison through
a faked candidate-build timeout without building anything.

The original and requalified comparisons below used earlier runner revisions
(`a8ea2d1` and `9c266b4`). Those checked exit codes and the `# pass` and
`# fail` totals, not named results or the index. Their archived logs satisfy the
current named checks.

Signal handling covers a SIGINT or SIGTERM delivered to the runner's PID. A
terminal or process-group signal also reaches the active build. The 300-second
command timeout kills only the direct child, so after a timeout the runner
restores source bytes, skips the rebuild, records build restoration as
unverified and exits. Discard that checkout.

The candidate only guards each existing chmod with
`process.platform === "win32" || (fileStat.mode & 0o7777) !== requiredMode`.
The complete mask includes special bits, so the demonstrated failure does not
come from accidentally ignoring them. It adds no cache or descriptor machinery.
Ownership/EPERM was not measured; the rejection rests on the two tested
differences.

| Runtime | Baseline | Temporary shortcut | Restored source/build |
|---|---|---|---|
| Node 20.20.2 | 4 pass, exit 0 | 4 fail, exit 1 | byte/hash identical |
| Node 24.19.0 | 4 pass, exit 0 | 4 fail, exit 1 | byte/hash identical |

For both removals the candidate reports no rejection instead of `ENOENT`. For
replacement, the asserted actual mode is decimal 511, or `0777`, instead of file
384, or `0600`, and directory 448, or `0700`. See the preserved TAP logs for exact
assertions, stacks and runtime-specific formatting. Timings printed by the test
runner are diagnostic output, not benchmark results.

The initially selected resource metric was process CPU per repeated listing,
with elapsed time, RSS, Node API counts and separately traced syscalls supporting
it. No measurements of these metrics were made because the shortcut failed the
required behavior gate. The historical 15,004 chmod API calls are not current
evidence and are not syscall counts. Combined-stack performance qualification
against `610c931` is unnecessary for a rejected shortcut with no production diff.

## Original qualification

The [comparison command manifest](permission-92/comparison/commands.jsonl)
records the executed arguments, working directory and exit statuses. Compressed
logs, source snapshots and build fingerprints are beside it; decompress `.gz`
files with `gzip -dc` or Python's `gzip.decompress`. The baseline/restored
production source SHA-256 is
`000d77f9dbd585e3f10ea393f03a6e59049980d4d3aae34a219e2cbfd4413e62`;
the temporary candidate is
`0136220d91065ce8bb5782eeb809c7c776d5f8af36a3d2b2737876fadef0392a`.
All 394 compiled files match between baseline and restored build.

The first combined qualification runner returned exit 143 during the Node 24
full suite. Its partial log has no completion summary and is not counted as a
pass. The cause of the interruption was not established. Three remaining owned
CLI processes were stopped with SIGTERM and verified absent; their synthetic
fixture tree was removed. The interrupted log and cleanup receipt are retained.
Node 24 full qualification was restarted in a separate job and passed;
subsequent checks ran sequentially. The [qualification command manifest](permission-92/checks/commands.jsonl)
contains 15 completed checks with exit 0 and the separately recorded interrupted
attempt with exit 143. Raw logs, interruption cleanup and final restoration
receipts are beside the manifest. Runtime source and test files remained
unchanged from the pinned experiment through qualification; only this report
and archived evidence changed. The runner was executed from the owned checkout
on Linux, using synthetic temporary homes and no real libraries.

- Frozen install, typecheck, baseline/candidate/restoration builds passed.
- Both runtimes: all 218 targeted permission/storage/listing/read-only/managed
  tests passed.
- Node 20.20.2: full suite 1,332 passed, two skipped.
- Node 24.19.0: completed full retry 1,331 passed, three skipped.
- Both runtimes: harness/skills 161 passed, two skipped; browser 73 passed,
  one skipped; installed-package smoke passed.
- Benchmark harness cleanup, website integrity/theme and pinned published skill
  fallback passed. The fallback smoke used Node 24.19.0.

Existing skips include the optional old CLI fixture, Windows-only taskkill,
live CDN opt-in and Node 24's generated IPv6 SAN behavior. No test was weakened
or skipped for this investigation.

Final source and all 394 compiled artifact hashes still match baseline after all
checks, and no owned CLI process remains. Linux qualification cannot establish macOS or Windows outcomes; those remain
CI gates. There is no claim of race-free path-based chmod or foreign-owner
equivalence.

## Acceptance and release disposition

- Avoid redundant chmod on already-private POSIX storage: rejected for the tested
  mode-only shortcut. No optimization ships.
- Preserve missing, replacement, type/symlink and error behavior: the controlled
  missing/replacement failures establish why the shortcut cannot ship. Existing
  type/symlink and wider behavior remain unchanged and qualified.
- Measure API calls and elapsed time before claiming a benefit: not measured,
  since the correctness gate failed; no benefit is claimed.

No part of this rejected shortcut is deferred to 1.x, and no modern contract
change is approved here. Eliding `chmod` would require a contract change, and
issue #92 routes such changes to 1.x. This PR proposes no 1.x change: whether
the unmeasured benefit justifies one is the maintainer's decision, which would
need measurements first. Descriptor/ownership design would be separate work.

## Review dispositions

Both fresh independent reviews inspected base
`52cdb70cc4a504fa8b983e6cdbcb23432d295592` through frozen head
`07a3b2b1dd6ff6f694f488488c6facbc19e38425`, including the full issue, execution
contract and raw evidence. [Sol High](permission-92/review-sol-r1.txt) found no
issues and passed functionality, quality and no-go evidence.
[Claude Code Sonnet 5.5 Medium](permission-92/review-claude-r1.txt) passed
functionality and no-go evidence, with a conditional quality pass requiring
public-document cleanup and recorded dispositions. The changes below were subsequently requalified without changing production
code. Original verdicts apply to the original reviewed pin, not automatically to
these changes.

| Claude finding | Disposition |
|---|---|
| 1 Medium, SIGTERM bypasses finally | Accepted. SIGINT/SIGTERM now request a stop; the active bounded command drains before source restoration and rebuild. Signals during restoration do not interrupt it. SIGKILL and machine failure remain unhandleable, documented limits. |
| 2 Low, asserts and hard-coded restoration booleans | Accepted. Explicit errors replace all runner asserts; receipt booleans come from actual comparisons. An earlier failure is chained if restoration also fails. |
| 3 Low, missing preflight/state receipt | Accepted. Record porcelain status; reject tracked/staged source edits and unexpected source bytes before mutation. |
| 4 Low, one-off and formatting-sensitive script | Accepted documentation change. Docstring pins the source from 52cdb70 and a source hash enforces the constraint. Retain the existing filename to preserve reproduction commands. A shebang, quote-style rewrite or new repo constant adds no useful behavior here. |
| 5 Low, vacuous replacement assertion if mock stops firing | Accepted. Both cases now assert exactly one target interception. |
| 6 Low, repeated setup/comment | Accepted characterization comment. Declined helper extraction: these two short explicit flows mutate differently, and an extra test abstraction would hide the controlled interleaving. |
| 7 Low, implementation-specific oracle | Accepted. Test comment and report explicitly identify path-based characterization and separately reviewed descriptor semantics. |
| 8 Low, scheduling chatter | Accepted. Removed scheduling and future orchestration instructions from this report. Receipts retain the operational history. |
| 9 Low, missing dispositions | Accepted. Both original results are archived and every finding is recorded here. |
| 10 Low, criteria/release mapping | Accepted. Added the acceptance disposition and explicit statement that no modern contract is approved or deferred here. |
| 11 Low, evidence hygiene | Retain exact raw paths, PIDs and snapshots to support independent reproduction/hash audits. These are synthetic fixtures, not user libraries. Fifteen qualification rows were logged automatically by local command wrappers; the interrupted exit-143 receipt was appended manually because the wrapper was killed. The manifests intentionally distinguish executed experiment commands from wider qualification receipts. Each command can be rerun directly; no hidden workload generator is needed. |
| 12 Suggestion, no-go could imply no benefit | Accepted. State explicitly that this is a contract rejection and the benefit remains unquantified. |
| 13 Suggestion, prose noise | Accepted. Removed archival chatter from prose, expanded the replacement-interval explanation and removed the stray blank line. Original archival details remain in the raw receipt. |

## Post-review qualification

Runtime/test/runner fixes were pinned at
`9c266b409bfc1c5cdf921564cfe7fb5eb67d408b`. The synthetic safety qualification
procedure was pinned at `e22a9d6e8b1270e513c5e3f131fe1287a5c5eec5`.
[Outer commands](permission-92/requalification/commands.json) exited 0;
[inner safety commands](permission-92/requalification/safety/commands.jsonl)
retain expected exit-1 refusals, and [safety receipts](permission-92/requalification/safety/receipts.json)
retain the actual signal outcome and byte/index restoration results. New logs,
source snapshots and fingerprints are under `permission-92/requalification/`.
Original fingerprints, failed candidate assertions and the interrupted original
qualification remain unchanged in their original directories.

- Typecheck/build and Python syntax/diff checks passed.
- Updated normal comparison: both runtimes passed four baseline cases and failed
  all four shortcut cases as expected. The actual restoration receipt is true.
- Unstaged and staged source edits were tested separately. Each runner invocation
  exited 1 at the clean-source preflight, before any build. Edited fixture bytes
  and staged index entry stayed unchanged; an outer finally restored the exact
  original source bytes and complete index bytes after each case and at exit.
- SIGTERM targeted runner PID `2427181` only, in its own session/group. At the
  signal checkpoint, the source matched the candidate hash and child PID
  `2427331` was observed running `pnpm build`. The runner deferred the signal
  until that command finished, restored/rebuilt, wrote its computed successful
  restoration receipt and exited 1 with `InterruptedError: Received signal 15`.
  The Linux `/proc` receipt records observed children and grandchildren, including
  compiler and restored-build processes. After waiting for the runner, a group
  scan found no remaining members. This verifies descendant cleanup for this
  exercised interleaving, beyond the direct wait alone.
- Both runtimes then passed all four updated regressions and 218 focused
  permission/storage/listing/read-only/managed tests. There was no new failure
  justifying repetition of the broad full suites or any performance search.
- Final source and all 394 build hashes match both the updated normal baseline
  and the interrupted comparison's baseline/restored hashes. No owned CLI
  process remained. The raw index hash in the receipt is from before subsequent
  intentional evidence commits, not a promise that future commits preserve the
  index file bytes.

Only runner-only SIGTERM was exercised. SIGINT, process-group interruption,
command timeouts, SIGKILL and machine failure were not exercised. SIGKILL and
machine failure remain unhandleable. The procedure's emergency SIGKILL cleanup
path was not needed. No general descendant-cleanup guarantee is inferred for
unexercised timeout or interruption paths. The normal no-go remains solely a
contract rejection of this shortcut; performance benefit stays unquantified.

The updated baseline differs from the original qualification baseline in exactly
one artifact, `packages/cli/dist/private-storage.test.js`, because of the new
interception-count assertions. The new normal comparison independently
re-establishes the four intended candidate failures against those updated tests.

To reproduce safety qualification, first run `permissions.py` with a fresh
`<parent>/comparison` output directory. Then run
`python3 scripts/bench/evidence/permission-92/requalify.py --out <parent>/safety --node20 <node20> --node24 <node24>`.
The safety procedure requires the uncompressed `comparison/fingerprints.json`
produced by that normal run; it does not consume the committed gzip copy directly.

## Focused second-round reviews

Both fresh reviewers inspected the complete diff through the same frozen pin
`6dd7d3aae557e1bdc508bb0aa83c71ea233cbd66`, including the original rubric/spec,
prior findings/dispositions and new raw evidence. Both were read-only.

| Reviewer | Functionality | Code quality | Performance/no-go evidence |
|---|---|---|---|
| [GPT-6.1 Sol High](permission-92/review-sol-r2.txt) | PASS, investigation scope | PASS, no findings | PASS |
| [Claude Code Sonnet 5.5 Medium](permission-92/review-claude-r2.txt) | PASS | PASS, only optional items below | PASS |

As of `6dd7d3a`, all original review conditions were satisfied. Council review
later changed the tests and runner; see the council sections below. The final
follow-up at that time changed only
review records, report prose and the safety procedure's module docstring. Its
executed statements, tests, production source and compiled files remain unchanged
from the requalified and reviewed pins. No additional runtime execution or third
review round was needed for these documentation-only updates.

| Second-round Claude item | Disposition |
|---|---|
| Low 1, scheduling phrase in safety docstring | Accepted; removed the phrase. |
| Low 2, hidden normal-run input dependency | Accepted; documented the required uncompressed sibling comparison output in both docstring and reproduction instructions. |
| Low 3, wait deadline anchored at checkpoint-search start | Optional change declined for this completed one-off. The existing bound can shorten the post-signal window after a late checkpoint. Its deadline-expiry path is written to invoke emergency/outer cleanup, but that path was not exercised. The successful receipt covers an early checkpoint only. Retain the qualified executable procedure; do not claim a fresh fixed restoration window or unexercised timeout behavior. |
| Suggestion 1, evidence volume | Retain original and new raw evidence for the requested independent audit. No new workload or artifact mechanism added. |
| Suggestion 2, changed test hash | Accepted; explicitly identify the sole baseline artifact difference and renewed candidate-failure proof above. |
| Suggestion 3, timing-dependent checkpoint | Accepted limitation. The 5 ms process scan observed one successful candidate-build interleaving; it is not proof that every future execution will hit that window. |

Correction to the archived second-round Claude transcript, which is kept
unchanged: its "Candidate build" line says the candidate differs from baseline
in `private-storage.js` and `.test.js`. The fingerprint maps show each
candidate build differs only in `private-storage.js`. The test JS differs only
between the original and updated baselines, as stated above.

At `aa72af4`, the final documentation receipt remained subject to final-head
CI and the maintainer's integration audit. The optimization itself remains rejected.

## Council round 1

Fresh read-only reviews of `fee002f4dcb605d29c78c2f442a6d41656da31c4` against
`bf80f9fa4815376f1771c3a6cb78d5ed19231ad2` used the same brief. Claude Opus 5.5
High scored 7.5/10, with functionality and code quality PASS and no-go evidence
PASS conditional on documentation fixes. GPT-6.2 Sol High scored 8.5/10, with
functionality and no-go evidence PASS and code quality FAIL on the runner. Both
agreed that the NO-GO is sound and that no benchmark, full-suite rerun or
redesign is needed.

| Finding | Disposition |
|---|---|
| Sol M1, runner overwrites existing generated output; Git index restore can lose concurrent staging; signal scope | Accepted. Runner, safety procedure and reproduction text require a clean, disposable checkout with no concurrent builds or Git writes, state that a fresh baseline build is restored, and limit the signal guarantee to the runner PID. The 300-second timeout's direct-child limit is stated. |
| Sol M2, four failures for any reason pass | Accepted. The runner requires the four named baseline passes and each named candidate failure's expected diagnostic. The new checks accept every archived baseline and candidate log. |
| Sol M3 / Opus M5, integration evidence only in ignored local files | Accepted. R1 to R4 receipts, logs and restoration maps are committed under `permission-92/integration/` with pre-compression hashes. Compiled output and fixture trees are excluded. |
| Sol L4, staged edits with restored working bytes pass preflight | Accepted. Added an index-against-HEAD check. |
| Sol L5 / Opus M6, PR body and transcript labels | Accepted. The PR body now links current evidence and labels CI by SHA. A correction note sits beside the archived second-round Claude transcript entry above; the transcript stays unchanged. |
| Opus M1, regressions overstated; ownership argument missing | Accepted with one correction. The decision now calls these timing-sensitive differences and adds the untested `EPERM` reasoning. Listing's `ENOENT` classification is also a consumer, not only post-write hardening. |
| Opus M2, 1.x routing unaddressed | Accepted. Added the reason no 1.x proposal follows. |
| Opus M3 / M4, stale and chatty integration receipt | Accepted. Rewritten as merge, commands, outcomes, restoration, evidence and limits. The original text stays linked at `b813f68`. |
| Opus L7, non-TTY pnpm | Accepted. Reproduction text states it. |
| Opus L8, `610c931` unexplained | Accepted. |
| Opus L9 / Sol optional, test intent and umask | Accepted. The test comment disclaims symlink-swap and descriptor semantics, and fixtures set the private mode explicitly. |
| Opus N10, recursive `rm` inside the mocked `lstat` | Accepted. Uses `unlink` or `rmdir`. |
| Opus N11, baseline checks only exit 0 | Accepted with Sol M2. |

The changed test and runner await a local rerun in a disposable checkout under
a separately granted slot. Results will be recorded here; hosted CI covers the
changed test on Linux, macOS and Windows.

## Council round 2

Fresh full read-only reviews of `27f7a53b7e36725b291942c4f6cd0619e4f7135b`
against `bf80f9f` used one shared brief. Claude Opus 5.5 High scored 8.5/10
with all three verdicts PASS. GPT-6.2 Sol High scored 8.8/10, with
functionality and no-go evidence PASS and code quality FAIL on the runner's
timeout path. Both found that all round 1 dispositions were applied. Both said
the pending local rerun blocks 9.5, and the pending `3a61d7c` parent merge does
not.

| Finding | Disposition |
|---|---|
| Sol M1, a timed-out build can race the restoration build | Accepted. After a timeout the runner restores source bytes, skips the rebuild, writes a receipt marking build restoration unverified, and exits; the operator discards the checkout. The signal path the earlier receipt validated is unchanged. |
| Opus M1, never-run test and runner revisions described as if run | Accepted. Present-tense claims now name the revisions that ran, and earlier runner revisions are described separately. The queued local rerun will record the current revisions. |
| Opus M2, criteria conflict not stated; `EPERM` scope; circular 1.x reasoning | Accepted. The decision states the strict reading, that any `lstat`-based elision changes these interleavings, that a uid-aware variant removes only the `EPERM` difference, and that a 1.x proposal is the maintainer's decision. |
| Sol L2, no receipt for a staged-only refusal | Accepted for the queued run: stage the edit, restore the working file, and require `source-index-clean` to refuse before any build. |
| Sol L3, reviewed base versus live tip | Accepted. `bf80f9f` is named as the reviewed merge base; a later pin will be recorded below. |
| Sol L4, R1 and R4 controls overstated | Accepted. R1 ran a read-only preflight and no application command; R4 used fresh fixture directories as well as the short temporary path. |
| Opus L1, transcript correction broke a table | Accepted. Moved below the table. |
| Opus L2, stale statements at `27f7a53` | Accepted. Pinned to `6dd7d3a`, `aa72af4` and `7356498`. |
| Opus L3 / Sol optional, negative controls unbacked | Accepted. `scripts/bench/test_permissions.py` runs them under the existing bench unit-test step. |
| Opus L4, controller scripts not archived | Accepted. Stated in the integration receipt. |
| Opus L5, evidence volume | Accepted in part. Nine restored snapshots byte-identical to their before snapshots are replaced by a hash record. Environment receipts stay as recorded. |
| Sol optional, runtime major versions unchecked | Accepted. |
| Opus nits: `CASES` before imports, bare `IndexError`, `lstat` name, PR body check count | Accepted. Line wrapping in older sections is left as is. |
| Owner check after round 2, timeout handler wrote mixed bytes and text | Accepted. `subprocess.TimeoutExpired` carries captured partial output as bytes even with `text=True`, so the `ea8cee6` handler raised `TypeError` before classifying the timeout and the restoration rebuild still ran. The handler now saves the partial output as bytes and keeps the timeout classification if saving fails. Two mocked tests drive the candidate path: one requires the preserved partial output, original source bytes, a `timeout` manifest entry and no restoration build; the other makes the log unwritable. Both fail with the `ea8cee6` handler restored. |
