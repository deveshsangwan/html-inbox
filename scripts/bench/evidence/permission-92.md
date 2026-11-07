# Redundant permission repair investigation

Issue: https://github.com/deveshsangwan/html-inbox/issues/92

Immediate parent and inspected HEAD: `52cdb70cc4a504fa8b983e6cdbcb23432d295592`
on `perf/92-chmod`, stacked on `perf/91-listing`. Draft PR #118 targets
`perf/91-listing`. Inherited listing, storage-policy and runtime changes are
outside this investigation's diff.

## Decision

NO-GO. The controlled adversarial comparison confirms that the mode-only
shortcut violates the required behavior on Node 20.20.2 and Node 24.19.0.
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

`packages/cli/src/private-storage.test.ts` adds these cases for files and
directories. All four cases pass on baseline and fail on the temporary shortcut
under both runtimes. They describe specific observable interleavings in the current path-based implementation, not a
claim that path-based chmod is race-free. These are characterization tests; a
descriptor-based design would require a deliberately reviewed contract change.
Adding another lstat would move the interval in which replacement can occur. Descriptor-based identity and storage-ownership
changes require separate review and are outside this compatibility optimization.
Ownership and EPERM equivalence remain a separate unresolved concern; no
foreign-user or privileged execution result has been established.

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

From the repository root, using Node 24.19.0 and pnpm 11.7.0 for build tooling:

```sh
pnpm install --frozen-lockfile
python3 scripts/bench/permissions.py --out artifacts/permission-92/comparison --node20 /absolute/node20 --node24 /absolute/node24
```

Run the comparison on POSIX storage. Choose a fresh output directory. The runner builds the unchanged source and runs
all four tests on both runtimes before changing production source. It records
the temporary candidate source and diff, builds it, requires the expected exit 1
and four failed assertions on each runtime, restores the original source in
`finally`, rebuilds, then verifies source and every compiled artifact hash equal
the baseline hashes. No real libraries are opened. Test fixtures use the existing
`temporaryHome` cleanup helper. Do not run another build against this checkout
while the comparison runs.

The candidate only guards each existing chmod with
`process.platform === "win32" || (fileStat.mode & 0o7777) !== requiredMode`.
The complete mask includes special bits, so the demonstrated failure does not
come from accidentally ignoring them. It adds no cache or descriptor machinery.
Ownership/EPERM was not measured and is not needed to establish this rejection.

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
change is approved here. Descriptor/ownership design would be separate work.

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

Fresh focused second-round review verdicts remain pending.
