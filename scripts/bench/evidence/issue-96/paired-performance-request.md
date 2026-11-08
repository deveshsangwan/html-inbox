# First paired performance qualification request

Executed once under explicit grant `root-96-paired-c491-20261108-r1` at clean
c491. All fixed samples and audits completed, then the slot was released.
See the [descriptive results](paired-performance-c491419.md). This request is
retained as the preselected reviewed scope; it grants no repeat or next phase.

## Original reviewed request

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
**Source-reviewed request only. No execution grant.** Scoped integrated
correctness and [actual-parent one-record smoke](actual-parent-smoke-caf2d6f.md)
are accepted. Production, workload, storage policy and existing runner are
unchanged. This is the first proposed paired matrix, not a benefit result.

## Fixed comparison and primary metric

Use accepted artifacts at the clean documentation head containing this request,
against exact actual parent `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad` in
`/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47`. Candidate400 compiled files,
parent392 and both bundles must match the accepted caf smoke receipt SHA256
`6f63d5888f3e7771a185dec1e9d08620c9cc3328a111908db16273d9b8653866`.
Candidate bundle SHA256 is
`7f8fa149cb7233b41cd1671089bcb76ac15ebdd2fb3323ce64a40ca644b70509`;
parent is `9e7b74b25117b23e64de30d16624dca18c4e503f4ce4375185d68af8c77afdd5`.
Reuse accepted build/typecheck and recorded tools with the historical transitive
declaration/tool-library hash limitation. No rebuild, bundle or identity-test repeat.

Primary metric remains **COMPLETE release-bundle CLI export process elapsed**,
including process/module startup, complete listing/validation/body/output work
and exit. Compare count100 and report count1 startup/cold-operation costs and
regressions independently for each exact runtime. Supporting metrics are complete
actual-callback batch process/operation elapsed and CPU, process peakRSS, batch
end-of-operation RSS, resource block counters and separately instrumented native
checked-byte/raw process I/O. Do not substitute parser/signature microbenchmarks.

Fixed workloads: counts1 and100, owned bodies10240bytes, seven pairs per count,
concurrency1. The existing loop alternates AB/BA: baseline first on pair0,2,4,6;
candidate first on1,3,5. Exact Node20.20.2 runs first, then24.19.0, with independent
fresh fixtures/output roots. Do not pool runtime results. Setup is outside timing;
each timed operation is a fresh process and callback with an initially empty
operation cache. Filesystem caches remain uncontrolled/warm, with no OS-cache-cold
claim or cache eviction. Imports/tombstones/suppression and distinct body bytes
remain in the existing untimed controls.

No pooling, p95 inference, early gain-based stopping or post-hoc workload choice.
Complete all planned samples/runtimes unless the first correctness/audit/identity/
cleanup failure or fixed deadline stops execution. Only after the full run evaluate
whether count100 primary improvement is repeatable beyond the observed paired
spread on each runtime; ambiguous results get no benefit claim. Report count1 and
memory/bundle costs even if unfavorable. No useful benefit means the existing
root decision route to reject production changes and retain investigation evidence.

## Exact requested commands and bounds

Four outer application commands only: two exact version/hash preflights15s each,
then one existing-runner invocation per exact runtime,420s each:

```sh
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --version
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --version
python3 scripts/bench/run.py managed-read \
  --baseline-repo /home/agent/.t3/worktrees/html-inbox/t3-26d1cd47 \
  --expected-baseline-commit b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad \
  --node /absolute/exact/runtime/node \
  --counts 1,100 --sizes 10240 --samples 7 --timeout 30 \
  --out /absolute/fresh/runtime-paired-evidence
```

Use the two absolute binaries above for their respective invocation and different
fresh absolute output directories. Existing child timeout remains30s. One900s
application deadline is set once, includes audits, with a separate fixed120s
cleanup allowance. Max outer command caps sum870s, leaving30s aggregate audit/
verification margin. Every full command scope must fit remaining time; every
wait/reap is capped. Audits check the same absolute deadline at row/tree/pair/I/O
checkpoints. Expect roughly3–8minutes, not an elapsed-time extension or guarantee.

The forecast comes from the pinned `run_count` loop, not previous fixtures:

| Per runtime | Derived total |
| --- | ---: |
| Owned seed/control/probe rows per count | 1+4+4×7+4 =37 |
| Additional first-count mixed seed/control rows | 5 |
| All recorded child rows | 37×2+5 =79 |
| Timed CLI rows / complete batch rows | 28 /28 |
| Raw paired records / separate I/O profiles | 14 /8 |
| Complete export trees / emitted manifests | 38 /38 |
| Exact API pairs / CLI-count stable-byte pairs | 3 /16 |

Across runtimes expect158 recorded rows,76 export trees/manifests,28 paired records
and16 profiles. Pinned output layout has three files per exported owned document
plus seven fixed files. This predicts5726 files per runtime,11452 total, roughly
100–150MiB raw evidence. Actual inventories remain authoritative. Metadata git/
Node/stat subprocesses are additional owned work, not measured child-row totals.

## Controller, observation and stop policy

Prepared ignored files live in `artifacts/issue-96/paired-performance-prepared`.
Copy approved controller/auditor/diffs/preparation/hash manifest into a new
same-depth directory only after root binds a full clean `--expected-head` and
new `--grant`. Nothing has executed. AST syntax/function inspection and read-only
hashes only; no auditor/controller/helper-control tests ran.

[Lossless source archive](paired-performance-source.tar.gz),37011bytes, six
byte-verified members, SHA256
`96c7d672ca44c1c88ee0540815896895718ed1ed6419a3f05866a499d3bbd379`.
Controller SHA256:
`c5f5cb506bcd8eef457fe5505d0d48eb2a807cf6b1346891c87c20e80fbe2bbd`.
Auditor SHA256:
`c9b787032f1fb2f800cd5a1b840c32188a66d85c29dc6aff69eb74e8c3cdf955`.
The archive includes both full diffs and the reusable-input/bundle proof.

The existing process/run/drain approach and existing workload runner are reused.
No tool commands remain, so the tool-output exception is retired; smoke/fixture
empty-directory rules remain strict. No parent generated-output mutation occurs.
Both source/ref/index states,335 reusable inputs,400/392 compiled outputs, bundles,
two runtimes and8+13 recorded tool maps must match accepted identities before/
after. Existing owner/reservation history is preserved.

Before first measurement, preselect outer100ms `/proc` process sampling and remove
hot fixture-directory traversal. This reduces observer filesystem interference;
it is a source-only measurement-controller change for root review. Child runner,
primary timing boundaries and workload environment do not change. All158 sample
PIDs/groups are recorded by the existing runner and checked additionally. Outer
monitoring overhead still exists identically for both roles, and shorter-lived
descendants can be missed; do not call this an uninstrumented-host measurement.
Primary rows contain no I/O preload. Probes stay separate and are explicitly
identified by their environment; no application permission or timing oracle changes.

First command/behavior/audit/provenance/cleanup failure stops later runtime work.
Retain all original raw rows, partial exports/staging evidence, failure logs,
auditor checkpoint identity and unrun list; no retry or oracle adjustment.
Join/reap owned/adopted work before fixture removal; preserve roots if joining
cannot complete. Explicitly release before packaging or reviews. Unused timeout/
interruption and generic OS-close guarantees remain unqualified.

## Independent multi-pair audit and reporting

Audit every raw row in pinned count/pair/role/operation order. Repeated sample
labels are **never dictionary identities**. Use row index plus complete semantic
identity; exports use original outputDir including count/pair/role. Refuse duplicate
identities and require every expected row and tree. Each export preserves complete
path/bytes/manifest/body/owner/time/outputDir and diagnostics. API pairs match all
bytes. CLI/count pairs permit only named owner/manifest nonce differences; independently
compare manifest structure after only generatedAt, derived snapshotHash and owner
file hash distinctions. No blanket normalization or skipped repeated samples.

Independently reconstruct all eleven pair metrics from the actual row/operation
outputs, then recompute `summary.json` and each `paired-summary.jsonl` record.
Retain every raw value and paired absolute/relative delta. Report baseline,
candidate and paired delta/percent min/median/max/range/IQR; quartiles use the
inclusive method, with a singleton non-null percent set reported as a degenerate
range. Baseline-zero percent remains undefined. No tail percentile inference.

Reparse all saved raw seven-field before/after I/O independently of the tested
parser. Check integer fields/maps/deltas, per-count native opens/body totals and
rchar/syscr lower bounds, permitting physical-I/O zeros. Ledger size is derived
only for consistency within each count's fixture. The independent runtime check
is the unchanged harness's successful live ledger.stat assertion per count/profile;
no retained stat, recovered ledger or hardcoded ledger size is claimed.

Current output/behavior/lifetime policy remains unchanged. Full serialized ledger
I/O still occurs per body: partial exact-current-byte parsing/validation reuse only.
No1000/larger-body expansion, build/typecheck/install/fullsuite/browser/listener/
worker/reviewer activity is requested. Both fresh same-pin full-rubric reviews and
normal full/package qualification remain after measured freeze. The source-only
request itself establishes no speedup or full#96 conclusion.
