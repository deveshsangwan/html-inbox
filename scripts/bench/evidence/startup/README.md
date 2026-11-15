# Issue 93 installed startup

Parent: `610c931b7b22920cce59cf03e49c0de15ebaf2a2` on `perf/89-bench`, PR #114. Candidate production source: `8ae19fd9c746d335b0fbf0c8ca6e21ada1dd9f80`. Later commits add qualification scripts and evidence, with no change to measured production JavaScript. The parent has no CLI source changes relative to `099dcbd6378e3b6f73216966cfe9ea7f91ed5d8e`, the original #88/#89 integration baseline. Thus this comparison also covers the combined stack's production startup change. The older exploration reference `1ae641a` is not a measured baseline.

## Reproduce

Use Linux, Python >=3.11, the frozen lockfile, build Node 24.19.0, pnpm 11.7.0, tsc-rs 0.7.0 and ncc 0.44.1. Run sequentially in an otherwise idle slot. Use the same clean owned checkout for both refs, preserving the candidate branch. No separate worktree is needed.

For each pinned source ref, build and pack after removing previous output. Start with a clean worktree. Save the runner outside the checkout if switching to a revision that lacks it.

```sh
pnpm install --frozen-lockfile
git switch --detach 610c931b7b22920cce59cf03e49c0de15ebaf2a2
node -e "require('node:fs').rmSync('packages/cli/bundle', {recursive:true,force:true})"
pnpm build
pnpm --filter html-inbox bundle
mkdir -p artifacts/93/base-clean/consumer
npm pack --ignore-scripts --pack-destination artifacts/93/base-clean ./packages/cli
npm install --prefix artifacts/93/base-clean/consumer --ignore-scripts --no-audit --no-fund --package-lock=false ./artifacts/93/base-clean/html-inbox-0.6.1.tgz

git switch perf/93-startup
node -e "require('node:fs').rmSync('packages/cli/bundle', {recursive:true,force:true})"
pnpm build
pnpm --filter html-inbox bundle
mkdir -p artifacts/93/candidate/consumer
npm pack --ignore-scripts --pack-destination artifacts/93/candidate ./packages/cli
npm install --prefix artifacts/93/candidate/consumer --ignore-scripts --no-audit --no-fund --package-lock=false ./artifacts/93/candidate/html-inbox-0.6.1.tgz

python3 scripts/bench/startup.py --base artifacts/93/base-clean/consumer --candidate artifacts/93/candidate/consumer --base-ref 610c931b7b22920cce59cf03e49c0de15ebaf2a2 --candidate-ref 8ae19fd9c746d335b0fbf0c8ca6e21ada1dd9f80 --node /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --out artifacts/93/qualified-node20
python3 scripts/bench/startup.py --base artifacts/93/base-clean/consumer --candidate artifacts/93/candidate/consumer --base-ref 610c931b7b22920cce59cf03e49c0de15ebaf2a2 --candidate-ref 8ae19fd9c746d335b0fbf0c8ca6e21ada1dd9f80 --node /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --out artifacts/93/qualified-node24
```

Node paths are host-specific; substitute equivalent installations with their own npm/npx CLIs. The runner resolves those CLI files, records their versions and hashes, and sets PATH so their child uses the selected Node. Setup installs are untimed, with scripts disabled after the explicit build. npm/npx measurements are offline local-installed resolution, not download or registry latency.

Each runtime has 20 alternating samples per variant, operation and launcher after two warmups per variant/cell, 600 timed samples per runtime. Wall time includes spawning and waiting. Raw stdout/stderr/exit results are compared exactly across base/candidate, including no arguments and invalid version options. CPU includes waited descendants. Linux wait4 peak RSS is the largest individual process high-water mark, including waited descendants; it is not aggregate process-tree memory. Hashing streams small blocks to avoid contaminating child RSS with a large pre-exec parent allocation. Filesystem caches are uncontrolled and warm. No p95 or cold-cache claim.

Only `qualified-node20` and `qualified-node24` enter the final evidence. Earlier experiments were discarded after finding stale ncc files in an uncleared output directory and an oversized hash allocation in the instrumentation. The clean candidate rebuild matches every originally installed candidate JS asset hash. Neither correction changes production source.

Complete raw samples are gzip-compressed alongside environment metadata, summaries and cleanup receipts in the adjacent runtime directories. Build/compiler/runtime/source-tree/tarball fingerprints are in `build-environment.json.gz`. Local setup/test logs and both installed artifacts remain under `artifacts/93`; public performance evidence does not depend on that ignored path.

## Results

Decision: retain the production change. Direct installed help/version savings are much larger than sample spread on both runtimes. These compare code within each runtime, not Node upgrades. All 1,200 timed samples and warmups preserved exact base/candidate stdout, stderr and exit behavior. Both cleanup receipts confirm fixture removal and child reaping.

Medians below use milliseconds for elapsed/CPU and MiB for peak RSS. Each entry is base → candidate. Complete min/median/max values are in the adjacent summaries.

| Node | Launcher | Operation | Elapsed ms | CPU ms | Peak RSS MiB |
| --- | --- | --- | --- | --- | --- |
| 20 | direct | help | 86.57 → 35.14 | 88.48 → 35.30 | 52.49 → 40.08 |
| 20 | direct | version | 88.31 → 36.74 | 90.17 → 36.61 | 52.49 → 40.08 |
| 20 | direct | noargs | 89.01 → 37.59 | 90.95 → 37.62 | 52.43 → 40.14 |
| 20 | direct | error | 94.76 → 53.96 | 95.63 → 54.33 | 52.62 → 43.73 |
| 20 | direct | list | 96.32 → 96.42 | 97.62 → 101.21 | 52.80 → 52.76 |
| 20 | npm | help | 431.53 → 381.51 | 503.66 → 452.89 | 73.03 → 73.23 |
| 20 | npm | version | 427.55 → 374.05 | 499.49 → 444.52 | 72.75 → 72.55 |
| 20 | npm | noargs | 427.03 → 367.99 | 499.61 → 438.38 | 72.74 → 72.73 |
| 20 | npm | error | 421.67 → 389.45 | 493.14 → 459.83 | 72.87 → 72.98 |
| 20 | npm | list | 441.80 → 436.24 | 513.96 → 510.94 | 72.55 → 72.79 |
| 20 | npx | help | 423.30 → 390.01 | 495.49 → 458.64 | 72.49 → 72.33 |
| 20 | npx | version | 422.68 → 376.49 | 494.99 → 448.24 | 72.44 → 72.67 |
| 20 | npx | noargs | 414.25 → 364.58 | 486.04 → 435.63 | 72.51 → 72.58 |
| 20 | npx | error | 421.03 → 382.80 | 493.60 → 453.55 | 72.56 → 72.64 |
| 20 | npx | list | 431.16 → 427.84 | 502.81 → 502.89 | 72.55 → 72.51 |

Node 20 direct elapsed spread and deltas:

| Operation | Base min / median / max ms | Candidate min / median / max ms | Median delta |
| --- | --- | --- | --- |
| help | 83.68 / 86.57 / 99.53 | 33.49 / 35.14 / 44.00 | -51.43 ms / -59.4% |
| version | 80.86 / 88.31 / 96.18 | 33.35 / 36.74 / 41.80 | -51.57 ms / -58.4% |
| noargs | 81.78 / 89.01 / 117.75 | 32.85 / 37.59 / 90.27 | -51.42 ms / -57.8% |
| error | 79.87 / 94.76 / 137.37 | 46.76 / 53.96 / 72.12 | -40.80 ms / -43.1% |
| list | 87.97 / 96.32 / 102.11 | 89.60 / 96.42 / 103.96 | +0.10 ms / +0.1% |


| Node | Launcher | Operation | Elapsed ms | CPU ms | Peak RSS MiB |
| --- | --- | --- | --- | --- | --- |
| 24 | direct | help | 84.21 → 39.29 | 93.86 → 39.22 | 66.55 → 47.54 |
| 24 | direct | version | 79.87 → 38.15 | 90.56 → 38.87 | 66.67 → 47.54 |
| 24 | direct | noargs | 79.27 → 34.97 | 90.06 → 36.56 | 66.65 → 47.51 |
| 24 | direct | error | 78.95 → 52.29 | 90.79 → 61.49 | 66.75 → 55.25 |
| 24 | direct | list | 84.53 → 85.61 | 95.47 → 95.78 | 66.95 → 65.81 |
| 24 | npm | help | 371.59 → 335.29 | 455.11 → 408.40 | 94.83 → 95.11 |
| 24 | npm | version | 370.73 → 326.08 | 453.45 → 399.52 | 94.97 → 95.00 |
| 24 | npm | noargs | 369.76 → 331.21 | 452.81 → 404.04 | 95.17 → 95.16 |
| 24 | npm | error | 380.05 → 345.17 | 464.32 → 427.74 | 95.12 → 95.28 |
| 24 | npm | list | 380.70 → 380.15 | 462.62 → 461.95 | 95.15 → 94.79 |
| 24 | npx | help | 374.28 → 333.22 | 458.29 → 404.52 | 94.41 → 94.42 |
| 24 | npx | version | 373.33 → 331.03 | 455.18 → 402.65 | 94.45 → 94.61 |
| 24 | npx | noargs | 373.09 → 328.12 | 456.84 → 401.64 | 94.64 → 94.72 |
| 24 | npx | error | 373.90 → 345.65 | 454.97 → 427.01 | 94.57 → 94.69 |
| 24 | npx | list | 376.02 → 375.73 | 459.66 → 456.39 | 94.50 → 94.41 |

Node 24 direct elapsed spread and deltas:

| Operation | Base min / median / max ms | Candidate min / median / max ms | Median delta |
| --- | --- | --- | --- |
| help | 74.21 / 84.21 / 164.79 | 31.54 / 39.29 / 50.10 | -44.92 ms / -53.3% |
| version | 75.20 / 79.87 / 96.28 | 30.47 / 38.15 / 43.50 | -41.73 ms / -52.2% |
| noargs | 74.32 / 79.27 / 87.09 | 31.74 / 34.97 / 44.97 | -44.30 ms / -55.9% |
| error | 75.58 / 78.95 / 89.35 | 47.55 / 52.29 / 64.20 | -26.66 ms / -33.8% |
| list | 80.13 / 84.53 / 93.81 | 80.90 / 85.61 / 93.09 | +1.08 ms / +1.3% |

The launcher dominates peak RSS, so npm/npx do not show the direct child's memory reduction. Direct list on Node 20 has median CPU 97.62 → 101.21 ms, a 3.7% increase, while elapsed is 96.32 → 96.42 ms. On Node 24 list elapsed is 84.53 → 85.61 ms, +1.08 ms / +1.3%, with overlapping ranges. No ordinary-command speedup is claimed. Large-library throughput and long-running worker resource changes were not measured because the command implementations are unchanged. Lifecycle tests qualify behavior, not a daemon memory/CPU improvement.

The clean base has one 1,275,572-byte JS file. Candidate has eight files totaling 1,293,946 bytes, +18,374 bytes / +1.44%; the entry is 22,016 bytes. Packed tarballs are 258,405 → 262,491 bytes, +4,086 / +1.58%. Deferred chunk reads add complexity and slight size overhead, but remove roughly 42–52 ms of direct help/version startup and 12–19 MiB peak RSS. Noncanonical help/version argument forms still go through the existing parser, and may load its dependencies. Installed canonical aliases/noargs have a subsystem-load guard.

## Behavior and repository checks

All commands in `verification.json` exited 0. Adjacent `.log.gz` files preserve their complete output and hashes. Node 24.19.0 uses npm/npx 11.17.0; Node 20.20.2 uses npm/npx 10.8.2.

- Node 24 `pnpm verify`: source 1,324 passed / 3 skipped / 0 failed; harness 15 passed; skill resolution 146 passed / 2 skipped; browser 73 passed / 1 skipped; site 9 passed; installed package smoke passed.
- Node 20 full source suite: 1,325 passed / 2 skipped / 0 failed. The runtime-dependent skip difference is retained in the full logs.
- Both measured npm-installed candidate artifacts passed package smoke on their selected runtime, including canonical help/version/noargs subsystem guards, ordinary publish/list/export/preferences-related source contracts, invalid private entry arguments, real IPC deletion through the viewer, foreground and concurrent detached viewer startup/reuse/stop, exposure reset, Tailscale fixture cleanup, selected-owner preflight, and detached managed worker enable/status/stop/start/disable with PID and runtime-record cleanup. No actual privileged service installation was attempted.
- The focused parser corpus checks exact stdout/stderr/exit behavior for aliases, end-of-options, selection flags, extra arguments, unknown commands and a non-IPC deletion-worker token. Full source suites include service-owner credential boundaries, fault/adversarial deletion cases, worker custody, recovery and cleanup.
- Shared #89 resource-runner failure/timeout cleanup tests: 2 passed. Final `pnpm verify` rebuilt bundle hashes exactly match the measured installed candidate.

No local checks failed. These Linux results do not replace final macOS/Windows CI or root readiness verification. Future forward-port qualification is separate. The PR remains draft.

## Review clarifications

Both independent reviewers passed functionality, code quality and performance evidence on `ac2b3b7993b893ac914a241d839c83331183679c`. Exact settings, findings dispositions and reviewer limits are in [reviews.md](reviews.md).

The cleanup receipt's `children_reaped` is a success-path postcondition about waited direct children, not an independent process-tree census. The package smoke's identical three-line runtime logs rely on `verification.json` and the separate measured environments for runtime identity. Selected-owner preflight was exercised locally as uid 1001; the success case skips under root. The synthetic catalog isolates the new managed-worker fixture from real catalog state. A failed worker-disable cleanup can leave a detached process and erase its fixture evidence; both reviewers treat failure-path teardown hardening as optional follow-up, and the successful receipts verified worker cleanup. The timed error cell is invalid-option startup, while unknown-command handling is behavioral coverage only. Publish and detached-start latency were not measured.
