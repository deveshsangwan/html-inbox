# One-record I/O smoke completed on both runtimes

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96).
Root accepted the corrected harness for one-record smoke on exact Node20.20.2
and24.19.0 only. Practical benefit, larger counts, generic interruption and
full issue qualification remain open.

This completion adds the [lossless additive/Node24 archive](io-requalification-completed-0575c1d.tar.gz),
274520 bytes, SHA256
`f1f513e6648e9307e16caaf6be930fb5556c47798a46feb5acbbe1a6d001695c`.
Its107 regular members include106 artifact hashes. Every member matched disk.
Use it with the immutable [Node20 partial archive](io-requalification-084b2b2-partial.tar.gz),
SHA256 `a262402a7ba5fb45ab3372c446e37388c84e88036ad1ed2336279f608cab4646`,
which retains the original failed auditor/traceback and complete Node20 data.
The additive auditor and new audit results have distinct paths. No original
receipt, assertion, error or profile was rewritten. Invalid76 profiles remain
invalid and preserved in their earlier archive.

## Pins and executions

Node20 ran at `084b2b26036c82f8f19fdb032aba1582cb983947`; its two runtime
version preflights, four pure ProcIoTests and18-child smoke exited0. Execution
stopped at an external audit's incorrect1901-byte ledger-size constant.
Root then accepted an additive read-only audit correction. Neither Node20 nor
parser tests were rerun. The separate [stopped receipt](io-requalification-084b2b2-partial.md)
remains historical.

Only the previously unrun Node24 step followed under a new exclusive grant,
at docs-only `0575c1de098c6d1fcb25cb1d8724f544ff67437c`. Executable source was
byte-identical to084; parent remained exact610. Exact Node24 `--version`
and the existing managed-read count1/10KiB/samples1/timeout30 command exited0.
Its18 workload children passed, and the independent audit completed. No
build/install/typecheck/bundle,44/GC repeat, application listener, worker,
browser, full suite or high-count run occurred. Parent output was read-only.

The archive's exact runner/receipt records absolute commands, environment,
per-command caps15/180s, a once210-second application deadline and separate
120-second cleanup bound. Node24 application elapsed3.790s, outer cleanup
0.00055s. These are budget facts, not useful operation timings. All21 new
recorded PIDs,20 groups and2 roots were absent, with no adopted children or
cleanup signals. Slot release occurred at2026-11-07T21:03:43Z before packaging.
Earlier Node20 cleanup remains separately accepted at23 PIDs/22 groups/3 roots.
No application command ran after release.

## Independent evidence checks

The corrected auditor imports neither the tested parser nor application code.
It independently splits each raw snapshot, checks all seven decimal integer
fields, recomputes maps/deltas and compares them with saved parsed values.
All eight profiles across both runtimes passed, including applicable rchar
and syscr native lower bounds. Physical-I/O zeros are valid and imply no
physical device result.

Open counts, body counts and bytes come from captured fixture seed arguments
and visible expected document specifications. CLI opens equal count+2; batch
count+1; body opens equal count and body bytes sum the actual expected bodies.
Derived ledger size is checked only for consistency across four profiles per
fixture. It is not an independently retained stat or recovered ledger. The
independent runtime check is the immutable source-pinned smoke's successful
live `ledger.stat().st_size` assertions. Those assertions were executed before
fixture removal. No fixed1901/1909 constant remains in the corrected auditor.

| Runtime | CLI ledger opens/bytes | Batch ledger opens/bytes | Body opens/bytes |
| --- | --- | --- | --- |
| Node20.20.2 | 3 / 5727 | 2 / 3818 | 1 / 10240 |
| Node24.19.0 | 3 / 5700 | 2 / 3800 | 1 / 10240 |

The consistency-only derived sizes1909/1900 differ across independent fixture
paths, whose canonical homes are serialized. These are not a source speedup
or I/O reduction. Both roles in each runtime used exactly the same fixture.
Full per-body serialized ledger reads remain.

Combined evidence covers16 export trees/160 files, every emitted manifest and
snapshot hash, four fixed-option all-byte API export pairs and four CLI/count
probe stable-byte pairs. Only named ownership/manifest nonce differences are
allowed after complete validation; exact owners/times/outputDir remain saved.
Mixed import/tombstone/suppression batch controls passed. No cross-runtime
whole-output equality is claimed.

Both runtimes reused unchanged199 candidate/195 parent compiled maps and
bundles. Compiled aggregates remain `6fa288cf60de4067b7562768b07e47e58522472cca4fddae072de6f91e07f669`
and `aa190f42b28b38c01bf03b0273a8e4649e07ebe42c3bb00ad50ffb14de826013`.
Full source/runtime/bundle before/after hashes are in the separate receipts.
Root independently audited each runtime, outputs and cleanup. These results
retain their original610-parent comparisons and do not qualify a subsequent
shared-viewer dependency integration, measurement matrix or review pin.
