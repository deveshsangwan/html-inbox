# Issue96 evidence

Current: root accepted normal source qualification from c77 hosted20.20.2/24.22.2 plus existing exact20.20.2/24.19.0 affected controls, and accepted measured-package behavior on BOTH exact runtimes. A's original Node24 disposal stop remains immutable, with its retained compile-cache root untouched. Root also accepted the [combined original610100-record complete-export benefit](combined-610-c77.md) independently on exact20/24; the bounded combined performance criterion is satisfied. The earlier [c491/b249 result](paired-performance-c491419.md) remains a separate immediate-parent comparison.

One-record gain is unproven. Full per-body ledger I/O and the partial reload-elimination scope remain. Five retained roots remain, no all-roots-clean claim. Full broad24.19 invocations and original local300s unit -15/incomplete/20 subsequent unrun remain historical facts, without redundant reruns. Both dc28 legacy-lock/LENGTH observations and other shared CI limitations remain open. Two fresh same-pin reviews and root/current-head CI readiness decisions remain; draft/no merge/release/full96 closure. Everything below is a historical checkpoint, not current execution authority.

## Historical baseline characterization

Later evidence is separate: the [integrated44ef partial stop](integrated-correctness-44ef6c0-stop.md)
records successful typecheck and a tooling-cache controller stop before build
or application tests. It adds no runtime qualification to this frozen baseline.
The [source-only continuation request](integrated-correctness-continuation-request.md)
retains that failure and proposes only the still-unrun build/runtime checks.
The [79a continuation stop](integrated-correctness-79a2912-cache-mode-stop.md)
records build exit0, a cache-mode guard rejection and all runtime checks unrun.
The subsequent [ecffd tests-only receipt](integrated-correctness-ecffd7c.md)
records the granted integrated scope passing on exact20/24, preserving both stops
and the separate unresolved hosted browser failure. It makes no gain claim.
The [actual-b249 one-record smoke](actual-parent-smoke-caf2d6f.md) subsequently
built both bundles and passed the exact20/24 smoke/audits. Practical benefit and
full package/review gates remain open.
The [first paired request](paired-performance-request.md) is source-only,
counts1/100 with seven pairs per exact runtime. Its controller/auditor were unrun at that source checkpoint.
That request was subsequently granted once at c491. The [measured report](paired-performance-c491419.md)
retains all pairs, statistics and tradeoffs. Root accepted scoped large-export
benefit; full checks/reviews remain gates; no automatic next phase or full issue closure.

The [lossless archive](baseline-42232780.tar.gz) records the approved baseline
characterization for [issue #96](https://github.com/deveshsangwan/html-inbox/issues/96).
Its SHA-256 is
`ee57d01333fc8f4cbe9430e42ed6884a5c5014092701fb0fb09db467f63f5874`.
It contains synthetic export output, command logs, the exact runner and teardown
observer, per-file hashes and cleanup receipts. It contains no managed library
ledgers or owner keys. Unpack with `tar -xzf baseline-42232780.tar.gz`.

The tested revision was `42232780e567728618680073ce40bb4efa5f887b`, with
production code identical to `610c931b7b22920cce59cf03e49c0de15ebaf2a2`.
These results do not test the subsequent production experiment or its new
actual-view controls.

## Commands and results

Dependencies were absent. All commands below exited 0, sequentially. Build and
package-manager commands used the exact Node 24.19.0 binary. The test runtimes
used the same 195 compiled JavaScript files without another build.

```sh
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --version
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --version
```

For each package-manager command, the full executable prefix was:

```sh
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/corepack/dist/pnpm.js
```

Arguments were `install --frozen-lockfile`, `typecheck`, then `build`.
The two test commands were:

```sh
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --test scripts/bench/managed-read-contract.cjs
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --test scripts/bench/managed-read-contract.cjs
```

Each runtime passed all 18 cases with zero failures, skips or cancellations.
Both adapters matched the same assertions about list/body publication cuts,
deletion, suppression, quarantine/fork, missing bodies, identity, unsafe ledger
permissions, later unselected descriptor corruption and export origin exclusion.
No source-derived expectation needed correction.

The runner removed inherited `HTML_INBOX_*`, `NODE_OPTIONS` and
`NODE_TEST_CONTEXT`. Each probe then received its own absolute `TMPDIR`, an
output evidence directory and a cleanup-only `NODE_OPTIONS=--require=...`
observer. The exact paths and environment construction are in `execute.py`.
The observer copied generated export output just before each fixture's normal
removal. It did not change the frozen probe or compiled production files.
This was an observed correctness run, not an uninstrumented timing run.

## Integrity and cleanup

The archive includes 36 fixture output inventories with 348 captured files and
36 emitted manifests. All captured sizes and SHA-256 values matched the files
and emitted manifests. All fixtures had only `export` and `library` before
removal, with no staging/backup residue, and all 36 roots were absent afterward.
All seven command processes were reaped, their process groups were absent at
exit, and their PIDs were absent at postflight. Both fixture temporary
directories were empty. There were no capture errors or remaining adopted
children. No full suite, bundle, worker, server or benchmark ran.

Root independently verified the 373 artifact hashes, all 479 tracked-file hashes
and current bytes, all 195 compiled-file hashes and current bytes, both runtime
binaries, command exits, case logs, output inventories/manifests and all 374
archive members against disk before authorizing source-only production work.

The compiled-map aggregate is
`aa190f42b28b38c01bf03b0273a8e4649e07ebe42c3bb00ad50ffb14de826013`.
The tracked-file aggregate is
`f6478c7948347051216e1121d11eb5fcca2a0187c31a63d0ba1d2d118afbd11f`.
These digest the UTF-8 Python encoding
`json.dumps(mapping, sort_keys=True, separators=(',', ':'))`, with each mapping
containing relative filenames and per-file SHA-256 values. The archive contains
the full maps and exact runtime binary hashes.

Independently seeded runtime fixtures have different creation timestamps. This
does not establish byte-identical output across runtimes, a performance benefit,
view lifetime behavior, or optimized-path correctness. The original two hosted
CI scenario timeouts also remain unexplained by this characterization.
