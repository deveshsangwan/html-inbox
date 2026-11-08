# Integrated scoped correctness at ecffd

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Grant `root-96-integrated-tests-ecffd-20261108-r3` ran once at clean
`ecffd7c44b68f72532148dd296b361d192633a28`, immediate parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`.

All twelve runtime commands and two exact version/hash preflights exited0.
Root's tests-only controller was copied unchanged to a fresh ignored directory.
Its SHA256 is
`fd4c761c0da1fbc2498b0a61ff7e3c95ee1deb2426f36cb341d587328170ba5f`.
The original44ef/79a tooling stops, prepared controllers and seven unexecuted
helper controls remain immutable. No controller correction or retry occurred.

## Commands and results

Each runtime used its absolute binary:

```sh
/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --version
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --version
```

Exact20.20.2 then24.19.0 each ran the following six commands, with their binary
substituted for `ABSOLUTE_NODE`:

```sh
ABSOLUTE_NODE --test scripts/bench/managed-read-contract.cjs
ABSOLUTE_NODE --test packages/cli/dist/managed-view-regressions.test.js
ABSOLUTE_NODE --test packages/cli/dist/managed-view-retention-check.js
ABSOLUTE_NODE --test packages/cli/dist/static-export.test.js packages/cli/dist/local-document-source.test.js
ABSOLUTE_NODE --test --test-name-pattern='^export fetched-origin guard rejects (imported|origin-only) return through (view|fallback)$' packages/cli/dist/sync-reader-compatibility.test.js
ABSOLUTE_NODE --test packages/cli/dist/viewer-owned-lifecycle.test.js scripts/viewer-fixture-browser.test.mjs
```

| Selected controls | Node20.20.2 | Node24.19.0 |
| --- | --- | --- |
| Baseline/direct/fallback characterization | 18 pass | 18 pass |
| Actual callback controls through normal CI wrapper | 44 pass, wrapper1 pass | 44 pass, wrapper1 pass |
| Explicit-GC disposal through separate wrapper | 1 pass, wrapper1 pass | 1 pass, wrapper1 pass |
| Static export and local source | 18 pass | 18 pass |
| Selected origin-only/imported view/fallback guards | 4 pass,12 filtered skips | 4 pass, unselected cases omitted |
| Inherited owned lifecycle3 and browser-fixture8 | 11 pass | 11 pass |

There were no failures or cancellations. Actual-view controls enter the real
callback and cover changed-ledger maps, returned metadata isolation, retained
view rejection, bounded admission, drained reads and disposal. Existing body-read
semantics and eighteen source-derived baseline outcomes remain unchanged.

The inherited fixture tests use a **stub browser and real ephemeral owned
reader/control HTTP listeners**. Existing tests assert their shutdown, rebind
and root ordering. Expected injected shutdown/journaling/browser/root-removal
failures were asserted and then cleaned up by their own finally blocks. Those
diagnostics are retained as successful failure-path tests, not environment errors.
No extra post-run bind probe or actual browser ran.

The successful exact24.19.0 build at79a was reused via immutable receipt
`8038412626e8e667cfeb9e994ac7eef359310b93f5a0db3d22551f9bb4130e59`.
All400 compiled files, including200JS, matched before every command, after each
runtime and finally. The JS-map aggregate remains
`457cc15a7e0b66fbab4d7a127d8efd3e12ca94443816655d01b1c25377e61c4d`.
Full path/size/hash maps, source/runtime/tool identities and exact command env,
cwd, bounds, outputs and exits are retained in the raw receipt.

Root authorized reuse of44ef typecheck based on unchanged tracked inputs and
recorded tools. The missing retrospective hash proof for installed transitive
declarations/tool-library files remains explicit. No build, typecheck repeat,
install, bundle, helper-control test, parent mutation, worker, full suite,
workload smoke, measurement or reviewer ran. The unchanged old bundle is **stale**.

## Output and cleanup evidence

The unchanged qualified teardown observer ran only for direct baseline,
containing and selected-origin commands. Its94 teardown inventories captured566
output files. Independent read-only verification checked every captured byte
length/hash and all56 emitted manifests:510 listed file entries, exact path sets
and all snapshot hashes recomputed from the pinned serialization rule. No ledgers
or keys were captured. Exact raw bytes are retained without normalizing fixture
timestamps, IDs, ownership or capability values.

Wrapper children sanitize their environment. Their44 actual-view and1 GC tests
therefore executed inner output assertions but had no external teardown observer
copying inner files. Full wrapper/inner TAP diagnostics are retained, including
Node20 escaped diagnostic formatting. This is not a cross-runtime whole-output
equality claim or uninstrumented timing evidence.

All38 observed PID/start identities and18 groups were absent after joining;
there were no adopted children or controller cleanup signals. All225 distinct
recorded fresh paths were absent, including28 command HOME/TMPDIR roots and4
inner wrapper roots. All command TMPDIRs were empty before removal.
Sampling every20ms can miss shorter-lived descendants. No generic interruption
or OS-close guarantee follows; injected close failures are the tests' existing
post-native-success cases.

The two old79a build HOME/TMPDIR roots remain untouched as permitted immutable
tooling evidence. Their21 original artifact hashes were rechecked. Fresh cleanup
success does not mean all historical roots were removed.
After root accepted this checkpoint, separate authorized filesystem housekeeping
removed only those two disposed tooling roots. The [new additive cleanup receipt](tooling-cleanup-after-r3.json)
records archive/bytes/ownership/modes/process revalidation. Earlier retained-root
receipts remain unchanged and checkpoint-specific.

The local slot was explicitly RELEASED at2026-11-08T17:15:34.469911Z, before
packaging. Controller application wall time was27.214353seconds within the one
900second deadline; automated cleanup0.048535seconds. First command to release,
including additive read-only inspection, was112.669956seconds, also below the
separate120second cleanup allowance. Additive inspection was not separately timed.

## Separate hosted browser failure and remaining gates

Hosted ecffd [Browser Ubuntu24 job128801143862](https://github.com/deveshsangwan/html-inbox/actions/runs/42503520909/job/128801143862)
failed the managed-backend variant at `sync-reader-browser.test.mjs:136:12`,
list count0 versus3 after Back to inbox. Managed-source passed. Node24.22.2
reported82 tests,80 pass,1 fail,1 skip,0 cancelled. The44611byte original log
SHA256 is `460f4d91421121014f5a32ccf6b975f56018340704d60bf8df26ae0b67321a69`.
Original metadata/log/pinned source are included under `separate-hosted-ci-browser`;
the run metadata snapshot was still in progress. This is a repeated navigation
symptom, with no established cause or pre-existence. No retry, assertion/waiter
change or browser investigation expansion followed. Local stub-browser correctness
does not replace that failing real-browser result. New docs heads need their own CI.

This receipt qualifies only the granted integrated correctness scope. The actual
b249 release build/bundle/workload smoke, practical complete-export/batch evidence,
package qualification and both fresh measured-pin reviews remain separate gates.
Complete current serialized ledger bytes are still read per body, with residual
O(N) bytes per body. No practical gain, full issue completion or release is claimed.

## Lossless raw evidence

[Archive](integrated-correctness-ecffd7c.tar.gz),1045034bytes, SHA256
`cdfbf2dd72cca6c50d0838792a472604be7ae1b8575d0f58f61eac3798cf96e0`.
All617 file members were compared byte-for-byte to disk;616 artifact hashes are
retained. It includes the exact controller and root diff/preparation, unchanged
observer, full logs/maps, captured output/teardown records, independent manifest
audit, additive release and separately labelled hosted browser failure. Root
independently accepted14 results,94 inventories/566 files,400 compiled outputs,
38 observed PIDs/18 groups and225 fresh paths before this publication.
