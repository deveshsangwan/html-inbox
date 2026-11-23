# Issue 89 parent integration, 15 November 2026

> **Historical receipt.** It describes the tested merge `edf9d32` and head `08d5b2b`. Later commits changed the harness and its tests, so "Harness scripts … are unchanged from 610c931" and "2 passed" describe that revision only. The inherited parent gates listed under "Open gates" remain open and are tracked in PR #114.

Related to [issue #89](https://github.com/deveshsangwan/html-inbox/issues/89) and [PR #114](https://github.com/deveshsangwan/html-inbox/pull/114). This is harness integration, not an optimization, release or new speedup claim. The PR remains draft for shared failure and final-head CI gates.

## Source and ancestry

Preserved clean unpublished `fa22ae2c7c9eac5ccfc5996daa81414fe7119c2b`, including parent `1bbfc5970c5ddd1f9fe43e635ef1834529522fe1` and the original published `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Ordinary-merged exact release/0.7 `c4bdc98b91acc15fa67ecf5fdc2ed754e2f090fd`, producing tested merge `edf9d327f65b8705528c699e833bfedc8b58394d`, tree `4b48e9be5fc57210bb3b54db2e096b28801f5d8d`. No conflicts, reset or rebase occurred.

The parent includes main `ff0bc4cda2db35cd014c6fcd31a3ffe659b12f17`, including PR126 ownership recovery, PR127 0.6.2, PR125 hub filtering and PR128 0.6.3 metadata/docs. Incoming 0.6.3 upgrade guidance and pending release policy remain intact. Production/test source equals the parent exactly; scripts/hub-browser.test.mjs is also identical. Harness scripts, resource workflow and historical raw archives are unchanged from 610c931. Only this receipt is added after testing.

Read the complete ownership-recovery guidance and PR125 five-file diff. Fresh fixture stores remain at their original canonical homes and use ordinary production enrollment/publication/reconciliation and worker APIs. No callback/API adaptation is needed. The suite does not authorize changed-anchor publication or call quarantine/fork as a repair shortcut. Missing-body repair removes only a synthetic receiver body; it does not establish ownership or restore old signing authority. All lifecycle exclusions, checked reaping, durable maintenance claims, under-mutation-lock validation, reader checks, crash regressions and durable-holder-before-request-clock correction are retained unchanged. Quarantine disables signing and clears saved networking; fork requires a new identity and peer coordination. Native macOS reboot/remount remains unproven.

PR125's shared renderer/client legitimately changes index, script, export and bundle bytes. Standalone HTTP benchmark routes and exact original-body checks remain applicable. Native requestSubmit GET, unsent query, fragment focus, history/shared URLs, JS-disabled forms, selected empty/unavailable distinctions and count/ARIA behavior are inherited, not replaced. HTTP timings alone cannot prove these browser behaviors.

## Granted checks

Grant `root-owner89-c4bd-integration-20261115-r1` started once at 03:20:43.787160 UTC, with 1200 application seconds plus 120 cleanup seconds. All checks ran once, admitted only with their complete cap remaining. No failed check was retried or assertion/bound changed.

Exact installed build runtime: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node`. PATH selected that executable for the existing scripts. Installed tsc-rs 0.7.0 launcher/package/resolver and native compiler hashes match owner88's installation; ncc is 0.44.1. Runtime binary hashes and compiler identities are retained in the raw provenance record. No install command was issued; the initial pnpm launcher output reported the existing lockfile up to date and dependencies already up to date. Subsequent build/bundle used COREPACK_ENABLE_NETWORK=0.

| Command | Cap | Result |
| --- | --- | --- |
| `pnpm typecheck` | 120 seconds | exit 0 |
| `pnpm build` | 120 seconds | exit 0 |
| `pnpm --filter html-inbox bundle` | 120 seconds | exit 0 |
| `python3 -m unittest discover -s scripts/bench -p 'test_*.py'` | 60 seconds | exit 0, 2 passed |
| Node 20.20.2 focused command below | 300 seconds | exit 0, 84 passed, 0 failed/skipped; 50.41 seconds |
| Node 24.19.0 focused command below | 300 seconds | exit 0, 84 passed, 0 failed/skipped; 40.22 seconds |

Each cap included GNU timeout's five-second final kill allowance: application commands used 115/55/295-second TERM deadlines respectively. Each focused command used its exact executable under `/home/agent/.local/share/fnm/node-versions/vVERSION/installation/bin/node` and these unchanged arguments:

```sh
--test packages/cli/dist/sync-maintenance.test.js packages/cli/dist/sync-acquisition-deadline.test.js packages/cli/dist/sync-protocol.test.js packages/cli/dist/sync-worker-runtime.test.js
```

The cleanup tests' synthetic timeout is intentional coverage. All other checks passed on their first execution. No full suite, sync-worker-integration reproduction, browser rerun, benchmark, one-document smoke, extra helper/reviewer or runtime installation was performed.

Scoped inherited evidence: parent b63 HTTP/deletion tests passed 18 each on Node20.20.2/24.19.0; hub browser tests passed 3 on Node24.19.0. Verified exact Git-object equality of source, relevant browser tests/fixtures, tsconfig and lockfile across b63, ff0, c4 and the tested merge, plus installed compiler byte equality. These receipts retain their original tested tree/tool context, not new executions or installed-package/native-Mac proof. The earlier 5a8 ownership-focused 245-pass receipt is separately historical.

## Generated outputs and cleanup

Before any build, copied and verified the complete current generated trees, independently of the cancelled-task backup: dist 391 entries and bundle 2, both present, no symlinks/special entries. Inventories include all entries, hashes, sizes, modes and mtimes. The new dist has 395 entries; the four additions are the .js/.d.ts files for sync-maintenance.test and sync-maintenance-crash-child. Bundle remains 2 entries. New built output was preserved in full, not overlaid onto historical emitted maps.

New bundle/index.js SHA-256: `aa0536e3d0daa9997114354612396ceca37c535f72884e190bb1f0b45c580831`. New canonical inventory digests: dist `22d01c5f449be2fd99e4e4ddd2c3e3c15a08987b52f0d4c14a666b869675a89a`, bundle `41a09ab39622da17cc8314952ebcfd5febc487a373075cdc952f1f6a933eecc9`.

All owned work joined before cleanup. No Node processes remained bound to this checkout; fixture logs report child reaping and port rebinds. Reverified the backups, preserved the new generated roots separately, then restored the complete pre-build state and verified exact inventory equality including modes/mtimes. Tracked checkout was clean at the tested merge after restoration. The restored outputs are intentionally historical and must not be mistaken for the new build. Local slot was explicitly released at 03:25:41 UTC, after 297.49 application seconds with 902.51 remaining, before extended reporting/commit/push. No unrelated/source changes were erased.

Raw logs, exits, once-set budget, compiler/runtime/source identities, original/new inventories and full saved trees, admissions and restoration receipt are in the owner checkout's ignored `artifacts/ownership-integration-c4bd-r1/`. This committed receipt preserves reproducible commands and outcomes without duplicating large evidence.

## Open gates and historical boundaries

Both parent full-suite history-gate failures remain unresolved: expected confirmed publication exit 0, actual durable-pending exit 2, foreground-deadline and unknown worker state. There is no cause, baseline, flaky-test or retry waiver. Original logs remain unaltered in root's `artifacts/performance-ownership-integration-2026-11-15/owner88-main-integration-r1/`: Node20 SHA-256 `8de21e1431e2e0b08dca49fc4711f10287b0df2e30eba05f85bf226f0408f07f`, Node24 `88c9a7c6c8281c326225ffca6d0ec45c138128234ecc0ae1a4624ba66f707f88`. Focused success does not close that shared gate. Final pushed-head CI is separately required.

Original measurements remain at clean `485273a2f7f20f604a2ae1e5e6a915396eba290e`; independent reviews remain at `d22e256799ba9767a813a29e4fc3a44191a30e38`, with their original dispositions/limitations. CI at 610c931 is historical. None certifies the integrated production source or implies a retrospective speedup. No new review agents were authorized. Root owns subsequent integration decisions; no performance merge, release, tag, publication, live inbox/service/route/report or PAM work occurred.
