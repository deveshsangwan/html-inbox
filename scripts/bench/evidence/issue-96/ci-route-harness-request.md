# Source-only CI route and harness request

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
This is a pending request, not an execution grant or test result.

The follow-up retains the qualified fc858 production and frozen probes. It
adds normal POSIX CI routing for actual-view44 and separate retention1,
plus complete managed-export/batch companions in the existing #89 runner.
The [plan](../../../../docs/performance/96-managed-read-plan.md#source-follow-up-for-normal-ci-and-complete-workloads)
and [workload instructions](../../README.md#managed-complete-reads-for-96)
explain the boundaries. No performance benefit is claimed.

Source checks passed, exit 0: both new CJS files with `node --check`, Python
`ast.parse` for `run.py`, `managed_read.py` and `test_managed_read.py`, and
`git diff --check`. No new test, typecheck, build, bundle, install or workload
was executed. Both historical evidence archives remain unchanged.

## Requested execution

Use the frozen source pin identified by the handoff, with the clean existing
parent checkout `/home/agent/.t3/worktrees/html-inbox/perf-89-bench` at exactly
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Only generated build/bundle output
would change there. Its tracked source must stay clean. No install is needed.

Exact binaries and the package-manager entry are:

```text
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/corepack/dist/pnpm.js
```

Preflight both absolute binaries with `--version` and record their hashes.
For package-manager commands use the absolute Node24 plus that pnpm entry,
with its installation/bin prepended to PATH for nested tools. Request twelve
commands, sequentially:

1. Candidate `typecheck`, maximum 120 seconds.
2. Candidate `build`, maximum 120 seconds.
3. Candidate `--filter html-inbox bundle`, maximum 180 seconds.
4. Exact610 parent `build`, maximum 120 seconds.
5. Exact610 parent `--filter html-inbox bundle`, maximum 180 seconds.
6. Candidate `python3 -m unittest discover -s scripts/bench -p 'test_*.py'`, maximum 30 seconds.
7. Node20 `--test packages/cli/dist/managed-view-regressions.test.js`, maximum 90 seconds.
8. Node20 `--test packages/cli/dist/managed-view-retention-check.js`, maximum 90 seconds.
9. Node20 managed-read smoke below, maximum 180 seconds.
10. Node24 `--test packages/cli/dist/managed-view-regressions.test.js`, maximum 90 seconds.
11. Node24 `--test packages/cli/dist/managed-view-retention-check.js`, maximum 90 seconds.
12. Node24 managed-read smoke below, maximum 180 seconds.

Each smoke uses the respective absolute binary and a new evidence directory:

```sh
python3 scripts/bench/run.py managed-read \
  --baseline-repo /home/agent/.t3/worktrees/html-inbox/perf-89-bench \
  --node /absolute/exact/runtime/node \
  --counts 1 --sizes 10240 --samples 1 --timeout 30 \
  --out /absolute/new/evidence-directory
```

One smoke launches 18 sequential owned workload children: two real fixture
setups, eight untimed API export/batch controls, four paired complete CLI/batch
commands and four separate I/O-count probes. The mixed fixture has two owned
and two imported descriptors, one owned tombstone and one suppressed import.
The Python checks are four pure comparator controls and the two existing
runner cleanup controls. The latter include an owned fake child with a
transient loopback socket and an uncooperative descendant, not an application
server. The CI wrapper children start no listeners or workers.

The aggregate application-command budget is 900 seconds, even though summed
individual ceilings are higher. Reserve a separate 120 seconds for cleanup.
Own groups for build/test parents as well as workload children. Retain/reap
children and verify group/fixture absence before deletion. Preserve original
failures, commands, exits, exact generated exports/stdout/stderr, all source,
compiled and bundle maps before/after, runtime hashes and cleanup evidence.
The wrappers log their private root and child group; their unchanged probes
assert output and teardown internally. No ledger, donor key or catalog data
belongs in the exported evidence. Stop at the first unqualified case and
classify source behavior versus setup/compile/GC uncertainty before changing
an oracle or implementation. Explicitly release after cleanup, then await
root inspection. No full suite, browser, application server, worker,
100-record timing, larger body or sustained measurement is in this request.

## Remote CI record kept separate

Run42407015451 attempt1 on docs-only0b failed the managed-source browser
row count, a macOS held-ACK margin precondition and downstream Verify.
Their original logs/metadata remain preserved. Root authorized one unchanged
failed-jobs retry after preflight. The exact command was
`gh run rerun 42407015451 --repo deveshsangwan/html-inbox --failed`;
it exited 0 at 2026-11-07T19:48:04Z with empty stdout/stderr. The single
acceptance read recorded attempt2 in progress on the same head, browser job
128509639417 and macOS source job128509639668. No subsequent polling or retry
was requested. Final results await the existing owner watch.

Root also supplied PR121/9fd509e browser job128510296669 as a shared symptom.
That was managed-backend; PR122/0b was managed-source. Both observed 0 versus3
at `sync-reader-browser.test.mjs:136` after Back to inbox. The other log is
42285 bytes, SHA256
`527a0f6780e3979d8f7e5172caa9cd2e6ad2cbb2599a73fd7cd8145e2c79167d`.
No causal or pre-existence conclusion follows from this correlation or later
green CI. The original422 timeouts and750 injection failures stay separate.
No browser, waiter, assertion, retry or reviewer scope is added here.
