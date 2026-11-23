# Issue 94 qualification plan and receipt

Status: local qualification reports GO for the measured scope. Root has not independently verified that receipt. Full local gates passed on Node 20.20.2 and 24.19.0. The exclusive local slot was explicitly released to root and granted to queued issue 92. Both independent reviews pass functionality, code quality and scoped performance evidence at frozen `821a19e`. CI at that reviewed pin is green. The post-review documentation follow-up still needs its normal CI and root gates; PR 119 stays draft.

Issue: https://github.com/deveshsangwan/html-inbox/issues/94

Immediate parent: `610c931b7b22920cce59cf03e49c0de15ebaf2a2` on `perf/89-bench`, PR 114, ready and unmerged at activation. The candidate targets the shared Node >=20 compatibility line. There are no changes from issues 90, 91, 93 or PR 81 in this layer. The development configuration was confirmed as `gpt-6.1-sol`, `reasoningEffort=xhigh`. The initial worktree was clean.

## Contract and implementation

Every current ledger still passes the existing file read/replacement checks, JSON/schema parsing, canonical encoding and global record validation. The origin grant lookup, authorization, anchor, barrier, reader identity and directory checks stay in their current locations. Cache hits establish only that the same public key text, signature text and canonical signed bytes previously passed Ed25519 verification.

The process owns one cache shared across inboxes, short-lived readers and the worker. FIFO eviction bounds all instances of the production singleton together. A signature input cannot retain a caller's mutable Buffer or a small substring backed by a much larger string. Failed verifications and malformed/non-Ed25519 keys are not retained as successes. Oversized inputs still use real crypto and bypass retention without flushing useful entries. Key rotation, restored old bytes, new reader instances and changed signed fields use their exact current inputs.

Limits are 128 parsed Ed25519 keys with a 256 KiB budget and 16,384 successful verification tuples with a 16 MiB budget. A verification tuple over 128 KiB bypasses retention. Budgets charge two bytes per retained code unit plus 512 bytes per parsed key or 256 bytes per verification entry. Detached text prevents backing-string retention. Counts also bound Map entries and fixed-size Ed25519 KeyObjects. These are retained-input budgets with allowances, not an exact measurement of V8/native allocations. Qualification must report actual heap, external memory and RSS too. Cache lifetime ends with the process. There is no persistent cache, trust decision, storage policy or wire change.

## Original preselected plan, historical

This section preserves the pre-experiment plan. The failed pilots and accepted scope adjustment below supersede the initial-transfer, large-worker and 10,000-record ambitions. The qualified matrix is 0/100-record warm worker/read cells plus standalone 1,000-record read/churn cells. No 10,000-record or over-capacity repeating-scan result was measured. Use the final reproduction commands below.

The primary benefit metric is process CPU per full managed list/get read and per configured owned-worker confirmed no-op pass over authenticated loopback TLS. Elapsed time is supporting evidence. Snapshot timing is a secondary explanation. Record wall time and process CPU for all operations, crypto key-parse and verification counts, exact output checks, retained heap/external/RSS after explicit GC when available, and process peak RSS. Both in-process peers count toward CPU and memory. OS filesystem caches are uncontrolled and usually warm. A fresh process means a cold application cache only.

Use Node 20 and Node 24 separately, the same machine, build tools, lockfile, synthetic document counts, bytes, concurrency one, and no competing measurement job. Start with 0, 100 and 1,000 records, 10 KiB bodies, five fresh paired/interleaved process samples per revision. Include 1 MiB bodies at 100 records to distinguish crypto work from body reads. Add 10,000-record snapshot/read and retained-memory cases if the first matrix indicates a practical gain. Keep cold snapshot, warm snapshot, full list, exact-body get, worker startup, worker transfer/no-op, churn misses and post-churn hits separate.

For large histories, prepare receiver custody with real authenticated reconciliation before timing the worker no-op. The production worker pass deadline stays 60 seconds. Small histories may also measure initial worker delivery. State this difference; never compare those labels across counts. Shared89 sync workloads supplement this with complete initial/no-op/repair reconciliation, not a prototype crypto loop. Small, empty and cold cases must report overhead rather than disappearing from the result.

Compare the actual parent implementation to the candidate, not a historical prototype. Build each source pin with the same tools and preserve dist/bundle fingerprints. Also compare the candidate to parsed-key-only reuse through a benchmark-only adapter if needed to decide whether successful-verification retention pays for itself. This adapter must not add a runtime configuration flag or bypass parsing/authorization. Count hits and misses from real crypto calls outside assertions.

The go decision requires a repeatable practical CPU or latency improvement in full operations beyond paired run noise. Report n, every raw observation, min/median/max, absolute and percentage deltas, memory costs and cold/churn regressions. Do not infer p95 from five samples. A fast snapshot alone does not justify retaining the production change. If full operations do not improve enough to justify the added memory and code, remove production changes and retain an evidence/no-go PR.

## Correctness gates

Run the focused cache and warm-integrity tests plus the existing managed-store, reader compatibility, ledger race, protocol, identity/fork and worker lifecycle tests on Node 20 and 24. Run typecheck and the normal complete verification under the granted slot. Do not weaken a check to obtain green results. Reproduce suspected existing failures at the parent pin.

Required proofs include repeated rejection of changed signatures, signed fields and public keys after warmup; corruption of an unrelated record breaking a selected read; unchanged generation/mtime giving no exemption; schema, permissions, anchor, barrier and reader identity checks; mutable Buffer ownership; entry/byte eviction and oversized bypass; valid rotation and restored bytes; copy quarantine/fork; current concurrent atomic replacement; multiple reader/inbox lifetime. Unit tests using a crypto stand-in exercise retention capacity only. Real cryptography covers tampering, misses and eviction behavior separately.

## Source checks completed before slot

- `node --check packages/cli/src/sync-signatures.ts`, exit 0.
- `node --check packages/cli/src/sync-signatures.test.ts`, exit 0.
- `node --check packages/cli/src/sync-signature-integrity.test.ts`, exit 0.
- `git diff --check`, exit 0.

These are syntax/whitespace checks. Lightweight assertions also checked the companion operation I/O parser and Python runner syntax. No compiled production test, install, build, full suite or benchmark ran during source activation. The final shared I/O parser is exactly the parent expression. The intermediate escaping regression, red/green check and unchanged signature-path evidence are documented below.

## Qualification receipt

Production parent `610c931b7b22920cce59cf03e49c0de15ebaf2a2`; production candidate `999c75d37e1f1d86c25e58b4d45db3f96a66df38`. Small/read/worker harness `b31d7a2eeec8ec302687b158bbdfeb0a2ec69335`; standalone-history harness `e6b8bbb6883b8f3de4fc974a43500b866bcda7c9`. Production source did not change between those pins. The measured candidate dist is `3abb4dc0362ed464eb2c96f28a91f13b06bb651104a2722bf1287e9b9294175c`; bundle is `d4e9c3de496308c8e1ff33d049c33d578efb068b2f1080c71f1b62e889e5591b`. Final verification rebuilt exactly those same hashes.

All 90 small/read/worker and 30 standalone-history process cells exited 0. Each operation has five independent interleaved process samples per variant/runtime. See [measured results and tradeoffs](signatures-94-results.md) for CPU/elapsed spreads, paired deltas, cold/churn/startup/idle costs, actual retained/peak memory, scope and failure exclusions. Successful-verification retention provides practical gains beyond parsed-key-only reuse. There is no qualified initial-sync or 1,000-record worker result.

Commands and exit status:

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm --filter html-inbox bundle`: all 0. Dependencies were installed once at the candidate and reused for the parent with an identical lockfile. The original build receipts remain immutable; `build-execution-supplement.json` records actual per-pin commands and log hashes. The parent build ran in this checkout with an EXIT/INT/TERM restoration trap and copied immutable artifacts before switching back.
- `node --test packages/cli/dist/sync-signatures.test.js packages/cli/dist/sync-signature-integrity.test.js`: 22 passed on Node 24. The focused seven-file Node 20 invocation passed 147 tests; exact command/log are archived.
- `python3 artifacts/94/qualify.py --cells 0:10240,100:10240,100:1048576 --pairs 5 --prefix matrix-qualified-small`: 0, Node 20 and 24 separately. The driver alternates parent/key-only/full order across five process pairs and independently checks source and loaded-dist hashes.
- `python3 artifacts/94/qualify.py --workload signature-history --cells 1000:10240 --pairs 5 --prefix matrix-history`: 0. Same pairing, 18 real re-signing rounds per process, independent read/memory/corruption checks.
- `bash artifacts/94/verify-runtimes.sh`: 0. For each runtime this ran `node scripts/run-unit-tests.mjs --test-concurrency=4`, the named harness/skill/site tests, `node scripts/run-browser-tests.mjs`, `node scripts/package-smoke.mjs`, and `node scripts/skill-cli-package-smoke.mjs`. Node 20 unit/integration passed 1,346 with two skips; Node 24 passed 1,345 with three skips. Both browser suites passed 73 with the live-CDN check skipped. Every constituent command exited 0. Node 24's extra skip is the existing native IPv6 SAN case; other skips require an explicitly supplied old CLI or Windows.
- `python3 -m unittest discover -s scripts/bench -p 'test_*.py'`: four tests passed under each runtime environment, including cleanup, numeric I/O and argument checks. The new ordinary-parser I/O check failed before repair, then passed. `node artifacts/94/check-io-equivalence.cjs`: 0; all five literal nonzero counters pass, the inherited declaration exactly matches parent, and signature parsing/timing code is unchanged. Primary timing-region SHA-256 is `d9f729235ca21db4be572bece8b35eb6985457ad9451e4e09e83bf89649d535b`.
- Final `pnpm typecheck` and `git diff --check`: 0. Final dist/bundle equality with measured artifacts passed. All measurement cleanup receipts report removed fixture roots and reaped direct children; runtime/receiver exact ports are rebound by the workload. No heavy process remained at slot release.

The [compressed raw archive](signatures-94-raw.jsonl.gz) contains 631 original UTF-8 files in gzip JSONL records with original-byte SHA-256, path and text. It is 839,044 bytes, SHA-256 `fcd2afb6dd0c627084fae869f12c2a773644c34cff9467e955e0a84750571185`. Every embedded original-byte hash was verified after compression. It includes commands, raw samples/stdout, environments/fingerprints, source/build receipts and execution supplement, failures/discards, cleanup, parser red/green/equivalence evidence and full local gate logs. Compiled build directories are excluded. Read a record with Python's `gzip`/`json`; each `text.encode('utf8')` must match its `sha256`. The same files remain under local `artifacts/94/` for direct inspection.

## CI triage and remaining gates

Original published head was `999c75d37e1f1d86c25e58b4d45db3f96a66df38`, run `42388445296`. Read current checks, all comments/reviews and both failed job logs before choosing a retry or fix. The only comment was the bot's draft-review notice; there were no review findings.

- Ubuntu Node 20 shard 2 job `128450720113` failed `actual client rejects oversized identity response and leaves recoverable work`: receiver request count was 0 versus expected 1. The test uses a 500 ms request budget. Earlier safety assertions passed. Cause is unresolved; unchanged source and a green parent job do not establish a pre-existing failure. Narrow diagnosis remains with issue 94; no production or test patch has been made for this CI failure.
- Windows browser job `128450720154` failed the legacy, non-managed changed-deletion fixture during `viewer.json` cleanup with EPERM. Root assigned issue 93 as the single read-only shared diagnostic lead; this cache PR leaves that surface unchanged pending coordination.
- Verify job `128452400001` is the aggregate failed gate. Parent PR 114 at exact `610c931` has successful corresponding Ubuntu Node 20 and Windows browser jobs. Original job logs, current checks/comments and parent-check context are in the raw archive. No retry has been used to chase green. The new frozen review head received normal CI and passed; the obsolete head was not rerun for a green badge.

Completed: fresh independent Sol High and claudeAgent Sonnet 5.5 Medium read-only reviews of the same frozen `821a19e`, with PASS verdicts from both on functionality, code quality and scoped performance evidence. See [all findings and dispositions](signatures-94-reviews.md). The reviewed pin has 16 successful Verify Actions checks, a successful CodeRabbit status and one skipped Macroscope check, 18 nonblocking rollup entries. Pending: normal CI for the doc-only follow-up and root audit/approval. The original failures remain unresolved observations; later green jobs do not establish their causes. Each owner now babysits its own PR through the requested watch; delegated reviewers/helpers never watch. No merge, release, publication or modern forward-port is part of this work.

## Final reproduction commands

Build and preserve the actual parent and candidate source pins first; independently verify their source/dist manifests and keep the restoration trap. Select Node 20.20.2 and Node 24.19.0 separately through `NODE`. For each runtime and matrix cell, run five pairs with `PAIR=0..4`, using order parent, keys, full on even pairs and full, keys, parent on odd pairs. Every invocation uses `--samples 1` and a new output directory. The archived `qualify.py` and command JSONL files record the exact executed order and absolute runtime/build paths.

Set `DIST` and `SOURCE_SHA` to the preserved parent dist and `610c931b7b22920cce59cf03e49c0de15ebaf2a2` for `VARIANT=parent`, `MODE=full`. For `VARIANT=keys` or `full`, select candidate dist and `999c75d37e1f1d86c25e58b4d45db3f96a66df38`; use `MODE=keys` or `full` respectively. Key-only is a benchmark adapter. Full selects the actual implementation in the chosen dist, which is uncached for the parent.

Run each of these cells for both runtimes and every variant/pair. For the first command use `COUNT=0`, then a separate cell with `COUNT=100`. These are the qualified warm worker/read cells; they are not initial-sync measurements.

```sh
python3 scripts/bench/run.py signatures --node "$NODE" --counts "$COUNT" --sizes 10240 --samples 1 --timeout 1200 --signature-mode "$MODE" --implementation-dist "$DIST" --implementation-ref "$SOURCE_SHA" --out "artifacts/94/reproduce-$RUNTIME-$COUNT-10240-$PAIR-$VARIANT"
python3 scripts/bench/run.py signatures --node "$NODE" --counts 100 --sizes 1048576 --samples 1 --timeout 1200 --signature-mode "$MODE" --implementation-dist "$DIST" --implementation-ref "$SOURCE_SHA" --out "artifacts/94/reproduce-$RUNTIME-100-1048576-$PAIR-$VARIANT"
```

The separate qualified 1,000-record cells omit worker setup. Run this command for both runtimes and every variant/pair; do not substitute `signatures --counts 1000` or claim a large-worker result.

```sh
python3 scripts/bench/run.py signature-history --node "$NODE" --counts 1000 --sizes 10240 --samples 1 --timeout 1200 --signature-mode "$MODE" --implementation-dist "$DIST" --implementation-ref "$SOURCE_SHA" --out "artifacts/94/reproduce-history-$RUNTIME-1000-10240-$PAIR-$VARIANT"
```

The runner fingerprints selected JavaScript and companion source but deliberately records the supplied source ref as unverified. Independently tie each dist to its clean source/compiler/dependency build receipt before interpreting results. These final instructions correct the historical plan prose only; executable workloads and the measured archive are unchanged.

## Qualification scope adjustment

Production build pin is `999c75d37e1f1d86c25e58b4d45db3f96a66df38`. Harness pin `863ea1bd09911f148110611e13e3cac36d4bb89d` corrected warm labels without changing production. A later harness revision separates `signature-history` cells from worker cells and explicitly populates validated custody before timing worker no-op passes. Every matrix receipt must identify the harness pin and hash its three companion files independently of the selected production dist.

The parent 1,000-record real-TLS receiver setup failed to confirm within the 300-second run budget, with 59 confirmed, 941 pending and aborted/local-validation-or-storage-failed. Its measured child ran 303,368 ms. The underlying cause is not established. A subsequent 100-record parent initial worker pass on Node 20 also aborted within its existing 60-second pass, with 48 confirmed and 52 pending. Keep both failed cells and their partial stdout, but exclude their partial reads from completed paired cells. No deadline or production validation changed.

For worker no-op cells, configure real routes and use public `completeInventory`, `apply` and `acknowledge` operations over actual source-signed descriptors and exact bodies to establish receiver custody. These operations produce actual receiver receipts; they do not establish or claim an initial TLS transfer. Validate complete record/descriptor/body/receipt sets through current production reads, then require a real authenticated TLS reconciliation to confirm with zero transfers before timing. The timed operation is the configured owned worker's later confirmed no-op pass, labeled `worker-noop-validated-custody`. Sender/receiver snapshots still perform global cryptographic/schema/ownership/anchor/barrier checks. Initial-sync performance and 1,000-record worker performance remain unqualified.

Successful large-history `signature-history` cells measure cold/warm global snapshots, full list/get, real re-signing churn, post-churn reads and memory retention independently of worker setup. They use fresh process fixtures with the same production enrollment and validation. Snapshot results remain secondary to full list/get CPU. No large-worker speedup follows from these cells.

Worker startup is a warm in-process owned-runtime start after the full read and custody preparation sequence. Sender and TLS receiver run in one Node process and share the signature singleton. Their combined CPU and resident memory are measured together. This is not cold subprocess/daemon launch or a separate-host measurement. Process-level CPU includes setup and forced GC; operation timing excludes explicit GC before/after the operation and still includes any natural GC during it. Linux wait4 peak RSS is the largest process high-water mark, not a sum of process-tree high-water marks.

The root identified a shared I/O parser escaping regression in harness b31d7a2. Its signature/history numeric branch was correct, so the recorded signature matrix remains valid. After the matrix ended, a new public-runner regression test reproduced zero `rchar` in the inherited parser workload. Restoring the exact parent expression fixed it. The primary operation/timing region is byte-identical and the corrected parser produces the same signature-path results. Preserve both harness pins/hashes, red/green logs and the equivalence receipt. Cleanup and opt-in argument checks run on Node 20 and 24.

## Post-review scope and migration limits

The cache can benefit repeated managed reads within a viewer/hub process using `LocalDocumentBackend` or `LocalDocumentSource`, and worker snapshots/passes using the long-lived store in `sync-worker.ts`. New store objects in the same process reuse the module singleton. These call paths explain the intended lifetime; this issue did not benchmark viewer/hub HTTP latency. A command that reads each signed state only once has no verification-cache hit and pays retention cost versus key-only reuse. Multistep commands can reuse within one process; separate CLI launches cannot share this cache.

Every current global ledger scan and canonical encoding still runs. The optimization changes a constant factor, not the worker's repeated global-validation growth. No 1,000-record worker speedup or general scaling claim follows from the 100-record no-op result.

FIFO hits do not refresh insertion order. Several inboxes or larger canonical metadata can exhaust the byte budget even below the ledger record-count limit. A repeating scan whose working set exceeds capacity can have zero verification-cache hits and pay allocation/insertion/eviction cost on every record. The 18-round churn result proves bounded growth under changing history, not performance for an over-capacity repeating scan. Ten-thousand-record and multi-inbox over-capacity performance remain unqualified; the measured miss costs and this limitation are accepted scope limits, not an unmeasured speedup claim. Tuple size follows public-key/descriptor metadata, not retained HTML contents.

Measurements used Linux tmpfs synthetic roots with warm/uncontrolled filesystem caches. Do not generalize the elapsed or RSS values to persistent media or separate hosts. The unexplained Node 20 empty startup/one-second idle regression remains open and disclosed. A future ESM migration must revalidate crypto-call observability and mocks; current call counts depend on CommonJS crypto-property interception. No modern forward-port was performed.
