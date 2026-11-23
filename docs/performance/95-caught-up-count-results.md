# One-parent caught-up diagnostic failed before idle

The once-only diagnostic at tested `7f7eed075d703d25e02403534455642601a2d546`
failed the original strict receiver-count assertion: zero records instead of
1,000. Four admission commands exited0 and the one workload exited1. Exactly one
611-byte safe state payload preceded the assertion. The underlying exception is
unknown. No idle resource observation, performance or readiness qualification
was established. This report is a documentation-only descendant of tested7f.

## Execution and exact selected observation

The workload ran on exact Node20.20.2 using actual parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`, with the byte-verified private390-file
input. Production candidate remained9fd. The [JSON receipt](95-caught-up-count-results.json)
contains exact argv, five command outcomes, payload line/hash and private raw
references. No raw ledger, token, status object or fixture entry listing is copied.

```sh
/usr/bin/python3.13 /home/agent/.t3/worktrees/html-inbox/perf-95-scheduler/artifacts/issue95-shutdown-diagnosis/controller-caught-up-count-v1.py \
  --manifest /home/agent/.t3/worktrees/html-inbox/perf-95-scheduler/artifacts/issue95-shutdown-diagnosis/manifest-caught-up-count-v1.json \
  --manifest-sha256 6ca926dd8cb751c686dae3dceb11ec6f2c924db96f0ca6710927c0b840da6b65 \
  --grant-id root-95-caught-up-count-7f7eed0-20261109-r1
```

Controller SHA256 was `62a16b74b266ed965160266c0685cbc555ffac2e5e848ecf85d61a1c88e69d1e`.
It exited1 after69.563880 seconds; workload elapsed was68.479262 seconds. Three
Git5s checks and exact20 version5s passed. Admission30/application270/fixed
start330, setup90/case240, request5/pass60/reconcile30 and all original bounds
were unchanged. No setup, case or application timeout was observed.

The single fixed-tag payload was611 UTF-8 bytes including newline, SHA256
`437d97b3b6fb81b395917eb2faab8fb5653dc847073677683e7aebc5f424f540`:

| Captured field | Exact value |
| --- | --- |
| expectedCount / sourceCount / receiverCount | 1000 / 1000 / 0 |
| sourceRoute | present:true, reconnecting, local-validation-or-storage-failed |
| receiverRoute | present:true, reconnecting, lastError:null |
| localWorker | enabled:true; retryPaused/ownerQuarantined/bootSupervised:false; lastError:null |
| localRetry | present:true, attempts:1, blocked:true, hasDeadline:true, local-validation-or-storage-failed |
| localOutbox | pending:0, confirmed:0, blocked:1000, retired:0 |
| receiverCommittedReceipts | 0 |

The strict assertion in finally failed at workload JS229:16, called by initial
main JS247:5. Source/receiver snapshots, readiness, bookkeeping and existing
settle observation were reached. Setup completion, the caught-up marker, idle65/
two periodic passes, wake/clock/retry reactions, external custody, repair, stale
fencing and held-read joining were unreached. The positive1000/outbound setup-
marker branch and diagnostic-failure/oversize paths remain unexercised.

## What this observation establishes

Generic non-protocol exceptions map to the blocked classification and fixed code
`local-validation-or-storage-failed`. The payload records that category, not its original exception or failed
request phase. One intercepted identity invocation precedes the original
SyncClient.json; it does not prove native dispatch or receiver admission.
completedPasses follows fulfilled recordWorkerRun bookkeeping, not reconciliation
success. A second worker pass event preceded the settled observation; its
bookkeeping completion followed stopping. Parent and worker monotonic origins
differ and cannot be subtracted. No particular authorization, storage, validation,
deadline, native actor or scheduler cause is proved.

The raw payload contains no extra identifiers, paths, URLs or raw error. Missing
or failed diagnostic output in a different run would remain missing evidence.
This new state is not assigned retrospectively to feasibility5's older failed
row. All whole-case/status CPU and RSS observations remain gain-ineligible.

## Release, evidence and remaining scope

LOCAL was released before classification, with root acceptance. All nine recorded
PID/start identities, six groups/session pairs and eleven paths were absent;
both recorded timed ports rebound. All867 frozen hashes and390 flat regular,
single-link0400 input files matched, with root0700/dist0500. Parent source, index,
refs and outputs were unchanged. Root independently verified identities, maps,
command bindings and raw hashes; it did not repeat binds, signals or deletion.

The owner physical audit was115.029470 seconds after controller finish, inside
the same fixed start-plus330 final. That delay is recorded as timing, not cleanup
duration or a new finish-plus60 deadline. Unseen short-lived descendants have no
invented identity/session. No generic interruption, native-call or adversarial-
input guarantee is claimed. Current159 dependency pins are not retrospective
dependency-byte proof for feasibility5.

Private originals remain under
`/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue95-caught-up-count-probe-1`.
Twenty source/copy inputs retain their original hashes. Root result SHA256 is
`9fee7d2a1ee3da8e6b24e87c10a5b05ab77fb74cf5894d1cfea59178210951ff`;
accepted release is `6bd0e24f8f2884b73bff4ca5fa25a5684b53a2e5017da7af06d9ddf21c041b4d`.
Local references do not close the durable public raw-artifact gate.

All earlier failed/unrun rows remain immutable. The7f outer post-child port
rebind EADDRINUSE36379 and aggregate Verify stay separate red CI gates; child0
is not complete cleanup or native-owner proof. No shared cause, baseline claim,
repair or retry is inferred. The only next work is an ignored source-only worker
classification-observer proposal. No application, controller/manifest binding,
matrix continuation, reviewer or new runtime grant follows this publication.
