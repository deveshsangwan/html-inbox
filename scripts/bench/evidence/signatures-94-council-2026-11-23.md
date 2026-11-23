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
| Measurements predate the integrated base, so the percentage gains at the current head are unmeasured | Both | Fixed below: committed pairing driver and a fresh paired measurement of `08d5b2b0` against the revised candidate on Node 20 and 24 (pending a local slot) |
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
- Historical disclosure: the archived `artifacts/94/qualify.py` used the same `with_suffix` call. Its per-invocation transcript files collapsed to names such as `matrix-qualified-small-node20.20.log`, so only the last transcript per runtime and prefix survived. The per-process output directories, which hold the `samples.jsonl`, `environment.json`, `summary.json` and `cleanup.json` files the published statistics come from, were unaffected. Those historical results remain scoped to their original pins and are not changed here.
