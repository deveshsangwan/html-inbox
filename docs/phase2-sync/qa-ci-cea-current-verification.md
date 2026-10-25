# Current CEA correction verification

This record binds the corrective snapshot reviewed on `feat/phase2-sync` against `cea30b48cbef814511e2eedfc83d1793bc011354`, before packaging. Both fresh independent reviews accepted the complete 98-file correction. Their reports are [Sol](review-ci-cea-r1-sol.txt) and [Astra](review-ci-cea-r1-astra.md). The sole nonblocking suggestion corrected stale current-status summaries; no code changed after review. Publication lineage is recorded in Git history and PR79.

The [169-file source manifest](tested-source-qa.sha256) has SHA-256 `4967ad40861e64dfe33932a3383216c47b25a978f49ec736dd2dd15c792a5eba`. The 336 compiled files have aggregate `88393e78f3292bc7fbd61b78e5deb4fe6bec909e0795987e7515f714a33d069a`. The previous 165-file manifest remains in [the CI190 archive](tested-source-qa-ci190.sha256).

| Check | Exit | Result | Elapsed |
| --- | --- | --- | --- |
| Full Node 24.21.0 verification | 0 | 1133 tests, 1129 passed, 4 skipped | 296.912625s |
| Complete Node 20.20.2 compiled units | 0 | 1051 tests, 1050 passed, 1 skipped | 311.573814s |

Every group has zero failures, cancellations and todo cases. Full verification includes typecheck/build, units 1050/1051, skills 48/50, browser 22/23, site 9/9, integrity for 14 pages and package smoke. Skips cover native Windows taskkill, two Windows PowerShell cases and optional live-CDN coverage. Counts overlap across runtimes and author checks.

Exact commands:

```sh
python3 /tmp/html-inbox-phase2-checks-1mpkndv5/check-coordinator.py qa-ci-cea-integrated-verify2421-attempt4 bash /tmp/html-inbox-qa-history-amcemjlx/verify-hosted-node2421.sh
python3 /tmp/html-inbox-phase2-checks-1mpkndv5/check-coordinator.py qa-ci-cea-integrated-unit20-attempt4 bash /tmp/html-inbox-qa-history-amcemjlx/node20-unit.sh
```

The complete [terminal report](qa-ci-cea-combined-current.txt) records UTC times, original receipts and stage messages. Immutable evidence is `/tmp/html-inbox-cea-queue-budget-combined-evidence-ndv9w6qx/`. Log SHA-256 values are `e804054b601fee643ea8eef4bc0dbfcedf17b5288199ff44889d980db359729f` and `b172517394667c1591c277c1207c904377fda7879ef8a4749c28c66d8cedf1bb`.

Parent verified all 85 artifact hashes, all 412 frozen nonignored files, source and output pins, and 633 recorded PIDs absent. Outer audits reaped 167 and 126 adopted children, both with empty remaining lists. No new synthetic residue remained. Three expected NCC cache files changed; exact before/after hashes are retained. Inherited scratch was untouched. Known PID sets overlap and do not establish whole-host absence. Endpoint and child-close evidence comes from actual scoped test assertions.

The author [positive backoff correction](qa-ci-cea-queue-backoff-positive-budget-implementation.txt) keeps the request timeout at 100ms and the holder at 140ms, and uses a fixed 1000ms enclosing positive worker pass. All original assertions and separate 300ms whole-pass negatives remain. Both containing files passed 6/6 without preloads. A 110ms completed-result hold passed with actual custody; a 1100ms hold fired the real pass timer and failed the strict assertion. That expected negative remains native exit 1. The correction does not promise deterministic scheduling.

All earlier failed commands, incomplete runs, helper failures and uncertainty qualifications remain historical evidence. The original hosted actors and some setup stages remain unassigned. This verification uses isolated local Linux environments with loopback and a documentation-range dummy interface. It establishes neither native Windows/macOS acceptance nor real three-device LAN/Tailscale success, OS sleep/boot, privileged manager operation or physical power-loss persistence.

Parent read both complete reports, verified their evidence and source/output pins, and resolved the documentation suggestion. Both reviewers inspected supplied tests without rerunning them; neither ran an application probe. Hosted checks must pass on the resulting exact commit before independent physical QA receives one full SHA. No merge or deployment is authorized.

The source is packaged into `c77c905143f7e2ed1546d71ea11b405d1b00d6f7` for cancellation, queue handling and attempt lifetime with regressions, then `9effb5bbba56e9abc655e9c9be0b2ff0ba561b13` for fixture ownership, preparation and browser readiness. Both actual staged trees independently typechecked and built in disposable exports. These are intermediate build checks, not intermediate full-test results. The final source and all 336 emitted files match the reviewed and broad-tested bytes. This documentation commit follows them; Git history and PR79 record its identity.
