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

## Remaining gates

The first slot needs root scheduling. Later acceptance needs repeated paired measurements on exact Node 20/24 with observed spread and behavior equivalence, a useful larger or multi-page case under a new grant, normal CI, and fresh same-pin Sol High and Sonnet 5.5 Medium full-rubric reviews after measured freeze. The combined comparison against original 610 is a later separate gate. No review launch, merge, release or high-count run is authorized by this plan.
