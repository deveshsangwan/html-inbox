# Issue 94 qualification plan and receipt

Status: local qualification reports GO for the measured scope. Root has not independently verified that receipt. Full local gates passed on Node 20.20.2 and 24.19.0. The exclusive local slot was explicitly released to root and granted to queued issue 92. Independent reviews, current-head CI and root gates remain open; PR 119 stays draft.

Issue: https://github.com/deveshsangwan/html-inbox/issues/94

Immediate parent: `610c931b7b22920cce59cf03e49c0de15ebaf2a2` on `perf/89-bench`, PR 114, ready and unmerged at activation. The candidate targets the shared Node >=20 compatibility line. There are no changes from issues 90, 91, 93 or PR 81 in this layer. The development configuration was confirmed as `gpt-6.1-sol`, `reasoningEffort=xhigh`. The initial worktree was clean.

## Contract and implementation

Every current ledger still passes the existing file read/replacement checks, JSON/schema parsing, canonical encoding and global record validation. The origin grant lookup, authorization, anchor, barrier, reader identity and directory checks stay in their current locations. Cache hits establish only that the same public key text, signature text and canonical signed bytes previously passed Ed25519 verification.

The process owns one cache shared across inboxes, short-lived readers and the worker. FIFO eviction bounds all instances of the production singleton together. A signature input cannot retain a caller's mutable Buffer or a small substring backed by a much larger string. Failed verifications and malformed/non-Ed25519 keys are not retained as successes. Oversized inputs still use real crypto and bypass retention without flushing useful entries. Key rotation, restored old bytes, new reader instances and changed signed fields use their exact current inputs.

Limits are 128 parsed Ed25519 keys with a 256 KiB budget and 16,384 successful verification tuples with a 16 MiB budget. A verification tuple over 128 KiB bypasses retention. Budgets charge two bytes per retained code unit plus 512 bytes per parsed key or 256 bytes per verification entry. Detached text prevents backing-string retention. Counts also bound Map entries and fixed-size Ed25519 KeyObjects. These are retained-input budgets with allowances, not an exact measurement of V8/native allocations. Qualification must report actual heap, external memory and RSS too. Cache lifetime ends with the process. There is no persistent cache, trust decision, storage policy or wire change.

## Preselected measurements

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

These are syntax/whitespace checks. Lightweight assertions also checked the companion operation I/O parser and Python runner syntax. No compiled production test, install, build, full suite or benchmark ran during source activation. The companion corrects operation I/O matching only for its opt-in mode; inherited timed workloads retain their original behavior.

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
- Verify job `128452400001` is the aggregate failed gate. Parent PR 114 at exact `610c931` has successful corresponding Ubuntu Node 20 and Windows browser jobs. Original job logs, current checks/comments and parent-check context are in the raw archive. No retry has been used to chase green. A new frozen head will receive normal CI; do not rerun a superseded head just for a green badge.

Pending: fresh independent Sol High and claudeAgent Sonnet 5.5 Medium read-only reviews at the same frozen revision, all three verdicts from both, finding disposition, current-head CI and root verification. Each owner now babysits its own PR through the requested watch; delegated reviewers/helpers never watch. No merge, release, publication or modern forward-port is part of this work.

## Runner commands

After independently building and preserving exact source pins, select the measured runtime explicitly. Run each command with `--samples 1`, alternate parent/candidate order for five pairs, and use a fresh output directory per process sample. This provides five independent process pairs rather than five adjacent candidate processes.

```sh
python3 scripts/bench/run.py signatures --node /absolute/path/to/node20.20.2 --counts 0,100,1000 --sizes 10240 --samples 1 --timeout 1200 --implementation-dist /absolute/path/to/pinned-dist --implementation-ref SOURCE_SHA --out artifacts/94/RUNTIME-VARIANT-PAIR
python3 scripts/bench/run.py signatures --node /absolute/path/to/node24.19.0 --counts 100 --sizes 1048576 --samples 1 --timeout 1200 --implementation-dist /absolute/path/to/pinned-dist --implementation-ref SOURCE_SHA --out artifacts/94/RUNTIME-VARIANT-LARGEBODY-PAIR
```

Use `--signature-mode keys` only with the candidate dist for the benchmark-only parsed-key comparison. `full` means the selected dist's actual implementation, which is uncached for the parent. The runner fingerprints selected JavaScript but deliberately records the supplied source ref as unverified. An independent build receipt must tie each dist graph to its source checkout, compiler, dependencies and commands before interpreting results.

## Qualification scope adjustment

Production build pin is `999c75d37e1f1d86c25e58b4d45db3f96a66df38`. Harness pin `863ea1bd09911f148110611e13e3cac36d4bb89d` corrected warm labels without changing production. A later harness revision separates `signature-history` cells from worker cells and explicitly populates validated custody before timing worker no-op passes. Every matrix receipt must identify the harness pin and hash its three companion files independently of the selected production dist.

The parent 1,000-record real-TLS receiver setup failed to confirm within the 300-second run budget, with 59 confirmed, 941 pending and aborted/local-validation-or-storage-failed. Its measured child ran 303,368 ms. The underlying cause is not established. A subsequent 100-record parent initial worker pass on Node 20 also aborted within its existing 60-second pass, with 48 confirmed and 52 pending. Keep both failed cells and their partial stdout, but exclude their partial reads from completed paired cells. No deadline or production validation changed.

For worker no-op cells, configure real routes and use public `completeInventory`, `apply` and `acknowledge` operations over actual source-signed descriptors and exact bodies to establish receiver custody. These operations produce actual receiver receipts; they do not establish or claim an initial TLS transfer. Validate complete record/descriptor/body/receipt sets through current production reads, then require a real authenticated TLS reconciliation to confirm with zero transfers before timing. The timed operation is the configured owned worker's later confirmed no-op pass, labeled `worker-noop-validated-custody`. Sender/receiver snapshots still perform global cryptographic/schema/ownership/anchor/barrier checks. Initial-sync performance and 1,000-record worker performance remain unqualified.

Successful large-history `signature-history` cells measure cold/warm global snapshots, full list/get, real re-signing churn, post-churn reads and memory retention independently of worker setup. They use fresh process fixtures with the same production enrollment and validation. Snapshot results remain secondary to full list/get CPU. No large-worker speedup follows from these cells.

Worker startup is a warm in-process owned-runtime start after the full read and custody preparation sequence. Sender and TLS receiver run in one Node process and share the signature singleton. Their combined CPU and resident memory are measured together. This is not cold subprocess/daemon launch or a separate-host measurement. Process-level CPU includes setup and forced GC; operation timing excludes explicit GC before/after the operation and still includes any natural GC during it. Linux wait4 peak RSS is the largest process high-water mark, not a sum of process-tree high-water marks.

The root identified a shared I/O parser escaping regression in harness b31d7a2. Its signature/history numeric branch was correct, so the recorded signature matrix remains valid. After the matrix ended, a new public-runner regression test reproduced zero `rchar` in the inherited parser workload. Restoring the exact parent expression fixed it. The primary operation/timing region is byte-identical and the corrected parser produces the same signature-path results. Preserve both harness pins/hashes, red/green logs and the equivalence receipt. Cleanup and opt-in argument checks run on Node 20 and 24.
