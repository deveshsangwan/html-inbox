# Source-only routed held-read diagnostic plan

Status: unexecuted source. Root accepted the minimized timer-read defect on both
exact runtimes. The original routed caller remains untagged, its row remains
failed, and all 25 unrun feasibility cells remain required. This plan authorizes
no local execution while #92 owns the slot. No production code, timer parameter,
request/pass/lease/repair bound, dependency, version or wire policy changes.

## Small tracing change at the original hook

The existing `scheduler-process.cjs` snapshot wrapper now assigns process-local
read IDs and stable WeakMap store IDs. The selected read records its actual
caller stack, read/store IDs and whether it is the child script's own store.
Release and completion events carry the same IDs; stop and closed events include
the active-read set. Release reason distinguishes the explicit RPC from an
unexpected disconnect. Original snapshot results/errors pass through unchanged.
No ledger content or signature validation is cached or suppressed.

Store IDs distinguish instances, not authority. Worker ownership must be inferred
from the actual archived caller path and process role, not simply the store type
or `scriptStore` boolean. Driver and peer reads in other processes cannot be
mistaken for worker reads with the same numeric ID.

Ordinary measurement mode still installs the wrapper after resource observation.
This routed diagnostic explicitly sets `ISSUE95_ROUTED_READ_DIAGNOSTIC=1`, which
tracks all worker snapshots before startup. Tracking from startup is needed for
an honest no-active-read barrier; installing late would miss reads already in
flight. It adds observer overhead to these two diagnostic resource observations,
so they cannot qualify resource gains. Native interval scheduling and the four
existing clock events remain unchanged; no sleep, timer rephasing or forced
caller selection is added.

After original custody, retry, repair and stale-route controls, the flagged
workload submits a real foreground ticket against the already revoked route.
It uses the existing 30-second foreground deadline and 5-second request cap.
The existing 30-second observation loop requires that exact ticket complete and
that the tracked active-read set be empty. The child atomically rechecks both
conditions when arming the original hold. The barrier must admit no extra request.
Its completed ticket must have no error. The driver records its event cursor
before arming, so a timer-selected read before the explicit wake is retained.
If another read wins that final arm check, report a setup failure and stop; do
not retry or infer an ownership defect from it.

This extra real pass completes queued work and naturally updates pass bookkeeping
and reconciliation phase. That is controlled setup, not the historical workload
history and not proof of its original caller. A different selected caller or a
passing parent here cannot erase or explain away the old failure. The original
driver's settle call remains unchanged and is not used as this barrier.

All original workload assertions remain, including actual protocol catch-up,
real receipts/bytes, at least 65 actual idle seconds and two completed periodic
passes, retry deadline, four clock events, external custody, empty-outbox lost-body
repair, stale-route fencing, held-read ownership, exit and exact-port cleanup.
The parent receives the same strict ownership assertion as the candidate.

## Normal-discovery regression

The existing `sync-worker-schedule.test.ts` gains one test for the actual interval
callback. It uses the existing real-worker fixture, gates, mock interval seam and
250 ms scheduling clocks. A real completed foreground ticket plus zero tracked
reads establishes startup settlement. Ordinary ticks reach the 5-second refresh,
whose next actual interval callback enters the held snapshot.

During the same one-second bounded pending window used by the accepted probe,
close must remain pending with both ownership files present. Releasing the read
must permit close, exactly one closed event, no new pass/gap and no active read.
The test joins its held read in finally before fixture teardown rebinds the exact
control port. Its 15-second test envelope is selected before execution; existing
tests and production timings are untouched. This file is already discovered by
the normal compiled `.test.js` runner. No new helper is introduced. Neither the
new test nor these CJS changes has been built or executed locally.

## Requested bounded execution scope

Request at most 900 application-command seconds plus a fixed 60-second final
cleanup allowance, after root explicitly grants the slot. Use the existing
ignored operational controller, preserving its executed source/manifest before
any separately reviewed operational update. No new helper/controller is added
here. Its current three-mode TAP manifest is not a routed-workload manifest and
must not be executed for this plan without review.

Prepare separate git-archive builds of exact parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2` and exact candidate
`9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`. A third source archive at the new clean
request HEAD contains the normal-discovery test only; validate its production
source/output against 9fd. The routed cases always load the exact 610/9fd builds,
not that test build. Only `sync-worker-schedule.test.js` may differ in that third
build; every other emitted JavaScript file must match the frozen 9fd build.
Reuse frozen dependencies and exact Node 24.19.0 for all
compilation. Retain original archives and complete source/compiled identities.

Preselect at most sixteen manifest commands, all sharing one application deadline:

- Pin/clean/runtime checks, 5 seconds each, at most 25 seconds total.
- Three archive commands, 15 seconds each; three builds, 60 seconds each.
- Typecheck the new test source, 30 seconds.
- Run only the new normal regression on exact Node 24.19.0 and 20.20.2, 30 seconds
  each. Any unexpected fixture or regression failure stops before routed cases.
- Exactly two Node 24.19.0 zero-record inbound workload invocations, parent then
  candidate, 240 seconds each with the existing stricter 90-second setup cap.
  No high counts, other direction, repeat pair or additional idle sample.

These maxima total 820 seconds, leaving 80 within the requested envelope
for metadata and normal joining. TERM/KILL/reap/wait grace must remain capped by
the single fixed application-plus-60 final deadline. Stop before the next
invocation on an unexpected setup/caller/contract/cleanup failure. No retry,
on-the-fly source correction, full suite, feasibility resume or reviewer.

Focused test command for each exact runtime, on the separate new-test build:

```sh
<absolute-node24-or-node20> --test --test-concurrency=1 \
  --test-name-pattern='an actual interval callback retains lifetime ownership' \
  <new-test-dist>/sync-worker-schedule.test.js
```

Run these exact two workload commands, with distinct controller-owned marker
fixtures and controlled temporary HOME/catalog directories:

```sh
ISSUE95_ROUTED_READ_DIAGNOSTIC=1 \
  /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node \
  scripts/bench/scheduler-workload.cjs <parent610-dist> <parent-fixture> 0 inbound 65000
ISSUE95_ROUTED_READ_DIAGNOSTIC=1 \
  /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node \
  scripts/bench/scheduler-workload.cjs <candidate9fd-dist> <candidate-fixture> 0 inbound 65000
```

## Evaluation and receipts

Require the selected read's actual caller/store/read identity and its active state
at stop/close, explicit release reason if reached, and completion/cleanup outcome.
Missing caller data or failed barrier is not cause evidence. Keep original
workload exit codes, errors, raw traces and failed control rows. A newly tagged
parent timer defect may be labeled a reproduced baseline correctness failure
separate from its resource observations, with `passing_cell: false`; the strict
candidate control still must pass. A different caller or clean nonreproduction
is reported as observed, not relabeled to fit the minimized result.

This diagnostic cannot classify the old untagged failure, count missing mandatory
cells as completed, establish noise or retain an optimization. Preserve all
prior reds, root audits and unrun lists. Join every owned process/read/listener,
rebind exact ports and account for fixtures before explicit slot release, then
package the source/output/runtime fingerprints and complete outcomes. Generic
timeout/interruption qualification must not be inferred from a successful run.
