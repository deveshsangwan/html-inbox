# CI correction follow-up

The first hosted run of PR #79 failed after the initial seven logical commits at `26506b488805092b8bf43b52dfabab36fd6cf297`. These follow-up changes preserve those published commits and add focused corrections. No merge, deployment, installed CLI/viewer, real store or live network/security change is involved.

| Cause | Evidence | Correction | Status |
| --- | --- | --- | --- |
| Shared protocol store removed before application shutdown | Ubuntu24 bytes-quota and Ubuntu20 files-quota hooks failed ENOTEMPTY in run40074284237. Deterministic real-three-process probe observes all writers live when removal begins | One fixture-owned teardown closes resources in reverse order, attempts every cleanup, and removes the store only after success. Extra applications/proxies/runners/readers use the same scope | Local regression and full31protocol cases pass on both runtimes |
| Windows path fixture masks intended listener validation | Scoped node:path.win32 adapter makes the old /tmp/key and /tmp/cert input fail canonical-path validation before /unicast/ | Positive paths use path.resolve(tmpdir()); valid loopback config is checked before the unchanged unicast rejection | Red/green Windows-path probe and integrated configuration tests pass |
| Optional managed ownership breaks ordinary Windows viewer records for large stat IDs | Actual startViewer/readViewerRecord with isolated win32/unsafe-stat simulation fails Invalid bounded integer before the fix | Omit the optional POSIX-managed anchor on Windows; verification explicitly rejects a missing current anchor. Strict parser, POSIX copied/UUID/dev/ino/PID controls and Windows managed-enrollment rejection stay intact | Local real-path regression passes. Hosted Windows root-cause confirmation remains pending |
| Failure details hidden until hung test process exits | Windows spec reporter listed failures, then job timed out at20min before printing stacks | Unit runner selects TAP only when GITHUB_ACTIONS=true, flushing individual failures. All files, assertions, concurrency and exit propagation remain unchanged | Broad verification exercised the CI reporter successfully |

The original quota, staged-body, receipt, overflow413, lease ownership, timeout and cleanup assertions remain. No retry of rm, longer deadline, skipped ordinary Windows case or weakened managed validation was introduced.

## Local verification

The unchanged `pnpm verify` ran through an isolated wrapper with GITHUB_ACTIONS=true, private HOME/XDG/ZDOTDIR, owned-child reaping and a private network namespace with a synthetic interface and no external route:

```sh
python3 /tmp/html-inbox-phase2-checks-1mpkndv5/check-coordinator.py ci-corrections-broad bash /tmp/html-inbox-phase2-ci-fbzleyds/verify-ci.sh
```

Exit0 in212.57s:738tests,733passed,five documented skips,zero failure/cancel/todo. Unit656/654passed/2skipped;skills50/48/2;browser23/22/1;site9/9/0;integrity14HTMLpages and package smoke passed. The wrapper reaped119adopted children with0remaining.

The new teardown ordering probe failed before the fix in0.742s and passes afterward. The original quota-only local run was green, so the deterministic probe is the red-capable feedback loop rather than a claim that ENOTEMPTY reproduces naturally on every run. A first version asserted in the earliest hook and prevented later cleanup; its three owned children expired at their existing bounded lifetime. All four recorded parent/child PIDs are absent, no termination signal was sent, and the two synthetic directories were removed. The corrected probe records the unsafe order, stops owned children, and fails its final assertion without leaking resources. All failed receipts remain.

The full independent protocol suite passes31/31 on Node24.19.0 and20.20.2 after the cleanup correction. The integrated ownership/configuration cases pass6/6 on each runtime. The isolated Windows author also passed19/19 reported ordinary viewer, selection, enrollment and ownership cases on Linux, with explicit platform/stat/path simulations. Native Windows execution is not claimed locally. Its cleanup audit contains80observed Node PIDs absent and33exact loopback ports rebound, with an empty fixture tree.

Exact expanded commands, exits, log hashes, original red evidence and author inventory are in verification.json under ciFollowup. Source ownership was disjoint: the coordinator owned the protocol test and runner; the app-owned child worktree owned only viewer-ownership.ts, sync-runtime-config.test.ts and new viewer-ownership.test.ts. The terminal child was read in full and its three hashes verified before integration.

The current147CLI-source checksum list is [tested-source-ci.sha256](tested-source-ci.sha256), aggregate a474027291dcfc3aefb2d1da8ec39e9ac4f314430b0892d1721ae6b4884f224f. The earlier146-file tested-source.sha256 remains the historical reviewed pre-CI snapshot; use the new list for this correction. The runner .mjs change is separately included in the CI review manifest.

## Review and hosted verification

Two fresh narrow confirmations accepted the identical complete ten-file CI delta and necessary interactions against the original contracts, accepted prior responses and the full correctness/security/integrity/concurrency/lifecycle/compatibility/structure/test rubric. [Sol's report](review-ci-sol.md) and [Astra's report](review-ci-astra.md) record no actionable finding. Both independently validated the pinned base, empty index, complete tracked/untracked hashes and all147source checksums. Sol passed8selected cases on both runtimes; Astra passed8on Node20. Name-filter exclusions are separate from product skips. This is a focused CI correction, not another exhaustive implementation review. Claude is unauthenticated, so no cross-provider claim is made.

Both complete reports, exact commands and cleanup receipts were read before releasing the freeze. Sol verified40observed PIDs absent and36exact loopback ports rebound; Astra verified21PIDs absent and8ports rebound. All reviewer fixture roots were removed, with no termination signals. Only documentation/result metadata changes after their freeze; reviewed production/test bytes remain unchanged.

This document is the pre-push local verification snapshot. Hosted status is pending a corrected push; the current [PR checks](https://github.com/deveshsangwan/html-inbox/pull/79/checks) are authoritative for subsequent hosted results. Linux failures are reproduced at their unsafe ordering. Windows ordinary-viewer cause is reproduced in controlled real-path simulations but remains a hypothesis about the hosted machine until the native matrix passes. The workflow/matrix/20minlimit and every required verification stage remain unchanged.

| Task | Receipt | Result |
| --- | --- | --- |
| CI-LINUX | ci-teardown-focused-green-node24; ci-protocol-full-node24/node20 | Deterministic red before correction;3focused and31full cases pass |
| CI-WINDOWS | windows-terminal-handoff.json; ci-owned-compatibility-node24/node20 |19author cases;6integrated cases per runtime; native Windows pending |
| CI-BROAD | ci-corrections-broad; unchanged pnpm verify with CI reporter | Exit0;738total/733pass/5documentedskips;119adopted children reaped,0remaining |
| CI-REVIEW-SOL | phase2-ci-fix-confirmation-sol-20261024-a | ACCEPT;8selected cases per runtime;40PIDs absent/36ports rebound |
| CI-REVIEW-ASTRA | phase2-ci-fix-confirmation-astra-20261024-a | PASS;8selected Node20 cases;21PIDs absent/8ports rebound |
| CI-HOSTED | PR79 checks after the corrected push | Pending; no native-green claim in this snapshot |

## Follow-up commits

The original seven commits remain unchanged. `01b3f82` closes protocol fixture writers before removing their shared store and enables immediate CI failure diagnostics. `639b118` preserves ordinary Windows viewer compatibility and adds the ownership/path regressions. A separate documentation commit records this local evidence and both review reports. The broad run and reviewer checks cover the final combined source; no source changes followed their freeze.
