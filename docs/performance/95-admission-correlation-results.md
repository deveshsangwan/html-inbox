# Admission correlation diagnostic result

The single authorized attempt failed at the original strict receiver-count
assertion,0versus1,000, before setup completed. Tested source was
`cc6ca259d0e3a9171dc58c45f6e08ff770d6803b`, actual parent was
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`, and scheduler production remained tested9fd.
This report is a documentation-only descendant. No gain, full feasibility,
behavior or readiness qualification follows.

All five commands ran once with exits0/0/0/0/1. The controller took64.521314391s;
the actual610/exact20/count1000/outbound workload took63.442910709s. The first
controller issue was command-result for actual workload exit1, with no command
exception and successful group join/fixture removal. The raw assertion remains
`scheduler-workload.cjs:229:16`, called by `main:247:5`. Setup marker was unobserved.
No90/240/270-second setup/case/application timeout was observed.

## Exact safe events

One first event at raw row46 is1,513 UTF-8 bytes including LF, SHA256
`6f5e793b73a4e8b4ff346eacd3865bd95995da6510a563a8f71578b7bad9499e`:

```json
{"wall":1794199710352,"monotonic":15714.699953,"role":"worker","pid":3058602,"type":"issue95-first-generic-blocked","ordinal":1,"timingEligibility":"ineligible","errorKind":"error","messageKind":"communication-authorization-deadline","codeKind":"unknown","frameKind":"communication-deadline","admission":{"schema":1,"firstIdentity":"identity-json","firstRequestCallId":3,"errorCallIds":[6,3],"historyOmitted":0,"outputOmitted":0,"observationFaults":0,"calls":[[1,1,"attempt","outer-attempt",null,null,1794199756493,null,1794199699192,4553.986352,1794199699192,4554.80152,1794199705072,10434.484739,57301,57301,51421,"fulfilled",0],[2,1,"communication","attempt-registration",null,1,1794199756493,null,1794199699192,4554.58384,1794199699192,4554.795246,1794199705072,10434.391761,57301,57301,51421,"fulfilled",1],[3,1,"request","identity-json",1,null,1794199756493,5000,1794199705073,10435.432843,1794199705074,10435.943404,1794199710352,15714.329317,51420,51419,46141,"rejected",0],[4,1,"attempt","client-attempt",1,3,1794199710073,null,1794199705073,10435.717615,1794199705074,10435.941358,1794199710351,15713.573307,5000,4999,-278,"fulfilled",1],[5,1,"communication","attempt-registration",1,4,1794199710073,null,1794199705073,10435.897034,1794199705074,10435.937693,1794199710351,15713.516369,5000,4999,-278,"fulfilled",2],[6,1,"communication","request-authorization",null,null,1794199710073,null,1794199710351,15713.735844,1794199710351,15713.847818,1794199710351,15713.903927,-278,-278,-278,"rejected",1]]}}
```

Root validated the complete supplied data schema, six unique19-column records,
ID references, same-worker sample ordering and margin arithmetic. All recorded
caller labels were recognized. historyOmitted/outputOmitted/observationFaults
were0. This gives no qualification to unknown/cap/overlap/install/send/error paths.

The selected first identity request is call3. Direct synchronous request3 ->
client attempt4 -> registration5 ancestry is preserved. Later authorization6 has
null parent/request IDs; they are not reconstructed from clocks. Exact original
rejection-object lookup gives `[6,3]` at classifier input. This associates this
recorded later rejection with selected request rejection, not a globally unique
origin or a link to later durable state.

| Boundary | Submitted budget at pre-original sample | Observed result |
| --- | --- | --- |
| Request3 options cap |51,420ms remaining, requestMs5,000 | Rejected with the same object as6 |
| Initial client attempt4 | Effective deadline1794199710073,5,000ms remaining | Fulfilled reaction observed after5,277.855692ms, remaining-278ms |
| Attempt registration5 | Same effective deadline,5,000ms remaining | Fulfilled reaction observed after5,277.619335ms, remaining-278ms |
| Later authorization6 | Same effective deadline, remaining-278ms | Rejected; same original object as request3/classifier |

The request options cap1794199756493 is the enclosing cap, not the effective
inner5s deadline. Entry samples follow caller preparation; synchronous return
and observed promise reaction are different samples. The earlier interval
includes unknown queue/acquisition, protected work, cleanup and reaction delay.
No callback entry, internal lock/CPU/I/O/native-owner or host phase was measured.
OtherUnsettled includes ancestor wrappers and is not a competing-holder count.
Why that time elapsed remains unknown. No retry/deadline-policy repair is inferred.

One later mismatch at row153 is611 bytes including LF, SHA256
`437d97b3b6fb81b395917eb2faab8fb5653dc847073677683e7aebc5f424f540`:

```json
{"type":"caught-up-count-mismatch","expectedCount":1000,"sourceCount":1000,"receiverCount":0,"sourceRoute":{"present":true,"state":"reconnecting","lastError":"local-validation-or-storage-failed"},"receiverRoute":{"present":true,"state":"reconnecting","lastError":null},"localWorker":{"enabled":true,"retryPaused":false,"ownerQuarantined":false,"bootSupervised":false,"lastError":null},"localRetry":{"present":true,"attempts":1,"blocked":true,"hasDeadline":true,"lastError":"local-validation-or-storage-failed"},"localOutbox":{"pending":0,"confirmed":0,"blocked":1000,"retired":0},"receiverCommittedReceipts":0}
```

This state has no original-error identity marker. It does not automatically
connect the observed rejection to blocked outbox/retry/count state. Byte equality
to older7f's safe payload does not explain that run;85dc's551-byte state stays
separate. All histories retain their original classifications.

## Boundaries and release

Raw order is first event46, pass-finished148, initial-catch-up-settled151,
second worker pass152, mismatch153, worker stopping154, pass-finished155,
closed156 with empty activeReads, peer stopping158, cleanup160 and failure161.
Bookkeeping fulfillment is not reconciliation success. Intercepted json count1
is not native dispatch or receiver admission. Settle is not a background-drain
barrier, and parent/worker monotonic origins must not be subtracted.

Caught-up completion/setup marker,65s idle/two-periodic-pass qualification,
clock/wake/retry controls, external custody/lost-body repair, stale-route fencing
and selected held-read joining were unreached. Ordinary close does not qualify
that explicit shutdown oracle. Every instrumented timing/resource is ineligible.

LOCAL release was explicit before classification and root accepted it in
`issue95-admission-correlation-cc6ca25-root-release.json`, SHA256
`05db617912c6ec72708982ac1f50a39ebed68359ea708d26f0e1564206686a65`. All9 saved identities,6 groups/6 session pairs,
11 scoped paths and both recorded ports were accounted for.869 frozen hashes,
private390 files, parent198 source/config entries,390 outputs/195JS/index matched.
Root repeated no bind, signal or deletion. The78.650893s audit interval is inside
the SAME fixedSTART330 with186.827793s left. It is neither physical cleanup
duration nor a finish-plus60 reset. Unsampled short-lived identities and unused
interrupt/native-call paths remain unqualified.

The exact saved tool94546 terminal exit1 was written additively after release.
Root's earlier note that its sidecar was absent then remains correct; no release
or original raw record was rewritten. [The JSON receipt](95-admission-correlation-results.json)
indexes raw receipts/logs,20 executed copies, terminal and root hashes without
publishing controller issue/environment, credentials, ledgers, arbitrary status
or fixture listings. Public durable raw evidence remains a separate gate.

The cc6 hosted18-green notification is watcher evidence only. Root did not audit
job logs; historical85dc/eaff/shared CI causes remain unresolved. No retry or
readiness waiver follows. Root authorizes only a new ignored selected-mutation
and protected-callback phase proposal. It is unapplied/unexecuted; no new source,
controller/manifest/launcher/grant, runtime reservation or reviewer is authorized.
