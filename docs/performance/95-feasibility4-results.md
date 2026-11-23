# Feasibility4 stopped on a Node24 runtime frame

The once-only run at tested `8f212d30d93b0c643c87f4b1ff2f92a0fd834ca6` stopped
after eleven workload exits 0. Ten cases formally qualified. The Node24 zero-record
inbound parent case stopped on an interposed task-queue frame outside the finite
classifier policy. Its original row stays unrecognized and nonpassing. There is
no observed workload/shutdown failure, retrospective qualification or performance
retention decision. All 25 fresh unrun names remain in the
[JSON receipt](95-feasibility4-results.json), including every high-count case.

## Exact execution and outcomes

Actual parent was `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Candidate production
remains tested `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`; the already-tested da21
normal regression is the sole inherited compiled test difference. Both roles used
separate archive builds and exact existing Node20.20.2/24.19.0 binaries.

Grant `root-95-feasibility4-8f212d3-20261109-r1` launched once:

```sh
/usr/bin/python3.13 /home/agent/.t3/worktrees/html-inbox/perf-95-scheduler/artifacts/issue95-shutdown-diagnosis/controller-feasibility2-r2.py \
  --manifest /home/agent/.t3/worktrees/html-inbox/perf-95-scheduler/artifacts/issue95-shutdown-diagnosis/manifest-feasibility4.json \
  --grant-id root-95-feasibility4-8f212d3-20261109-r1
```

Controller SHA256 was `66f43e6bb44b668a3088ba1304383d1318dfd3336010af475bbab6343d851c4e`;
manifest4 was `aed83b3a19b2a37582bbeac14a1663114afc95dcfe13bd96ff0f80f19a3c0a1d`.
Outer PID/start was `3019810/90285535`, group/session `3019810/3019810`, tool session
`65946`. Pre-exec and independent live identity checks recorded Umask `0002`
read-only. No environment or Umask override was introduced by the launcher.

Start monotonic was `902855.463232282`; application/final deadlines were fixed at
`908255.463232282/908315.463232282`. Controller and runner exited 1. Controller
elapsed was 1,033.477174 seconds within the 5,400-second budget. No cap changed.
All eight outer commands ran: five pin/version checks 0, 17 pure classifier
methods 0, five cleanup methods 0, runner 1. Classifier and cleanup logs reported
17 passes in 0.411 seconds and five passes in 8.426 seconds. Those passes belong
only to tested8f, before the root task-queue correction published with this receipt.
All nine archive/build/reader preliminaries exited 0. No full suite ran.

| Zero-record cases | Workload exits | Formal result |
| --- | --- | --- |
| Node20 none/outbound/inbound, parent and candidate | Six exits 0 | Six qualified |
| Node24 none/outbound, parent and candidate | Four exits 0 | Four qualified |
| Node24 inbound parent | 0 | Unrecognized, stop |
| Node24 inbound candidate | Unrun | Unrun |
| All 24 cases at 1,000/10,000 records | Unrun | Unrun |

Archive source counts were 198/201 and emitted counts 195/198. Compiled aggregates
remained `41663c8ae9c916f5613ae86def13123a29f24749da88ea14b09eeb4fb7822ebc` and
`cc1dc274e01b9869d407e3f53c5889c38197627d21d53ada9e0304d3ce2b042a`.
Full archive, source, runtime and emitted identities are retained with raw output.

## Formal stop and separate raw observation

The stopped caller was the exact archived parent `reconcileSyncRoutes` JS99:49,
then `process.processTicksAndRejections(node:internal/process/task_queues:104:5)`,
then `async drain` at worker JS307:21. The extra frame was between application
frames, not a new application caller. The complete raw caller remains untouched.

Worker PID `3022853`, read `1`, store `1`, `scriptStore:false` recorded these
worker monotonic milliseconds:

```text
128044.595118  held
128068.263828  stopping, selected read active
128094.928238  RPC release
128102.179981  fulfilled, active reads empty
128118.421937  closed, active reads empty
```

Original shutdown-resources, pending-read-shutdown-joined and clean teardown
followed. The formal row retains exit0, `qualified_case:false`,
`passing_cell:false`, `shutdown_correctness:"unrecognized"` and
`errors:["Unknown actual archived worker-owned caller"]`. `read_joined` is absent.
The early return left release/completion fields `unobserved` before collecting
the later events. These defaults are not the complete raw trace. The summary's
failed-control entry is an operational classifier stop, not an observed shutdown
defect. No native-timer-red disposition occurred. The new correction has not been
run against or used to replace this original row.

## Cleanup and retained evidence

LOCAL was explicitly released before result classification. The owner audit at
39.542 seconds after controller exit was inside the fixed final deadline. All 67
recorded PID/start identities, 34 owned groups and 21 paths were absent; all 18
recorded timed-workload ports rebound and closed. There were 32 sampled
group/session pairs; two short-lived Popen groups lacked separate session samples.
Preliminary cleanup/reader tests retained their own port assertions, without
numeric preliminary ports for another independent bind. Controller forced signals
and adopted-child reaps were empty. Synthetic cleanup tests exercised only their
selected paths; unused controller timeout/interruption paths remain unqualified.

Root independently rechecked identities/groups/paths and accepted release; it did
not repeat owner binds. Root result SHA256 is
`7ffccdf273bd3c8ea63aa08087b8820b172528d4e824ee48221abf91313e2b4a`.
It also discloses two corrected read-only extraction mistakes, with no original
rewrite, classifier rerun or changed outcome.

Raw roots under `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07`:

- `issue95-feasibility4-grant-1` retains outer logs, receipt, independent audit and
  15 exact executed source/manifest/grant/preflight/launch copies with an index.
- `issue95-feasibility-4` retains all archives, source/emitted maps, commands,
  workload/process traces, original classification/cleanup, checkpoint and summary.

The additive 106-file index SHA256 is
`4f8025264b93f1442fa90b919d25768495f6f3cfea180a4aa0863ee61330bfac`.
Root matched 69 original runner-output hashes and outer logs. These local hashes
do not close the durable public raw-artifact gate.

## Unexecuted source follow-up

This publication copies root's two exact prepared Python files. Only pinned
Node24.19.0 may admit one exact observed task-queue frame immediately before an
existing async application frame, followed by the unchanged full application-chain
match. Raw caller text is retained. Only parent99 -> queue104:5 -> async drain307
was runtime-observed. Other existing-chain positions are synthetic coverage, not
new observations. Other versions, positions, native frames, multiple frames or
unknown application ancestry still stop. All downstream ownership/completion and
failed-parent checks are unchanged. New controls remain unexecuted.

The [scope and separate pending request](95-feasibility-source-preparation.md)
bind a new clean publication pin and manifest5, with unchanged controller66f,
caps, policies and absent fresh outputs. No grant, retry or resume follows from
publication. R2/33 unrun, the older untagged failure/25 unrun, R1 and CI history
remain immutable. Windows rename EPERM/Verify remains a separate readiness gate.
Resource feasibility, full behavior and gain eligibility remain false. Five
completed n1 zero-record pairs establish no noise bound or practical benefit;
high-count/repeated-pair/full-check/public-artifact/review gates remain open.
