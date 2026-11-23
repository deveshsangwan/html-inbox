# Issue 88 integration receipt, 15 November 2026

Part of #88; [PR #113](https://github.com/deveshsangwan/html-inbox/pull/113). This is release-policy groundwork, with no optimization or new speedup claim. Runtime activation remains pending.

## Ancestry and resolution

Starting clean local head `1bbfc5970c5ddd1f9fe43e635ef1834529522fe1` already contained the preserved merge of ownership recovery `f14f2c8d89bb74385da9da6ba8537c0df1b5d720`. The previous published head was `1b2009132b8df184540c1990091fd1e9911dbb00`. No history was reset or rebased.

Merged main `5a8dba8b70dad0961010545433c8bffcb3c8d423`, retaining the merged 0.6.2 package, changelog and recovery guidance. Only README.md and packages/cli/README.md conflicted. Both now retain main's full 0.6.2 recovery paragraph and the pending 0.7/1.x paragraph with current version 0.6.2. The release-policy document's two current-version statements also became 0.6.2. Skill references needed no edit: the copies remain identical, their published/tested fallback stays 0.5.0, and modern routing remains pending.

While validation ran, the integration target advanced to `b63ac5aab82622b939251f8223897010fcf60211`, the merge of PR #125. The running suites settled before further source mutation. The 5a8 merge was committed as `fb8c9e11df7078059f47c9b1e0bd5ac77a6f3e89`, then exact b63 was merged without conflicts. This preserves the pending merge and its tested tree rather than rewriting it after the addendum.

The complete five-file PR #125 diff was read. The policy layer has no changes to its hub/filter call paths; final runtime source and scripts/hub-browser.test.mjs match b63 exactly. Inherited behavior retains immediate form.requestSubmit GET on filter change, unsent query text, native fragment focus, history/reload/shared URLs, JS-disabled Search/Enter, selected-source availability semantics and count/ARIA associations. No server/filter redesign or adaptation was needed.

Ownership runtime source also matches main exactly. Canonical home/dev/ino and reader identity, conclusive-death-only maintenance, lifecycle exclusions, checked reaping, durable claim bindings, transaction validators, reader checks, crash regressions and durable-holder-before-request-clock correction are inherited unchanged. Quarantine does not recover publication or signing under the former identity. Native macOS reboot/remount remains unproven.

## Validation and limitations

Linux, installed exact Node 20.20.2 and 24.19.0. Commands ran once, except an initial compiler command used the nonexistent node_modules/tsc-rs/tsc.js and failed before compilation. That setup log is retained; the corrected declared bin/tsc-rs launcher passed. No failed test was retried and no assertion, deadline or fixture was weakened.

The first group tested pending 5a8 merge tree `744220b71d4d941e52b91cf54c344faf16394477`, not b63:

| Check | Exit | Seconds |
| --- | --- | --- |
| `typecheck` | 0 | 0.43 |
| `build` | 0 | 0.72 |
| `policy` | 0 | 0.16 |
| `site-integrity` | 0 | 0.27 |
| `site-theme` | 0 | 0.27 |
| `ownership-focused` | 0 | 22.79 |
| `units-node20` | 1 | 469.36 |
| `units-node24` | 1 | 439.96 |

Exact commands: Node 24.19.0 `node_modules/tsc-rs/bin/tsc-rs -p packages/cli/tsconfig.json --noEmit`, then the same command without `--noEmit`; `node --test scripts/release-policy.test.mjs`; `node scripts/verify-site.mjs`; `node --test scripts/site-theme.test.mjs`; `node --test packages/cli/dist/{sync-maintenance,sync-acquisition-deadline,sync-ownership-publication,sync-ownership-worker,sync-shutdown-ownership,viewer-ownership}.test.js`. These passed, including 245 focused tests, 4 policy tests and 9 theme tests. Each full suite used the indicated exact Node executable with `scripts/run-unit-tests.mjs`, capped at 600 seconds.

Both full suites failed the same `sync-worker-integration.test` case, "recoverable history gate": expected confirmed publication exit 0, received durable-pending exit 2 with reason foreground-deadline and worker process state unknown. Node 20: 1,361 passed, 1 failed, 2 skipped. Node 24: 1,360 passed, 1 failed, 3 skipped. Cause is unresolved; no base reproduction or pre-existing/flaky claim is made. The test and production deadline remain unchanged. These failures are a validation gap and need coordinated investigation before an integration recommendation.

The second group tested pending b63 merge tree `7cb4d2f57168f68b9c307ed75353323f0b064175`:

| Check | Exit | Seconds |
| --- | --- | --- |
| `b63-typecheck` | 0 | 0.76 |
| `b63-build` | 0 | 0.88 |
| `b63-policy-site` | 0 | 0.32 |
| `b63-http-node20` | 0 | 3.23 |
| `b63-http-node24` | 0 | 2.68 |
| `b63-hub-browser` | 0 | 5.46 |

Commands: repeat exact typecheck/build above, then Node 24 `--test scripts/release-policy.test.mjs scripts/site-theme.test.mjs` (13 passed); each exact runtime `--test packages/cli/dist/hub-http.test.js packages/cli/dist/viewer-document-deletion.test.js` (18 passed each); Node 24 `--test scripts/hub-browser.test.mjs` (3 passed). Browser coverage includes immediate filter submission, focus/query/history/shared URL behavior and JS-disabled submission. Full suites were not repeated on b63. No exact-package smoke, broad browser suite, benchmarks, native macOS or Windows local tests ran in this grant.

Original reviews at `8b9fbb4` and CI at `1b20091` remain historical evidence. They do not certify this new integrated revision. No new review agents were authorized. The original performance evidence is preserved; no new-head speedup claim follows from these checks. PR stays draft pending root's handling of failures, final-head CI and integration gates.

## Budget and cleanup

Grant root-owner88-main-integration-20261115-r1 retained its conservative start 02:49:30 UTC, application deadline 03:19:30 and cleanup deadline 03:21:30, with no extension for b63. Checks finished around 03:07:43. Compiler/build caps were 120 seconds, focused caps 300, full caps 600. Only disposable fixture stores/processes/endpoints were used.

The cancelled task's generated-before backup was verified as an empty tar and empty hash map, matching absent dist/bundle before this build. Current absence was separately recorded. After checks, no Node process remained bound to this checkout; generated output was restored to the original absent state. Fixture logs report owned children reaped and ports rebound, and browser/HTTP cleanup settled. Local slot was explicitly released to root before extended reporting. No installed CLI, service, real inbox, report, route or PAM access occurred.

Raw commands, exact timestamps, exit codes, both full-suite logs, compiler launcher error, b63 logs and cleanup records remain in the root-coordinated artifact directory `artifacts/performance-ownership-integration-2026-11-15/owner88-main-integration-r1`. This committed receipt preserves the outcomes and reproduction commands independently of those local raw logs.

## 0.6.3 metadata integration follow-up

Merged exact main `ff0bc4cda2db35cd014c6fcd31a3ffe659b12f17` into preserved head `b18acfd00f29236f71614ca7b8653d25285e0680`. The full eight-file b63..ff0 delta was read: only documentation and package metadata changed; runtime source and scripts did not. README.md and packages/cli/README.md conflicted at the introduction. Both resolutions retain the complete incoming 0.6.3 filter/restart paragraph, existing 0.6.2 recovery limits and pending 0.7/1.x policy. Current-version wording in these two READMEs and docs/release-policy.md now says 0.6.3. Incoming package 0.6.3, changelog, named-inbox, releasing and site documentation remain intact. Skill fallback stays 0.5.0; no runtime activation or publication occurred.

Grant `root-owner88-release063-integration-20261115-r2` started once before the first check, with 180 seconds for application and 60 for cleanup. On resolved staged tree `4063959247cb8726e1978e6e53669f458fc6cc5d`, the exact installed `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node` ran these commands once, each with a 30-second cap:

- `--test scripts/release-policy.test.mjs`: exit 0, 4 passed.
- `scripts/verify-site.mjs`: exit 0, 15 pages passed.
- `--test scripts/site-theme.test.mjs`: exit 0, 9 passed.

All completed in under one second combined. Generated dist/bundle remained absent; these checks launched no application/browser fixture processes. The slot was promptly released before reporting. No compiler, build, install, version probe, app, browser, package, full suite, benchmark or retry command ran under this follow-up grant. Raw timestamps, exact commands and exit codes are retained in the root-coordinated `artifacts/performance-ownership-integration-2026-11-15/owner88-release063-r2` budget/checks/cleanup JSON and logs.

Runtime source remains exactly ff0/b63, and the entire scripts tree is unchanged from b18. Earlier 5a8 full-suite failures, b63 targeted passes, launcher error, historical review pins and their limitations above remain original evidence. Passing documentation/policy checks do not resolve the history-gate failure, supply baseline execution, requalify runtime behavior or establish a speedup. PR remains draft for root-coordinated diagnostic and final-head gates; release/0.7 is left untouched.

## Hosted CI diagnosis at c4bd, 23 November 2026

Two Verify runs tested the same tree, `3d3cd370ba91b15648382e0327858f5555c21ad7`, on the same runner image (ubuntu-24.04 `20261111.370.1`) and Node 20.20.2. The PR #113 merge ref `a973c30` has the same tree as head `c4bdc98` because the branch was not behind main. [Pull-request run 43671475355](https://github.com/deveshsangwan/html-inbox/actions/runs/43671475355) passed every job; its Ubuntu Node 20 shard 2/2 reported 658 tests, 657 passed and 1 skipped. [Push run 43671738643](https://github.com/deveshsangwan/html-inbox/actions/runs/43671738643) on `release/0.7` failed the same shard with 655 passed, 2 failed and 1 skipped. The aggregate Verify job then failed only because a source job had failed. Every job was a first attempt, and none was rerun.

All three failing tests live in `packages/cli/src`, which is byte-identical to main `ff0bc4c`. This PR changes release policy, workflows, documentation and one archive engine assertion only. The failures belong to the shared sync layer. They remain unresolved here, with their original assertions; nothing is waived, retried or classed as a flake.

Durations were compared by matching test names across the two shard logs, using tests over 50 ms in the green run: 359 pairs, median red/green ratio 0.88. Reviewers recomputed 0.887 and 0.89 with slightly different pairing rules. So the failing shard was not generally slower. Several ownership and fsync-heavy tests were outliers, for example "queued managed deletion rechecks barrier under actual ownership" at 1,891 ms against 89 ms. TAP output times show when results were reported, not that these tests overlapped, so the logs cannot establish a shared I/O stall.

The original sync owner reviewed these cases on `45d92ba` and agrees with the boundaries below. They name no confirmed cause.

1. **Late pin.** "late pin remains independent while a genuinely queued server watcher drains" took 4,480 ms against 808 ms. It missed `reached(..., 3000)` for "real server watcher entered queue". The test starts `pullBody` before the wait. Before the watcher can be enqueued, the window includes client admission (`sync-client.ts:97`: the receiver's `openRouteAttempt` and `startCommunication`), TLS, server admission (`authenticate` → `startCommunication` and `openRouteAttempt` → `startCommunication`, each a managed lock acquisition) and the first 50 ms tick. The server was started with `requestMs` 1000, and three 1-second bounds apply before the 3-second wait: the per-socket destroy timer and `server.setTimeout` (`sync-http-server.ts:87`, `:90`), and the `authenticate` deadline (`:199`). An admission stall past 1 second fails as `403 unauthorized`, or destroys the socket. Either way the handler closes the attempt and its watcher before any enqueue, and `assert.rejects` accepts the rejection. The log shows only the missed predicate, so it cannot place the delay on the client, in TLS or on a server lock.
2. **Restarted foreground.** "ready retained real foreground CLI cuts its next empty mutation candidate" failed in the replacement child. The first child became ready, created an empty candidate, was SIGKILLed and reaped, and its ports rebound. The replacement exited with "Managed store lock deadline exceeded; unknown or live owners are never stolen". All managed acquisitions share that message, so it names no lock. The test's 3,978 ms total excludes the 10-second startup-exclusion and store-lock defaults. The remaining one-second ownership deadline on that path is production `sync-worker.ts:90`, `acquireSyncOwnership(paths.lifetime, Date.now() + 1000)`; `sync-maintenance.ts:102` uses the same one-second lifetime deadline. That budget covers candidate creation and fsync, any reaping of the killed predecessor's lifetime lock, and the final `checkAcquisition` after link and flush (`sync-files.ts:323`). Which phase used it is unmeasured. The production cause remains unknown; if the lifetime lock is confirmed, a crash restart can fail on slow storage.
3. **History gate.** Locally on tree `744220b7`, Node 20 (13.88 s) and Node 24 (12.57 s) each saved durably but exited 2 with `foreground-deadline`, where 0 was expected. The case passed in both hosted shards (8.11 s on Ubuntu Node 20). [PR #116's Node 24 job 137772353081](https://github.com/deveshsangwan/html-inbox/actions/runs/45197662958/job/137772353081) independently observed the same pending/exit 2 result. `sync-publication.ts:41` sets `deadlineAt = committedAt + waitMs`, and the test passes `--wait-ms 5000`. The first inspection then runs against `finishAt`, up to 250 ms earlier. The test's `observeFirstDelivery` holds that inspection while the parent runs the receiver's separate `html-inbox sync worker enable` CLI (`sync-worker-integration.test.ts:207`), so fixture startup definitely runs inside the publication budget. Both local logs then print "Saved locally. Waiting for intended peer". The code emits that only after the hold returns and while time remains, so the remaining budget was later used by worker verification, contact, the history handshake, reconciliation or receipt observation. How much each phase contributed is unmeasured.

Root routed distinct test-only proposals for cases 1 and 3, and a diagnostic-only proposal for case 2, to the sync owner. No runtime grant exists for those diagnostics yet. Case 2 needs explicit review of both one-second lifetime deadlines. Case 3's fix must keep `--wait-ms` and the strict exit-code assertion. On main, the Windows push run [43668402490](https://github.com/deveshsangwan/html-inbox/actions/runs/43668402490) at `f14f2c8d` failed a different test, "independent public deleters coordinate real child processes", with `EPERM` on rename. It is a separate failure and is not evidence for these cases.

Since the earlier sections: commit `45d92ba` replaced the "0.6.3" current-version wording in both READMEs and `docs/release-policy.md` with the 0.6.x line. Root fast-forwarded `release/0.7` to `c4bdc98`. Raw logs, their hashes and the duration comparison are in the root-coordinated `artifacts/performance-ownership-integration-2026-11-15/owner88-ci-c4bd` and `owner88-council-2026-11-23` directories.
