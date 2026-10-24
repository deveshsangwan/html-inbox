# Fatal worker shutdown assessment

Read-only Codex gpt-6-astra assessment, task phase2-qa-worker-fatal-contract-20261024-a. This is design evidence, not independent implementation review or test credit. The coordinator accepted the finding and recorded the separate source gate before dispatching its writer.

**Quiet exit 0 is an actionable contract gap.** Stopping on unsafe ledger state is correct; reporting that stop as successful is not. The original requirement combines visible failure states with independent worker operation, and the accepted supervisor contract explicitly restarts unsuccessful exits. Documentation of the objection does not waive those requirements. See [required-contracts.md:5](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/docs/phase2-sync/required-contracts.md:5) and [worker-cli-contract.md:70](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/docs/phase2-sync/worker-cli-contract.md:70).

This should be a separately scoped coordinator correction. The ledger reader author correctly respected the frozen exclusion of worker/CLI changes in [qa-ledger-read-contract.md:17](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/docs/phase2-sync/qa-ledger-read-contract.md:17).

The evidence supports a narrow finding:

- The copied native trace records an unchanged `nlink: 0` observation, snapshot rejection, worker closure and exit 0 after 48.21 seconds. That worker remained stopped. The replacing actor and contemporaneous canonical inode were not captured, so this does not independently establish every safe-replacement condition. See [native report](/home/agent/programming/html-inbox-qa-evidence-20261024/workers/qa004-stat-repro-d3/qa004-stat-report.md).
- The parent’s actual symlink negative control, recorded in [qa-followup.md:36](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/docs/phase2-sync/qa-followup.md:36), establishes unchanged unsafe-path behavior: no unsafe open, unchanged target, quiet exit 0. I did not rerun it.
- The source explains that outcome: the [timer catch](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/packages/cli/src/sync-worker.ts:139) discards the failure and invokes `close()`. The [foreground CLI](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/packages/cli/src/sync-cli.ts:264) has already returned readiness and has no later failure notification.

I recommend one additive production option, `onFatalStop?: () => void`, on `startOwnedSyncWorker`. Keep the existing return shape and `close(): Promise<void>`. A no-argument notification prevents accidental exception/path disclosure and avoids inventing a failure taxonomy.

Its concrete behavior should be:

1. **Latch unexpected fatal failure once**, initiate the existing shutdown, and notify without waiting for cleanup. Concurrent failures must not duplicate notification. A throwing observer must not interrupt cleanup.
2. Use that path for the timer’s rejected state read and unexpected cleanup rejection. Preserve successful deliberate shutdown for authenticated stop/disable, SIGINT/SIGTERM, validated configuration/incarnation replacement and temporary-runtime completion.
3. Keep ordinary route failures in existing persistent blocked/backoff handling. In the [outer drain catch](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/packages/cli/src/sync-worker.ts:193), preserve the existing recoverable `worker-pass-failed` bookkeeping, but replace its suppressed bookkeeping rejection with fatal shutdown. Do not await shutdown from inside `draining`: `close()` awaits that same promise.
4. Observe every internal `close()` rejection, including signal, lifecycle-change and control-stop paths. Preserve rejection for callers that explicitly await `close()`. Replace the existing library-level signal-handler `process.exitCode` assignment with this notification.

At the CLI boundary, emit exactly one fixed stderr diagnostic, for example:

`html-inbox: Sync worker stopped after an unrecoverable state or cleanup failure; inspect the inbox before restarting.`

Set exit status 1 there, without `process.exit()`. Do not append the exception, stack, home, credential reference or control record. Install the callback when creating the runtime, before readiness. Apply equivalent fatal-result handling to the temporary `sync run` runtime so automatic shutdown cannot become a successful ticket or ordinary deadline-pending result.

The existing output plumbing suffices. Detached startup already redirects stderr into the private [worker log](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/packages/cli/src/sync-worker-client.ts:160); [supervisor definitions](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/packages/cli/src/sync-supervisor.ts:54) capture stderr and use failure-based restart. Neither needs a new policy or production edit.

An unsafe authoritative ledger cannot safely hold its own newly persisted failure record. Preserve existing durable blocked states where validated writes are possible; use the existing log and unsuccessful process status for this fail-closed boundary. Do not claim a new durable ledger status or guaranteed recovery from corruption.

Cleanup needs particular care. [Current `close()`](/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync/packages/cli/src/sync-worker.ts:370) stops at its first rejected cleanup operation. Setting exit status alone will not terminate a process with a remaining listener. Attempt independent listener cleanup despite earlier failure, preserve ownership checks, and do not release lifetime ownership while replication work can still run. Retain uncertain ownership artifacts rather than deleting them speculatively. Startup cleanup must also release its startup exclusion despite another cleanup rejection.

The disjoint production scope is `packages/cli/src/sync-worker.ts` and `packages/cli/src/sync-cli.ts`. Add a dedicated fatal-lifecycle test file and, if necessary, a test-only child helper. Coordinator documentation updates belong in `worker-interface.md`, `worker-cli-contract.md`, `worker-operations.md` and `qa-followup.md`. No ledger, wire or runtime-record schema change is needed.

The meaningful test gate is:

- **Actual foreground CLI:** introduce a real unsafe symlink after readiness. Require exit 1, exactly one sanitized diagnostic, zero unsafe opens, unchanged target, terminated child and rebound control/ingestion ports.
- **Library:** notification occurs once across racing tick/drain/close failures; omitting it causes no process-exit side effect; explicit `close()` still rejects on cleanup failure. No unhandled rejection, leaked listener or drain/shutdown deadlock.
- **Failure bookkeeping:** inject a drain failure plus failed error persistence. Require fatal handling. A recoverable pass failure with successful persistence retains its existing behavior.
- **Normal lifecycle:** successful stop, disable, signals, configuration/incarnation replacement and temporary completion retain successful shutdown without fatal diagnostics. Pause, cancellation, removal and persistent route blocks must not become process failures.
- **Existing correction:** proven benign replacement retains the same worker identity and subsequent custody/empty-outbox repair. Unsafe samples remain fail-closed.
- **Detached/supervised boundaries:** actual detached logging captures the diagnostic; a disposable failure-sensitive supervisor distinguishes exit 1 from deliberate exit 0. Existing viewer lifecycle remains independent.

Run those on Node 20 and 24, then the required combined checks and fresh correction reviews. This assessment performed reads only; it supplies no implementation, test result, reviewer credit or readiness claim.
