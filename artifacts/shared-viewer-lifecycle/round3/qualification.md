# Round 3 qualification: #114 integration and teardown ordering

Linux, sequential, inside root-granted exclusive LOCAL slots. `round2/` and the original qualification are byte-unchanged. They qualify `b24927a` only.

## Revisions

| Commit | Content |
| --- | --- |
| `2fc4536` | Ordinary no-conflict merge of PR #114 head `08d5b2b` into `b24927a`. Source-only. |
| `05716ec` | `document-isolation-browser.test.mjs` registered `rm(home)` first. node:test runs after-hooks in registration order, so it removed the viewer home while the viewer and browser were live, then raw-closed the viewer without awaiting owned cleanup. Both fixtures now share `closeFixtureResources` / `startFixtureViewer`. |
| `b0c85f1` | Council round 1: caller-level isolation teardown test, `browserFailureCount` rename. |
| `5c49486` | Root review: the caller test drains collected hooks on setup failure, fails promptly when teardown settles before owned record removal, and retains failed-teardown evidence. |
| `e18a268` | Evidence for runs A and B. |
| `0463edb` | Council round 2: start-lock release inside the rollback boundary, caller-test root-removal observation, accurate retention diagnostic, startup cause kept with a server close failure. |

Production code (`packages/cli/src/viewer-server.ts`) is unchanged from `b24927a` through `e18a268`; `0463edb` changes only its start-lock release.

## Run A: `05716ec` (slot pr120-05716ec-qualification-20261123)

Directory `05716ec/`. Application time 700.2s.

- Node 24.19.0 typecheck: exit 0. Build: exit 0.
- Focused (8 files): Node 20.20.2 72/72 pass, Node 24.19.0 72/72 pass.
- Ownership (sync-maintenance, sync-acquisition-deadline, viewer-service-owner, viewer-service, hub-http): 85/85 on each runtime.
- Full Node 24 `pnpm verify`: TIMEOUT at its 600s cap, inside source unit tests. Before the cap it recorded six failures, all in sync suites that this layer's diff does not touch:
  - actual admitted run with held ACK SIGINT cancels its HTTPS attempt
  - actual admitted run with held ACK allows exact-ticket positive cancellation
  - successful push and pull sessions release capacity across more than eight multiroute passes
  - real HTTPS history times out with retained authority
  - explicit retry resolves a rotated route after an unrelated reconciliation already entered the pass
  - listening receiver admits new inbound route and rotates revision credentials without a manual worker restart

  These are recorded, not attributed or classified. Verify's browser, site and package stages were UNRUN at `05716ec`.
- Cleanup: dist and bundle (393 files) were restored hash-equal. The verify timeout's session kill left one detached fixture `sync worker start --foreground` (pid 1982270) under the run's isolated TMPDIR. It was stopped manually with SIGTERM after re-checking its argv, and exited. The cleanup.json leftover list also names two unrelated agent processes whose cwd was the worktree. They were not signalled.
- The runner's final gzip step raised a TypeError (`gzip.open` has no `mtime`). A separate script then archived the logs losslessly. `runner.py` is the patched copy.

## Run B: `5c49486` (slot pr120-5c49486-focused-20261123)

Directory `5c49486/`. Runner exit 0, no problems recorded. Application 140.8s, cleanup 0.1s within its deadline.

- Node 24.19.0 typecheck: exit 0. Build: exit 0.
- FIFO after-hook probe (`fifo-probe.mjs.txt`): exit 0 on both runtimes. Observed order `[first-registered, second-registered]` on 20.20.2 and on 24.19.0.
- Focused (11 files: the run A set plus viewer-background, viewer-record-shutdown-race and hub-browser): Node 20.20.2 90/90 pass, Node 24.19.0 90/90 pass.
- Ownership: 85/85 on each runtime.
- Red overlay (`red-overlay.mjs.txt`, which restores the pre-`05716ec` wiring around the new caller test) on Node 24: native exit 1, one failure, `AssertionError: isolation home removed before owned viewer cleanup completed`. RED-CONFIRMED.
- Full browser suite on Node 24 (`scripts/run-browser-tests.mjs`), admitted only after every control above passed: 86 pass, 1 skip (opt-in live CDN check), 0 fail.
- Full `pnpm verify`: not replayed, per root instruction.
- Cleanup: quiescent. No run-scoped processes were discovered, joined or preserved. dist and bundle were restored hash-equal. The overlay was removed by content hash. Worktree clean at `5c49486`.

Detached-fixture handling in run B: the `/proc` scan is discovery only. Each candidate is pinned with a pidfd, and its argv, cwd and kernel start time are re-verified on that handle. It is matched to the exact owned worker shape, stopped first with `sync worker stop --home`, and only then sent SIGTERM and SIGKILL through the same pidfd. Anything uncertain halts admissions and retains roots.

## Council round 2 fixes (`0463edb`)

- `startViewerLifecycle` released its start lock in an outer `finally`. A release failure after readiness therefore rejected the call with both listeners live, the record written, and no close handle. On the failure path, the release error also replaced the startup cause. The lock is now released, through a memoized release, as the last step inside the existing rollback boundary, so a release failure stops the viewer through the existing rollback. A distinct release failure is aggregated with the startup cause. `ensureViewer` and `stopViewer` lock handling is unchanged.
- The caller test observes the actual root `rm` call against completed owned record removal, names which side settled first, and reports retention only when the home still exists.
- `closeFixtureResources` keeps a viewer startup cause when a plain server also fails to close.

## Run C: `0463edb` (slot pr120-0463edb-focused-20261123)

Directory `0463edb/`. Runner sha256 `16963acb14f21847c307141aea24a854ae5af81f49ff59860a2f5e65db7ea704`, exit 0, no problems recorded, single run. Application 141.9s, cleanup 0.1s.

- Node 24.19.0 typecheck: exit 0. Candidate build: exit 0.
- Disposable negative control: `git archive 0463edb tsconfig.base.json packages/cli` was extracted into the run directory, with only `src/viewer-server.ts` replaced by the `5c49486` blob, then built with tsc-rs into the copy's own dist (exit 0). The tracked candidate source was only read and was verified unchanged. The candidate's lock tests from that copy (`--test-force-exit`) exited 1 with 2 of 2 failing:
  - `live viewer record survived a start-lock release failure`
  - `start-lock release failure replaced the startup cause`

  RED CONFIRMED. Scope: the mock releases the real lock and then throws, so this covers a release reporting failure. It does not cover a lock file left behind.
- FIFO probe: exit 0 on 20.20.2 and 24.19.0. Order `[first-registered, second-registered]` on both.
- Focused (11 files, including both lock tests and their port rebinds): 92/92 on 20.20.2 and 92/92 on 24.19.0.
- Ownership: 85/85 on each runtime.
- Isolation overlays on Node 24, all native exit 1 with the named failure, CONFIRMED:
  - Old wiring: `isolation home removed before owned viewer cleanup completed (teardown entered first)`. The diagnostic reports the home as already removed.
  - Settles-first, where teardown skips owned viewer close (`--test-force-exit`, viewer deliberately leaked): the same assertion with `(teardown settled first)`.
  - Setup-failure, which throws after the viewer is live (no force-exit; it exited naturally): `injected isolation setup failure after viewer start`, plus `Viewer … stopped (reader-close)` from the drained teardown, and no setup-plus-teardown aggregate.
- Process-cleanup and port-rebind evidence comes from the ordinary focused runs, not the forced-exit controls.
- Full browser suite on Node 24, admitted after every control passed: 86 pass, 1 skip (opt-in live CDN check), 0 fail.
- Full `pnpm verify`: not replayed.
- Cleanup: quiescent, with no run-scoped processes. dist and bundle restored hash-equal, overlay absent, worktree clean at `0463edb`.

## Limits

- These runs are Linux only. Windows and macOS rely on hosted CI for the published head.
- The historical Windows EPERM, macOS deadline and Ubuntu queue-observation CI failures remain unexplained and unattributed.
- The c4 hosted failure and the shared history-gate failure remain separate.

`log-archives.json` in each directory lists every log's original bytes and SHA256 plus its gzip SHA256. Raw logs remain in the scratch run directories.
