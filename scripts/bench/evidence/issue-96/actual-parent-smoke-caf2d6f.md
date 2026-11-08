# Actual-parent one-record smoke at caf

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Grant `root-96-actual-parent-caf-20261108-r1` ran once at clean candidate
`caf2d6f7b3376538539c8bff92ce7e962d7a5ed7` against actual clean parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad` in its reserved checkout.
All five application commands and two exact version/hash preflights exited0.
Both independent raw-I/O/native/output audits passed.
Root independently accepted this one-record scope and release, rechecking all
eight raw profiles,160 output files/16 manifests, all output pairs,36 child rows,
seven outer commands, source/build/tool identities and recorded process cleanup.
Its audit SHA256 is
`97ce69ca2ff5fc739138df8f6efe97568e78857271073a6daefc419751f0027e`.

The exact seven approved source files were copied to a fresh same-depth
directory. Controller SHA256
`a4e12a4612ff52dbb553519563b2f40232be4caa1a1c23bc3f0df5f365d8bb8c`
and auditor SHA256
`97cd899e54b69707c136b0dff88ac5d2af3da7c2802d9f4d4a95bc2b15064329`
matched before the single launch. Original source hash manifest and all copied
files remain unchanged; `evidence-hashes.json` separately covers execution data.
No correction, retry or oracle adjustment occurred.

## Commands and identities

Exact binaries were:

```sh
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --version
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --version
```

The following tool commands used the absolute Node24.19.0 binary and its
`installation/lib/node_modules/corepack/dist/pnpm.js` entry, pnpm11.7.0:

1. Candidate `--filter html-inbox bundle`.
2. Parent `build`, cwd `/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47`.
3. Parent `--filter html-inbox bundle` at that same cwd.

Then exact20.20.2 followed by24.19.0 each ran:

```sh
python3 scripts/bench/run.py managed-read \
  --baseline-repo /home/agent/.t3/worktrees/html-inbox/t3-26d1cd47 \
  --expected-baseline-commit b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad \
  --node /absolute/exact/runtime/node \
  --counts 1 --sizes 10240 --samples 1 --timeout 30 \
  --out /absolute/fresh/runtime-smoke
```

Each smoke used18 sequential owned children and concurrency1. Actual absolute
arguments, cwd, environment, command limits and exits are in `receipt.json`.
Each environment records expected b249 beside actual parent/candidate build
identities; the independent auditor checked those values.

The accepted400 candidate compiled files and successful44ef typecheck were
reused. No candidate rebuild/typecheck, install or pure/helper test repeat ran.
The missing retrospective transitive declaration/tool-library hash proof remains
explicit. Parent reservation receipt SHA256
`f21101e2a32ead8cd1805585a4b29ba7945f274d773b8a76c73551f4394b2143`
and pre-build output fingerprints were preserved before authorized mutation.
Parent392 dist files were freshly built. Its new bundle happened to equal its
old presence fingerprint; this does not retroactively qualify the old bytes.

| Fresh bundle | Bytes | SHA256 |
| --- | ---: | --- |
| Candidate | 1283240 | `7f8fa149cb7233b41cd1671089bcb76ac15ebdd2fb3323ce64a40ca644b70509` |
| Parent b249 | 1276123 | `9e7b74b25117b23e64de30d16624dca18c4e503f4ce4375185d68af8c77afdd5` |

Both tracked source maps stayed unchanged and clean. Candidate400 compiled
files stayed fixed; parent392 files stayed fixed after build. Both bundles
matched the inputs used by both smokes. Runtime hashes, eight recorded tools
and thirteen additional parent/ncc tool entries matched before/after. No
identity mismatch was observed. These bundles now have one-record smoke
evidence; this is not full package/release qualification.

## Behavior, raw I/O and output evidence

Each runtime completed a full managed release-CLI export and supported complete
batch work, fixed-option API controls and mixed import/suppression/tombstone
controls. Batch document metadata/body summaries matched the seeded fixture;
the candidate used its view capability, baseline used its ordinary path.
Exports excluded imported records as required.

Across both runtimes, the independent auditor verified16 complete export trees,
160 files,16 manifests and snapshot hashes. Four API baseline/candidate pairs
matched all bytes. Four CLI/count-probe pairs matched every stable byte and
allowed differences only in the named ownership/manifest nonce files. Original
owner, outputDir, generatedAt and capability values are retained. No blanket
normalization or cross-runtime whole-output equality is claimed.

All eight saved I/O profiles retain exact raw `/proc/self/io` before/after text.
The independent auditor imports neither the tested parser nor application code;
it reparsed all seven integer fields, recomputed maps/deltas and verified native
rchar/syscr activity bounds. Physical read_bytes was0 in all eight profiles,
which is valid on warm/tmpfs storage and does not mean zero checked reads.

For both revisions on both runtimes, each complete CLI count probe opened the
ledger3 times and checked5727 ledger bytes; batch opened it2 times and checked3818
bytes. Each opened one body/read10240 bytes, matching this run's seed arguments
and fixture specification. Derived1909 bytes per ledger read is a consistency
check for this fixture only. No separate stat or ledger was retained/recovered;
the independent runtime check is the source-pinned harness's successful live
ledger.stat size assertions. Full serialized ledger I/O remains per body.

The process I/O counters include startup/module work; native counters separately
identify checked ledger/body activity. Instrumented count probes are separate
from primary samples. Raw elapsed/CPU/RSS samples are preserved for harness
audit only. One interleaved pair, one record and uncontrolled warm filesystem
caches cannot establish practical speedup or regression beyond noise.

## Cleanup, release and limits

The three exact tool commands' owned0700 TMPDIR identities were checked after
their processes joined. Compiler/Corepack output was inventoried/hash-recorded
without following symlinks, then that exact directory was safely removed.
Tool temporary bytes were not copied, only their original inventories retained.
No application empty-directory oracle or0775 child permission rule was applied
to tooling output. Smoke fixture/output/cleanup assertions stayed unchanged.

All54 observed or sample PIDs,43 groups and16 fresh roots were absent after
joining. No adopted reaps or controller cleanup signals occurred. No old-root
cleanup was part of this run. Candidate/parent source/ref/index stayed clean;
the only parent mutation was the authorized generated dist/bundle work.
No managed ledger or private key was archived.

The local slot was explicitly RELEASED at2026-11-08T17:47:58.244496Z, before
packaging. Controller application wall time14.183894seconds was within the
single900second deadline; automated cleanup0.041466seconds. The entire
first-command-to-release interval102.797099seconds also bounds all inspection
within the separate120second cleanup allowance; additive inspection was not
separately timed. Sampling every20ms can miss shorter-lived descendants; exact
sample PIDs/groups were checked additionally. Unused timeout/interruption paths
and generic OS-close behavior are not qualified by normal completion.

No full suite, actual browser/listener/worker, larger count, sustained matrix,
reviewer, runtime/storage policy change or automatic next phase occurred.
Historical hosted failures and old invalid76/audit-error records remain separate
and unchanged. Practical complete-export/batch1/100-record evidence, full package
qualification and both fresh measured-pin reviews remain open. No full#96 closure
or practical benefit is claimed.

## Lossless evidence

[Raw archive](actual-parent-smoke-caf2d6f.tar.gz),549157bytes, SHA256
`4ca44ec21f70e36d58072f975952df0e2f9ec21b9f3544689bf86f2e88b5cef0`.
All211 file members were compared byte-for-byte to disk;210 execution artifact
hashes are recorded separately from the original six-file source manifest.
Contains controller/diffs/auditor/reservation, exact logs and full maps, saved raw
profiles, complete output bytes/manifests, independent audits and additive release.
