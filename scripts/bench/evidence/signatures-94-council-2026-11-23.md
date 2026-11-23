# Issue 94 council review, 2026-11-23

This file records the council review of PR #119 and the changes it led to. Earlier evidence files are unchanged. Their timings compare `610c931b` with `999c75d3`, which predate the ownership/hub integration at base `08d5b2b0`.

## Round 1 on `efa93e3d`

Both reviewers worked read-only on the same brief and the same exact head, without running builds, tests or benchmarks.

| Delegate | Functionality | Code quality | Scoped performance evidence | Score |
|---|---|---|---|---:|
| Claude Opus 5.5, high effort | PASS | PASS | PASS | 8.9/10 |
| Codex gpt-6.2-sol, high effort | PASS | PASS | PASS | 9.2/10 |

Neither reviewer found a Critical, High or Medium defect.

| Finding | Source | Disposition |
|---|---|---|
| Measurements predate the integrated base, so the percentage gains at the current head are unmeasured | Both | Fixed: committed pairing driver and a fresh paired measurement of `08d5b2b0` against `2ba6ffb5` on Node 20 and 24, reported below |
| `signatures` and `signature-history` silently use only the first `--sizes` value | Sol, Low | Fixed: `run.py` rejects anything but one size for these workloads; `test_runner.py` covers it |
| No test admits an exact signed state and then removes its route grant | Sol, Low | Fixed: new integration test admits a state through `startCommunication`, removes the route's origin grant at the same generation, and asserts rejection before the callback, with no signing and unchanged ledger bytes |
| Private Ed25519 PEM text in a grant was retained in the process-wide caches | Opus, Low | Fixed: retention now requires SPKI `PUBLIC KEY` PEM text. Verification behaviour is unchanged. The suggested `key.type === "public"` check would be ineffective because `createPublicKey` derives a public `KeyObject` from private PEM, which was confirmed experimentally |
| No integration test proves warm store reads hit the cache | Opus, Low | Fixed: new test asserts zero `crypto.verify` and `createPublicKey` calls across warm snapshot/list/get reads and a second reader instance |
| Pairing driver existed only inside the raw archive | Opus, Low | Fixed: `scripts/bench/signature_pairs.py`, argument tests and a README entry |
| Imported `verify` shadows the method name; dense identity block | Opus, Nit | Fixed: imported as `verifyEd25519`; identity construction separated from the guards |
| Retained-byte budget charges 2 bytes per character although V8 likely stores these strings at 1 byte | Opus, Low | Declined. The budget is a deliberate upper bound that does not depend on V8's internal string representation, and the measured retention, heap and RSS figures rely on it. Halving the charge would double real retention and invalidate those figures. The 10,000-record repeated-scan regime remains explicitly unqualified; it still verifies every record correctly and beats the parent |
| Evidence prose is dense | Opus, Nit | Declined as a rewrite of preserved historical receipts. This file and the PR description carry the current summary |
| The parser read-counter test is loosely tied to issue 94 | Opus, Nit | Kept. It guards the shared runner instrumentation this PR's companion depends on |

## Root pre-slot finding on `36d94b20`

Before granting the measurement slot, root reproduced a defect in the new driver. Runtime directory names such as `v20.20.2-100-10240-pair0-parent` contain dots, so `Path.with_suffix('.log')` mapped several processes to `v20.20.log`, and opening it with `'w'` discarded earlier transcripts.

- Fixed: `plan_runs` appends `.log` to the full basename and rejects any colliding output or log path before a process starts. Failure readback uses the same path, and transcripts open with `'x'` so none can be overwritten. A runner test plans the proposed 30 processes for `v20.20.2` and `v24.19.0` and checks 60 distinct paths and the alternating order.
- The summary now records five within-block variant/parent CPU comparisons per runtime and operation as well as marginal medians. Raw `samples.jsonl` files stay in each process directory.
- At root's request, `pairs-summary.json` also records per-operation sample counts. Every failed or unrun process and every operation absent from a planned block is listed as missing, with `complete: false` and a nonzero exit. A failure stops further measurement but still writes this summary.
- Historical disclosure: the archived `artifacts/94/qualify.py` used the same `with_suffix` call. Its per-invocation transcript files collapsed to names such as `matrix-qualified-small-node20.20.log`, so only the last transcript per runtime and prefix survived. The per-process output directories, which hold the `samples.jsonl`, `environment.json`, `summary.json` and `cleanup.json` files the published statistics come from, were unaffected. Those historical results remain scoped to their original pins and are not changed here.

## Integrated-head paired measurement, 2026-11-23

Root granted one exclusive local run (`pr119-2ba6ffb-paired-qualification-20261123`, 2700 s inclusive). It ran once from 17:06:33Z to 17:26:40Z, used 1207 s, and had no retries or extra cells.

- **Pins.** Candidate `2ba6ffb52c282c1eed7cd6cd497f6e68dd715ec0`, clean; parent `08d5b2b056515ad876ac8aec2a164eea82050fa0`, the published `perf/89-bench`. Lockfile, package manifests and tsconfigs are identical between the pins.
- **Builds.** Both builds are fresh, with tsc-rs on Node 24.19.0. The parent comes from `git archive` and uses the existing dependency tree, with no install. The candidate bundle used the private ncc package with a private cache and temporary directory. Dist graph SHA-256: candidate `ceb32ab4…095e`, parent `5a1510ff…b8c2`. Every process's `environment.json` records the same hash for the dist it loaded, plus clean harness commit `2ba6ffb`.
- **Correctness.** TAP on both runtimes: focused set 111/111 and reader/HTTP set 64/64 on Node 20.20.2 and on Node 24.19.0, with zero failures, cancellations, skips or todos. Bench harness tests 7/7. Typecheck passed.
- **Completeness.** All 30 processes exited 0. `pairs-summary.json` reports `complete: true` with no missing process or operation. A separate raw check found exactly the 19 intended operations in each of the 30 blocks: cold snapshot 1, warm snapshot 5, list 1, get 1, worker startup, no-op, idle and close 1 each, churn miss 3, churn repeat 3, adversarial 1.
- **Cleanup.** The generated `dist` and `bundle` were restored from backup after every owned process had exited, and their hashes match. Only allowed private ncc `.cache` files changed. No owned process or fixture remained.

The 100-record, 10 KiB cell compares parent, key-only adapter and full cache, five interleaved single-sample processes each per runtime. Operation CPU is in ms; ratios are within the same interleaved block.

| Runtime | Operation | Parent CPU median [range] | Key-only | Full cache | Full/parent per block (pairs 0–4) | Key-only/parent median |
|---|---|---:|---:|---:|---|---:|
| Node 20.20.2 | Warm snapshot | 38.5 [38.0, 40.3] | 23.0 [21.6, 23.2] | 8.9 [8.7, 9.0] | 0.23 / 0.23 / 0.22 / 0.23 / 0.24 (median 0.23) | 0.59 |
| Node 20.20.2 | Get | 37.2 [35.4, 44.2] | 20.5 [20.0, 22.7] | 8.3 [6.9, 9.5] | 0.26 / 0.23 / 0.20 / 0.18 / 0.19 (median 0.20) | 0.55 |
| Node 20.20.2 | List | 62.4 [60.0, 64.1] | 47.0 [42.2, 47.5] | 30.8 [28.8, 32.7] | 0.49 / 0.54 / 0.47 / 0.46 / 0.51 (median 0.49) | 0.74 |
| Node 20.20.2 | Warm TLS worker no-op | 17003.2 [16691.2, 17107.3] | 10062.4 [9806.4, 11289.2] | 5783.7 [5684.0, 6500.5] | 0.35 / 0.33 / 0.35 / 0.34 / 0.38 (median 0.35) | 0.59 |
| Node 20.20.2 | Worker startup | 190.7 [185.4, 200.7] | 121.8 [120.3, 139.9] | 71.4 [69.7, 73.1] | 0.36 / 0.39 / 0.38 / 0.37 / 0.37 (median 0.37) | 0.65 |
| Node 20.20.2 | Cold snapshot | 47.8 [43.7, 54.6] | 29.8 [28.6, 31.3] | 32.2 [31.7, 35.6] | 0.67 / 0.68 / 0.58 / 0.68 / 0.81 (median 0.68) | 0.65 |
| Node 20.20.2 | Churn miss | 38.7 [35.8, 41.0] | 19.5 [18.5, 20.9] | 19.8 [18.6, 22.3] | 0.53 / 0.50 / 0.48 / 0.58 / 0.54 (median 0.53) | 0.54 |
| Node 20.20.2 | Churn repeat | 40.8 [36.5, 42.0] | 19.2 [18.3, 26.9] | 6.1 [5.8, 6.3] | 0.14 / 0.15 / 0.17 / 0.15 / 0.16 (median 0.15) | 0.47 |
| Node 20.20.2 | Adversarial rejection | 165.9 [158.6, 174.9] | 109.3 [108.8, 180.2] | 67.1 [64.3, 72.6] | 0.39 / 0.39 / 0.41 / 0.39 / 0.45 (median 0.39) | 0.67 |
| Node 24.19.0 | Warm snapshot | 24.0 [23.5, 24.9] | 21.2 [21.0, 21.9] | 7.3 [6.7, 9.7] | 0.41 / 0.28 / 0.30 / 0.30 / 0.36 (median 0.30) | 0.88 |
| Node 24.19.0 | Get | 24.2 [23.7, 26.1] | 20.4 [19.8, 20.5] | 7.4 [7.3, 7.9] | 0.33 / 0.31 / 0.29 / 0.31 / 0.29 (median 0.31) | 0.82 |
| Node 24.19.0 | List | 39.5 [36.0, 40.6] | 33.3 [33.0, 36.3] | 20.5 [20.0, 21.4] | 0.51 / 0.57 / 0.52 / 0.59 / 0.50 (median 0.52) | 0.91 |
| Node 24.19.0 | Warm TLS worker no-op | 8386.1 [8242.2, 8537.2] | 7795.9 [7673.9, 8328.4] | 3786.0 [3621.2, 3831.4] | 0.44 / 0.46 / 0.44 / 0.45 / 0.45 (median 0.45) | 0.92 |
| Node 24.19.0 | Worker startup | 120.1 [116.6, 138.0] | 109.5 [106.0, 118.2] | 58.0 [54.7, 59.3] | 0.49 / 0.43 / 0.49 / 0.50 / 0.40 (median 0.49) | 0.93 |
| Node 24.19.0 | Cold snapshot | 33.0 [31.0, 35.2] | 29.9 [29.1, 35.9] | 32.6 [32.5, 38.1] | 1.23 / 1.01 / 0.93 / 0.98 / 0.95 (median 0.98) | 0.93 |
| Node 24.19.0 | Churn miss | 26.9 [25.2, 28.1] | 18.7 [17.3, 22.3] | 21.6 [20.6, 22.4] | 0.77 / 0.78 / 0.83 / 0.89 / 0.78 (median 0.78) | 0.72 |
| Node 24.19.0 | Churn repeat | 27.7 [25.5, 32.1] | 18.1 [17.9, 20.4] | 7.5 [5.0, 9.3] | 0.18 / 0.18 / 0.30 / 0.29 / 0.29 (median 0.29) | 0.65 |
| Node 24.19.0 | Adversarial rejection | 112.8 [107.3, 117.1] | 94.6 [93.1, 101.7] | 55.6 [52.3, 60.6] | 0.47 / 0.48 / 0.52 / 0.48 / 0.54 (median 0.48) | 0.87 |

Reading:
- The full cache cuts warm snapshot and get CPU to 0.20–0.31× of the integrated parent, list to about 0.5×, and the warm TLS worker no-op to 0.35× on Node 20 and 0.45× on Node 24. For warm snapshot, get, list, worker startup and the worker no-op it beats key-only reuse in all five blocks on both runtimes.
- On Node 24, key-only reuse gains little over the parent (worker 0.92×, get 0.82×), so the exact-success cache supplies most of the benefit there.
- Costs stay disclosed. A cold snapshot on Node 24 is no faster than the parent: median 0.98×, with one block at 1.23×. Paths that pay the miss cost lose to key-only reuse. Cold snapshot is slower than key-only in 5/5 blocks on Node 20 and 4/5 on Node 24. Churn miss is slower in 3/5 blocks on Node 20, where the medians are close (19.8 against 19.5 ms), and in 4/5 on Node 24 (21.6 against 18.7 ms).
- Retained heap at 100 records is within about 0.3 MiB across variants.
- This one cell does not qualify 1,000- or 10,000-record, over-capacity, initial-sync, separate-host or persistent-media behaviour. Those limits from the earlier evidence still apply.

Raw outputs: [`signatures-94-integrated-pairs-2026-11-23.tar.gz`](signatures-94-integrated-pairs-2026-11-23.tar.gz), SHA-256 `453a14472478e14f18dd2eb8b6db23f13b8e0ead27aa5c5636dd6ec6985cadc6`, 211 members. It holds every process's `samples.jsonl`, `environment.json`, `summary.json`, `cleanup.json` and full transcript, plus `commands.jsonl`, `pairs-summary.json`, `intended-operations-check.json`, the TAP and build logs, before and after hash manifests, the qualification script and the check script.
