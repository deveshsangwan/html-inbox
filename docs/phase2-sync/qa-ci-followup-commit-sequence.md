# Hosted CI follow-up commits

These follow the existing seventeen commits on `feat/phase2-sync` without rewriting history. Base is `01657ea6fd6dcb1d4c4f3f5ed4233828ab135f27`; PR79 remains stacked on PR76 at `b843e126fdb10f7038e9305c6791707bcfee9ff5`. No main or unrelated sibling changes were merged.

| Commit | Logical chunk |
| --- | --- |
| `232ee3b38250d0b770991d1464455e00af1dd6c0` | fix(sync): retain delivery diagnoses when custody inspection expires |
| `de199109acc6dc1bb78826f445af7f237cc35c40` | test(sync): bound composite session coverage by its full workload |
| This documentation commit | Record diagnoses, frozen gates, exact verification, both review rounds and remaining limits |

Each staged tree independently typechecked and built with exact Node24.21.0 in a disposable index export before commit. All six checks passed; each temporary export was removed. Intermediate typecheck/build is not an intermediate full-test claim. The complete final165-source aggregate remains `99261687aadcfad5f973a50e7e9abcf8d6a1e6020a45f4e01f9a07338180fc30`, identical to the full checked and reviewed bytes. Exact commands/exits/log hashes are in verification-qa.json and `/tmp/html-inbox-qa-history-amcemjlx/hosted-ci-commit-receipts.json`.

The publication chunk includes the original diagnosis-preservation correction and the final unavailable-observation continuation together with nineteen dedicated regressions. The session chunk changes only one composite test observation budget and adds progress diagnostics, preserving all production deadlines and original application assertions. The evidence commit preserves original failed hosted logs, controlled reproductions, both accepted final reports, cleanup and compatibility qualifications.

Full local verification is1094tests/1090pass/4documentedskips on exact24.21.0 plus completeNode20 units1012/1011pass/1Windowsskip. There are no failures/cancellations/todo cases. Both final fresh focused reviewers accept; their56/31cases per runtime overlap these counts. Prior whole-change reviews remain retained. Hosted checks of the complete published head and independent physical QA remain separate gates. No partial head is released to QA, and no merge or deployment is authorized.
