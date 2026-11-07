# Stopped I/O requalification at 084b2b2

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96).
Requalification stopped at the first independent-audit mismatch. Full harness
qualification remains withheld. No performance benefit is claimed.

The [lossless partial archive](io-requalification-084b2b2-partial.tar.gz) is
268589 bytes, SHA256
`a262402a7ba5fb45ab3372c446e37388c84e88036ad1ed2336279f608cab4646`.
It contains 109 regular members with 108 artifact hashes. Every member was
compared with disk. Original runner/auditor source, failed audit traceback,
all logs/profiles, raw counter text, exact export output and additive
classification/cleanup receipts remain unchanged. No managed ledger or key
material is archived. The invalid76 archive/profiles remain unchanged.

## Commands and stop

Tested source was `084b2b26036c82f8f19fdb032aba1582cb983947`, parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Both checkouts were clean.
The exact [three-command request](io-requalification-request.md) was granted
once with a 420-second application deadline and at most120 seconds of
separate cleanup. Commands ran sequentially in owned groups:

- Absolute Node24.19.0 and20.20.2 `--version`, both exit0, each capped15s.
- `python3 -m unittest test_managed_read.ProcIoTests` in `scripts/bench`, exit0, four tests passed, capped30s.
- Exact Node20 one-record smoke with `--counts 1 --sizes 10240 --samples 1 --timeout 30`, exit0,18 workload children passed, capped180s.
- The immediately following independent read-only audit raised AssertionError.
- Node24 smoke was **not run**. No fix, retry or continuation followed.

The independent auditor incorrectly asserted that each ledger read was
1901 bytes, copied from the preceding independent fixture. The new fixture's
ledger was1909 bytes. The source harness derives expected bytes from the
actual current file stat and correctly accepted5727 bytes over3 CLI reads
and3818 over2 batch reads. Both roles read one10240-byte body.

This is a qualification-audit assumption fault. It does not demonstrate a
production or repaired-parser defect. The ledger stores its canonical home
in `ownerAnchor.home`; this fresh fixture's home path is eight characters
longer. The archived additive path context explains why serialized size is
fixture-dependent. It supplies no missing stat observation after deletion
and does not replace the failed audit or relax its assertion.

## Bounded facts retained

An additive diagnostic independently split the four Node20 raw `/proc` texts
and recomputed all seven fields, parsed before/after maps and deltas. They
match the saved maps/deltas, with `rchar`745777..1302608 and `syscr`268..424,
satisfying the native byte/open lower bounds. Physical `read_bytes` was0,
which is permitted. No physical-device I/O conclusion follows. Original
profiles retain exact raw text; their four-test parser coverage and this
single-runtime evidence do not substitute for the unrun Node24 gate.

The failed auditor had already compared complete exports and batches before
its native-length assertion. A separate preservation inventory additionally
verified80 captured files and8 complete manifest/snapshot hashes. Four API
exports used fixed options; four CLI/count-probe exports retain precise
owner/time/outputDir distinctions. Mixed import/tombstone/suppression controls
and direct native counters are retained in the original smoke records.
No cross-runtime output or performance comparison is claimed.

All497 source hashes,199 candidate/195 parent compiled hashes, runtime binary
hashes and both bundles stayed unchanged. No build, bundle, typecheck,
install, repeated44/GC, application listener, worker, browser, full suite or
high-count run occurred. Parent outputs were read-only. The application
elapsed4.312s; outer cleanup0.0011s. These are ownership/budget facts only.

Postflight verified all23 recorded PIDs,22 groups and3 temporary roots absent,
with no owned/adopted children or outer cleanup signals. The slot was
explicitly released at2026-11-07T20:57:37Z before packaging. No application
command ran after release. No generic interruption guarantee is established.

Root must decide how to correct/re-audit the preserved evidence and scope
any continuation. The original audit, failed assertion and complete Node20
data remain preserved; no correction has run. Node24, full instrumentation
qualification, sustained measurements and both independent reviews remain
open. PR122 stays draft.
