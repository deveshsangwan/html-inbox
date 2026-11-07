# Partial CI-route and harness receipt at 76b20f5

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96).
The twelve granted commands and two exact-version preflights exited 0 at
`76b20f5ea913ac3368ac7fbb6fb1071ece6ade86`, but the overall harness is **not
qualified**. The final evidence audit found an invalid `/proc` counter parser.
No performance benefit or zero-I/O result follows from this run.

The [lossless archive](ci-harness-76b20f5.tar.gz) is 470033 bytes, SHA256
`4bf9f60c34f5b19468576962777d9f2e63c4de681370670e13fd09d1c35cc2a7`.
Its 223 regular members include 222 artifact hashes, the exact runner, all
original logs/profiles, source/compiled/compiler/runtime/bundle hashes,
commands/exits, complete captured export output and cleanup/audit receipts.
Every archive member was compared with its file on disk. No managed library,
ledger, donor key or real catalog material is included.

## Results retained separately

The [frozen request](ci-route-harness-request.md) lists the exact absolute
runtime/package-manager paths and twelve commands. Candidate Node 24.19.0
ran typecheck/build/bundle, then the existing clean app-managed exact610
parent ran build/bundle. Six Python checks passed. Exact Node 20.20.2 then
24.19.0 each ran the normal actual-view CI wrapper, separate GC wrapper and
one count1/10KiB/samples1 managed-read smoke. Both wrapper children passed all
44 actual-view cases and the one retention case, without skips or failures.
Each smoke completed its 18 sequential workload children with empty stderr.
No install, full suite, browser, application listener or worker ran.

Both runtimes used unchanged 199-file candidate and 195-file parent compiled
maps and the same release bundles. Candidate source494 stayed unchanged and
both checkouts remained clean. Parent source/ref was untouched at
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Aggregates:

- Candidate compiled: `6fa288cf60de4067b7562768b07e47e58522472cca4fddae072de6f91e07f669`.
- Parent compiled: `aa190f42b28b38c01bf03b0273a8e4649e07ebe42c3bb00ad50ffb14de826013`.
- Candidate source: `b7aac6e6137652f89be48fdf43b9dff6b79e8a6bb7063c2e4b3cbd2d1a3412c9`.
- Candidate bundle: `962731fe77dd1bc99f70c6a20db7e3872a35b7e844cba4517cf476b96c6c811b`.
- Parent bundle: `a6fa54ab38173962a4f77134821b6b1938984533d9e78568af0139807ce1b535`.

The smoke's fixed-option API controls compared complete exports and batches
on owned and mixed imported/tombstoned/suppressed fixtures. The final read-only
audit independently verified 160 captured files, 1333776 bytes and all 16
emitted manifests, including every file hash and full snapshot hash. Each
export contained its one visible owned document; the mixed batch also read
the visible import. No cross-runtime whole-output equality is claimed.

Real CLI owners/timestamps/output directories differ. All raw values remain
in evidence. Only the ownership/manifest nonce files may differ between
paired CLI outputs after complete schema/hash checks; every other file byte
matched. Fixed-option API controls compared every file byte. This distinction
is explicit and does not normalize arbitrary output changes.

Independent native FileHandle counts passed for each role/runtime: CLI read
three complete 1901-byte ledgers, batch two, and each read one 10240-byte body.
These counts bypass the invalid `/proc` parser. They retain the full serialized
ledger cost and establish neither physical I/O nor a scaling benefit.

## Counter instrumentation failure

The preload used one literal backslash before `d` in a JavaScript template
string passed to `RegExp`. JavaScript consumes that escape, so the expression
fails to match decimal fields and `?? 0` silently substitutes zero. All eight
saved `/proc` dictionaries are invalid instrumentation. They are not evidence
of zero reads/writes, cache behavior or device activity. Raw kernel snapshots
were not retained, so actual deltas cannot be recovered from this run.

The commands did not reject this fault. I found it during the final evidence
audit after recording their exit statuses and releasing the local slot. The
original receipt/logs/profiles remain unchanged. The separate
`postflight-instrumentation-fault.json` and classification summary withhold
full harness qualification. No application command ran after discovery or
release, and no correction receives credit from the old logs. A narrow source
repair and a new explicit requalification grant are required.

## Cleanup and scope

Postflight found all 91 recorded PIDs and 56 groups absent. Both runtimes'
wrapper roots and benchmark roots were absent, as were all outer temporary
directories. The first cleanup receipt parsed TAP diagnostics only and listed
four roots. The final read-only audit additionally parsed Node 24 Unicode
diagnostics and checked all six roots, without rewriting that receipt.

The existing Python cleanup test intentionally kills an uncooperative fake
child/descendant. The outer runner adopted and reaped one already-killed
PID with wait status9; its attempted SIGTERM is disclosed in the receipt.
No detached application worker was started. The slot was explicitly released
at 2026-11-07T20:37:43Z before packaging. The runner recorded 31.025 seconds
within its 900-second application budget and 0.0024 seconds of outer cleanup
within a separate 120-second allowance. These describe command ownership,
not useful workload timing or generic interruption guarantees.

Broader package/integration qualification, corrected instrumentation,
sustained 1/100-record comparisons and both fresh independent reviews remain
open. PR122 stays draft. Full per-body serialized ledger I/O remains, and #96
is partial. Historical hosted failures remain separate from this local run.
