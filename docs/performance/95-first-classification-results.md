# First classification diagnostic result

The single authorized diagnostic failed. Tested source was
`85dc034eede0dada7c2b1628a9c7fb84c958d3c3`, actual parent was
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`, and scheduler production remained
at tested9fd. This report is a documentation-only descendant. There is no gain,
full feasibility, behavior or readiness qualification.

All five commands ran once. Their exits were `0/0/0/0/1`: three Git admissions,
exact Node20.20.2 version, then actual610/count1000/outbound/65000 workload.
The controller took56.094544901 seconds; the workload took54.997439740 seconds.
The unchanged strict receiver-count assertion failed with `0 !== 1000` at
`scheduler-workload.cjs:229:16`, called from `main:247:5`.
The first controller issue is `command-result` for actual workload exit1,
with no command exception and successful group join/fixture removal.
Setup completion was unobserved. This was no observed90/240/270-second timeout.

## Exact safe observations

One first-classification event appeared at raw row58. Its293 UTF-8 bytes including
LF hash to `4a05b9b3bbdf670801fe21bd7d216be73e44b47eeddb8c2f154dc6d040540ba0`:

```json
{"wall":1794196414151,"monotonic":19889.058637,"role":"worker","pid":3050234,"type":"issue95-first-generic-blocked","ordinal":1,"timingEligibility":"ineligible","errorKind":"error","messageKind":"communication-authorization-deadline","codeKind":"unknown","frameKind":"communication-deadline"}
```

The first matching original generic-blocked classification supplied an Error
prototype, exact communication authorization deadline message and pinned
communication-deadline frame enum. `codeKind:unknown` means no recognized code,
not a guessed native error. These enums do not identify the admission caller,
explain expiry or connect the original error object to later durable state.

One later mismatch appeared at raw row130. Its551 bytes including LF hash to
`86e5d71e6e0abac1030c6e8ebc5e41539b4109e3d150065edf2c8bd91e213683`:

```json
{"type":"caught-up-count-mismatch","expectedCount":1000,"sourceCount":1000,"receiverCount":0,"sourceRoute":{"present":true,"state":"reconnecting","lastError":null},"receiverRoute":{"present":true,"state":"reconnecting","lastError":null},"localWorker":{"enabled":true,"retryPaused":false,"ownerQuarantined":false,"bootSupervised":false,"lastError":null},"localRetry":{"present":false,"attempts":null,"blocked":null,"hasDeadline":null,"lastError":null},"localOutbox":{"pending":0,"confirmed":0,"blocked":1000,"retired":0},"receiverCommittedReceipts":0}
```

The source snapshot contains1,000 records and the receiver0. Both routes are
reconnecting with null lastError. Local retry is absent, with null fields rather
than invented zeros; all1,000 local outbox entries are blocked and receiver
committed receipts are0. This differs from the prior7f diagnostic's captured
state. No new field or enum is assigned to that or any older failure.

## Reached boundaries and limits

The worker and peer started. First-classification58 precedes pass-finished125;
a second worker pass event127 precedes initial-catch-up-settled129, which reports
completedPasses1/requests1. Mismatch130 precedes stopping131, pass-finished132,
worker closed133 with empty activeReads, peer stopping135, cleanup137 and the
original assertion report138.

Fulfilled recordWorkerRun counts bookkeeping, not reconciliation success.
The observer increments requests before original SyncClient.json; one identity
invocation proves neither native request dispatch nor receiver admission.
Status/settle does not join all background work. Parent and worker monotonic
origins differ and must not be subtracted. Ordinary closed evidence does not
qualify the explicit held-read shutdown control, which was never reached.

Caught-up assertion completion/setup marker,65-second idle/two-pass qualification,
clock/wake/retry reactions, external-commit custody/lost-body repair, stale-route
fencing and selected held-read joining were unreached. All instrumented resource
and timing observations are gain-ineligible, including the admission intervals.
No diagnostic failure/oversize/send/install or unused timeout/interruption path
receives qualification from this one emitted event.

Actual610 source has a plain communication deadline guard before mutate at
sync-store.ts547-551. Both initial client attempt registration and later request
authorization can reach it; outer reconciliation also opens an attempt. The
current payload identifies none of those callers. The narrow acquisition test
and design deliberately exclude raw precheck and later admission errors from
initial typed-queue retry translation. No retry/deadline-policy repair follows.

## Release and preserved evidence

LOCAL was explicitly released before classification. Root accepted release in
`issue95-first-classification-85dc034-root-release.json`, SHA256
`032847338237e31e57541996200544d40fdb217ec11ceb4e4c78f0f146ac89b2`. All11 recorded PID/start identities,
6 groups/6 session pairs and11 owned paths were absent; both recorded ports
rebound successfully.869 frozen hashes, private390 regular input files,
198 parent source/configuration entries,390 parent outputs/195JS and parent
index remained unchanged. Root repeated no bind, signal or deletion.

The owner audit was59.172186 seconds after finish, inside the SAME fixed
start-plus330 final with214.733269 seconds remaining. This is neither physical
cleanup duration nor a new finish-plus60 deadline. Only actually recorded
identities/groups/ports are covered; unseen short-lived children or listener
identities are not invented. No generic unused native-call/interrupt guarantee.

[The JSON receipt](95-first-classification-results.json) indexes original private
receipt/logs,20 executed input copies, terminal83330 exit1 and root result hashes.
No raw controller issue, token, ledger, full status or fixture listing is published.
Original payloads, logs, manifests, controllers, indexes and prior histories are
unchanged. Public durable raw evidence remains a separate gate.

Current85dc Windows initial page.goto ERR_NO_BUFFER_SPACE and aggregate Verify
remain red and unresolved. Historicaleaff viewer-record EPERM/aggregate and all
older CI failures remain separate. No CI retry, shared fix or readiness waiver.

Root permits only a new ignored observer proposal for bounded call/error identity
and same-process entry/return/deadline observations. It is unapplied/unexecuted;
there is no controller/manifest/launcher preparation, production edit, runtime
grant, replay, candidate/Node24 follow-on, matrix continuation or reviewer.
