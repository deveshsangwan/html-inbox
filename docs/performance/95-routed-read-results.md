# Routed held-read diagnostic receipt

Both controlled zero-record inbound cases passed the original strict ownership
assertions. Their actual archived caller stacks identify `drain` calling
`assertManagedLifecycle`; the selected read completed before worker close on both
parent and candidate. This is a controlled nonreproduction. It does not identify
the original failed workload's caller or change its failed row and 25 unrun cells.
The separately reproduced parent timer-read defect remains documented in
[the earlier diagnostic](95-shutdown-read-results.md).

Grant `root-95-routed-read-da21-20261108-r1` ran once, without controller changes,
at clean source `da21f4ee0f3a37a52f1692ef32b9fb83840f0fa8`. Actual parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`, frozen production candidate
`9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f` and new-test source da21 were separately
archived and compiled with exact Node 24.19.0 and the frozen compiler closure.
All 16 commands exited 0. The selected normal-discovery timer-ownership regression
passed once on Node 24.19.0, then once on Node 20.20.2. Node 24 filtered the other
tests; Node 20 reported twelve nonmatching tests skipped. The selected test had
zero failures or cancellations on either runtime. No full suite ran.

Parent/candidate source tables contain 198/201 files and emitted JavaScript tables
contain 195/198 files. Their compiled aggregates match the previously approved
`41663c8a...` / `742950a6...`. The third archive contains 201 source and 198 emitted
files. Only `sync-worker-schedule.test.ts` and its emitted `.test.js` differ from
9fd; all other source/output identities match. Complete archive, source, emitted
output, runtime and compiler fingerprints, exact commands, exits, output digests
and selected-read events are referenced by [the compact receipt](95-routed-read-results.json).

Each routed case retained real protocol catch-up, 65 actual idle seconds, at least
two completed periodic passes, explicit wake, all four clock events, persisted
retry deadline, external custody, empty-outbox lost-body repair, stale-route
fencing, held-read shutdown and exact-port/child cleanup. Parent/candidate idle
observations lasted 65,003.118/65,002.147 ms with three/two completed passes.
Every reaction met the unchanged 30-second bound; retries were not early.
External custody completed in 30.511/30.516 seconds and repair in 30.182/30.233
seconds, within the unchanged 65-second limits. Setup checkpoints were observed
at 0.833/0.805 seconds, using the conservative sampling-boundary interpretation.

The diagnostic flag tracked reads before worker startup. Immediately before
arming, both cases established the same real error-free completed foreground
ticket and no-active-read barrier. This additional pass changes real bookkeeping
and scheduling phase. It is controlled setup, not the old execution history, and
the original `settle` call was not treated as a drain. No extra request was
admitted by the revoked-route barrier. The pre-arm event cursor retained the
selected caller without forcing a timer phase.

The parent selected read 590/store 19 in worker PID 2890867; the candidate selected
read 101/store 17 in PID 2891843. Actual archived lifecycle/worker paths and stacks
establish the caller; numeric store IDs alone establish no authority. Both traces
show the selected read active at stop, explicit RPC release, fulfilled completion
and then one closed event with no active reads, using each worker's own monotonic
clock. Neither case produced a newly tagged baseline failure. Every diagnostic
row keeps `passing_cell: false` and resource-gain eligibility false.

The unchanged failure path still asserts both ownership files before release-read
and calls stop in finally. A failing parent could therefore have no release or
completion event. The controller preserves those absences, and requires a known
strict ownership error, actual archived caller/read identity and clean teardown
before classifying a new baseline-control failure. That red-classification path
was not exercised here and was not qualified by these successful cases.

The outer controller exited 0 after 263.774 seconds within its one fixed
900-second application deadline and start-plus-960 final deadline. Individual
caps total 820 seconds; routed cases retained their 240-second case and 90-second
setup limits. No retry, correction, timeout, interruption or signal cleanup ran.
The controller created each owned fixture before spawn and assigned a catalog
path under it; it did not itself create that catalog directory before spawn.

After exit, independent inspection found all 27 recorded PID/start identities,
including the outer controller, and all 17 recorded process groups absent. All
four exact loopback ports rebound and closed; scratch and all sixteen command
fixture roots were absent. The LOCAL slot was explicitly released before this
packaging. Successful cleanup does not qualify unused timeout/interruption,
TERM/KILL grace or adopted-child reaping paths.

Original archives, complete identities, redacted raw traces/TAP, original output
digests, the exact operational controller/manifest and fresh cleanup audit remain
under `artifacts/performance-issues-2026-11-07/issue95-routed-read-1/` in the root
workspace. Its `raw-files.json` fingerprints the retained inputs and outputs.
Public raw-artifact publication remains an open deliverable. No resource gain,
large-count feasibility, retention decision, matrix continuation or independent
review follows from this diagnostic. PR #121 remains draft.
