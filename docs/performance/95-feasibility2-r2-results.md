# Second feasibility attempt stopped at classifier coverage

The granted R2 attempt stopped after three workload exits 0. Two Node20 zero-record
zero-route cases qualified. The next parent outbound case reached an awaited
reconciliation read that the reviewed classifier did not recognize. This is an
operational classifier coverage stop, with no observed worker or shutdown failure.
The original verdict remains unchanged. Thirty-three fresh cases remain unrun,
including every 1,000/10,000-record case and every Node24 workload.

The [machine-readable receipt](95-feasibility2-r2-results.json) preserves commands,
identities, classification fields, raw shutdown observations and the exact unrun
list. No classifier, worker, workload, controller, assertion or deadline changed
during or after this attempt. No correction or further execution is authorized.

## Execution and provenance

Grant `root-95-feasibility-02fc856-20261108-r2` executed once at clean
`02fc856f99a0e37fd443529e0b8f5c52a61c5202`, against actual parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Candidate production remains identical
to tested `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`. The only compiled difference
from that production pin is the already-tested `sync-worker-schedule.test.js`
regression. Builds used separate Git archives and existing frozen dependencies.

The exact launch used `/usr/bin/python3.13` and the versioned ignored files under
`artifacts/issue95-shutdown-diagnosis`:

```text
controller-feasibility2-r2.py --manifest manifest-feasibility2-r2.json --grant-id root-95-feasibility-02fc856-20261108-r2
controller SHA256 66f43e6bb44b668a3088ba1304383d1318dfd3336010af475bbab6343d851c4e
manifest SHA256   ae33134247a989817a91978c3cf58db0f30aa41ffd277c11f73505cacea34c5c
```

The JSON records full absolute argv. Outer PID/start was `2928152/88316468`,
group/session `2928152/2928152`, tool session `16234`. Start monotonic was
`883164.779338089`; the fixed application/final deadlines were
`888564.779338089/888624.779338089`. Controller and runner exited 1 after
248.452881 controller seconds. Neither deadline was extended.

All eight outer commands ran. Five pin/runtime checks exited 0, all 17 pure
classifier/guard methods passed, and all five existing owned-group cleanup methods
passed. The feasibility runner then exited 1. Its nine preliminary commands all
exited 0, including both isolated archive builds and four reader-race checks on
exact Node20.20.2/24.19.0. Each Node20 reader invocation reported one pass and 32
nonmatching skips; Node24 reported one pass and zero skips. No full suite ran.

The parent archive has 198 source entries and 195 emitted files, aggregate
`41663c8ae9c916f5613ae86def13123a29f24749da88ea14b09eeb4fb7822ebc`.
Candidate has 201 source entries and 198 emitted files, aggregate
`cc1dc274e01b9869d407e3f53c5889c38197627d21d53ada9e0304d3ce2b042a`.
Archive hashes and complete table references are in the JSON receipt.

## Three attempted cases

| Node20.20.2, zero records | Child exit | Formal verdict | Actual idle | Completed idle passes |
| --- | ---: | --- | ---: | ---: |
| Parent, none | 0 | Qualified, shutdown passed | 65.004 s | 2 |
| Candidate, none | 0 | Qualified, shutdown passed | 65.006 s | 2 |
| Parent, outbound | 0 | Unrecognized, unqualified, stop | 65.005 s | 3 |

The first two actual callers were archived `assertManagedLifecycle` under `drain`.
Each selected read was active at stop, then released by RPC and fulfilled before
close. The outbound trace instead identifies worker PID `2928947`, read `1`,
store `1`, `scriptStore:false`, at actual parent
`reconcileSyncRoutes`, `sync-reconciliation.js:99:49`, awaited by `drain`,
`sync-worker.js:307:21`. It does not identify a native timer caller.

Worker monotonic milliseconds preserve the outbound sequence:

```text
98459.498942  read held, reconciliation -> drain
98466.057200  stopping, selected read active
98491.249770  RPC release
98493.833251  fulfilled read, active reads empty
98503.106184  closed, active reads empty
```

The child completed its original shutdown assertion and cleanup. Formal fields
remain `qualified_case:false`, `passing_cell:false`,
`shutdown_correctness:"unrecognized"`, with
`errors:["Unknown actual archived worker-owned caller"]`. Its early return happens
before the classifier collects release/completion events. The retained
`release_observation:"unobserved"` and `completion_observation:"unobserved"` are
therefore defaults at that return, not a complete description of the raw trace.
This receipt does not retroactively qualify or relabel the cell. The summary's
`failed_shutdown_controls` entry records that formal policy failure, not an
observed shutdown defect. Owner and root static review both missed this awaited
reconciliation path.

All original workload assertions ran. Explicit wake and four clock/gap reactions
completed in each case. Outbound retry lateness was 249 ms, real external-commit
custody took 618.833 ms, and lost-body repair took 30,487.896 ms. Stale-route
rejection preceded the held read. The natural diagnostic flag stayed unset;
tracking installed only after resource sampling, with no controlled startup
tracking, completed-ticket barrier or added ticket. Fresh classification/cleanup
evidence preceded each subsequent invocation. No known-parent timer-failure
disposition occurred.

## Cleanup and retained evidence

Every owned command settled before fixture removal and explicit LOCAL release.
The independent owner audit found all 37 recorded PID/start identities, 26 owned
PGIDs and 13 fixture paths absent. There were 23 observed group/session pairs;
three short-lived preliminary PGIDs lacked a separately sampled start/session
witness. All groups were scanned absent. The owner independently rebound and
closed the four exact timed-workload ports `39049`, `40129`, `42967`, `46179`.
The five cleanup methods and four reader checks passed their own port-rebind
assertions; their numeric ports were not retained for another independent bind.
The outer controller recorded no forced signals or adopted-child reaps. Cleanup
tests separately exercised their selected termination/failure paths. Normal
completion does not qualify unused controller timeout/interruption paths.

Root accepted release and independently rescanned the 37 identities, 26 PGIDs
and 13 paths, finding none and no unreadable `/proc` entries. Root retained the
owner's bind evidence without repeating binds. Root audit SHA256 is
`d0ad26ee099e41e4b9227b244910aea645f872f58f24946828a3e03845c47148`.

Raw roots under `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07`:

- `issue95-feasibility2-grant-2` contains the outer receipt, logs, exact executed
  operational copies, launch/preflight, independent cleanup and SHA256 index.
- `issue95-feasibility-2` contains all original archives, source/emitted maps,
  commands, per-case workload/process traces, classifications, cleanup, checkpoint
  and summary. Original and specified synthetic-token-redacted digests remain.

The 54-file index SHA256 is
`4794bf220f2f26b5fed7994959047369536778f6e27d65898c6d3823c8363524`.
These retained local paths do not satisfy the durable public raw-artifact gate.

The original untagged failed row and 25 historical unrun cells, R1 admission
failure and review limitation, and separately proven minimized timer-ownership
defect remain unchanged. All 33 fresh unrun names are in the JSON. Resource
feasibility, full behavior qualification and gain eligibility remain false.
The single completed zero-route pair cannot establish benefit beyond noise or
justify retention. High-count qualification, repeated pairs, full checks and
both independent reviews remain open. Hosted 02fc green is separate CI evidence;
the historical Windows EPERM cause remains unresolved.
