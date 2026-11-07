# Bounded scheduler feasibility request

Status: source-only preparation; no new local execution grant. Tested production
is `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`; the request uses the subsequent
clean harness/receipt HEAD, whose application source must match that pin exactly.
The correctness receipt is separately pinned at `ee8eead`. The earlier `c00f614`
smoke is historical harness evidence and does not qualify this new candidate.

Request one exclusive local slot for `--phase feasibility`, with a 5,400-second
total runner budget and a separate 60-second final forced-cleanup allowance.
Expected duration if feasible is 60–90 minutes. Stop earlier on the first failed
preliminary command or unqualified case. This is one attempt, with no automatic
retry, resume, count reduction or deadline extension. There is no install, full
suite, five-pair qualification, review, or retention decision in this request.

The matrix contains 36 cases: three counts (0 / 1,000 / 10,000), three directions
(none / outbound / inbound), two exact runtimes (20.20.2 / 24.19.0), and actual
parent plus candidate. That is one pair for each of 18 workload/runtime cells.
The parent is exactly `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Count is the outer
loop: all twelve fresh zero-record controls run before 1,000-record cases, then
10,000-record cases. Within each count, both runtimes retain adjacent
parent/candidate observations. A failure stops before the next case; unfinished
cells remain required and explicitly listed in `summary.json`.

The nine preliminary commands are included in the total budget: filesystem
observation (5 seconds), two actual `git archive` exports (15 seconds each), two
separate frozen-dependency builds (60 seconds each), and four enabled-worker
reader-race checks on both archived builds and runtimes (15 seconds each).
These retain their existing owned groups and exact race-hit, process-identity
and shutdown assertions. No shell checkout or worktree is created.

Each timed case retains the existing 240-second outer bound, also constrained by
the remaining total runner budget. Feasibility adds a stricter 90-second setup
cap from case launch through seed creation, full signature validation, TLS and
worker startup, initial ordinary pass completion, and actual caught-up custody
checks. It includes all setup work rather than only protocol time. Existing
10-second child readiness and 70-second bookkeeping/RPC observation bounds
remain. No request, pass, lease or production retry deadline changes.

Only after the unchanged real custody checks pass does the workload publish a
small setup-complete marker outside the inbox, before resource sampling. Python
observes it during the existing 100 ms external sampling loop, records setup
elapsed time, and stops a still-pending setup at 90 seconds. Observation is
conservative at the sampling boundary. The marker is a harness checkpoint; it
does not establish custody or authorize production work. Marker checks stop when
it is first observed; that one external check can coincide with sample start.
They never read the ledger or worker control status. No synthetic receipt,
route activation, checkpoint or ACK is
introduced. Catch-up still has one ordinary bounded initial pass; inability to
catch up is an explicit feasibility failure, not evidence that production could
never catch up through further passes.

Every successful case must observe at least 65 actual idle seconds and two
completed periodic passes, then retain its applicable explicit wake, retry
deadline, four clock-event, real external-commit custody, empty-outbox lost-body
repair, stale-route fencing, pending-read shutdown and exact-port/child cleanup
controls. Default 30-second reconciliation and 60-second pass bounds remain.
Reaction observations retain 30 seconds; actual custody and periodic repair
retain 65 seconds. These observations share the unchanged 240-second case cap;
their individual maxima are not extra time. At capacity a signed deletion
preserves the canonical count. Failed high-count preparation is never replaced
by fabricated caught-up state, fewer records or extrapolation.

After the first unqualified case, its exit/error, stdout/stderr and process traces
are retained, the owned group is joined before fixture removal, and
`checkpoint.json` identifies the stop. Final summary lists every unrun case and
reports incomplete coverage. Preliminary failure and total-budget exhaustion
also stop and retain partial output through the existing finalization path.
Any cleanup failure stops execution and retains the fixture root while owned
processes remain. A new source disposition and grant are required before retrying
or continuing. Successful rows before the stop remain historical observations;
they cannot stand in for missing mandatory cells.

Exact runner command after grant, substituting the full clean request HEAD and
a fresh artifact directory:

```sh
python3 scripts/bench/scheduler.py \
  --candidate <full-clean-request-HEAD> \
  --node20 /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node \
  --node24 /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node \
  --phase feasibility --budget-seconds 5400 \
  --out /home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue95-feasibility-1
```

The outer launch must retain its PID/group, deadline and exit under the grant;
the runner already owns preliminary and timed groups. Its existing error cleanup
uses TERM/KILL leader waits of at most two seconds each and an adopted-group
reap window of three seconds. The separate final allowance bounds cleanup after
the total runner budget; it does not allow another cell. Release only after all
recorded groups/children, listener ports and fixture roots are accounted for.

The primary metric remains measured worker CPU-seconds per actual elapsed idle
second, with independent `/proc` CPU/RSS observations, actual elapsed/RSS and
separate peer/observer costs. Preserve startup, active, catch-up, clock/retry/
repair and shutdown traces, source/compiled/runtime hashes, commands and every
failure. One pair is feasibility evidence only. At least five alternating pairs
at every mandatory count/direction/runtime, practical benefit beyond noise,
durable public raw artifacts, full checks and independent same-pin reviews remain
required later.

## Adopted-child inspection

The correctness-wrapper failure involved real detached CLI workers becoming
zombie children of its Python subreaper while the still-running test awaited
their PID disappearance. The proposed runner's preliminary reader case instead
starts an owned worker in the test process. The timed workload directly forks
retained worker/peer processes, awaits their exit events and closes/rebinds their
exact ports. `scheduler-process.cjs` starts an owned worker or ingestion server
in that same process; it does not spawn a detached CLI worker. TLS helper
subprocesses are awaited directly. The wrapper's problematic PID-wait path is
absent here, so no concurrent adopted-child reaper is added speculatively.

Existing preliminary timeout/interruption cleanup tests and the historical
zero-record smoke cover their stated paths only. The new setup marker,
feasibility stop/checkpoint branch and high-count paths are unexecuted source.
Successful runs do not prove arbitrary interruption cleanup. On an interruption,
retain the actual exit/group/fixture evidence and report any gap explicitly.
