# Admission phase diagnostic: failed count assertion

The one granted actual-parent diagnostic at `4f554c98028f5afb71a4e4feb931d7d9b970a314` failed the original
receiver-count assertion, `0 !== 1000`, before setup completion or idle controls.
All five commands ran with exits `0/0/0/0/1`; controller/tool exit remained 1.
The requested phase boundary question has been answered at observed, source-reviewed
boundaries. The mechanism consuming those intervals and any connection to durable
blocked/count state remain unproved. This is failed diagnostic evidence, with no
performance, full-feasibility, behavior, CI or readiness approval.

Actual parent is `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Candidate production remains equivalent
to `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`. This documentation publication is a separate descendant
of tested 4f; it changes no executable. The run reused the existing exact 390-file
parent input on Node 20.20.2, without a build, install, candidate or Node 24 command.
[Selected original data, columns, arithmetic and hashes](95-admission-phases-results.json)
retain the complete safe event and mismatch.

## Scope and original failure

Grant `root-95-admission-phases-4f554c9-20261109-r1` allowed three Git checks 5s each,
exact Node 20 version 5s, then one parent/count1000/outbound65000 workload 240s/setup 90s.
Admission 30s/application 270s/fixed START+330s and at most 60s cleanup were assigned once.
Original request 5s/pass 60s/reconcile 30s/idle 65s/two-pass/reaction 30s/custody 65s controls
and all strict assertions stayed unchanged. Natural startup tracing remained
unset; no extra ticket, barrier, retry or timer rephasing was added.

Controller elapsed 79.741093s, workload 78.652878s. The command had no recorded error
or observed setup 90s/case 240s/application 270s timeout. First unexpected controller
result was the workload's exit 1. The original assertion at
`scheduler-workload.cjs:229:16` through `main:247:5` was serialized after cleanup.
No command remained unrun; successful setup, 65s idle/two periodic passes,
wake/clock/retry reactions, actual custody/lost-body repair, stale fencing and
held-read shutdown controls were unreached. Status/settle is not a full drain.
A fulfilled `recordWorkerRun` is bookkeeping, and an intercepted identity call
precedes native request dispatch or receiver admission.

## Exact bounded observations

One event at original row 51 is 1,857 UTF8 bytes including LF, below the 4,096-byte cap.
SHA256 `2a37d687ca3a16de8da89d0d82e8ec75b1914191a9967de62684d5e7e4b6a089`. Six unique 19-cell admission rows and two 7-cell
phase rows satisfy the complete supplied schema as DATA only. The payload has no
observed history/output omissions, admission/phase faults or selection misses.
It retains one observed callback entry. This does not qualify missing, overcap,
trimmed, repeated, sync-throw, installation or unused timeout paths.

```json
{"wall":1794203814464,"monotonic":17442.454539,"role":"worker","pid":3069289,"type":"issue95-first-generic-blocked","ordinal":1,"timingEligibility":"ineligible","errorKind":"error","messageKind":"communication-authorization-deadline","codeKind":"unknown","frameKind":"communication-deadline","admission":{"schema":1,"firstIdentity":"identity-json","firstRequestCallId":3,"errorCallIds":[6,3],"historyOmitted":0,"outputOmitted":0,"observationFaults":0,"phases":{"schema":1,"selection":"selected","callId":5,"callbackEntriesObserved":1,"selectionMisses":0,"observationFaults":0,"mutation":[1794203808215,11192.993598,1794203808215,11193.032986,1794203814463,17440.917169,"fulfilled"],"callback":[1794203812138,15116.820182,1794203812139,15116.875041,1794203813483,16461.252679,"fulfilled"]},"calls":[[1,1,"attempt","outer-attempt",null,null,1794203858900,null,1794203801551,4529.391492,1794203801552,4530.457203,1794203808213,11191.232837,57349,57348,50687,"fulfilled",0],[2,1,"communication","attempt-registration",null,1,1794203858900,null,1794203801552,4530.041559,1794203801552,4530.449435,1794203808213,11191.12448,57348,57348,50687,"fulfilled",1],[3,1,"request","identity-json",1,null,1794203858900,5000,1794203808214,11192.293676,1794203808215,11193.044445,1794203814464,17442.081769,50686,50685,44436,"rejected",0],[4,1,"attempt","client-attempt",1,3,1794203813214,null,1794203808214,11192.622096,1794203808215,11193.041574,1794203814463,17441.329248,5000,4999,-1249,"fulfilled",1],[5,1,"communication","attempt-registration",1,4,1794203813214,null,1794203808214,11192.815556,1794203808215,11193.038197,1794203814463,17441.245586,5000,4999,-1249,"fulfilled",2],[6,1,"communication","request-authorization",null,null,1794203813214,null,1794203814463,17441.493972,1794203814463,17441.599779,1794203814463,17441.655889,-1249,-1249,-1249,"rejected",1]]}}
```

Selected communication 5 has retained source/store/request ancestry
`5 attempt-registration -> 4 client-attempt -> 3 identity-json`, all store 1/request 1.
The pinned exact immediate `startCommunication` frame at emitted `sync-store.js453`
and the per-invocation closure establish selection. The payload retains labels
and numeric identities, not a raw stack. Neither clocks nor a shared deadline
establish that ancestry.

Both selected phase 5 mutation and callback observations fulfilled. Phase5 is
**not an errorCallId**. Exact original-error links `[6,3]` associate the standalone
later authorization rejection with selected request 3 and classifier input.
Call 6 parent/request remain null. This does not state phase 5 generated the later
error or connect the error object to durable blocked/count state. Propagated,
reused, replaced or omitted errors outside the recorded window remain a limit.

The source-selected mutation's pre-original sample to callback entry was
3923.826584ms; callback entry to its fulfillment reaction was 1344.432497ms;
callback reaction to mutation fulfillment reaction was 979.664490ms. Total observed
mutation interval was 6247.923571ms. Synchronous mutation/callback returns were
0.039388/0.054859ms. These are distinct boundaries and side-observer reactions.
All use the same worker clock; parent/peer `performance.now()` origins are not
subtracted from it.

Request3 options cap was 1794203858900 with requestMs 5000; the effective inner
client-attempt deadline was 1794203813214. Remaining margins were 4999ms at mutation
pre-original, 1076ms at callback entry, -269ms at callback observed fulfillment and
-1249ms at mutation/client/registration observed fulfillment. Later authorization 6
was already 1249ms past that inner deadline at its pre-original sample.

Pinned mutate 1099-1122 has directory, acquisition, recovery, ledger, anchor,
barrier and reader work before callback. The startCommunication 453-475 callback
contains authorization/baseline/start; baseline 1240-1252 syncs the checked ledger
and flushes five directories. These are source alternatives, not attribution of
recorded duration. The post-callback interval also includes promise adoption,
ownership cleanup and handler scheduling. No interval directly measures lock wait,
CPU, I/O or native cleanup. Callback/prototype substitution, added handlers,
stacks, clocks, IPC and V8 effects remain unquantified. Every instrumented timing
and resource observation is gain-ineligible, including observations before failure.

The later mismatch at row 187 is 579 bytes including LF, SHA256
`3fa910d5d133fecaeb5bf976573bcd57c9cf782ed17563b7d49682c21796a785`. Both route lastError values are null; preserve this
payload rather than earlier 611-byte or 551-byte states.

```json
{"type":"caught-up-count-mismatch","expectedCount":1000,"sourceCount":1000,"receiverCount":0,"sourceRoute":{"present":true,"state":"reconnecting","lastError":null},"receiverRoute":{"present":true,"state":"reconnecting","lastError":null},"localWorker":{"enabled":true,"retryPaused":false,"ownerQuarantined":false,"bootSupervised":false,"lastError":null},"localRetry":{"present":true,"attempts":1,"blocked":true,"hasDeadline":true,"lastError":"local-validation-or-storage-failed"},"localOutbox":{"pending":0,"confirmed":0,"blocked":1000,"retired":0},"receiverCommittedReceipts":0}
```

Original order was event 51, bookkeeping pass 182, initial-settled 185, second worker
pass 186, mismatch 187, stop 188, pass-finished 189, closed 190 with empty active reads,
peer stop 192, cleanup 194, serialized assertion 195. The earlier event has no original
error-object link into the later snapshot, retry, outbox or count state.

## Release and retained evidence

Owner explicitly released LOCAL before classification. All 9 saved PID/start
identities, 6 PGIDs/6 session pairs and 11 scoped fixture paths were absent; no
unreadable/proc errors. The two original URL ports 41393/36909 rebound once.
All 869 pins, private 390 regular single-link0400 files/dist0500/root0700,
actual parent610 198 source/config entries,390 outputs/195JS/index and 25 executed copies
matched. Original terminal tool 5147/chunk 77805f exit 1 is saved. No controller
signals, cleanup interventions or adopted reaps occurred.

Owner audit was 123.133874s after controller finish and 127.125033s before the SAME
fixed final 922024.076686545. That interval is not physical cleanup duration or new
finish-plus60 authority. Root independently corroborated saved identities/paths
and input/copy/log hashes later, read-only, without binds, signals or deletes.
Unseen short-lived identities are not invented, and only the two original URL
ports have bind evidence. Successful paths establish no generic interruption or
native-call guarantee.

Root disclosed two additive receipt-reader corrections. Owner port witness lines
are one-based; the initial root reader used zero-based indexing. Workload stdout
uses `jsonl_original_sha256`, while other stdout files use `tap_original_sha256`.
Both corrected read-only checks matched the original evidence. Neither is an
application defect, application retry or raw rewrite. The JSON records their
receipt hashes and the accepted root result/release/decision references.

The original private receipt is 289606 bytes, SHA256
`73f60d729f28e9d64de087afacb820a9160ad576cc0882a42621a8235cbae825`;
workload JSONL 86308 bytes, SHA256
`6e8e1b262e32775e0a9bc0d7f2a016721ba3966e2e30ca897bdaad9044443b65`.
All ten log hashes and 25 copied input identities remain indexed privately.
This report publishes no full controller environment/issues, credentials/control
tokens, managed ledger, status dump or fixture-entry listing. Durable public raw
artifact delivery remains an unmet gate; selected safe extracts are not that gate.

## Historical and current gates

Original untagged failure/25 unrun, R1 admission stop, R2 formal unrecognized
row/33 unrun, feasibility4 stop/25 unrun and feasibility5 high-count stop/21 unrun
remain immutable. The separately proven parent timer ownership red remains failed,
nonpassing and unjoined. This run does not identify the old untagged caller,
resume any matrix or retroactively replace a stopped row. Earlier count,
first-classification and correlation payloads retain their own identities and
causality limits. See [feasibility5](95-feasibility5-results.md),
[prior correlation](95-admission-correlation-results.md) and their linked histories.

Tested4f hosted Source failed separately on eligibleLookups 0 versus 2 after
publication returned; eligible custody/suppression commands and later result
assertions were unreached. Verify adds only the aggregate gate. Those failures,
36a and all shared historical causes remain unresolved. New documentation-head
CI is separate and unassessed. There was no CI retry, assertion/deadline/policy
repair, cause/baseline/flake claim or readiness waiver.

Mandatory 0/1000/10000 counts, none/outbound/inbound, both exact runtimes,
actual-parent comparisons, >=5 alternating pairs, practical idle benefit beyond
noise, full checks, durable raw evidence, two fresh same-pin whole-diff reviews
and root/final gates remain open. Keep PR121 draft and both issue95 links.
LOCAL is free; the grant is consumed. No new observer/probe proposal, source fix,
binding, helper, reviewer, runtime or automatic next attempt is authorized.
