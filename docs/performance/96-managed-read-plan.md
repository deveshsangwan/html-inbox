# Checked managed reads within one operation

Related to [issue #96](https://github.com/deveshsangwan/html-inbox/issues/96).
This is a source-only policy and contract-probe prerequisite. It changes no
production code and claims no performance improvement. Execution and the
production candidate remain gated by the orchestrator.

Source preparation passed `node --check scripts/bench/managed-read-contract.cjs`
and `git diff --cached --check`, both exit 0. No dependency install, build,
application test or measurement has run for this candidate. The 18 probe cases
are proposed checks, not passing results.

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

These are source-derived expectations pending the focused execution gate.
`scripts/bench/managed-read-contract.cjs` exercises actual complete exports at
this cut against either compiled revision, for both source adapters. It checks
exact deterministic manifests, content digests, diagnostics, preserved existing
output, staging removal and synthetic fixture removal. Its suppression case
also exercises ordinary list-plus-body reads. It creates no listener or worker.

There is no cancellation API on the current export. The probe does not claim
signal cancellation, forced process-death cleanup, peak descriptor counts or
all body-read race positions. Those remain candidate qualification work.

## Decision needed before production changes

A once-captured ledger cannot both ignore subsequent ledgers and reproduce
the fresh-read deletion, fork, safety and corruption behavior above. Taking a
lock for the full export would add writes and serialization to a documented
read-only consumer. Pinning all bodies would change disappearance behavior and
can retain up to 10,000 handles or roughly 100 GiB of HTML. Neither is an
acceptable silent compatibility fix.

The orchestrator must choose the implementation route before a contract is
relaxed. The compatibility-first experiment is to reuse parsing and signature
validation only when a freshly checked, complete ledger byte buffer exactly
equals the operation's last validated buffer. A changed buffer receives all
existing validation before any of its records are used. Keep every existing
anchor, barrier, reader and source identity check at the corresponding read
boundary. Use no mtime, generation, inode-only or digest-only equality shortcut.

That experiment preserves fresh reads, but still reads the full serialized
ledger for every body. It therefore addresses repeated reconstruction and
verification, and does not satisfy a literal requirement to eliminate all
per-document ledger I/O. It should be evaluated as a partial #96 candidate only
if root accepts that scope. No full-issue completion claim would follow from
its speedup alone.

The alternative is a genuinely fixed metadata/visibility cut with incremental
bounded body reads, explicit current identity checks and missing-body failures.
It needs an explicit decision about deletion/suppression, restore, later ledger
corruption and pinned-body behavior. If that changes the compatibility contract,
route it to the modern line with a documented policy. Do not change 0.7.x by
calling the difference a speedup. A final fresh-ledger check also changes the
current behavior when a deletion occurs after its body has already been read.

## Small read interface and lifetime, once a route is approved

Prefer an optional `withReadView(operation)` on existing document sources.
The callback receives only list, metadata and body read methods. A managed
implementation owns a validated ledger, a map from local ID to checked record,
and fresh metadata projections. Legacy sources keep their existing operations.
Keep source-specific root/UUID checks and selected byte limits in the adapter.

The callback lifetime must close admission in `finally`, await admitted reads
and clear the map and buffers on success, callback rejection and cancellation.
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
bounded operation and close in existing `finally` paths. Additional concurrent
batch callers need an enforced admission bound, not an unbounded `Promise.all`.
Measure the real memory overhead; these bounds do not claim low RSS.

Preserve immutable metadata, descriptor identity/signatures, body filename and
byte-length rules. Routine current reads do not rehash HTML, while publication,
ingestion and audit enforce body hashes. Moving validation must not weaken any
of those checks or introduce a hash shortcut. Continue export ownership checks,
origin filtering, fetched-metadata equality and atomic replacement.

## Qualification gates

First request only dependency preparation if needed, a Node 24 build/typecheck
and this contract probe on independent installed Node 20 and Node 24 binaries.
Use the same compiled JavaScript for the two probe runs. Capture exact versions,
commands, exit codes and logs. This phase is baseline characterization, not a
speed measurement. No production candidate or sustained matrix is authorized.

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
