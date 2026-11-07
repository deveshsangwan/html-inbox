# Worker scheduling experiment

Status: source-only. No performance result or retention decision yet.

The plan was committed as `9ca71fd` before the production edits. Local execution
is pending the orchestrator's exclusive slot. Source inspection and
`git diff --check` are the only checks completed in this phase. No install,
typecheck, build, test, or benchmark has run.

## Pins and scope

Issue: https://github.com/deveshsangwan/html-inbox/issues/95

Immediate parent: `610c931b7b22920cce59cf03e49c0de15ebaf2a2`, the reviewed
`perf/89-bench` head. The checkout was clean before this plan was written.
The candidate must contain no #94 signature cache, other production optimization,
runtime/version changes, storage/wire/validation policy changes, or PR #81 work.

This plan was selected before production edits. The affected operations are
persistent-worker idle observation, wake/pass admission, retry scheduling and
periodic reconciliation. The primary metric is worker process CPU-seconds divided
by elapsed idle seconds. Also report elapsed time, steady/peak RSS, startup and
shutdown cost, and trigger-to-pass/request/custody latency.

## Qualification plan

Compare builds of the actual parent and committed candidate independently on
Node 20.20.2 and 24.19.0 on the same exclusive host. Build each revision from its
own tracked source into separate scratch outputs, without another git checkout.
Use identical disposable fixtures and environment, warm filesystem caches,
request/pass/reconciliation configuration, concurrency and runtime for each pair.
Record source/output hashes and exact commands. Do not attribute a runtime upgrade
or inherited parent changes to this scheduler.

For each runtime, use 0, 1,000 and 10,000 canonical records, separately with zero
routes and with a real configured caught-up route. Include inbound and outbound
behavior controls. All six count/route combinations are required. Fixture setup
is outside the observation interval. Large fixtures must pass the unchanged
ledger validator and use real signed descriptors and usable bodies. If setup or
the existing protocol limits cannot qualify a workload, report that blocker.
Do not substitute a smaller count, relax a deadline, or extrapolate.

Use at least five interleaved parent/candidate pairs per combination. Alternate
the first revision. Observe at least 65 seconds after startup and the initial
pass settle, so the default 30-second repair interval occurs twice. Save each
process's CPU, elapsed and RSS observations, pass/request times and external
sampling traces. Include observer/receiver processes separately and aggregate
their CPU/RSS where applicable. No competing builds, suites or benchmarks.
Report all raw values, median, range, paired absolute/relative deltas and paired
spread. Do not claim a percentile from five observations. Retain production
changes only after practical CPU improvement exceeds measured noise at all
required sizes, with no unacceptable reaction/lifecycle regression. For the
near-zero-record case, report absolute CPU as well as ratios.

Behavior observations must cover startup, active transfer, catch-up after an
external commit without a wake, explicit wake, due item/route retries, persistent
backoff/blocked state, pause/resume, slow pending observations, coalesced wakes,
stale route requests, cancellation and shutdown during pending work. Delete a
receiver body after caught-up state and prove periodic custody repair even with
an empty pending outbox. Check wall-clock forward/backward jumps, monotonic gaps
and suspend-like divergence. Verify exact bytes/receipts, all child exits, exact
listener-port reuse, removal of owned records/locks and disposable fixture cleanup.

The existing `scripts/bench/workload.cjs` worker mode only measures one second
with no routes. It is insufficient for this qualification. The existing sync
mode proves transfer/no-op/repair separately, but is not a persistent-worker
measurement and cannot substitute for the required route matrix.

Raw traces go under the orchestrator's performance artifact directory and need a
durable published reference before a PR can claim qualification. Record failed
runs as well as successes. Expected initial local slot: one build/typecheck and
focused scheduler/lifecycle tests, approximately 10 minutes. Request the sustained
measurement slot separately after that result and harness inspection.

In particular, measure whether long validated reads at 10,000 records themselves
cause clock-gap catch-up work. The unchanged gap detector includes event-loop
stalls. A reduced nominal refresh count cannot establish a CPU improvement if
that catch-up work keeps the worker busy. This is an open qualification risk.

## Proposed scheduling bounds

Keep a 250 ms cheap clock/deadline observation. Serialize all scheduler snapshot
refreshes and outgoing passes through one promise. Explicit runs and wakes join
that flight; repeated wakes during pending work retain one additional background
request. Read fresh validated authority at pass and route admission. Never use a
cached schedule as route authority. Shutdown stops admission, aborts attempts and
joins the flight, including a pending state read, before releasing ownership.

Keep only scalar scheduling state between observations, not a cached ledger.
Refresh validated state after passes, on a known retry deadline or clock event,
and at a five-second fallback for other-process changes. The fallback is measured
with the monotonic clock from the beginning of each read. If a read itself takes
longer than five seconds, allow one cheap observation interval after it settles
before another fallback read. This avoids a catch-up loop of slow state reads.

Absent a current flight, an explicit trigger schedules immediately. Known retry
deadlines and periodic reconciliation become eligible within 250 ms. External
commits without a wake are discovered within 5,250 ms plus state-read time; when
the preceding read takes over five seconds, its completion plus 250 ms replaces
that bound. A trigger arriving during a flight waits for that bounded pass/read
and its required bookkeeping. Storage and event-loop stalls add their own delay;
no scheduler can promise a wall-time bound on an arbitrarily stalled filesystem.
Measure those costs at the required record counts and report actual bounds.

Retry timestamps use wall time because persisted retry timestamps do. Periodic
reconciliation and fallback refresh use monotonic elapsed time so wall rollback
cannot postpone them. Preserve gap thresholds: either clock advancing over
2,000 ms between observations, or wall/monotonic progress diverging by over
1,000 ms, requests catch-up on the first available observation. A forward wall
jump also makes persisted deadlines due; a backward jump preserves their wall
meaning while periodic repair continues on monotonic time. On platforms whose
monotonic clock excludes suspend, wall divergence detects it; where it includes
suspend, the elapsed gap detects it. No work runs during actual process suspension.

Periodic reconciliation uses the configured interval after pass completion and
checks eligible routes regardless of outbox contents. Blocked/backoff routes,
route ownership/revision fencing, cancellation, listener lifetime and global
ledger validation remain unchanged. The five-second external discovery fallback
is an explicit latency tradeoff against the old full-read-every-250-ms approach.
