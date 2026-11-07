# Issue 94 independent reviews and disposition

Both fresh reviewers inspected frozen `821a19e9e896353b8fb557910d92056dedf6716e` against immediate parent `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. The worktree stayed clean and unchanged through both reviews. Both received the complete rubric and issue/contract, source, tests, raw measurements, fingerprints, failures, cleanup and tradeoffs. Neither ran a build/suite/benchmark, edited files, delegated, or watched the PR. The local heavy slot had been explicitly released to root and granted to issue 92 before they started.

| Reviewer | Requested and confirmed setting | Functionality | Code quality | Performance evidence |
|---|---|---|---|---|
| Codex | gpt-6.1-sol, reasoningEffort high | PASS | PASS | PASS for qualified scope |
| Claude Code | claudeAgent, claude-sonnet-5-5, effort medium | PASS | PASS | PASS for qualified scope |

Sol reported no actionable findings and independently checked all 631 original-byte archive hashes, source/build manifests, 120 cells and 1,140 per-process operation summaries against raw values. Sonnet independently checked the archive/provenance, cell counts and all 12 large-read CPU rows, and accepted the memory/code tradeoff within the measured scope. Sonnet's opening code-quality summary mentioned Low/Suggestion items, while its full findings also contain two Medium scope/evidence items. Both Medium items are retained and dispositioned explicitly below.

These are independent review verdicts, not root GO or merge approval. Root's earlier archive/source preflight was not a full statistical/code audit. Production and executable benchmark code remain the measured/reviewed code. The only post-review changes are these Markdown dispositions, historical-plan/reproduction-command corrections and clarified limits. The raw archive is unchanged, SHA-256 `fcd2afb6dd0c627084fae869f12c2a773644c34cff9467e955e0a84750571185`.

## Findings disposition

| ID | Severity and frozen reference | Disposition and reason |
|---|---|---|
| S1 | Medium, `sync-signatures.ts:67`, benchmark churn | Accepted the explicit-scope remedy. The report and PR state that 10,000-record and multi-inbox/large-metadata over-capacity scans are unqualified. FIFO hits do not refresh order; a repeating working set beyond capacity can miss on every record while paying copies/insertion/eviction. The 18-round changing-history result proves bounded retention, not that repeating-scan performance. No new measurement or scaling claim was added. |
| S2 | Medium, results' decision/scope text | Accepted. Named actual repeated consumers: managed LocalDocumentBackend/LocalDocumentSource calls in viewer/hub processes, plus worker snapshots/passes. Store instances share one module cache. A one-read-per-state command has no verification-cache hit and pays the disclosed miss cost versus key-only; multistep commands can reuse within their one process, while separate launches cannot. Global scans and worker growth are unchanged. No viewer HTTP, large-worker, initial-sync or separate-host gain is inferred. |
| S3 | Low, results' Node 20 empty startup/idle rows | Accepted as an open, disclosed limitation, as the review permits. The startup/one-second-idle regressions and ranges remain in the results. Their cause and long-term idle implications are unresolved. No additional diagnostic was run after slot release, and no empty-workload benefit is claimed. |
| S4 | Low, `sync-signatures.ts:50` and `:59`, miss/oversize copies | Not adopted. The owned immutable message establishes that the exact bytes in the cache identity are the bytes verified. Verifying the original caller Buffer would add a non-mutation assumption, including for shared backing memory. The copies and their cold/miss costs are measured and disclosed; key-only avoids that work, so that comparison remains conservative. An oversize-copy optimization is optional future work requiring its own input-ownership proof and qualification, not an integrity shortcut in this change. |
| S5 | Low, `sync-signatures.ts:33` and `:67`, duplicated eviction | Not adopted. Two small direct loops operate on different value shapes. Their accounting is covered by entry/byte/eviction tests. A common helper adds an abstraction solely to remove a few lines, contrary to the purpose-specific seam requested here; the reviewer also calls the duplication tolerable. |
| S6 | Suggestion, `sync-signatures.ts:80` and `sync-model.ts:6`, usage/singleton ownership | Retained the existing arrangement. The current comment already explains process lifetime across readers/workers/inboxes. The usage method returns counters without exposing cached input/key contents or mutation controls. The benchmark's prototype interception remains benchmark-only. No extra exported mutable singleton/accessor or production telemetry framework was added. |
| S7 | Suggestion, `sync-signatures.test.ts:21` and benchmark crypto interception | Accepted as a documentation limit. The migration note requires revalidating call-count/mocking observability if a future port uses ESM named bindings. These CommonJS interception assumptions must not be copied silently into a modern port. No forward-port was performed. |
| R1 | Root report wording/reproduction commands | Accepted after both reviews finished. The original plan is explicitly historical; the final parser is described as exactly restored to the parent. Final reproduction commands use signatures at 0/100 records and 100 records with 1 MiB bodies, plus standalone signature-history at 1,000 records for each runtime/variant/pair. No executable or measurement changed. Root explicitly allowed this doc-only correction without another review round. |

The earlier root I/O finding was already fixed and reviewed: a public-runner regression test went red, the original parent declaration was restored, both runtime harness checks passed, and signature parsing/primary timing equivalence is recorded. The build-accounting finding was already corrected by the immutable original receipts plus the actual install-once/per-pin execution supplement. Neither required a production change.

## CI receipt and remaining gates

Reviewed head `821a19e` completed normal [run 42398047735](https://github.com/deveshsangwan/html-inbox/actions/runs/42398047735) with 16 successful Verify Actions checks, a successful CodeRabbit status and one skipped Macroscope check. That is 18 nonblocking rollup entries, not 18 individual SUCCESS conclusions. The formerly failing Ubuntu Node 20 shard passed [job 128479580052](https://github.com/deveshsangwan/html-inbox/actions/runs/42398047735/job/128479580052); Windows browser passed [job 128479579806](https://github.com/deveshsangwan/html-inbox/actions/runs/42398047735/job/128479579806).

Original `999c75d` run `42388445296`, attempt 1, remains preserved with its two failures and unresolved causes. A later green head does not prove either was pre-existing or explain it. No obsolete-head retry was used. Root assigned issue 93 the single read-only shared Windows diagnostic lead; this PR leaves that surface unchanged.

The post-review Markdown-only head receives its normal CI. The owner watch stays active through green periods as requested. Root audit/approval remains open; keep PR 119 draft. No merge, release or modern forward-port is authorized.

## Full independent outputs

The CI observations inside the review outputs are snapshots from review time, superseded by the green reviewed-head receipt above.

<details>
<summary>Sol High functionality review, verbatim</summary>

No actionable findings in the full immediate-base-to-frozen-HEAD diff. Independent verdicts are below; this is not merge approval.

Reviewed HEAD `821a19e9e896353b8fb557910d92056dedf6716e` against base `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Git status was clean before and after review. I made no edits and ran no builds, suites or benchmarks.

1. **Functionality: PASS.** The length-prefixed identity distinguishes exact public-key text, signature text and signed bytes. Latin-1 preserves the bytes, and detached immutable strings prevent caller Buffer mutation or backing-string retention from changing cached facts. Only successful verification enters the success cache. Both caches enforce FIFO entry and retained-input bounds; oversized entries bypass retention.

   The singleton deliberately spans readers and inboxes. Its synchronous operations introduce no asynchronous cache race. Hits skip crypto only. Current ledger reads, schema/canonical parsing, global record verification, grant lookup, ownership/permissions, anchor, barrier, reader identity and replacement checks remain in their existing paths.

   Tests meaningfully cover warm unrelated-record corruption, repeated invalid inputs, rotation/restoration, copy quarantine/fork, concurrent replacement, eviction, byte limits, oversized bypass and Buffer ownership. Capacity stand-ins are confined to retention tests, with real crypto restored for eviction checks. I found no Node 20 compatibility issue.

2. **Code quality: PASS.** The small dedicated verifier has a clear responsibility and direct integration at the two existing crypto sites. Production code follows the supplied naming, semantic-paragraph, narrowing and type-inference rules. Comments explain exact-input identity, ownership and memory accounting. No speculative abstraction, unsafe assertion, suppression or unrelated production change warrants a finding. Parsed-key-only reuse is simpler, but the evidence supports the additional successful-verification cache.

3. **Performance evidence: PASS for the explicitly qualified scope.** I independently verified:

   - The archive’s supplied SHA-256, all 631 embedded hashes, both source manifests against Git, and preserved dist/bundle files against their manifests.
   - All 120 qualified process cells, five samples per variant/runtime/cell, commands, companion fingerprints, exits, operation counts, cache bounds and cleanup.
   - All 1,140 per-process operation summaries and their aggregate statistics against raw observations, including CPU, elapsed time, memory and crypto counts.
   - Build originals plus execution supplement, parser red/green receipts, and the unchanged primary timing region.

   The repeated full-read and prepared 100-record worker results demonstrate practical CPU savings beyond parsed-key reuse. Actual custody creation, production body reads and authenticated zero-transfer TLS confirmation support the stated no-op workload.

   The added memory and miss-path costs are justified within that scope. Retained-input budgets are not RSS caps; forced GC is excluded from operation timing, and process high-water RSS is not aggregate process-tree RSS. Cold daemon launch, separate hosts, initial sync, 1,000-record workers, 10,000-record workloads and long-term idle behavior remain unqualified.

Archived local gates support passes on both runtimes. Original CI run `42388445296` still has unresolved Ubuntu oversized-identity request-count and Windows `viewer.json` cleanup failures. Green parent jobs do not establish either as pre-existing. At my current-head inspection, both corresponding jobs passed, while macOS Node 20 shard 2 and Windows Skills remained running. Keep the PR draft pending complete CI, the other independent review and root gates.

PR https://github.com/deveshsangwan/html-inbox/pull/119, head 821a19e9e896353b8fb557910d92056dedf6716e, checks and reviews current CI incomplete; this independent review passes functionality, code quality and scoped performance evidence with no actionable findings.

</details>

<details>
<summary>Claude Code Sonnet 5.5 Medium code-quality review, verbatim</summary>

# Issue 94 / PR 119 review (code-quality emphasis)

HEAD is 821a19e, the tree is clean, and I made no edits. Production source under `packages/` is identical between the measured pin 999c75d and 821a19e, so measured code equals frozen code. I ran no suites, builds or benchmarks. I read the source, tests, evidence and archive. The PR checks I saw had no failures, but one job (`Source (macos-latest, 20, 2/2)`) was still pending and the listing was cut off at 20 lines, so I did not see the rest. I did not check CI for the new head separately.

## Verdicts

1. **Functionality: pass, no defects found.**
   - Parsing, canonical encoding, grant lookup, ownership, anchor, barrier and reader checks are untouched.
   - Only the `createPublicKey`/`verify` calls in `sync-model.ts:107-109` and `:157` changed.
   - The cache key (`sync-signatures.ts:45-52`) is length-prefixed public key, length-prefixed signature, then latin1 bytes. That is unambiguous and byte-exact.
   - Only successful Ed25519 verifications are retained. Non-ed25519 and invalid keys throw or bypass retention.
   - The cache key owns its own copy of the Buffer bytes.
   - Oversized entries (over 128 KiB) skip retention without flushing the cache.
   - Both eviction loops are FIFO and correct: they cannot underflow, and an empty map always has room.
   - `sync-signature-integrity.test.ts` covers the acceptance cases against real stores, with the replacement file given the old mtime and unchanged generation. Cases covered:
     - changed signature, signed field and key;
     - schema, permission, anchor, reader-identity and barrier failures;
     - rotation, restore and fork;
     - concurrent replacement.
   - The Windows skip in that file is a documented limitation.

2. **Code quality: pass, with Low and Suggestion items only.** The module is small, with one purpose and a narrow interface (`verify`, `parsePublicKey`). The tests assert on observable crypto-call counts rather than internals.

3. **Performance evidence: pass for the stated scope, with limits.**
   - The archive's SHA-256 is fcd2afb6…0571185, and all 631 embedded hashes match.
   - The qualified cells are exactly 90 small and 30 history, five per variant.
   - Every candidate and key-only environment shows dist hash 3abb4dc0, and every parent shows 41663c8a. The superseded harness pins (863ea1b, b31d7a2, e6b8bbb) are labelled as such.
   - I recomputed the 1,000-record list/get CPU medians and ranges from raw samples. All 12 rows match the results table.
   - Full-versus-parent ranges do not overlap, and the build supplement and I/O-equivalence receipt are present and consistent.
   - The benchmark's CPU window excludes forced GC, and natural GC inside operations is included.

## Findings

**Medium. Unmeasured scan-thrash regime** (`sync-signatures.ts:68-80`, `scripts/bench/signatures.cjs` churn)
- The cache holds about 12k entries, at roughly 1.33 KiB each at 10 KiB bodies. `SYNC_LIMITS.records` allows 10,000 records, and several inboxes or larger metadata can exceed capacity.
- FIFO does not refresh on a hit. A repeating scan larger than capacity then gets a 0% hit rate and still pays two string copies and a Map insert per record.
- The contract said to add 10,000-record cases if the first matrix showed a gain. That was not done.
- The measured churn-miss costs at 1,000 records are 197.7 ms versus 186.5 ms for key-only on Node 20, and 176.5 versus 174.3 ms on Node 24.
- Fix: measure one 10k-record or multi-inbox over-capacity cell, or state the limit explicitly in the PR.

**Medium. Benefit is limited to long-lived processes, and the worker metric is dominated by existing quadratic validation** (results lines 139-143)
- A one-shot CLI process starts cold and gains only from key reuse. At 1,000 records on Node 20, cold-snapshot CPU is 290 ms for full versus 264 ms for key-only, which is about 10% worse.
- Parent is 442 ms on that same cold snapshot, so full still beats parent.
- The 65% worker gain at 100 records comes from a no-op pass that costs 16.7 s of CPU on parent. That points to per-request global validation, so the cache cuts a constant factor and does not change the growth.
- The 1,000-record worker case failed even on parent, and it is correctly marked unqualified.
- Fix: in the PR text, name which long-lived consumers actually repeat reads in one process, and do not generalize the worker figure.

**Low. Unexplained Node 20 empty-inbox regression** (results lines 71-72)
- Worker idle is 62.1 ms versus 28.2 ms on parent, and startup is 34.7 ms versus 27.9 ms.
- Key-only shows the same increase, so it may come from loading the new module rather than from verification retention. The idle window is only one second.
- The report discloses this and does not investigate it. Node 24 shows no such increase.
- Fix: a short diagnostic, or keep it recorded as an open item.

**Low. Wasted copies on the miss and oversize paths** (`sync-signatures.ts:45-52`, `:57`)
- Every call converts the signed bytes to a latin1 string, then `Buffer.from(message, "latin1")` copies them back before `verify`. This also happens when the entry is oversized and will never be retained.
- The caller's Buffer is not mutated during the synchronous verify, so crypto can take `signedBytes` directly. Only the retained identity needs the string, and it is only needed when the byte length is under the cap.
- The key-only benchmark adapter passes the original bytes, so it excludes this cost. That makes the full-versus-key-only comparison slightly conservative.
- Fix: verify the original `signedBytes`, and skip stringification when `signedBytes.length` exceeds the entry cap.

**Low. Duplicated dual-budget FIFO eviction** (`sync-signatures.ts:27-34` and `:68-75`)
- The two loops are near-identical: entry-count and byte-budget eviction, with the same accounting.
- Fix: a small private helper. This is optional, and the duplication is tolerable at this size.

**Suggestion. Test and benchmark-only API and ownership**
- `usage()` is production API used only by tests and the benchmark. The benchmark finds the private singleton by patching the class prototype.
- The process-wide singleton lives in `sync-model.ts:6-7`, a module that is otherwise pure encoding and parsing.
- Fix: keep as is with a comment, or export the singleton from `sync-signatures.ts` along with a usage accessor.

**Suggestion. Forward-port fragility**
- The unit tests and the benchmark count crypto calls by replacing properties on the CommonJS `crypto` object.
- If 1.x moves to ESM named bindings, those counters and mocks would stop observing the calls.
- Fix: note this in the forward-port checklist.

## Do the gains justify the memory and code?

Yes, within the measured scope.
- The code is about 90 lines in a single new file.
- The measured process memory costs are modest and disclosed:
  - heap rises from 8.64 to 16.31 MiB under 1,000-record churn on Node 20, and from 9.50 to 17.23 MiB on Node 24;
  - Node 20 worker peak RSS rises from 119.9 to 140.2 MiB at 100 records and 10 KiB bodies.
- Full beats key-only in every repeated-read cell. At 1,000-record get on Node 24, full is 33.6 ms versus 176.6 ms for key-only and 199.3 ms for parent.

The key cache alone gives the cold gain over parent for any process. The full cache adds the large warm gain for processes that read more than once.

## Remaining limits to keep explicit

- The original CI failures are unresolved: the Ubuntu 20 oversized-identity test (request count 0 versus 1 under a 500 ms budget) and the Windows `viewer.json` EPERM. Neither is labelled pre-existing, and the Windows one is owned by issue 93.
- CI for the new head is still pending.
- Not measured or qualified: initial sync, 1,000-record worker passes, cold daemon launch, separate hosts, and caches at the capacity edge.
- Measurements ran on tmpfs with warm filesystem caches.
- Each cell has only five samples, so no p95 is claimed.
- I did not independently rebuild or re-run anything. Statistical GO rests on my recomputation of the raw samples and the archive hash checks.

</details>
