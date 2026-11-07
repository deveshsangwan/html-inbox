# Source-only startup scheduling regression proposal

Status: unexecuted regression source. No application execution or production fix
is authorized in this phase. Root assigned the local slot to #96 after accepting
the zero-record smoke release. This proposal requires a separate correctness
grant before any high-count feasibility or performance qualification.

## Question and evidence

`nextReconcileAt` starts as `Infinity`. A startup drain that sees persistent pause
or disabled state skips its pass. `refreshSchedule()` can later observe an
external enable/unpause and set `backgroundEnabled` true without initializing the
periodic deadline. A genuinely healthy route with retry time zero and an empty
outbox yields `nextRetryAt === Infinity`. Five-second full validation alone does
not arm reconciliation. This source path is plausible, not yet reproduced.

The staged file is
`packages/cli/src/sync-worker-startup-schedule.regression.ts`. The explicit suffix
keeps these new cases out of ordinary test discovery until the granted red/green
diagnosis invokes the compiled file directly. After validation and correction,
promote it to `.test.ts` so its coverage becomes permanent. Production files
remain unchanged at this source-only pin. A subsequent separate
[CI fixture correction](95-ci-fatal-fixture.md) atomically publishes unsafe ledger
entries while preserving their existing assertions and timing bounds.

## Regression construction

The fixture creates real loopback HTTPS credentials, two enrolled stores and a
matching route. A real, exclusively owned worker completes the empty inventory
handshake and records successful retry state. It is joined and stopped before
starting the worker under test. Both route states must be active, actual route
retry time must be zero/unblocked and the source outbox must be exactly empty.
No route activation, retry state, receipt or checkpoint is fabricated.

The primary case persists enabled plus retryPaused before startup. After the
startup flight settles, it advances two configured reconciliation periods while
paused and asserts zero passes, zero real protocol admissions and at least two
full ledger reads. Then an independent `ManagedSyncStore` commits unpause. It
does not call requestWake, submit a foreground ticket, or inject a gap.

The configured reconciliation period is 6,000 ms, a valid existing setting longer
than the independent 5,000 ms full-refresh fallback. Both injected scheduling
clocks and the existing Date.now test seam advance together in 250 ms steps.
There is never a greater-than-two-second jump. Three further reconciliation
periods are observed, allowing the first cheap observation's 250 ms. Diagnostics
record pass times, actual SyncClient admissions, full ledger opens and gap count.
Assertions require a first bounded pass, at least three passes over the three
periods, real admissions and zero gap wakes. Refreshing every five seconds must
not perpetually move a six-second deadline into the future.

A persistently disabled worker is rejected at startup preflight, so that literal
state cannot reach the same running branch. A nearby deterministic case disables
through an independent store commit after enabled preflight but before the first
background admission, using the existing lifecycle test seam. It then enables
through an independent commit and applies the same no-wake assertions. A separate
control preserves direct disabled-entry rejection.

The temporary-worker control starts disabled and paused. External unpause and
enablement plus multiple ordinary periods must not create background work. A
separate explicit foreground request then proves that temporary foreground work
still functions. That positive control is not used in either external-change
regression. Full refresh, ownership, route checks and real HTTPS requests remain
in place. All workers/listeners are joined and exact ports rebound before
fixture removal.

## Ranked hypotheses and causal check

1. A missing initial finite deadline causes starvation. The current unchanged
   production pin should show repeated full reads after unpause, no gaps, and
   zero passes/admissions. Initializing a deadline once when background work
   becomes eligible should produce bounded periodic passes.
2. External eligibility is not observed. This would show no metadata-triggered
   validated state inspection despite the independently persisted state. The
   ledger-open trace distinguishes it from an observed state with no deadline.
3. Periodic validation repeatedly resets the deadline. A proposed correction
   that rearms on every refresh would still starve the six-second case because
   the five-second refresh arrives first. The three-period assertions must reject
   that correction.

No hypothesis is a mandate to change behavior now. Keep permanent backoff,
temporary background suppression, pause, ownership and configured bounds intact.

## Separate correctness-slot request

Request at most ten minutes, after #96 releases the local slot:

1. Reconfirm clean regression HEAD and unchanged production equivalence to
   `fddde69`. Reuse frozen dependencies, typecheck/build with Node 24.19.0 and run
   the staged compiled regression sequentially on exact Node 20.20.2/24.19.0.
   Capture both original red outcomes and all four case diagnostics before any
   production change. Do not retry unchanged or substitute a wake/gap.
2. If the evidence supports the initialization hypothesis, make the smallest
   causal correction, pin it, and rerun the regression on both runtimes. Do not
   extend any configured timing or reset a finite deadline on each validation.
   Promote the verified regression to normal test discovery.
3. Run the existing scheduler/runtime/fatal/credentials/pause-admission/
   revocation-order/shutdown-ownership/shutdown-ingestion/attempt-lifetime suites
   sequentially on both exact runtimes. Preserve all failures and dispositions.
   No full suite, feasibility matrix or performance qualification is in this
   correctness request. Explicitly release after all groups and fixtures settle.

The direct red/green command after building is:

```sh
/exact/node20-or-node24 --test --test-concurrency=1 \
  packages/cli/dist/sync-worker-startup-schedule.regression.js
```

A production correction creates a new performance candidate. The historical
smoke remains harness evidence at `c00f614`; it cannot qualify the new scheduler's
performance. All mandatory high-count, paired runtime/resource/reaction/repair/
cleanup, full-check and independent-review gates remain open.
