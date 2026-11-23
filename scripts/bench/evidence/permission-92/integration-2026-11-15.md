# Permission investigation integration, 15 November 2026

Related to [issue #92](https://github.com/deveshsangwan/html-inbox/issues/92) and [PR #118](https://github.com/deveshsangwan/html-inbox/pull/118). This receipt records how the qualified investigation was merged onto the reviewed #91 parent and requalified. No chmod optimization ships and no new performance result is claimed. The fuller original text, including the pre-execution proposal and grant bounds, is preserved at [b813f68](https://github.com/deveshsangwan/html-inbox/blob/b813f68a1527ab7843f60aef3d87f0f473050a1d/scripts/bench/evidence/permission-92/integration-2026-11-15.md).

## Merge

Commit `7356498207bafe235229270c1c1406c385b69c1f` is an ordinary merge of parent `bf80f9fa4815376f1771c3a6cb78d5ed19231ad2` (PR #116) into qualified head `aa72af4423736821c460807cdcac802f0c9f5634`. It had no conflicts. All 102 blobs owned by this investigation matched aa72, and all 30 blobs changed by the parent matched bf80. Production `private-storage.ts` keeps SHA-256 `000d77f9dbd585e3f10ea393f03a6e59049980d4d3aae34a219e2cbfd4413e62`. The four characterization tests, Windows handling, the listing pool's eight shared permits with sibling draining, and read-only hub sources are unchanged. The inherited listing and storage changes belong to PR #116 and are not verified here beyond the focused tests below.

## Commands and results

All runs used the unchanged source at 7356498, fixture-owned `HOME`, `TMPDIR` and catalog directories, and exact runtimes Node 20.20.2 and 24.19.0. The focused command is the same for both runtimes:

```sh
$NODE --test --test-concurrency=1 --test-reporter=tap packages/cli/dist/private-storage.test.js packages/cli/dist/private-json.test.js packages/cli/dist/backend-listing.test.js packages/cli/dist/backend-records.test.js packages/cli/dist/storage-cleanup.test.js packages/cli/dist/local-document-source.test.js packages/cli/dist/inbox-catalog.test.js packages/cli/dist/sync-store.test.js packages/cli/dist/sync-storage-faults.test.js packages/cli/dist/sync-reader-compatibility.test.js packages/cli/dist/sync-maintenance.test.js packages/cli/dist/sync-acquisition-deadline.test.js packages/cli/dist/hub-http.test.js packages/cli/dist/viewer-document-deletion.test.js packages/cli/dist/viewer-http.test.js
$NODE --test --test-concurrency=1 scripts/hub-browser.test.mjs
```

| Run | Outcome |
| --- | --- |
| R1 | Stopped during preparation; no command ran. |
| R2 | `pnpm typecheck` exited 1: pnpm attempted an implicit install and aborted without a TTY. Later commands did not run. The dependency-status cause is unknown. |
| R3 | Expanded the package scripts to the installed compiler with Node 24.19.0: `tsc-rs -p tsconfig.json --noEmit`, the root build's `rmSync` of `packages/cli/dist`, then `tsc-rs -p tsconfig.json`. All exited 0. The focused command passed 285 tests with no failures or skips on each runtime. The browser file failed all three cases on Node 20 at Chromium launch with `Socket path too long` under the long fixture `TMPDIR`; Node 24 browser did not run. |
| R4 | Reinstalled the exact R3 compiled output, verified against R3's build map, and set `TMPDIR`, `TMP` and `TEMP` to a fresh short private directory. The browser file passed three tests with no failures or skips on each runtime. Nothing else changed. |

R3 and R4 restored the complete prior generated output (files, types, bytes, modes and mtimes), source, index and inventoried tool files. Inode and ctime restoration is not claimed. The parent's earlier strict compiler-cache audit failure is separate and not waived here.

## Evidence

Receipts, logs and restoration maps for R1 to R4 are committed under [`integration/`](integration/). Each `.gz` file decompresses with `gzip -dc`. [`integration/source-sha256.json`](integration/source-sha256.json) records the SHA-256 of every archived file before compression. Compiled output and fixture trees were not archived. Key log hashes:

| Log | SHA-256 |
| --- | --- |
| R3 focused, Node 20 | `0777877566421cd8e9c7cea2fc44069ca0c504d1781da33e6b0062937a723e00` |
| R3 focused, Node 24 | `a413ef44183dfc51cdbf7feebac4d53e162547431cf0f1eca27c33853b6cf564` |
| R4 browser, Node 20 | `caee53d77af973b701c00496153cc4b830f90268b5b7861c229c806ad0d35326` |
| R4 browser, Node 24 | `dadf78f8c728185f5ab7fa1c364c901ae3d04ec450bc989d7427b6370b14d233` |

Published head `b813f68a1527ab7843f60aef3d87f0f473050a1d` later passed [Verify run 43678418304](https://github.com/deveshsangwan/html-inbox/actions/runs/43678418304), all 16 Actions jobs, based on run metadata.

## Limits

These runs establish no speedup, race-free storage, or foreign-owner and `EPERM` equivalence. No full suite or package check was rerun for the merge. The shared hosted c4 failures, the separate local 5a8 history gate, the historical managed-ledger nlink failure and the Mac held-ACK diagnosis remain unresolved and are not explained by any later green result.
