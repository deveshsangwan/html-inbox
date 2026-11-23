# Listing integration, 15 November 2026

Related to [issue #91](https://github.com/deveshsangwan/html-inbox/issues/91) and [PR #116](https://github.com/deveshsangwan/html-inbox/pull/116). This receipt records source integration and scoped correctness checks. It makes no new performance or review claim. The PR remains draft pending final-head CI and root's shared gates.

## Source

Ordinary-merged only the authorized parent `08d5b2b056515ad876ac8aec2a164eea82050fa0`, producing tested merge `f2902d3db28003ab69bf1042e2a6fa62096783ad`, tree `cef4a452d17ae5f1f302aa4f391ec04b63a4d142`. Its parents are the original `52cdb70cc4a504fa8b983e6cdbcb23432d295592` and that exact incoming parent. No conflicts or listing adaptations occurred. Root verified all 35 own-layer blobs unchanged and all 29 incoming changed blobs equal the parent. The following commit adds only this receipt; source, tests and harness remain at the tested tree.

Preserved fa22/1bb/c4/ff0 ancestry, ownership recovery, merged 0.6.2/0.6.3 metadata/docs and PR125's native hub GET/query/focus/history/no-JavaScript/selected-empty-versus-unavailable/ARIA regressions. No reset, rebase, independent main merge or release-branch mutation occurred.

The ordinary backend retains eight fixed workers and eight shared permits, synchronous indexed claims, stable tie ordering, the first error and drain-before-release for workers and hardening siblings. Managed dispatch still precedes this pool and requires snapshot anchor/barrier/reader checks. Hub sources use `LocalDocumentSource`; the pool does not bound hub enumeration. Ownership/lifetime exclusions, checked reaping, bound maintenance claims, under-mutation-lock validators, quarantine/recovery reader checks and durable-holder-before-request-clock correction are inherited unchanged. Quarantine disables signing and saved controls; fork is a new identity requiring peer coordination. Native macOS reboot/remount remains unproven.

## Once-only granted checks

Grant `root-owner91-f2902-validation-20261115-r1` started once at 03:41:39.937897 UTC. Application budget was 1320 seconds plus at most 180 cleanup seconds, with fixed final deadline START+1500. Each complete command cap had to fit before admission; TERM deadlines left five seconds for final kill within each cap. All seven commands ran once, serially, without retries or changed assertions.

| Command | Runtime | Cap | Result |
| --- | --- | --- | --- |
| `pnpm typecheck` | 24.19.0 | 120 s | exit 0 |
| `pnpm build` | 24.19.0 | 120 s | exit 0 |
| `pnpm --filter html-inbox bundle` | 24.19.0 | 120 s | exit 0 |
| focused command below | 20.20.2 | 300 s | exit 0; 143 passed, no failures/skips |
| focused command below | 24.19.0 | 300 s | exit 0; 143 passed, no failures/skips |
| `node --test scripts/hub-browser.test.mjs` | 20.20.2 | 180 s | exit 0; 3 passed, no failures/skips |
| `node --test scripts/hub-browser.test.mjs` | 24.19.0 | 180 s | exit 0; 3 passed, no failures/skips |

Exact executables were `/home/agent/.local/share/fnm/node-versions/vVERSION/installation/bin/node`. Build PATH selected the exact 24.19.0 binary; `COREPACK_ENABLE_NETWORK=0` applied. Installed tsc-rs 0.7.0 launcher/package/resolver/native hashes and ncc 0.44.1 entry hash matched the parent's recorded tools. No install, bootstrap, full suite, benchmark, new test, reviewer or application retry was run.

```sh
node --test packages/cli/dist/backend-listing.test.js packages/cli/dist/storage-cleanup.test.js packages/cli/dist/local-document-source.test.js packages/cli/dist/sync-reader-compatibility.test.js packages/cli/dist/sync-store.test.js packages/cli/dist/sync-maintenance.test.js packages/cli/dist/sync-acquisition-deadline.test.js packages/cli/dist/hub-http.test.js packages/cli/dist/viewer-document-deletion.test.js packages/cli/dist/viewer-http.test.js
```

## Restoration and retained failed strict tool audit

Before builds, independently copied and verified the complete current generated roots, without relying on cancelled-task backups. Original dist has 393 entries; new dist has 397. Original/new bundle each has two. Full new outputs/maps were preserved separately. Original generated sets, types, bytes, modes and mtimes were restored exactly. Tracked source and semantic index remain clean. Joined command sessions and a checkout-bound Node/browser process audit found no survivors; fixture logs separately report owned cleanup. This is scoped evidence, not proof about every unseen process.

The original strict `tool_identity_exact` audit **failed and remains false**. Four `.bin` entries, the directory plus three wrappers, changed only mtimes with identical sets/types/modes/sizes/hashes. Their complete delta was preserved and only those verified original mtimes were restored under the grant. Four ncc data files additionally changed bytes and remain at their observed hashes:

| Under installed `@vercel/ncc/dist/ncc/` | Retained observed SHA-256 |
| --- | --- |
| `cli.js.cache` | `7e330e55a2fafdf4fbc223efad72546c464305251feda8586c8b9d6ec8553db3` |
| `index.js.cache` | `29271ba95bdf6854c201ef7a3e930022b9d10b3a12c1dcdae2e0f7061039f3e4` |
| `loaders/relocate-loader.js.cache` | `36bc7e9de614f10ccc078152eed6267927294b1d0ea338fec14d58ab638d6c0d` |
| `loaders/shebang-loader.js.cache` | `0c305eae44def1921c5a1599a59632d005ce03bfeef875f5b51b6fffea8a2a68` |

Root independently verified all 908 final recorded tool entries. Unchanged installed loaders identify these four files as generated V8 code-cache data: they read corresponding `.cache.js` sources, supply cached data to `vm.Script` and register exit writes using `createCachedData`. This classifies file purpose, not an independently traced write cause. Before-cache bytes were not fully backed up, only hashes/metadata; no original-cache-byte restoration is claimed. Root preserved exact current bytes additively. The remediation left the observed cache bytes in place: it did not erase, rewrite, reconstruct or rebaseline any cache. This does not mean the files were unchanged; their bytes had already changed as recorded above. All other inventoried tool source/runtime/metadata matches the original after the authorized `.bin` correction. Full tool state was not restored, and not all audits passed.

Root accepted LOCAL release and authorized publication of bounded correctness results with that failure retained. Application work settled after 320.21 seconds; cleanup finished after 55.90 seconds, total 376.11, before the fixed deadline. LOCAL was explicitly released before interpreting the delta. The original failure, raw maps/logs/exits and all corrections remain under the owner checkout's ignored `artifacts/ownership-integration-f2902-r1/`. The derived check-duration field initially used the admission offset with the wrong sign; corrected metadata and the original file are retained, without any command repeat. Root's initial read-only audit also misread a standalone Node-file map as a directory, stopped before writes, and corrected its data reader only.

Root audit SHA-256: `4d1d3a7bd3045e1d66ea1717cc9c94c67b4b79366989bda7cd8b5669a82e6eab`. Complete root disposition SHA-256: `c2529607ba25c5c5dfcde2fe8a907e28640d92f39474ccaa56aa617158affc66`. Those root receipts and additive retained cache bytes are under `artifacts/performance-ownership-integration-2026-11-15/` in the orchestrator workspace. Source/test/harness changes were not made to obtain publication permission.

## Evidence boundaries and open gates

Historical listing evidence remains pinned to base `610c931`, reviewed revision `427942f` and formatting follow-up `52cdb70`, with original limitations/dispositions. Neither old measurements nor old green CI qualify the integrated head or establish a new speedup. PR125 changes rendered HTML, so old HTTP hashes remain historical too. Companion BASE610 is unchanged; running it in a newer dependency tree would not reconstruct the exact old whole build. No rerun was performed.

The earlier local 5a8 history gate, expected confirmed exit 0 versus actual durable-pending exit 2, and c4 hosted queue-observation/replacement-foreground-readiness failures remain separate and unresolved. Parent 08d's 16 successful workflow jobs and these focused passes are not baseline reproduction or exoneration. Final pushed-head CI is independently required. No performance merge, release, tag, publication or live inbox/installed CLI/service/route/report/PAM access occurred.
