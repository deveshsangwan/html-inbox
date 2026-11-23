# Round 3 qualification: #114 integration and teardown ordering

Linux, sequential, inside root-granted exclusive LOCAL slots. `round2/` and the original qualification are byte-unchanged. They qualify `b24927a` only.

## Revisions

| Commit | Content |
| --- | --- |
| `2fc4536` | Ordinary no-conflict merge of PR #114 head `08d5b2b` into `b24927a`. Source-only. |
| `05716ec` | `document-isolation-browser.test.mjs` registered `rm(home)` first. node:test runs after-hooks in registration order, so it removed the viewer home while the viewer and browser were live, then raw-closed the viewer without awaiting owned cleanup. Both fixtures now share `closeFixtureResources` / `startFixtureViewer`. |
| `b0c85f1` | Council round 1: caller-level isolation teardown test, `browserFailureCount` rename. |
| `5c49486` | Root review: the caller test drains collected hooks on setup failure, fails promptly when teardown settles before owned record removal, and retains failed-teardown evidence. |

Production code (`packages/cli/src/viewer-server.ts`) is unchanged since `b24927a`.

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

## Limits

- These runs are Linux only. Windows and macOS rely on hosted CI for the published head.
- The historical Windows EPERM, macOS deadline and Ubuntu queue-observation CI failures remain unexplained and unattributed.
- The c4 hosted failure and the shared history-gate failure remain separate.

`log-archives.json` in each directory lists every log's original bytes and SHA256 plus its gzip SHA256. Raw logs remain in the scratch run directories.
