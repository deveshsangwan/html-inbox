# Formatter integration with the updated compatibility parent

PR [#115](https://github.com/deveshsangwan/html-inbox/pull/115), related to [#90](https://github.com/deveshsangwan/html-inbox/issues/90). This receipt records source integration and focused correctness checks, not a new performance measurement or readiness approval.

## Source pins and resolution

Tested candidate: `6fcd5e81b7181f3fcd44102cbf78f2ee6aef7dd6`, tree `ac4012ae41a220fdf152b87707be511b0e2cadd1`. Its ordinary merge parents are previous owner head `9f21a8dc1f1f4c7ac6e3b685e47078fbabe35cf6` and incoming `release/0.7` at `c4bdc98b91acc15fa67ecf5fdc2ed754e2f090fd`. The parent contains main `ff0bc4cda2db35cd014c6fcd31a3ffe659b12f17`, including PRs #126, #127, #125 and #128. Incoming 0.6.3 metadata and the 0.6.2 ownership-recovery guidance remain intact. No publication, release or performance merge was performed.

There was one conflict, in `viewer-render.ts` at the `renderLibrary` setup block. The resolution keeps PR #125's selected-source availability, escaped named empty title, publish target, document count and aria associations, then creates exactly one lazy formatter closure before rendering documents. One-argument date calls, the document-shell closure and invalid-date-before-Intl construction remain. The incoming native GET `requestSubmit()` and `#inbox-filter` focus behavior, client/HTTP/deletion/browser files and ownership code are unchanged from the parent. Neither whole-file side was selected.

The existing construction-bound test gained one combined assertion. It covers an empty selected inbox with an unrelated unavailable source, escaped selected-name text and help/count/empty aria references, then an actually unavailable selected source. Both render with an invalid timezone and must construct zero date formatters. Existing date, timezone, static UTC and populated-render bounds remain covered.

## Granted validation

Grant `root-owner90-6fcd-validation-20261115-r1` authorized one sequential run. `COREPACK_ENABLE_NETWORK=0` was set throughout; the existing pinned tools were used. No explicit install, full suite, package smoke, benchmark, reviewer or CI retry was run. Node 24's installation directory headed PATH for the two pnpm commands. Each test command used its absolute requested Node executable, with concurrency one.

The grant's START, application and fixed-final monotonic values were set once before admission/build: `1431460.281804608`, `1432660.281804608`, `1432780.281804608`. Caps were 120/120/300/300/300/300 seconds and each complete cap fit the remaining application budget. GNU timeout reserved five seconds for forced shutdown within each cap, using TERM at 115 or 295 seconds and `--kill-after=5s`. All six commands exited zero, once each. No cap expired and no command was retried or left unrun.

| Command | Runtime | Result |
| --- | --- | --- |
| `pnpm typecheck` | 24.19.0 | Exit 0 |
| `pnpm build` | 24.19.0 | Exit 0 |
| Six compiled files below | 20.20.2 | 42 passed, 0 skipped, exit 0 |
| Six compiled files below | 24.19.0 | 42 passed, 0 skipped, exit 0 |
| Three browser files below | 20.20.2 | 19 passed, 1 skipped, exit 0 |
| Three browser files below | 24.19.0 | 19 passed, 1 skipped, exit 0 |

The only browser skip on each runtime was the opt-in live CDN test. Local deterministic CDN fixtures ran. The new hub immediate-filter/query/history/focus/JavaScript-disabled regressions and local/static date-localization tests passed.

Absolute runtime paths were `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node` and `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node`. For each runtime, the complete test argv after that executable was:

```sh
--test --test-concurrency=1 packages/cli/dist/viewer-render.test.js packages/cli/dist/static-export.test.js packages/cli/dist/viewer-http.test.js packages/cli/dist/hub-http.test.js packages/cli/dist/viewer-document-deletion.test.js packages/cli/dist/sync-reader-compatibility.test.js
--test --test-concurrency=1 scripts/viewer-browser.test.mjs scripts/hub-browser.test.mjs scripts/sync-reader-browser.test.mjs
```

Complete outputs, argv, caps and admission timestamps are under `artifacts/owner90-6fcd-validation-r1/` in the owner checkout. The `seconds` fields in `checks.json` are derived from recorded start timestamps and exit-file mtimes; they are not performance measurements. TAP durations retain their original test-runner meaning.

## Restoration failure, correction and bounded acceptance

Fresh full generated backups were verified before building. Original `dist` had 393 entries; built and after-work `dist` had 397. Original `bundle` had two entries and was not rebuilt by this grant. Full before/built/after-work maps and bytes are retained. Both generated directories were restored to their original sets, types, bytes, modes and mtimes.

The original final audit nevertheless **FAILED**, exit 1. Its exact tool error was:

```text
Traceback (most recent call last):
  File "<stdin>", line 44, in <module>
AssertionError
```

The failed assertion compared the before-map of `node_modules/.bin` with its current map. Source/index checks preceding it had passed. Only mtimes differed for the wrapper directory and `ncc`, `playwright` and `tsc-rs`; recorded sets, types, modes, sizes and hashes were identical. No independent causal proof identifies which operation changed those timestamps. Tool invariance is qualified to this recorded wrapper inventory, not the full dependency tree.

A premature release-success message was withdrawn immediately after inspecting the tool result. It remains withdrawn; the original audit is not retroactively passed. The original failure and before/after tool maps remain preserved in `original-restoration-audit-failure.txt`, `audit-failure.json` and `tool-audit-deltas.json`.

Only verified-identical wrapper/directory mtimes were restored from the before-map. The correction finished at monotonic `1431711.766237407`, 37.295108 seconds before the unchanged shorter cleanup boundary `1431749.061345385`, which was `min(fixed final, work settled + 120)`. No deadline extension or runtime retry occurred. LOCAL was explicitly released before detailed classification and has passed to another owner. Publication was held until root independently verified the generated maps, wrapper map, source and semantic index and accepted the corrected result.

The owner process scan found no new observed node/chrome runtime whose cwd matched the candidate checkout. This is limited to the selected executables, new PIDs and readable `/proc` evidence. It is not universal process-cleanup proof, native platform qualification or an independent port audit. Only disposable fixture stores/processes/endpoints were exercised.

## Audit references and remaining gates

The shared artifact directory is `/home/agent/programming/html-inbox/artifacts/performance-ownership-integration-2026-11-15/`:

- `owner90-6fcd-validation-grant.json`: SHA-256 `0dd6d3047df0d96d3d8bbe52ba840e05e3f1de0f174be96c6016c05ad36fbc9e`.
- `owner90-6fcd-source-review.json`: SHA-256 `767054f25f8da87b6ed51328c37761c5fa2f5c748c48083ebbc6449e41fa3973`.
- `owner90-root-restoration-audit.json`: SHA-256 `98f080e2c567427bfe81fd2bfc67f6e910dc49956c33bfc712728fa931ac3c71`.
- `owner90-corrected-release-root-disposition.json`: SHA-256 `51784090b71da80964c22fb5800af78480885dfe54f566924cc50f5e4d3ade95`.

The original benchmark report, raw JSON, harness and browser test blobs remain unchanged from `9f21a8d`. Original measurement pins and independent reviews at `b3d3eaf` remain historical evidence for those revisions. This integration was not benchmarked or freshly independently reviewed; root accepted the source resolution for focused validation. No new-head speedup is claimed. The receipt-only publication commit has the same source and test tree as tested `6fcd5e8`.

These focused successes do not waive or explain the separate local 5a8 history-gate pending-2/exit-2 failure, the c4 push-CI run `43671738643` Ubuntu 20 queue-observation and foreground startup-lock failures with aggregate Verify failure, or older failure/retry limitations. Parent PR #114's later successful workflow jobs at `08d5b2b` do not explain those failures. New published-head CI and root readiness/integration decisions remain separate gates. PR #115 stays draft; no merge or release.

## Correction, 23 November 2026

Council round 1 found two overstatements in this receipt. First, "client/HTTP/deletion/browser files … unchanged from the parent" applies to the incoming hub and filter coverage only. This PR's own diff adds the date-localization test to `scripts/viewer-browser.test.mjs`. Second, "static UTC … remain covered" was wrong. The unit test passed `timeZone: "UTC"` directly, and the browser test inspects dates after the client rewrites them, so nothing caught the static exporter dropping that option. `packages/cli/src/static-export.test.ts` now exports a real snapshot under a non-UTC process timezone and checks UTC text in the index and document shell. The original text above is kept as recorded.
