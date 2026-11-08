# Candidate correctness qualification

All twelve authorized checks passed on
`fc858a56d874debb470d8e26bb91c3fac99b01e6`, based on
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. The two exact runtime-version
preflights also passed. This receipt is distinct from the earlier 18-case
baseline characterization at 42232780. It provides no performance result or
approval of later implementation changes.

The [lossless raw evidence](correctness-fc858a5.tar.gz) has SHA-256
`f00ddf66af1b8b30da94201cabfa12470f023276c4b5165c58b53a98e62ac805`.
It contains the exact runner, cleanup-only observer, environment policy, every
command log, source/compiled maps, per-case diagnostics, actual export bytes,
output inventories and cleanup receipts. It contains no managed ledger or
private key contents.

## Commands and outcomes

Node 24.19.0 typecheck and build each exited 0. No install was needed. The
package-manager executable prefix for both commands was exactly:

```sh
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/corepack/dist/pnpm.js
```

Arguments were `typecheck`, then `build`. The exact test executables were:

```text
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node
```

Each ran `--version` before qualification. After the one Node 24 build, the
following test commands ran sequentially on Node 20, then Node 24. Every
command exited 0, without failures or cancellations.

| Arguments | Node 20.20.2 | Node 24.19.0 |
| --- | --- | --- |
| `--test scripts/bench/managed-read-contract.cjs` | 18 pass | 18 pass |
| `--test scripts/bench/managed-view-contract.cjs` | 44 pass | 44 pass |
| `--expose-gc --test scripts/bench/managed-view-retention.cjs` | 1 pass | 1 pass |
| `--test packages/cli/dist/static-export.test.js packages/cli/dist/local-document-source.test.js` | 18 pass | 18 pass |
| Selected export-origin command below | 4 pass, 12 filtered skips | 4 pass |

```sh
/absolute/node --test --test-name-pattern='^export fetched-origin guard rejects (imported|origin-only) return through (view|fallback)$' packages/cli/dist/sync-reader-compatibility.test.js
```

Node 24 reports only the selected four cases; Node 20 also reports twelve
name-filter skips. The full containing HTTPS/viewer suite did not run. Counts
across the different probes overlap in behavior and are not unique-case totals.

The run used a 900-second overall application-command budget, individual
30/120/180-second limits and a separately recorded 120-second cleanup allowance.
All commands completed normally; none timed out or required a signal. No bundle,
full suite, listener, worker, high-count work or sustained benchmark ran.

## Proven controls and limits

Both source adapters passed the unchanged baseline expectations. The actual
callback controls passed entry/cut assertions and rejected outer export fallback.
They exercised fresh complete-byte reads with callback-local validation reuse,
changed-ledger ID-map refresh, global corruption visibility, returned metadata
and public-snapshot isolation, source limits, legacy transition and existing
body-read behavior.

Admission and drain controls held real opened ledger/body handles, rejected
additional reads, and required closure before scope completion on success,
callback failure, cancellation and injected read/close failure. The injected
close error follows a successful native close; it does not establish disposal
after a permanently failing OS close. Distinct callback/read errors survived
together. GC controls retained escaped methods while confirming collection of
three private ledgers and six fresh byte buffers per runtime.

All four repaired reader-origin controls passed through actual view and
independent fallback paths, with exact entry/fetch counts, preserved previous
output and no staging. The origin-only cases obtained real inherited records
whose non-origin metadata, local ID and body matched the listed original before
requiring rejection. The historical 750baae failing injection remains preserved;
these results do not retroactively turn that bypassed mock into an exercised
guard. The unrelated 42232780 hosted timeout causes remain unresolved.

## Integrity, capture and cleanup

The one build produced 196 JavaScript files. Their per-file map stayed identical
through all ten runtime commands. The 484 tracked input files also stayed
identical; the worktree was clean after application checks.

The canonical compiled-map aggregate is
`8eaa2d75cacc00c9e6535be984862b5c4f3c0d68ac19dae495d560bceed3ffc0`.
The source-map aggregate is
`7fb6106ec2baa33477c78b55ee3a7b45f53749eb18e856ffddbdf141c70ca540`.
Both digest UTF-8 `json.dumps(mapping, sort_keys=True, separators=(',', ':'))`.
The complete maps and both runtime binary hashes are in `receipt.json`.

Each application command had its own process group. All fourteen direct command
groups and all 26 direct/observed PIDs were absent after reaping. There were no
remaining adopted children, signal cleanup or fallback fixture removal. All 180
fixture roots were absent. Both versions used per-command temporary directories,
which were removed only after command reaping and group/child drain.

The observer distinguished 36 baseline-export, 82 actual-view-control, two legacy,
two retention, 50 existing-unit and eight selected-origin fixtures. It captured
1,414 output files and 142 emitted manifests, with zero observer errors. Every
file size/hash, manifest entry and manifest snapshot hash was rechecked. Only
whitelisted generated output directories were copied; library directories and
keys were excluded. PID/sequence names separated concurrent test-file workers.

The recorded cleanup used 0.1255985590396449 seconds of its 120-second allowance.
Forced GC and output capture add work, so logs are not uninstrumented timing
samples. Independently seeded fixtures have different creation timestamps; no
cross-runtime whole-output equality or speedup is claimed. The per-body full
serialized ledger I/O remains an accepted limitation of this partial experiment.

## Reproduction and remaining gates

Unpack the archive for inspection. To repeat under a new explicit execution
grant, use an app-managed checkout of the tested fc858 pin. Put only the archived
`execute.py` and `capture-outputs.cjs` in a fresh directory immediately below
`artifacts/issue-96/`, then run that copy of `execute.py`. Its relative depth
identifies the checkout root. Existing evidence directories must remain intact;
the runner creates fresh output directories. Exact commands, environment
construction, budgets and binary identities are recorded for review.

This evidence follow-up changes documentation/artifacts only. Application and
test changes after fc858 need new qualification. Normal-CI routing for the
standalone regressions, broader integration, complete export/batch performance
measurements and both fresh independent reviews remain outstanding. The PR
stays draft and does not fully resolve issue #96.
