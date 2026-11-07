# Redundant permission repair investigation

Issue: https://github.com/deveshsangwan/html-inbox/issues/92

Immediate parent and inspected HEAD: `52cdb70cc4a504fa8b983e6cdbcb23432d295592`
on `perf/92-chmod`, stacked on `perf/91-listing`. Draft PR #118 targets
`perf/91-listing`. Inherited listing, storage-policy and runtime changes are
outside this investigation's diff.

## Decision

NO-GO. The controlled adversarial comparison confirms that the mode-only
shortcut violates the required behavior on Node 20.20.2 and Node 24.19.0.
There is no production change or claimed performance improvement. Root granted
the exclusive qualification slot after #93 released it. Performance experiments
stopped at the failed correctness gate.

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
under both runtimes. They describe specific observable interleavings, not a claim
that path-based chmod is race-free.
Another lstat moves the race. Descriptor-based identity and storage-ownership
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

## Qualification

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
or skipped for this investigation. An initial archival assertion was attempted
before the final check finished; it stopped without copying logs and was retried
after that process exited 0. This did not change tests or results.

Final source and all 394 compiled artifact hashes still match baseline after all
checks, and no owned CLI process remains. All heavy jobs have exited. No further
heavy rerun is authorized after slot release without another grant. Linux
qualification cannot establish macOS or Windows outcomes; those remain CI gates. There is no claim of race-free path-based chmod or foreign-owner
equivalence.


## Reviews and integration

Fresh independent Sol High functionality and Claude Code Sonnet 5.5 Medium
quality reviews will inspect the same pinned revision after slot release. Both
must give functionality, code-quality and no-go evidence verdicts. Dispositions
will be recorded here. PR #118 stays draft pending those reviews, root audit and
final-head CI. No watch, merge or release is part of this investigation.
