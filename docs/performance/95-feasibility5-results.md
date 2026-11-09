# Feasibility5 stopped before routed high-count idle

The once-only run at tested `fad2da58d91d5608e8e89f4f0ab1657c1280cd11`
attempted 15 of 36 cases. Thirteen formally qualified and fourteen completed
resource observations. The Node24 zero-record inbound parent failed the exact
timer ownership control and continued for resource feasibility only. The first
unexpected stop was the Node20 parent 1,000-record outbound receiver-count
assertion, before idle sampling. All 21 unrun names and every attempted result
are retained in the [JSON receipt](95-feasibility5-results.json). Resource
feasibility, full behavior qualification and gain eligibility remain false.

## Pins, command and bounded credit

Actual parent was `610c931b7b22920cce59cf03e49c0de15ebaf2a2`; candidate production
remained tested `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`. This report is a
documentation-only descendant of tested fad. Separate archive builds used exact
Node20.20.2/24.19.0. Source/emitted counts were 198/195 for parent and 201/198 for
candidate, with the previously tested da21 schedule regression as the inherited
candidate test difference. Full archive, runtime and emitted identities remain
in the original environment and provenance records.

```sh
/usr/bin/python3.13 /home/agent/.t3/worktrees/html-inbox/perf-95-scheduler/artifacts/issue95-shutdown-diagnosis/controller-feasibility2-r2.py \
  --manifest /home/agent/.t3/worktrees/html-inbox/perf-95-scheduler/artifacts/issue95-shutdown-diagnosis/manifest-feasibility5.json \
  --grant-id root-95-feasibility5-fad2da5-20261109-r1
```

Controller SHA256 was `66f43e6bb44b668a3088ba1304383d1318dfd3336010af475bbab6343d851c4e`;
manifest5 was `19bb558e0d3b2dbacc9c130ea330c6c216b9ffba29aec78d048673b8b470cdd2`.
Outer PID/start was `3027498/90555400`, group/session `3027498/3027498`, tool
session `29138`. Pre-exec and independent live observations recorded inherited
Umask `0002` read-only. Application/final deadlines were fixed from start at
5,400/5,460 seconds. Controller and runner exited 1 after 1,449.098325 seconds;
no deadline was extended or exhausted.

Five pin/version checks, seventeen classifier methods, five cleanup methods and
nine original archive/build/reader preliminaries passed. The methods took
0.929/8.419 seconds. All fifteen case provenance checks and fresh cleanup checks
matched, including cleanup before the next invocation. These results qualify
only the executed source and selected controls, not exhaustive runtime stacks.

| Attempted cases | Exit and formal outcome |
| --- | --- |
| All twelve zero-record cases | Eleven qualified exits 0; one parent timer red |
| Node20 1,000 records, no routes, both roles | Two qualified exits 0 |
| Node20 1,000 records, outbound parent | Exit 1 before idle; stop |
| Remaining nine 1,000-record and twelve 10,000-record cases | Unrun |

## New parent timer failure and candidate control

Row eleven captured actual archived parent tick JS341 -> interval JS135 -> native
timer ancestry on Node24.19.0. Worker `3030040`, read `1`, store `1`,
`scriptStore:false` recorded held `127578.382028`, stopping `127597.791068`, then
closed `127601.860146`, with the selected read still active. These are that
worker's monotonic milliseconds. No release or completion was observed. The
original owned `lifetime.lock` ENOENT at workload JS339 remains unchanged.

The row remains exit1, failed shutdown correctness, nonpassing, unqualified and
`read_joined:false`. Its completed resource observation allowed only the exact
granted resource continuation. Fresh cleanup at `906586.819053448` preceded the
next candidate start at `906587.14181239`. The matching candidate released its
read by RPC, fulfilled it, then closed with no active reads. This new tagged
baseline failure does not identify or reclassify the older untagged failure.

## First unexpected stop and observation limits

Row fifteen exited 1 after 56.124863 seconds. `assertCaughtUp` at workload JS170
found zero receiver records instead of 1,000. It reached neither `caught-up`, the
setup marker, idle sampling nor the held-read control. The original classifier
retains the broad `Setup/case bound failed` error, unrecognized shutdown status
and nonpassing/unqualified fields. The raw assertion is narrower evidence; no
90-second setup or 240-second case timeout was observed.

The observer increments `completedPasses` after `recordWorkerRun` fulfills. That
is bookkeeping, not successful reconciliation. Its request counter increments
before the original `SyncClient.json` call; one identity invocation does not
prove native request dispatch or receiver admission. A second worker pass event
occurred before the parent's `initial-catch-up-settled` event. Status and settle
do not prove all background reconciliation joined. Parent and child
`performance.now()` origins differ and cannot be subtracted. Original request,
pass and reconcile defaults remain 5/60/30 seconds. The cause is unresolved;
there is no production-repair justification.

## Release, evidence and remaining gates

LOCAL was explicitly released before classification. All eighty recorded
PID/start identities, 38 PGIDs and 25 paths were absent, with no unreadable
`/proc` entries. All 24 recorded timed ports rebound. Thirty-seven group/session
pairs were sampled; one group lacks a separate session sample. Preliminary
numeric ports were not retained for independent rebind.

The physical owner audit was 48.071213 seconds after controller finish. Its
initial extraction expected numeric cleanup ports, although those fields are
URLs. An additive annotation at 66.575515 seconds confirmed all URL ports were
already covered by the original binds. Both receipts remain immutable, inside
the fixed start-plus-5,460 final deadline. The annotation was not new physical
cleanup. Root independently rechecked identities/groups/paths and URL coverage;
it did not bind or signal. Successful runs do not qualify unused controller
timeout/interruption or native-call paths.

Raw roots under `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07`
are `issue95-feasibility5-grant-1` and `issue95-feasibility-5`. Root verified 89
runner-output hashes, fifteen executed inputs and every case's provenance and
cleanup order. The JSON preserves selected original hashes and root result,
release and decision references. Local references do not close the durable
public raw-artifact gate.

Feasibility4's stopped row and 25 unrun, R2's original row and 33 unrun, the older
untagged failure and 25 unrun, R1 and all CI histories remain unchanged. Current
Ubuntu24 Browser count0-versus3 is unresolved. Verify adds only an aggregate
failure, without dependency mapping from its result string. Windows EPERM and
other shared histories remain separate. No CI retry or assertion repair occurred.

Seven completed pairs each have one observation. They establish no noise bound,
practical benefit or retention decision. The only next preparation is an ignored
failure-only proposal using the two snapshots already acquired by `assertCaughtUp`.
There is no tracked harness change, runtime grant, matrix continuation or reviewer.
