# Identity recovery failure and local nonreproduction

Related to [issue #97](https://github.com/deveshsangwan/html-inbox/issues/97) and [PR #124](https://github.com/deveshsangwan/html-inbox/pull/124). Tested source: `c8baba7cfeaabe200deca00e4bcdcbb701476ba7`, base `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. The diagnostic added alongside this report was not present in that local run.

## Hosted failure

[Source Ubuntu 20 shard 2/2](https://github.com/deveshsangwan/html-inbox/actions/runs/42674717480/job/129352829725), run 42674717480 attempt 1, failed `actual client rejects length identity response and leaves recoverable work`. The original recovery assertion at TS357 expected `confirmed` and received `pending`. The case took 3013.009022 ms; no overall test timeout was observed. The earlier negative-pass assertions, receiver request count 1, fault proof and explicit retry completed. The final receiver document-count assertion was unreached. The returned recovery error and counters were not printed.

The job built on Node 24.22.2 and tested on 20.20.2: 893 tests, 890 passed, 1 failed, 2 skipped, 0 cancelled. Fourteen other leaf jobs succeeded. [Verify](https://github.com/deveshsangwan/html-inbox/actions/runs/42674717480/job/129355374398) failed its aggregate comparison and adds no separate application defect. This failure remains unresolved. Source identity with the CI merge is not baseline reproduction or a cause finding.

## Bounded local attempt

The single granted sequence `root-97-recovery-c8baba7-20261110-r1` completed all five commands with native exit0. It checked both exact runtime versions, built unchanged c8 source with installed Node 24.19.0 and pinned pnpm 11.7.0, then ran these existing tests on 20.20.2:

```text
<node20> --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="^actual client rejects length identity response and leaves recoverable work$" packages/cli/dist/sync-protocol-faults.test.js
<node20> scripts/run-unit-tests.mjs --test-reporter=tap --test-shard=2/2
```

The name pattern was one argv entry. The second command used the original default file concurrency. Exact argv, caps, log hashes and counts are in [the extracted result](issue-97-recovery-c8.json).

The focused invocation passed its one selected case and skipped 30 unrelated cases. The full shard passed 891 tests and skipped 2, with no failures or cancellations. Both original recovery-confirmed and final receiver document-count 1 assertions passed. The shard command took 257.003865 s under its 300 s cap; the adapter took 276.851909 s. There was no retry or deadline extension.

This is local nonreproduction only. The hosted build runtime 24.22.2 differs from the local build runtime 24.19.0; emitted bytes were not compared across hosts. Neither pass proves a cause, a flaky test, a passing base or candidate exoneration. Zero receiver-mismatch/startup-lstat tags qualify no failure branch. No full recovery result was logged.

## Restoration and evidence

The adapter restored all 393 qualified output files. The complete rebuilt 393 files remain in private evidence; only the protocol and fatal diagnostic test JS files differed, with the other 391 unchanged. Source, semantic index, tools and runtimes matched their pins. Independent owner and root audits found all 1,600 saved PID/start identities and 87 groups absent, plus one separately identified PID-only observer. Command and fixture roots were absent. These are sampled known identities, not universal process or port coverage; no output inode/time or general raw-index byte identity is claimed.

LOCAL was released before interpretation, 116.361877 s before the shorter cleanup deadline and 441.692262 s before the original fixed final deadline. The original receipt, logs, release, audits and rebuilt bytes remain immutable under `artifacts/performance-issues-2026-11-07/issue97-recovery-c8baba7-r1` and its adjacent `-launch` directory. The public JSON is an explicit safe extraction, not a replacement for the original receipt or a public raw archive.

## Next observation

The test now binds the same already-awaited recovery result and attempts one `issue97-recovery-result-v1` diagnostic only when the length case returns a status other than `confirmed`. It includes fixed route status/readiness/count fields, allowlisted error classification and returned client request/byte counters. Unknown errors become `other`. It emits no IDs, URLs, headers, credentials, bodies, ledgers, raw errors or the receiver sample from the earlier negative pass.

The tagged string plus three bytes reserved for a TAP comment prefix/newline must fit 4096 bytes; reporter indentation and hosted log framing are separate. A constant fallback replaces oversized output. The original strict assertion runs in `finally`, including when formatting or emission throws. The final document assertion and 500 ms injection, 1,500 ms recovery, 8,000 ms pass and 20 s test bounds are unchanged. There is no extra request, reconcile, IPC, snapshot, stat, await, handler, timer or retry.

Pinned native tsc-rs 0.7.0 `-p packages/cli/tsconfig.json --noEmit` passed once on the new source, with empty stdout/stderr. No local application/test run followed this diagnostic edit. Its mismatch, formatting-error and size-cap paths remain runtime-unqualified; missing output or a later green run cannot establish their behavior. Client `requests` counts `https.request` creation, not upstream delivery. Returned classification can identify a boundary, not its native cause. Remove this temporary observation once the recovery failure is understood and an appropriate regression test covers it.

Both completed independent reviews remain accepted for their recorded code/evidence scopes. This small diagnostic follow-up has root diff/typecheck review, not a claim that those reviewers inspected these new lines. Measured production/harness/output bytes and accepted performance claims are unchanged. New-head normal CI and the final readiness decision remain open; keep the PR draft. Earlier 887/e017 failures and all historical limits remain separate and unwaived.
