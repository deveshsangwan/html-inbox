# Scheduler measurement harness and next slot

The historical zero-record smoke passed at `c00f614`; its stopped attempts remain
preserved. The subsequent startup correctness fix at `9fd509e` creates a new
production candidate. The next source-only
[bounded feasibility request](95-feasibility-request.md) includes fresh controls
and all required counts. Its single granted attempt stopped at a parent shutdown
assertion after ten passing zero-record cases; [the receipt](95-feasibility-1.md)
lists all 25 unrun cases. No continuation grant or performance qualification
exists. This harness extends the workload selected in `9ca71fd` before production
edits; the small smoke never replaces 0/1,000/10,000 qualification.

## Comparators and collection

`scripts/bench/scheduler.py` requires the clean, committed candidate HEAD and the
exact parent `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. It rejects changes to the
lockfile or package/runtime metadata. It exports each revision's tracked source
and TypeScript configuration with `git archive` into scratch directories and
compiles each separately with the existing locked compiler. This creates no git
checkout or worktree. Dependencies are shared through the frozen installation;
compiled outputs are separate and fingerprinted. Both revisions use the same
pinned harness source.

The measured executables must report exactly Node 20.20.2 and 24.19.0. Builds run
with Node 24.19.0. The runner records binary/source/output fingerprints, runtime,
filesystem, host, arguments, per-case commands and exits. It alternates revision
order across pairs and records every case, including failures. There is no
percentile estimate from five samples.

The primary metric remains worker process CPU-seconds per elapsed idle second.
The worker and actual HTTPS ingestion peer run in separate retained child
processes, so their CPU/RSS observations are separate. Each reports real
`process.cpuUsage()` deltas, actual elapsed time and beginning/end RSS. Cumulative
process peak RSS is labeled as such. The Python supervisor independently samples
the owned process group through Linux `/proc` every 100 ms, including CPU ticks,
resident pages, PID, start ticks and process state. It also records `wait4`
CPU/elapsed/peak RSS for the whole workload. Sum-of-observed-RSS and per-process
high-water marks must not be described as exact simultaneous peak memory. CPU
ticks have kernel accounting granularity; RSS sampling can miss short spikes.

The observer does not poll worker control status or ledger snapshots during the
idle interval. Constructor clock/event hooks, an unchanged-result wrapper around
pass bookkeeping, and request event logging are identical on both revisions.
They add some overhead, which must be reported, particularly at zero records.
There is no snapshot/signature cache, skipped validator, changed timer, enlarged
pass/request/session deadline, or synthetic confirmed receipt in this harness.
The final candidate's metadata checks and independent full-refresh fallback are
both included in the sampled worker process.

## Fixture and behavior gates

Fixture generation happens outside the idle interval. Each disposable store is
enrolled normally. Bulk fixture construction then uses the real disposable owner
key, `signOriginState`, HTML validation and `DurableFiles` to install 10 KiB-scale
real bodies and signed canonical records. It validates the resulting ledger
through the unchanged store snapshot, including all signatures and anchors.
This avoids timing thousands of repeated publication mutations during setup;
it is not a publication-throughput measurement. UUIDs, keys and ephemeral ports
are fresh for each equivalent-shape fixture. Payload bytes, count, metadata
shape, scope, timings and cache conditions are the same across revisions.

The runner exercises no routes, an outbound worker, and an inbound worker at
each required count. A route covers the source's entire seeded origin. A real
paired HTTPS route must complete actual protocol catch-up before an idle sample
is eligible. Both route states, exact canonical fingerprints, bodies, committed
receipts and the measured worker's empty pending outbox are checked. Setup does
not fabricate receipts, checkpoints, custody, route activation or protocol ACKs.

Initial setup currently permits one ordinary bounded worker pass before requiring
caught-up state. A high-count case that cannot meet that fixture precondition is
reported as unqualified, with its traces, not omitted or extrapolated. This is a
limitation of this bounded setup, not proof that repeated production passes could
never catch up. Root must decide whether to authorize a separate longer setup
that retains every existing per-pass/session/request deadline. No resource claim
for a caught-up high-count worker can be made until that precondition is real.

Each idle observation lasts at least 65 seconds of actual measured process time.
An explicit completed-bookkeeping barrier precedes sampling on both revisions.
The parent's `tick()` does not join the startup pass, so relying on it alone can
include startup work in an idle sample. The first smoke attempt exposed this
with `completedPasses: 0`, was stopped, and is retained as invalid. A correction
waits for the first actual completed pass within the existing 70-second command
observation bound. Sample-start replies also record the starting pass counter.
The workload requires two completed periodic passes during that window and
checks custody afterward. If slow passes prevent that, the case is unqualified;
the duration or criteria cannot be silently adjusted during execution. A longer
explicitly planned observation is compatible with the original minimum, but
requires a new bounded slot plan before running it.

After resource observation, the workload checks explicit wake, forward/backward
wall-clock events, a monotonic gap and a both-clocks gap. These inject scheduling
clock hooks only, not a physical OS suspend or a change to durable retry time.
It records the persisted route retry deadline and requires no request before it.
Real external publication or signed deletion runs through a separate store
instance without a worker wake. At capacity, deletion preserves 10,000 canonical
records instead of failing a new publication or lowering the fixture count.
At zero records, an external live publication also supplies an actual active
body transfer and subsequent repair case.
The second smoke attempt caught receiver state appearing before sender ACK and
pass bookkeeping. It is retained as failed. The corrected external-custody gate
requires a matching current-incarnation durable receipt and exact live bytes;
outbound also requires the sender's confirmed obligation. Repair waits for the
latest admitted pass to finish, preserving its empty-outbox precondition.

Periodic repair removes one receiver body with no pending local outbox and sends
no wake. It waits for the actual replacement body filename, then checks the
persisted canonical record and exact bytes. The repair observation bound is
65 seconds, retaining the default 30-second reconciliation and 60-second pass
limits. External inbound changes are remote to the worker's local ledger and
therefore rely on that independent reconciliation; their custody observation
also uses 65 seconds. These outer fixture bounds do not extend production
requests, leases or passes. Other wake/clock/retry reaction observations use
30 seconds and report actual admission/request/pass timestamps and resource
costs. Fine-grained 250 ms scheduling bounds remain subject to measured current
flight, validation, storage and event-loop costs as documented in the main plan.

Finally the workload revokes the route and submits a stale explicit request,
requiring zero additional requests. A test-only hold of the next real state read
is enabled after measurements. Shutdown must retain its actual runtime/lifetime
evidence while that read is pending, then join it before releasing authority.
Every retained child is reaped and every exact listener port rebound. Python is
a child subreaper and kills/reaps the owned process group on errors or its outer
bound. Separate cleanup tests exercise an uncooperative group and an exited
leader that leaves a descendant holding a port. Root's pre-smoke review also
required preliminary builds and reader checks to own and join process groups.
Their direct bounded-command helper records PID/command/exit/timeout and joins
the group in `finally`, before removing fixture directories. Cleanup receipts
include preliminary and timed groups. If a group remains, fixtures are retained.
Additional tests cover a real preliminary-command timeout, interruption and
combined nonzero exit plus cleanup failure, with retained descendants/ports and
both original and cleanup causes preserved. No real inbox path is accepted;
the workload requires the supervisor-created disposable marker.

## Historical smoke request

Request a maximum 1,800-second exclusive local slot for harness smoke only:

1. Run `python3 -m unittest discover -s scripts/bench -p test_scheduler_cleanup.py`.
2. Run the command below on the committed harness/candidate pin. It builds the
   actual parent and candidate separately, runs the enabled-worker
   ledger-replacement case on both builds and exact runtimes, then executes
   twelve zero-record cases, one parent/candidate pair for each of the three
   directions on each runtime. Each still observes 65 seconds of idle time and
   performs its applicable resource, clock, custody, repair and cleanup controls.
3. Allow only harness or demonstrated scope-local fixes. Retain every failed
   attempt and request additional scope before widening tests or changing a
   preselected bound. Release the slot after all owned processes end.

```sh
python3 scripts/bench/scheduler.py \
  --candidate <full-clean-harness-HEAD> \
  --node20 /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node \
  --node24 /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node \
  --phase smoke --budget-seconds 1800 \
  --out <new-orchestrator-artifact-directory>
```

Expected duration is 20 to 30 minutes, with a strict 30-minute runner budget and
240-second per-case outer bound. Exhausting either bound produces failed or
unfinished coverage, not a rerun with a hidden longer timeout. The unchanged
reader-race case is included because its injection was skipped beyond the nine
suites in the first grant. CI at `698fd49` still reports zero injected reads.
`lastRunAt` is persisted before the startup flight settles, so a clock-only tick
can join a read admitted before the injection. The candidate test now explicitly
wakes the worker to require a fresh admission. Its exact one-hit, stable process
identity and no-shutdown assertions remain unchanged. The parent retains its
original tick-based test. Both need execution evidence in this slot.

Passing this smoke phase qualifies only the harness at zero records. A separate
`--phase feasibility` request must run all required counts and directions on both
runtimes with one pair each, without dropping blocked high-count cases. Only a
separately granted `--phase qualify` runs five interleaved pairs at every count,
direction and runtime. The runner writes raw traces, external samples, paired
values and spread and labels its phase. Resource evidence, practical gain beyond
noise, absolute/relative deltas and regressions, durable public raw-artifact
references, full checks and two fresh independent same-pin reviews remain
required before production retention or draft promotion.
