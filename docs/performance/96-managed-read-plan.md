# Checked managed reads within one operation

Related to [issue #96](https://github.com/deveshsangwan/html-inbox/issues/96).
This records the approved partial exact-complete-byte experiment and its
baseline contracts. Candidate correctness passed at the frozen fc858 revision;
broader qualification and performance remain gated by the orchestrator. No
performance improvement is claimed.

Source preparation passed `node --check scripts/bench/managed-read-contract.cjs`
and `git diff --cached --check`, both exit 0. The original 18-case probe
subsequently passed on the unchanged baseline under
exact Node 20.20.2 and 24.19.0. The [durable receipt and lossless evidence](../../scripts/bench/evidence/issue-96/README.md)
identify its tested revision. Candidate correctness was subsequently qualified
at `fc858a56d874debb470d8e26bb91c3fac99b01e6` under the explicit twelve-check
grant. The [candidate qualification receipt](../../scripts/bench/evidence/issue-96/correctness-fc858a5.md)
records its separate logs, outputs, hashes and limitations. No performance
measurement or independent review is credited to either correctness run.

## Starting point and affected work

The clean activation base is `610c931b7b22920cce59cf03e49c0de15ebaf2a2`,
the reviewed `perf/89-bench` parent. This branch includes no #94 cache,
#95 scheduler, PR #81, runtime change or storage-format change.

The affected operations are complete managed static exports through
`LocalDocumentBackend` and `LocalDocumentSource`, including the cloud snapshot
caller, and explicit list-plus-many-body reads. Ordinary single-document reads
must retain their present freshness and validation behavior.

Before any production edit, the primary benefit metric is elapsed wall time for
a complete managed export to a fresh destination. Measure small and large
libraries on each Node runtime independently. Also collect process CPU, Linux
I/O counters, peak RSS, operation RSS, output bytes and cleanup. A local-ID map
or fewer signature calls alone does not establish a useful optimization.

## Existing behavior that a frozen view would change

At the activation base, `snapshot()` checks home and directory safety, reads a
bounded private ledger through `readManagedLedgerBytes`, parses all ledger
relationships and verifies every record's origin signature. It then checks the
home anchor, format barrier, reader UUID and body/staging directories.
`getDocument()` repeats this for each call, finds a local ID, tests visibility
and reads its body through the current bounded file checks.

`exportStaticSnapshot()` takes its metadata list once. It filters imports before
fetching any bodies, then checks each returned document's origin, metadata and
buffer type. It publishes the staging output only after all documents succeed.
It does not hold a managed mutation lock across the operation.

The following policy describes mutations completed after the list returns but
before a particular `getDocument()` begins. A mutation during the body read or
after its return has only the existing syscall checks and later export checks;
the export has no final freshness check over previously emitted documents.

| Event at that cut | Existing export or batch result | Naive frozen view result |
| --- | --- | --- |
| Valid new publication | Not in the exported list; old selected documents still export | Same list, but no validation of the new descriptor |
| Delete a selected original | Fresh body fetch returns null; export fails with `Document changed while exporting: <id>` | Earlier live record could still export because deletion retains its body |
| Suppress an imported batch member | Later ordinary body fetch returns null; unsuppression makes it available again | Earlier visibility would persist |
| Import present at listing | Included in ordinary reads, excluded before export body fetch | Must still be excluded |
| Explicit quarantine on the same root | Rotates custody incarnation, but reader UUID and original read visibility remain valid | Rejecting every incarnation change would add a failure |
| Restore/fork completed on that root | Backend sees inherited origin metadata and export rejects it; selected read-only source rejects its changed reader UUID | Earlier original could wrongly export as owned |
| Copy/move or root replacement | Anchor or selected-root identity checks fail closed | Earlier anchor cannot authorize the replacement |
| Body absent before listing | List omits it; descriptor stays live | Must not invent deletion or a body |
| Body disappears after listing, before fetch | Fetch returns null and export fails; previous output remains | Pinned earlier bytes could make the export succeed |
| Identity replacement or unsafe current ledger | The next fresh read fails | Earlier checks cannot establish current safety |
| Invalid later descriptor, even outside exported IDs | The next read validates the entire current ledger and fails | Earlier complete validation would miss newly visible corruption |

The 18 probe expectations passed the approved baseline characterization on both
runtimes. The table also records source-derived cases, including root replacement
and mid-read events, outside that probe. Candidate controls must independently
establish their covered outcomes inside the actual callback view.
`scripts/bench/managed-read-contract.cjs` exercises actual complete exports at
this cut against either compiled revision, for both source adapters. It checks
exact deterministic manifests, content digests, diagnostics, preserved existing
output, staging removal and synthetic fixture removal. Its suppression case
also exercises ordinary list-plus-body reads. It creates no listener or worker.

There is no cancellation API on the current export. The probe does not claim
signal cancellation, forced process-death cleanup, peak descriptor counts or
all body-read race positions. Those remain candidate qualification work.

## Approved partial route

A once-captured ledger cannot both ignore subsequent ledgers and reproduce
the fresh-read deletion, fork, safety and corruption behavior above. Taking a
lock for the full export would add writes and serialization to a documented
read-only consumer. Pinning all bodies would change disappearance behavior and
can retain up to 10,000 handles or roughly 100 GiB of HTML. Neither is an
acceptable silent compatibility fix.

Root approved the compatibility-first partial route after inspecting the
baseline characterization. No frozen-cut or modern policy relaxation is
approved. The experiment reuses parsing and signature validation only when a freshly checked, complete ledger byte buffer exactly
equals the operation's last validated buffer. A changed buffer receives all
existing validation before any of its records are used. Keep every existing
anchor, barrier, reader and source identity check at the corresponding read
boundary. Use no mtime, generation, inode-only or digest-only equality shortcut.

That experiment preserves fresh reads, but still reads the full serialized
ledger for every body. It therefore addresses repeated reconstruction and
verification, and does not satisfy a literal requirement to eliminate all
per-document ledger I/O. It should be evaluated as a partial #96 candidate only
under the accepted scope. A speedup alone would not establish full completion.

The alternative is a genuinely fixed metadata/visibility cut with incremental
bounded body reads, explicit current identity checks and missing-body failures.
It needs an explicit decision about deletion/suppression, restore, later ledger
corruption and pinned-body behavior. If that changes the compatibility contract,
route it to the modern line with a documented policy. Do not change 0.7.x by
calling the difference a speedup. A final fresh-ledger check also changes the
current behavior when a deletion occurs after its body has already been read.

## Candidate read interface and lifetime

The candidate adds optional `withReadView(operation, signal?)` on existing
document sources. The callback receives only list, metadata and body read methods. A managed
implementation owns a validated ledger, a map from local ID to checked record,
and fresh metadata projections. Legacy sources keep their existing operations.
Keep source-specific root/UUID checks and selected byte limits in the adapter.

The callback lifetime closes admission in `finally`, awaits its admitted read
and clears the map and buffers on success, callback rejection and cancellation.
At most one read is admitted; concurrent calls reject immediately with no
queue. Abort stops admission and rejects the result of an admitted read after
native I/O finishes. Scope completion still waits for the callback to settle.
Distinct callback and pending-read errors survive together as an AggregateError.
Escaped methods must reject after closure. Do not expose the ledger object,
route authorization or mutation methods. Return copied metadata so caller
mutation cannot alter the checked records. The future Library implementation
can supply these same reads from its own transaction; no transaction, scheduler
or general cache framework is needed in this change.

The exact-byte experiment retains at most one validated ledger buffer and one
in-progress comparison buffer, each bounded by the current 64 MiB ledger cap,
plus parsed ledger/map memory. Stream selected bodies serially, at most one
10 MiB body buffer plus the existing renderer/copy working data. Avoid retaining
buffers from prior bodies. Read handles remain open only for their current
bounded operation and close in existing `finally` paths. Concurrent batch callers receive an admission error;
the view has no waiting queue. Callers must consume their reads serially.
Measure the real memory overhead; these bounds do not claim low RSS.

Preserve immutable metadata, descriptor identity/signatures, body filename and
byte-length rules. Routine current reads do not rehash HTML, while publication,
ingestion and audit enforce body hashes. Moving validation must not weaken any
of those checks or introduce a hash shortcut. Continue export ownership checks,
origin filtering, fetched-metadata equality and atomic replacement.

## Qualification gates

The baseline gate requested dependency preparation, a Node 24 build/typecheck
and the original contract probe on independent Node 20 and Node 24 binaries,
using the same compiled JavaScript. That gate passed at 42232780. Its exact
commands, logs and hashes are in the durable receipt. The historical command
shape below describes characterization, not a speed measurement. New candidate
execution and sustained measurements require separate grants.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
/absolute/node20 --test scripts/bench/managed-read-contract.cjs
/absolute/node24 --test scripts/bench/managed-read-contract.cjs
```

The install is conditional on missing dependencies and requires the same
explicit root grant. `node --check scripts/bench/managed-read-contract.cjs` and
`git diff --check` are source-only checks, not application execution.

Harness inspection found that `scripts/bench/run.py cli` exports only legacy
fixtures. `managed` measures enrollment, publication and status, not managed
exports. Neither currently qualifies this change. Before requesting sustained
measurement, add managed complete-export and complete-batch workloads using
the existing runner's process ownership, deadline, sanitized environment,
wait4 and cleanup machinery. Avoid a second ad hoc process runner.

Preselect 1 and 100 owned records for the first small/large comparison, plus
imports, tombstones, suppressed members and distinct per-ID body bytes in the
behavior fixture. Add 1,000 records only under a separately scoped grant if the
100-record measurements are too small or the scaling tradeoff needs it. Use
10 KiB bodies initially, then qualify larger body/copy costs separately.

Measure baseline common-parent production and the eventual pinned candidate
under each runtime separately, with equivalent synthetic durable fixtures,
release bundles for CLI export, identical output options and concurrency one.
Use fresh destinations and repeated interleaved runs, at least seven paired
samples per primary workload after untimed setup. Report every raw value,
median, min/max, absolute and relative deltas and paired spread. Do not pool
Node 20 and Node 24 results or infer a p95 from these samples. Caches are
uncontrolled/warm unless an independently scoped cold-cache procedure exists.

Compare every emitted path and byte, metadata, manifest/hash, copy diagnostics,
origin exclusions and failure category. Keep mutation controls outside the
performance samples and exercise actual publish/delete/suppress/restore APIs
at deterministic list/body cuts. Extend controls for mid-read changes, unsafe
files, unrelated-record corruption, callbacks retaining a view, cancellation,
read/close/write failures and cleanup before freezing the measured revision.
Report changed behavior separately from runtime improvements.

Accept production only for a repeatable practical improvement beyond observed
noise without unapproved behavior changes. Otherwise remove production edits
and keep an evidence/decision PR. Keep raw evidence in durable downloadable
artifacts with concise committed commands/results. After the measured pin,
request two fresh independent Sol functionality and Sonnet 5.5 Medium quality
reviews with the full rubric and explicit functionality, quality and performance
verdicts. Neither reviewer owns Actions watches.

## Qualified candidate correctness scope

The frozen baseline probe remains byte-identical at
`scripts/bench/managed-read-contract.cjs`. Run it again to qualify direct/fallback
behavior independently. The new `managed-view-contract.cjs` derives the same
18 expectations but supplies `withReadView` and throws if export tries its
outer list/get fallback. Its mutation is injected after listing inside the real
callback, and entry/cut counts must each be one. Its import exclusion wrapper
also enters the actual callback. These controls must not be mistaken for the
already-passing baseline run.

Additional controls count actual byte reads, parsing and signature verification,
check callback-local reuse and cross-operation isolation, mutate returned nested
metadata and ordinary snapshots, change local IDs without a generation/inode
change, reject invalid later ledgers, recheck the format barrier, and enforce
selected byte limits. Open-handle gates exercise admission, callback close,
failure and abort, requiring native-handle closure before completion. Separate
GC controls hold escaped methods while observing release of parsed ledgers
and buffers. GC is a retention check, not a memory benchmark. Legacy export
and enrollment transitions have independent controls.

The fc858 correctness grant used exact Node 24.19.0 typecheck/build, then sequential
Node 20.20.2 and 24.19.0 runs of the frozen baseline probe, new actual-view
probe and `--expose-gc --test scripts/bench/managed-view-retention.cjs`, against
the same compiled candidate bytes. Run the existing static-export and
local-document-source containing tests on each runtime as targeted regression
checks. This request excludes installs, bundles, full suites, servers/workers
and sustained measurements. Preserve all original failures and stop on a
behavior or lifetime mismatch before changing the oracle. A later scoped
request will address full-operation performance qualification.

## Scoped-reader decoration and normal CI follow-up

For a source advertising `withReadView`, that capability supplies the scoped
reader for consumers opting into it. Decorating the ordinary public getter on
an internal concrete adapter does not decorate its scoped reader. A decorator
must wrap `withReadView` too, or omit it and provide a list/get-only facade.
This does not change structural fallback dispatch or export origin exclusion.

The hosted red at 750baae was `Missing expected rejection` in the existing
reader-race test on Ubuntu Node 20/24 and macOS Node 20. Source inspection found
that its replacement of `fixture.source.getDocument` was outside the selected
scoped-reader path. The production post-fetch origin/metadata/buffer checks
remain unchanged. The new source-only repair retains the real returned import,
exact rejection/fetch count, unchanged previous output and no staging assertions
for independent actual-view and list/get-only fallback routes. The view wrapper
throws on outer fallback and requires exactly one callback entry.

A second scenario produces a real fork-inherited original after listing. It
asserts that every fetched non-origin metadata field, local ID and body byte
matches the listed original, while origin is present. Both routes must reject,
so metadata, ID or body discrepancies cannot substitute for the origin guard.
These repaired controls passed at fc858 under the explicit correctness grant.
They do not retroactively validate the bypassed injection in the old red run. The red 750baae logs
and the unrelated historical 42232780 timeout failures remain separate evidence.

The approved correctness phase added one selected-case command per exact
runtime, in addition to its ten checks:

```sh
/absolute/node --test --test-name-pattern='^export fetched-origin guard rejects (imported|origin-only) return through (view|fallback)$' packages/cli/dist/sync-reader-compatibility.test.js
```

This selects four export-origin cases. Their fixture setup starts no listener
or worker. Do not run the whole containing HTTPS/viewer suite in this phase.

For eventual normal CI integration, the smallest proposed route is a compiled
POSIX-only `.test.ts` entry in the existing unit discovery that invokes the
retained non-GC actual-view controls once under the current `process.execPath`,
using existing owned-child harness conventions and a bounded deadline. This
would run in the current Node 20/24 source matrix without a new workflow or
framework. Keep the GC-specific retention invocation separate, explicitly
passing `--expose-gc` on supported POSIX runtimes in an existing harness/source
step. The source follow-up below wires that route after correctness qualification.
The frozen standalone controls remain unchanged.

## Correctness qualification completed at fc858

The approved twelve checks and two exact-version preflights all passed on the
frozen fc858 candidate. Both runtimes passed baseline18, actual-view44,
retention1, containing18 and selected-origin4. Node 20 additionally reports
12 name-filter skips; Node 24 reports only the selected four. The full containing
HTTPS/viewer suite was not run. All 196 compiled JavaScript files remained
unchanged across both runtimes; all 484 tracked input files stayed unchanged.

The lossless receipt includes 180 removed fixture roots, 1,414 captured output
files, 142 verified emitted manifests, absent process groups/PIDs and zero
observer errors. These tests demonstrate the selected view/fallback and lifetime
controls at fc858. They do not validate later code edits, provide a speedup,
diagnose the old 422 timeouts or qualify permanent OS-close failure cleanup.
Normal-CI integration, broader qualification, complete-operation performance
measurements and both independent reviews remain later gates.


## Source follow-up for normal CI and complete workloads

This follow-up changes test routing, benchmark companions and documentation.
It changes no production implementation, runtime contract, dependency or
storage format. The fc858 evidence still qualifies only that frozen code and
its original invocation. New wrappers and harness code have source checks only
until the orchestrator grants their bounded smoke.

`managed-view-regressions.test.ts` enters ordinary compiled unit discovery.
One discovered file belongs to one shard of each runtime/OS combination, so
its child runs the original 44 controls exactly once across that shard pair.
The child uses `process.execPath`, an isolated HOME/TMPDIR/catalog, a 60-second
deadline and a 1 MiB output bound. It checks exit status and all TAP totals,
propagates failures, joins the owned process group before fixture removal and
retains both probe and cleanup errors if both fail. No listener or worker is
started. The test has a 75-second parent bound including cleanup.

A separate `managed-view-retention-check.ts` entry invokes the original GC
probe with `--expose-gc` in its owned child. It is deliberately not a discovered
`.test.ts` file. One existing source step runs it on shard 1/2 for each current
POSIX matrix entry, after selecting the test runtime. Thus ordinary unit
execution receives no GC flag. Both routes skip Windows because managed
enrollment requires POSIX directory fsync. They cover Linux 20/24 and macOS
20 in the existing matrix; macOS 24 remains excluded by the existing workflow.
The original 18-case baseline stays historical characterization and a manual
qualification control, outside normal discovery.

The existing #89 runner now accepts `managed-read`; it retains its original
owned-child runner, environment sanitization, wait4 and cleanup. The companions
add no subprocess runner, service or worker. The [workload instructions](../../scripts/bench/README.md#managed-complete-reads-for-96)
define exact-parent builds, identical durable fixtures, complete release CLI
exports, actual callback batch reads, output comparisons and separate I/O
probes. Primary complete-export elapsed remains preselected. Neither this
source addition nor smoke timing demonstrates practical benefit.

The CLI generates owner/time values internally. We will preserve all raw
output and permit only their two named files and dependent manifest values to
differ, after validating each complete manifest and all remaining file bytes.
A separate complete API export fixes those options and must match every file
byte. This is a disclosed measurement constraint, not an approved behavior
change. Existing mutation, origin, identity and lifetime controls remain
independent gates.

The next request is limited to CI-route and harness smoke on a frozen source
pin. It requests exact-version preflight, candidate Node 24 typecheck/build/
bundle, a recorded Node 24 build/bundle of the clean exact610 parent, both new
CI routes on exact Node 20/24, six Python harness checks, and one managed-read
pair at count1/10KiB per runtime. The six Python checks include the existing
owned fake child with a transient loopback socket for cleanup, and four pure
output-comparator cases. No application listener, full suite, browser, worker,
install, 100-record timing or sustained measurement is requested. All commands
must be sequential, own their process groups and fit a 900-second application
budget plus a separate 120-second cleanup allowance. Stop on the first
unqualified case, preserve original output and classify it before changing any
oracle. Root must grant the scope after #95 explicitly releases its slot.

A later measurement request will use at least seven interleaved pairs per exact
runtime at 1/100 records, on the same source/compiled/release pins. Report
absolute deltas, spread and regressions without pooling runtimes or claiming
physical-drive I/O. Both fresh independent reviews still follow measured
qualification. PR122 remains draft and #96 remains partial.

## Partial CI-route and harness run at 76b20f5

The explicitly granted twelve commands and two runtime preflights exited 0.
Both new CI wrapper routes passed on exact Node 20.20.2 and 24.19.0, as did
the six Python controls and both one-record smoke commands. This does not
qualify the full harness: final evidence inspection found that the preload's
`/proc` parser silently substituted zero for unmatched decimal fields.
All eight dictionaries are invalid; no raw snapshots remain to recover them.
The independent native FileHandle counts, exact export/batch output facts and
cleanup receipts are retained separately. The [partial receipt and lossless
archive](../../scripts/bench/evidence/issue-96/ci-harness-76b20f5.md) preserve
all original results and the subsequent failure classification.

The local slot is released. Root authorized a narrow source-only repair with
strict named-field parsing, raw/parsed before/after snapshots and deltas,
focused malformed/missing/nonzero parser controls and independent raw-data
recomputation. New source requires a separate minimal requalification grant.
No prior log validates that repair; no sustained measurement or reviewer gate
has started.

The narrow source follow-up moves parsing into the existing Python companion:
the CJS preload records raw snapshots, the companion strictly validates all
seven counters and saves raw/parsed maps plus deltas, and four pure parser
controls exercise nonzero/zero/error inputs. Read/syscall activity checks use
independent native counts; no physical-I/O positive minimum is added. The
[minimal pending request](../../scripts/bench/evidence/issue-96/io-requalification-request.md)
reuses the verified compiled files/bundles and selects only the four parser
controls plus the existing one-record smoke on each runtime. The source repair
has syntax/diff checks only; it has not received runtime qualification.

## I/O requalification stopped at an external audit assumption

At the explicit084 grant, both version preflights, the four parser controls
and Node20's18-child smoke exited0. The independent audit then stopped on a
hardcoded1901-byte ledger size copied from the earlier fixture, while the new
ledger was1909 bytes. Serialized owner-anchor homes make that size depend on
the fresh fixture path. Node24 was not run, and neither source nor the auditor
was corrected/retried under the grant. The [partial receipt and lossless
archive](../../scripts/bench/evidence/issue-96/io-requalification-084b2b2-partial.md)
preserve the failed assertion, exact source/logs/raw profiles, bounded passing
facts and additive diagnostic. Full harness qualification remains withheld.
The local slot is released; any audit correction or continuation needs root's
next instruction.
