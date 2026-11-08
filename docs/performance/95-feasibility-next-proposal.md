# Next scheduler feasibility proposal

This is a source-only decision proposal after root accepted the routed diagnostic
receipt at `c102ab822a73e05a873b3ff4ef706711a8e10aee`. It authorizes no execution or
runner change. Production remains `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`;
actual parent remains `610c931b7b22920cce59cf03e49c0de15ebaf2a2`.
The natural post-observation tracing source is da21. The controlled routed run
selected joined lifecycle reads on both revisions. The original untagged failure
remains failed, and the separate minimized parent timer-ownership defect remains
proven on both exact runtimes. No further held-read diagnostic is proposed.

## Proposed scope and historical coverage

Use the existing runner's fresh `--phase feasibility` matrix. It has no resume or
case-selector option. Run 36 fresh cases, one pair in each of 18 cells, across
0/1,000/10,000 records, none/outbound/inbound and exact Node 20.20.2/24.19.0.
Run all twelve zero-record controls first, then 1,000, then 10,000. Parent precedes
candidate within each pair. Counts remain the outer loop. Every case retains its
own command, exit, setup result, resources, correctness result and cleanup.

The twelve fresh zero-record controls cover natural late tracing and the proposed
classifier on both runtimes and all three route configurations. Eleven repeat
previously attempted rows, including the failed parent Node24 inbound row. The
twelfth is the previously unrun candidate Node24 inbound row. All twelve get new
attempt IDs. They do not overwrite historical observations or fill historical
rows by inference. The 24 high-count cases address the other original unrun rows.
The controlled diagnostic contributes no feasibility cell.

The original receipt's exact 25 unrun case names are:

```text
24.19.0-0-inbound-0-candidate
20.20.2-1000-none-0-parent
20.20.2-1000-none-0-candidate
20.20.2-1000-outbound-0-parent
20.20.2-1000-outbound-0-candidate
20.20.2-1000-inbound-0-parent
20.20.2-1000-inbound-0-candidate
24.19.0-1000-none-0-parent
24.19.0-1000-none-0-candidate
24.19.0-1000-outbound-0-parent
24.19.0-1000-outbound-0-candidate
24.19.0-1000-inbound-0-parent
24.19.0-1000-inbound-0-candidate
20.20.2-10000-none-0-parent
20.20.2-10000-none-0-candidate
20.20.2-10000-outbound-0-parent
20.20.2-10000-outbound-0-candidate
20.20.2-10000-inbound-0-parent
20.20.2-10000-inbound-0-candidate
24.19.0-10000-none-0-parent
24.19.0-10000-none-0-candidate
24.19.0-10000-outbound-0-parent
24.19.0-10000-outbound-0-candidate
24.19.0-10000-inbound-0-parent
24.19.0-10000-inbound-0-candidate
```

Both the failed row and this unrun list stay byte-for-byte unchanged in the first
attempt's committed receipt. Any future summary must distinguish historical
attempt coverage, fresh attempted coverage, resource observations and failed
correctness controls. It must list each fresh unrun case at a stop.

## Observation boundaries and natural callers

Leave `ISSUE95_ROUTED_READ_DIAGNOSTIC` unset. Do not add the startup snapshot
wrapper, completed-ticket/no-active barrier, another foreground ticket, settling
pass, sleep, clock adjustment or caller-selection retry. Keep the original hold,
explicit wake, ownership assertions, release RPC and finally-stop ordering.

In ordinary mode, `hold-next-read` installs the wrapper after the idle window,
all reaction samples and applicable custody/repair/fencing checks. The existing
pre-arm event cursor retains a read that enters before the explicit wake. Capture
the actual caller, process-local read/store IDs, script-store flag and selected
active-read state. Require the arm reply to show startup tracing disabled and
no controlled-barrier event. Late tracking cannot see reads already in progress
at installation. An empty tracked set is not proof that every read has drained.

The primary metric remains worker CPU-seconds per actual elapsed idle second,
using the worker's existing sample-start/sample-stop interval. Keep peer costs
separate. Store elapsed/RSS and independent 100 ms process observations with
their existing sampling-boundary limits. The new per-read wrapper and stack
capture run after all resource samples stop. Empty tracking containers and IPC
observer code are common instrumentation, not production savings. Whole-case
elapsed, CPU or peak RSS can include late diagnostics and are ineligible for a
gain label. Crop independent idle observations to the recorded idle window and
state their boundary uncertainty. Preserve later shutdown resources as diagnostic
facts. One pair is feasibility only; no gain or retention decision is available.

## Proposed disposition of a new parent timer failure

Root must approve this separation before implementation or execution. The
unchanged runner currently stops whenever `qualified_case` is false. A narrow
result-classification change inside that runner would preserve this field and
the child's actual exit. It would add separate resource-completion and shutdown-
control results. Only a newly evidenced parent timer defect could permit the
next case while its correctness control remains failed.

Require every predicate below for that exception:

- The revision is actual archived parent610. Exact source/archive/runtime and
  emitted identities match the reviewed pins, and the worker PID/start identity
  belongs to this owned case. There is exactly one selected read with valid
  read/store IDs, worker role and `scriptStore: false`.
- Its actual stack positively identifies parent `tick` and the parent's real
  interval callback at the verified emitted `setInterval` callsite, with native
  timer ancestry. A generic `tick` frame, an RPC clock caller, missing ancestry,
  script-store read or unrelated lifecycle/reconciliation caller is insufficient.
  No caller is inferred from absence, event names or the old untagged trace.
- All original pre-hold checks completed. The count/direction match; real
  catch-up and the 65-second/two-pass idle assertions passed; all applicable
  wake/clock/retry/custody/repair/fencing events meet their unchanged bounds.
  There is no setup, parse, credential, request, fatal, corruption or other error.
- The same read is held before stopping and remains selected/active at the
  worker's single closed event. Positive PID/read/store identity and ordering
  use that worker's monotonic clock. No release or completion precedes close.
- Exit is exactly 1 with the original strict `ENOENT` ownership assertion at
  this owned worker's `lifetime.lock` or `runtime.json`, from the pinned workload
  assertion callsite. No unrelated failure or cleanup AggregateError replaces it.
- Original cleanup reports expected child exits, one child/port for none or
  two for a route, zero cleanup failures and successful exact-port rebinds.
  The owning runner/controller also joins every observed process group before
  fixture removal; fresh independent PID/start/group/port checks confirm teardown.

Keep `passing_cell: false`, `qualified_case: false`, actual exit 1 and an explicit
failed shutdown-control result. Store any completed resource window separately,
with this failed correctness disposition attached. If release/finish are absent
because lstat failed before release and finally stopped the child, preserve
empty arrays and mark completion unobserved. Do not call that read joined.
This exception can classify only that new tagged row; it cannot change the old
row. If any predicate is missing, stop before the next invocation.

For an exit-0 case, require a known archived worker-owned caller, all original
controls, observed RPC release and fulfilled read completion before closed,
selected read absent at close, and clean exact-child/listener teardown. Report
the limitation of late tracking. Any candidate failure stops, including a timer
ownership failure. Unknown callers and unrelated errors stop on either revision.
Do not force a timer selection after a lifecycle read passes.

If every fresh resource window completes but one or more parent controls fail
under the approved exception, report resource feasibility complete and behavior
qualification incomplete. Do not label the matrix fully qualified or change a
failed control to a pass. Pair summaries must attach both correctness outcomes
and remain ineligible for gain claims in this one-pair phase.

## Bounded request after policy and source review

Propose one attempt with a 5,400-second total application deadline and one fixed
start-plus-5,460 final deadline. Expected feasible duration is about 60 to 90
minutes; this is not a promise that all high counts will fit. Nine existing
preliminary commands retain caps totaling 215 seconds: filesystem 5, two archives
15 each, two Node24 builds 60 each, four exact-runtime/build enabled-worker
reader-race checks 15 each. This is at most 45 preliminary/timed command rows.
Include preflight, metadata and all case work in the same application deadline.
The sum of case caps exceeds the total budget; exhaustion stops with an explicit
partial matrix. Reuse installed frozen dependencies; no install.

Keep the exact binary pins already audited for the routed run. Node20 SHA256 is
`6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd`;
Node24 SHA256 is
`bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
Recheck the full 680-file compiler closure and absence of
`node_modules/.bin/node` before the inspected shim selects Node24 from PATH.
Use a curated environment without inherited compile-cache settings or Corepack.
Retain original archives and complete Git-blob/source/emitted tables.

The existing runner archives its reviewed clean HEAD as candidate. That source
includes the da21 normal regression, unlike the exact 9fd routed build. Require
198 parent source files and 195 emitted files with aggregate
`41663c8ae9c916f5613ae86def13123a29f24749da88ea14b09eeb4fb7822ebc`.
The expected candidate has 201 source and 198 emitted files with aggregate
`cc1dc274e01b9869d407e3f53c5889c38197627d21d53ada9e0304d3ce2b042a`.
Its only source/output difference from 9fd is the already tested
`sync-worker-schedule.test.ts`/`.js`; require every production file to match 9fd.
This candidate aggregate was established by the routed run's distinct third build,
not by compiling this proposal. No new TS change is proposed.

Each case keeps its 90-second setup cap from launch, including signed seed/full
validation/startup/real custody, and its unchanged 240-second outer cap. Setup
marker observation remains conservative at the 100 ms sampling boundary. Keep
65 actual idle seconds, existing request/pass/lease timings, 30-second reaction
bounds and 65-second custody/repair bounds. At capacity preserve signed deletion
and canonical count. Do not fabricate custody, lower counts or extend a deadline.

Stop on the first preliminary failure, infeasible setup, candidate control
failure, unknown/unrelated parent failure, cleanup failure or total exhaustion.
Retain partial rows, every error/exit/raw trace and every fresh unrun case. There
is no automatic restart, correction, count reduction or resume. The separate
60 seconds permits cleanup only, with TERM/KILL/reap/waits capped to the one fixed
final deadline. Retain fixtures if owned processes cannot join.

Before any execution request, separately review and pin the minimal runner result
classification, source/compiled identities and an adaptation of the existing
ignored operational controller. Preserve both executed controller versions and
manifests. The old feasibility outer timeout path cannot be reused unchanged;
its sequential grace clocks need the already reviewed fixed-deadline approach.
No new helper, timer hook, production change or general scheduling layer is needed.
These preparation changes have not been authorized or implemented by this document.

The future command shape is the existing entry point, with its full reviewed
clean source/receipt pin and a fresh output directory. It is not executable as
an approved continuation today:

```sh
python3 scripts/bench/scheduler.py \
  --candidate <reviewed-full-clean-feasibility-pin> \
  --node20 /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node \
  --node24 /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node \
  --phase feasibility --budget-seconds 5400 \
  --out /home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue95-feasibility-2
```

Mandatory large-count coverage, five alternating pairs per cell, noise/practical
benefit, startup/active/repair/clock/lifecycle gates, durable public raw artifacts,
full checks and fresh independent same-pin reviews remain required. #96's next
actual-parent smoke retains scheduling priority. No local work starts from slot
release, CI green or acceptance of this proposal alone.
