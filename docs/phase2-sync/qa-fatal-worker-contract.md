# Fatal worker shutdown correction gate

This separately scoped gate closes the quiet-success objection retained by the ledger-read correction. It does not amend the frozen ledger-reader gate or authorize retrying unsafe files. An independent read-only assessment accepted the objection against required-contracts.md and the failure-sensitive supervisor contract in worker-cli-contract.md. The ledger author correctly left worker and CLI behavior unchanged within its earlier scope.

## Interface and behavior

Add only `onFatalStop?: () => void` to the options of `startOwnedSyncWorker`. Preserve its return shape and `close(): Promise<void>`. Notification carries no exception, path, credential, identity, control record or new failure taxonomy. The reusable library must not change process exit status.

Latch unexpected fatal failure once, initiate shutdown and notify without waiting for cleanup. A throwing observer cannot prevent cleanup. Concurrent timer, drain and close failures cannot duplicate notification. Observe every internally initiated shutdown rejection. Explicit callers awaiting `close()` must still receive cleanup rejection.

Fatal paths include rejected timer state reads, unexpected shutdown cleanup failure, and failure to persist the outer drain's existing worker-pass-failed bookkeeping. A recoverable route/pass failure with successful persistence retains existing blocked/backoff behavior. Do not await shutdown from inside the drain promise that shutdown itself awaits.

Successful authenticated stop/disable, SIGINT/SIGTERM, validated configuration/incarnation replacement and temporary completion remain normal shutdowns. Their successful cleanup produces no fatal notification. Pause, foreground cancellation, route removal and persistent route blocks are not fatal process failures. A genuine cleanup failure during an otherwise normal stop is unsuccessful.

At the CLI boundary, install the notification before runtime readiness. Emit exactly one fixed stderr diagnostic:

```text
html-inbox: Sync worker stopped after an unrecoverable state or cleanup failure; inspect the inbox before restarting.
```

Set process exit status 1 there, without process.exit(). Do not append the original exception or stack. Apply equivalent fatal handling to a temporary sync-run runtime so fatal shutdown cannot become a successful ticket or ordinary deadline-pending result. Preserve successful foreground readiness output and normal command results. Existing detached worker stderr and supervisor capture supply the diagnostic destination; no new logging system or supervisor policy is needed.

## Shutdown and ownership

Attempt independent listener cleanup despite an earlier rejection, and preserve the original cleanup failures for an explicit close caller. Stop local scheduling, abort attempts and settle replication work before releasing lifetime ownership. Do not release authority while replication can still act. Retain uncertain ownership artifacts instead of deleting them speculatively. Complete independent startup-exclusion cleanup even if another startup cleanup step rejects. No blind force-unlink or arbitrary process signalling is authorized.

An unsafe authoritative ledger cannot safely receive a new persisted failure record. Keep existing durable route errors where writes remain validated; use the existing private worker log and unsuccessful CLI process status for this safety-stop case. This gate introduces no ledger, wire, runtime-record or supervisor schema, no automatic corruption repair and no guaranteed recovery from unsafe storage.

## Ownership and verification

Production scope is sync-worker.ts and sync-cli.ts. New dedicated sync-worker-fatal.test.ts and an optional sync-worker-fatal-child.ts are allowed. Existing reserved independent test files, generic private-file helpers, ownership protocol, ledger reader, publication, reconciliation, worker client and supervisor remain unchanged. Any necessary expansion must first carry concrete evidence and a proposed narrow gate to the coordinator. Documentation beyond this gate remains coordinator-owned.

Before production edits, retain a tight actual-CLI red on current integrated source. After readiness, introduce a real unsafe symlink in an isolated fixture. Require exit 1 and one sanitized diagnostic after correction, zero unsafe ledger opens, unchanged target, reaped worker and exact control/ingestion port rebinds.

Library tests must cover once-only notification across racing failures, observer rejection/throw safety, no process-exit side effect without an observer, explicit close rejection, all independent cleanup, no unhandled rejection and no drain/shutdown deadlock. Inject drain failure plus failed error persistence, and keep a recoverable pass-failure control with successful persistence. Observe unsuccessful cleanup through both explicit and internal shutdown paths.

Exercise normal stop/disable, signals, configuration/incarnation replacement and temporary completion without fatal output. Route errors, pause, cancellation and removal retain existing semantics. Actual detached logging must capture the fixed diagnostic; a disposable failure-sensitive supervisor must distinguish fatal exit 1 from deliberate exit 0. Keep viewer independence and the benign ledger-replacement same-worker/custody/body-repair proof.

Use only synthetic stores, temporary credentials and short-lived loopback fixtures, with isolated HOME/XDG/TMP/ZDOTDIR and retained owned-child cleanup. Test Node 20 and 24 sequentially with no compiled-output writes during execution. Exact commands, exits, counts, log hashes, complete tracked/untracked diff and cleanup receipts are required. Native Mac and physical network acceptance remain with the separate QA thread. No live service, real inbox, settings, security grant, remote host, commit, push, merge or deployment is authorized for the writer.
