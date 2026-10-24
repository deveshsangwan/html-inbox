# Phase 2 commit sequence

The original local readiness report records the reviewed, uncommitted snapshot. The user subsequently authorized logical commits and a single PR stacked on phase1 PR #76. That later authorization supersedes the earlier no-commit/no-push/no-PR boundary. No merge, deployment or live infrastructure operation is authorized.

The stack base is `feat/named-inboxes-local-hub` at `b843e126fdb10f7038e9305c6791707bcfee9ff5`. The phase2 branch is `feat/phase2-sync`. This is one phase2 PR containing the following logical commits.

| Order | Commit | Purpose | Verification |
| --- | --- | --- | --- |
| 1 | `cd0950e` | docs: record the approved phase-2 sync contracts | Typecheck/build exit0 |
| 2 | `eccdbb4` | feat: add durable managed storage and origin identity | Typecheck/build exit0; 130 tests, 130 passed, 0 skipped, 0 failed |
| 3 | `28a2cb8` | feat: implement verified HTTPS push pull and relay reconciliation | Typecheck/build exit0; 43 tests, 42 passed, 1 skipped, 0 failed |
| 4 | `8b5ac9d` | fix: preserve managed viewer and service ownership lifecycles | Typecheck/build exit0; 143 tests, 143 passed, 0 skipped, 0 failed |
| 5 | `2d9d348` | feat: add owned sync workers and confirmed CLI publication | Typecheck/build exit0; 64 tests, 64 passed, 0 skipped, 0 failed |
| 6 | `4d2982b` | test: cover sync recovery security and reader compatibility | Typecheck/build exit0; 62 tests, 62 passed, 0 skipped, 0 failed |
| 7 | This documentation commit | docs: record sync acceptance review and commit verification | Full final verification below; source checksums and whitespace checks |

The last commit is identified by its subject to avoid embedding its own SHA. Exact commands, cwd, exits, log hashes and staging-tree IDs are retained in verification.json under commitReorganization. Temporary validation checkouts were exported from the staged index and removed after their owned processes exited. Tests used isolated homes and private network namespaces with a synthetic interface and no external route.

Three shared files are introduced incrementally. The storage commit adds only the existing protocol-error class and literal-IP validator in sync-wire.ts and sync-http-server.ts; the HTTPS commit adds their complete implementations. The viewer commit adds the service-owner preflight and service-selection portions of index.ts; the worker commit adds sync dispatch and confirmed publication. These definitions are unchanged from the reviewed source. All final production/test files remain byte-identical to the reviewed handoff.

One staging-only whitespace check initially rejected an extra blank line at EOF in the temporary class-only blob. It was corrected before the storage commit. No check was disabled and no reviewed working-tree source changed.

## Final verification

`python3 /tmp/html-inbox-phase2-checks-1mpkndv5/check-coordinator.py logical-commits-final-broad bash /tmp/html-inbox-phase2-checks-1mpkndv5/verify.sh` exited0 in213.66 seconds. The unchanged inner `pnpm verify` passed734tests:729passed, five documented skips, zero failures/cancellations/todos. Unit652/650passed/2skipped; skills50/48/2; browser23/22/1; site9/9/0; integrity14HTML pages and package smoke passed. The owned subreaper reaped121adopted children with0remaining.

The inner command remains the unchanged `pnpm verify`. The wrapper uses isolated HOME/XDG/ZDOTDIR, an owned-child subreaper and a private network namespace, preserving the original testing restrictions. Node24.19.0 is the current host runtime. The original independent Node20.20.2 verification remains applicable because all source bytes are unchanged; it was not represented as a fresh Node20 run during history reorganization.

The 146 CLI source files still match [tested-source.sha256](tested-source.sha256), aggregate `752186ddcd8f399fc54206451c9f045e7a93c755e785145bef3450f4abc78b1e`. Both implementation source and tests are unchanged. Only result documentation is updated to record the committed handoff and new publication authorization.

The original review reports, accepted corrections, platform limits and infrastructure limits remain in [local-readiness.md](local-readiness.md), [acceptance.md](acceptance.md) and [review-triage.md](review-triage.md). No additional whole-change review is claimed for rearranging identical source into commits.

Final publication consists only of pushing feat/phase2-sync and opening its PR against the phase1 branch. Main, phase1 and unrelated sibling branches are not modified. No merge, release, deployment, installed CLI/viewer, live service, real report store, production credential or network/security setting is changed.
