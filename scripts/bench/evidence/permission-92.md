# Redundant permission repair investigation

Issue: https://github.com/deveshsangwan/html-inbox/issues/92

Immediate parent and inspected HEAD: `52cdb70cc4a504fa8b983e6cdbcb23432d295592`
on `perf/92-chmod`, stacked on `perf/91-listing`. The proposed PR targets
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
directories. All four cases pass on baseline and fail on the temporary shortcut under both
runtimes. They describe
specific observable interleavings, not a claim that path-based chmod is race-free.
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

Choose a fresh output directory. The runner builds the unchanged source and runs
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

Final restored-code checks and durable raw evidence will be recorded here before
review. Linux qualification cannot establish macOS or Windows outcomes; those
remain CI gates. There is no claim of race-free path-based chmod or foreign-owner
equivalence.
