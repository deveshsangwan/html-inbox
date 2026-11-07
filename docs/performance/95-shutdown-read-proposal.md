# Source-only shutdown read diagnosis

Production remains frozen at tested `9fd509e`. The three measured harness files
remain byte-identical to `a7f8719`. The original stopped attempt and its failure
remain unqualified. The separate staged diagnostic
`scripts/bench/scheduler-shutdown-read.regression.cjs` is unexecuted and outside
normal test discovery. No local execution or correction is authorized now.

## What the failed trace establishes

All times below are from worker PID 2602040's own monotonic clock. Parentprocess
and peer `performance.now()` values have different time origins and must not be
subtracted from these values.

| Worker time, ms | Observation |
| --- | --- |
| 128069.907 | Status still says running-pass, 11 completed passes, 48 requests. |
| 128071.922 | Settle returns running-pass with the stale-route ticket queued. |
| 128072.083 | A second status still has that queued ticket. |
| 128072.266 | Read-hold arm acknowledged. |
| 128072.372 | Explicit wake acknowledged. |
| 128107.306 | Snapshot wrapper reports read-held, without a caller identity. |
| 128123.110 | Stop handler reports stopping before invoking close. |
| 128124.378 | Pass bookkeeping reports its twelfth completion. |
| 128128.461 | Worker reports closed. |

The driver's 25 ms observation polling permits close to progress before its
ownership-file inspection. The missing file alone does not identify the held
caller. However, the hold gate is released only by the explicit release RPC or
unexpected disconnect. The explicit release was not reached. Normal stop sets
`isStopped` before disconnect, whose handler then returns without releasing the
gate. A `read-held` event is therefore insufficient as a proof of worker-owned
work, while the observed normal stop path does not explain the gate settling.

The full trace has four injected gap events, all long before this phase, and no
new gap between stale-route handling and close. The final clock offsets are wall
zero and monotonic +10,000 ms. Event messages use raw Date.now/performance.now;
the worker scheduling hooks use the offsets. Both clocks then progress ordinarily.
`processState` depends on `current`, not `draining`, so idle status also cannot
prove all scheduler work is settled.

## Read and ownership map

| Caller | Parent 610 behavior | Candidate 9fd behavior |
| --- | --- | --- |
| Interval callback into tick | Awaits snapshot outside draining; callback discards its promise after attaching fatal handling. | Tick admits observation into draining and returns that promise. |
| Drain admission | assertManagedLifecycle constructs a store and awaits its snapshot inside draining. | Same ownership, plus post-await close/cancellation checks. |
| Per-route read/reconciliation | Direct snapshot and awaited reconciliation are inside draining/current.done. | Same fresh authority and joining responsibility. |
| Lifecycle check in HTTP control handler | Separately awaits assertManagedLifecycle; it is a distinct possible caller. | Same distinct control path. |
| Record bookkeeping | recordWorkerRun mutates through readLedger, not prototype snapshot. | Same storage path. |
| Close and owner release | Cancels attempts/tickets, closes listeners, awaits draining, reads runtime record directly, then removes record/releases lifetime. | Same ordering, with scheduling observation included in draining. |

The global prototype hold covers lifecycle-created stores as well as the main
worker store. It cannot capture the driver's or peer's reads in other processes.
The child script's own store is not explicitly snapshotted after readiness in
worker role. Its ordinary RPC status is in-memory; RPC settle calls tick. On the
parent, settle can return while the route pass remains live, as the trace proves.
That leaves an active route and queued ticket during hold selection. Caller
classification needs stack/store identity, not status or event names.

Ranked falsifiable hypotheses:

1. The held read is a worker timer observation outside parent draining. An
   observation-only timer trigger should show that caller and early parent close,
   while candidate retains ownership; an admission-only read should remain joined.
2. The live route, queued ticket or lifecycle path selects another read. Recorded
   caller frames should identify that path, or the isolated observation case
   should fail to reproduce the ownership symptom. Do not assume cancellation
   detaches awaited reconciliation; the source awaits its state reads.
3. The inspected event is stale or the hook captures an independent observer.
   A selected read's active/release/finish trace or store identity would distinguish
   this from worker-owned pending work. The separate observer control should let
   worker close release its own handles while that external read remains pending.

These are predictions, not selected causes. The new probe is a proposed
minimization, not a proven reproduction of the full routed trace.

## Staged probe and evaluation

For each actual archived revision, create a fresh genuinely enrolled disposable
home, enable/start its real owned worker, retain its real control listener and
lifetime handles, and freeze intervals with the existing node:test timer seam.
A completed foreground ticket, zero active snapshots and an event-loop turn form
the startup barrier. No route, custody state, TLS setup or 65-second resource
measurement is needed for this first diagnostic. No performance result follows.

Three cases identify the selected snapshot with an ID, exact caller stack,
explicit external-store identity, entry/release/finish times and outstanding-read
set. Each holds before the original snapshot call, matching the existing hook;
it does not claim to suspend an operating-system read already in flight.

1. Advance scheduling clocks in ordinary 250 ms steps to 4,750 ms, invoking and
   joining ticks before arming. At 5,000 ms invoke the actual interval callback
   through mock timers. Both revisions can then require a real snapshot without
   a gap or periodic pass. Require observation caller frames, not lifecycle frames.
2. With intervals frozen, issue one foreground ticket and hold its lifecycle
   snapshot. Require an actual lifecycle caller stack. This controls the read that
   both implementations are already intended to join through draining.
3. Hold a snapshot on the probe's separately identified external store instance.
   This is a control for an overbroad hook, not a claim that the original child
   performed such a read. Worker close should release its own resources here.

For worker-owned cases, use the same strict ownership assertion on both revisions.
Observe close settlement and both ownership files while the selected read is
still active, before explicit release. Record a bounded one-second pending window;
it is a diagnostic observation window, not a new production deadline. Then release
and join the actual read and close promises, require zero gap wakes, rebound the
exact port and remove runtime evidence. An external observer has a different
ownership contract because it is explicitly not worker work. All diagnostics are
emitted before the final contract assertion, so original reds remain visible.

A caller-classification, startup, mock, cleanup or real-handle failure is not
causal proof. Preserve it and stop before interpretation or another run. If a
minimal case does not reproduce the routed failure, do not select the timer
hypothesis. Return with a plan for a bounded routed replay using a diagnostic
copy that tags the original hook; the measured files must remain frozen.

If a real parent defect is proven, report that baseline behavior as a failure of
the same worker-lifetime contract and require the candidate to satisfy it.
Original failed rows and assertions remain. Any future separation of resource
observations from a known baseline behavioral defect needs an explicit root
decision and visible qualification rule; it cannot silently turn the failed
baseline into a passing cell or qualify the missing high counts.

## Next bounded request

Request at most 600 application-command seconds plus 60 seconds cleanup, after
#96 releases its slot. Pin/review this unexecuted probe before launch. Export and
compile actual parent 610 and exact candidate 9fd separately using frozen
dependencies and Node 24.19.0. Archive bounds are 15 seconds each; builds 60 each.
Record full source/compiled/runtime hashes and all original outputs.

Run the three cases first on exact Node 24.19.0 against both revisions, then on
exact Node 20.20.2 against both if the initial results reach the intended caller
and ownership assertions. Each file invocation has a 90-second outer bound and
each case 30 seconds, for at most twelve cases/four invocations. Preserve strict
parent failures instead of treating them as setup successes. Unexpected fixture,
caller or cleanup failures stop the diagnostic; no unchanged retry, production
fix, full suite, resource matrix, reviewer or feasibility resume is included.

The command for each separately archived build is:

```sh
ISSUE95_DIAG_DIST=<absolute-archived-dist> \
ISSUE95_DIAG_REVISION=<exact-610-or-9fd-SHA> \
  <absolute-node20-or-node24> --test --test-concurrency=1 \
  scripts/bench/scheduler-shutdown-read.regression.cjs
```

The owned outer controller must share one absolute application-plus-cleanup
deadline, replacing the previously identified accumulating grace pattern before
reuse. Record PID/group/exit and join every child/read/listener before fixture
removal. Node 24 static syntax checking passed. No probe or application command
has run under this proposal.
