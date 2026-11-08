# Issue 97 acknowledgement experiment

Related to [issue 97](https://github.com/deveshsangwan/html-inbox/issues/97). Source preparation only. No speedup or test result is claimed yet.

## Pins and scope

The clean activation base was `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`, the reviewed PR 120 branch `t3/shared-viewer-lifecycle-repair`. This work targets that immediate parent on the Node 20 compatible 0.7 line. It inherits the runtime policy and benchmark/lifecycle fixes. It imports no issue 95/96 changes and changes no engine, ledger schema, wire schema, durability policy or worker scheduling.

The old acknowledgement took one mutation lock, persisted the receipt and receiver incarnation, emitted `receipt-before-retirement`, then persisted confirmation in a second replacement. The proposed transaction validates each receipt and persists evidence plus confirmation in the same replacement. The storage interface documents its crash argument and the replacement fault hook. Existing locked readers, fsync ordering, uncertain-outcome fencing and explicit recovery remain authoritative.

## Metric selected before production edits

Primary operation and metric: source-peer logical ledger replacement bytes during unchanged HTTPS reconciliation with 100 previously transferred 10 KiB documents. Initial transfer and one missing-body repair are additional affected operations. Record source/receiver commits and replacement bytes, operation latency, process CPU/RSS/I/O and wire counters. Use the existing `scripts/bench/run.py sync` and `sync.cjs` fixture. Count 0 is the empty-work control. Higher counts require a separate grant.

The new fixture observation stats the actual ledger file after each successful rename and sums its size per peer. This measures successful logical replacement bytes, not physical device writes. It adds one stat per commit to both builds. Existing process I/O counters remain available with their documented limits. Each pass checks canonical identity, metadata, signature, fingerprint, exact receipt and matching confirmed obligation, as well as existing body/count/transfer assertions. No-op passes must transfer zero bodies. Repair must transfer exactly one body. Peers and TLS credentials are disposable and local.

The issue's 1.9 GB example is source-derived arithmetic, not an observed measurement. A source-only reduction in commit count is not final acceptance.

## First requested execution slot

No install, build, application test or workload has run during source preparation. Only `node --check scripts/bench/sync.cjs` and `git diff --check` have run, both exit 0.

Request a single sequential slot, up to 15 minutes, concurrency 1. Stop on the first failure and preserve partial results. Reuse the existing runner's child deadline and cleanup. Do not add a process controller.

1. Use `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin` first on PATH. Run `pnpm install --frozen-lockfile`, then the bounded baseline build described below, and `pnpm --filter html-inbox bundle`. No engine/package policy edit.
2. With the identical prepared benchmark script, run the parent production source at the pinned base: `python3 scripts/bench/run.py sync --counts 0,100 --sizes 10240 --samples 1 --timeout 120 --node /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --out "$ARTIFACT/baseline-node20"`, then the same command with Node `v24.19.0` and output `baseline-node24`.
3. Restore the pinned candidate source, then `pnpm typecheck`, `pnpm build` and `pnpm --filter html-inbox bundle` under Node 24.19.0. Under each exact Node 20.20.2 and 24.19.0, run `node --test --test-concurrency=1 packages/cli/dist/sync-store.test.js packages/cli/dist/sync-storage-faults.test.js packages/cli/dist/sync-protocol-faults.test.js`. This covers invalid binding atomicity, exact replay, repairs, process kills around all commit boundaries and EIO/ENOSPC controls. No full suite or browser run is in this slot.
4. Repeat the two benchmark commands on the candidate with outputs `candidate-node20` and `candidate-node24`. These single samples qualify the workload and behavior controls only. They cannot establish spread or final performance acceptance.

Baseline source preparation uses this same app-owned checkout, with no new checkout or thread: from a clean committed candidate, capture its SHA, temporarily restore only `packages/cli/src` from `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`, verify `git diff b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad -- packages/cli/src` is empty, build/bundle/run the parent, then restore `packages/cli/src` from the captured candidate SHA even on failure. Harness files stay identical. Record this explicit source overlay alongside the runner's HEAD/dirty metadata and compiled/bundle fingerprints. The baseline production source pin is b249, not the candidate HEAD reported while overlaid. Do not stage or commit the temporary overlay. Save baseline build outputs before rebuilding candidate if repeated paired runs are later granted.

`ARTIFACT` is a fresh directory under the root-controlled performance artifact area. Save exact commands, exit codes, build fingerprints, source pins, raw benchmark outputs, TAP and cleanup receipts. If the 15-minute slot ends, stop; do not start later steps.

## Source-only trace preparation

Prepared from clean `67d685d70436012da316ef95704200bc2c7f9564`, with production/test source still exactly a3e087c and baseline b249. This adds only the opt-in existing-runner `--sync-trace` path described in the benchmark README. Ordinary invocations remain untraced. The original count100 timeout, R1/R2 histories and raw evidence remain immutable. Verification is limited to `node --check` on the two CJS files, Python AST parsing without importing the runner, and Git/file hashes. One intermediate CJS syntax error was caught and corrected by these allowed source checks; no code was imported or executed. No install, version command, build, test, fixture, controller or benchmark ran during preparation.

One proposed parent-only replay after a separate grant: `python3 scripts/bench/run.py sync --sync-trace --counts 100 --sizes 10240 --samples 1 --timeout 120 --node /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --out <fresh>/baseline-node20`. Bind the full source prefix to b249 using the approved worktree-only overlay, retain the identical traced harness/config/lock at the new committed head, build the parent with exact24/pinned Corepack pnpm11.7.0, and preserve/verify the qualified393 candidate files before overlay. Join owned children before restoring source and the exact saved files in outer finally, including failures. Require clean source/index and exact393-byte restoration before release. Do not rebuild the candidate.

Proposed bounds remain application450s plus separate cleanup120s and fixed final start+570s; versions15s each, parent build60s/bundle120s, outer runner150s, unchanged child120s. Stop first failure or application exhaustion, with no in-run fix/retry. Keep production request5s/pass300s/lease60s/lock10s unchanged. No candidate or Node24 follow-on, higher count, reviewer, full suite, browser or CI retry. This is a request, not an execution grant. The trace can reveal setup, request/pass, validation/reporting or cleanup boundaries; missing markers cannot identify an internal stall. Baseline primary-byte/control qualification is conditional on completion and root acceptance; all traced performance timings are ineligible.

## Remaining gates

The first requested broad slot was superseded by the root's candidate-correctness-only grant. That attempt stopped before subprocess creation with an adapter error; see [the retained receipt](issue-97-correctness-attempt1.md). The root-prepared R2 candidate correctness run subsequently passed all eight commands and 178 tests on each exact runtime; see [the combined correctness report](issue-97-correctness.md). The subsequently granted first peer-feasibility slot stopped at the parent Node20 sync/100 child120s bound; candidate runs were unrun and source/qualified output restoration passed. See [the retained failure and cleanup](issue-97-peer-feasibility.md). Any next runtime scope needs root scheduling. Later acceptance needs repeated paired measurements on exact Node 20/24 with observed spread and behavior equivalence, a useful larger or multi-page case under a new grant, normal CI, and fresh same-pin Sol High and Sonnet 5.5 Medium full-rubric reviews after measured freeze. The combined comparison against original 610 is a later separate gate. No review launch, merge, release or high-count run is authorized by this plan.
