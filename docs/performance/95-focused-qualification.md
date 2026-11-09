# First focused scheduler qualification

Issue #95, draft PR #121. Immediate parent is
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. The tested source is
`fddde69afaa9e030a3df0058f6f47ef4c2f8abb3`. Later receipt-only commits do not
change the tested TypeScript. The original source-only candidate was `6b2d95c`.

This receipt covers the first exclusive local grant only. It does not qualify
performance, the 0/1,000/10,000 matrix, actual empty-outbox body repair, the full
suite, or either independent review. No gain or retention decision is claimed.
The preselected workload and remaining timing risk are in
[the scheduling experiment](95-worker-scheduling.md).

## Original failure and correction

[The original Linux Node 20 CI job](https://github.com/deveshsangwan/html-inbox/actions/runs/42399838523/job/128485028789)
passed install, typecheck and build, then ended with 451 passing tests and three
cancelled fatal-worker tests. The detached-worker case timed out before the new
five-second fallback could observe an unsafe ledger. Its unreferenced child
cleanup then had no remaining event-loop handle. The following tests were
cancelled with it.

The exact focused reproduction was:

```sh
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --test --test-name-pattern='actual detached worker captures' packages/cli/dist/sync-worker-fatal.test.js
```

It exited 1 on the original candidate. A temporary compiled-only change from
`startedAt + 5000` to `startedAt + 250` made the same command exit 0. The compiled
file was restored in `finally`, with matching SHA-256 before and after. The
retained correction adds a cheap serialized ledger metadata observation. Changed
metadata triggers full validated state inspection; non-regular ledgers fail
before opening bytes. The independent full-refresh fallback remains. Existing
three-second exit assertions and all other timeouts remain unchanged.

An intermediate focused run exposed two mistakes in the new scheduler fixture.
Its home cleanup ran before worker close, and its terminal-bypass input remained
blocked. The corrected fixture closes and verifies the worker before removing
its own home and supplies pending work to the bypass assertion. An intermediate
unsafe-ledger assertion also caught repeated metadata observations. Rejecting
the non-regular ledger at the first check preserves its exact once-only
observation and zero body-open assertions. All intermediate failures are retained
alongside the final logs; they were not retried unchanged.

## Reproduction scope

Build tools ran on Node 24.19.0 with pnpm 11.7.0. Frozen installation, typecheck
and build all exited 0:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Run each named compiled suite separately and sequentially with each exact binary:

```sh
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --test --test-concurrency=1 packages/cli/dist/<suite>.test.js
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --test --test-concurrency=1 packages/cli/dist/<suite>.test.js
```

The suites are `sync-worker-schedule`, `sync-worker-runtime`, `sync-worker-fatal`,
`sync-worker-credentials`, `sync-pause-admission`, `sync-revocation-order`,
`sync-shutdown-ownership`, `sync-shutdown-ingestion` and `sync-attempt-lifetime`.
Each runtime reports 105 passing tests with zero failures, cancellations or
skips. All 18 suite invocations exit 0. The local runner records each expanded
command, actual exit code, elapsed
time and log path. It uses a fresh process group per command and a 180-second
outer kill bound, without changing individual test deadlines.

[The committed result receipt](95-focused-results.json) records the commands,
exits, counts, source fingerprints and log fingerprints. A final `/proc` check
found no remaining Node, pnpm or compiler process executing this checkout's code
or running inside it. The exclusive local slot is released before any review or
future measurement wait.

The local raw receipt directory is
`/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue95-focused-1/`.
It contains `commands.jsonl`, original CI and focused red logs, the temporary
causal control, intermediate failures, final per-suite logs and tested-source
SHA-256 fingerprints. This local reference supports orchestrator inspection; it
is not a public artifact reference for performance qualification. The next push's
Actions logs independently check the candidate in the ordinary CI matrix.
