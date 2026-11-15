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
