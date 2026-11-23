# Issue 97 candidate correctness

Related to [issue 97](https://github.com/deveshsangwan/html-inbox/issues/97) and [draft PR 124](https://github.com/deveshsangwan/html-inbox/pull/124).

R2 passed the complete granted sequence once. Both exact Node 20.20.2 and Node 24.19.0 passed 178 tests, with zero failures, cancellations, skips or todos, using the same candidate emitted bytes. The private run completed in 223.852 seconds, inside the fixed 900-second application and 120-second cleanup limits. LOCAL was released to root after independent cleanup checks.

The tested head was `ddc9f6274844186a8743a114ed78b6d5a7698333`. Its application/test source is exactly `a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a`, based on `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. R2 used the root-prepared adapter unchanged, SHA-256 `cfa939ea53ceef28c2f5e77209f030b295a2a3e56ef440feadbb282d532de61a`, with the unchanged reused execution engine, SHA-256 `87d98accb4a6f69308bd27221e8e53bfe65014fd155229fb02d0e04fbe4aee68`. Grant: `root-97-correctness-ddc9f62-20261108-r2`.

| Command | Exit | Seconds including per-command cleanup |
| --- | ---: | ---: |
| node20-version | 0 | 0.069 |
| node24-version | 0 | 0.057 |
| install | 0 | 4.621 |
| typecheck | 0 | 1.668 |
| build | 0 | 1.990 |
| bundle | 0 | 2.500 |
| node20-tests | 0 | 112.258 |
| node24-tests | 0 | 99.371 |

Tooling used exact Node 24.19.0 and Corepack pnpm 11.7.0. Both absolute runtime binaries matched the root's recorded hashes before and after execution. The unchanged test arguments were `--test --test-concurrency=1 packages/cli/dist/sync-store.test.js packages/cli/dist/sync-storage-faults.test.js packages/cli/dist/sync-protocol-faults.test.js`. No second build occurred between runtimes. Source/lock identities and compiled/bundle bytes remained unchanged throughout both test commands.

These tests exercise exact replay after restart, invalid batch atomicity, current authority/fingerprint/incarnation rejection, retirement rejection, atomic acknowledgement crash boundaries, EIO/ENOSPC controls and the existing authenticated HTTPS fault/repair paths. Their fixture assertions and deadlines were unchanged. Node 20 emitted TAP. Node 24 selected its default spec reporter with the granted arguments; its verbatim output remains named `node24-tests.tap`. The engine's TAP-only summary fields are null for Node 24. An additive independent audit extracted the original spec summary. There was no reporter retry or output rewrite.

All command process groups joined before fixture disposal. The owner audit preserves 304 observed-process entries and separately confirms the outer adapter absent. Root's additive audit checked 305 unique PID/start identities including that adapter and nine groups, all absent. Root audit SHA-256: `bfde0a5516cecf09fb3755298e6774ca9120405fbae351cfb98aa6d24cbe9d1d`, at `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue97-correctness-r2-root-audit.json`. Original owner accounting remains unchanged. Every command root was removed. The retained tooling-cache directory is empty; installed `node_modules` and emitted outputs remain in this isolated checkout. The existing tests supply listener/child cleanup assertions, including loopback port rebinding. The outer process scan records observed descendants and adopted exits; it does not claim to sample every short-lived helper. Original outputs, command identities and cleanup records remain available.

R1 is still an original failed adapter attempt, not a passing test result. It launched zero runtime commands because of a duplicate environment keyword. Root corrected only that keyword and the grant/docs/source-pin binding for R2. [The retained R1 report](issue-97-correctness-attempt1.md) and raw artifacts were not changed. No fix or retry occurred inside either run.

The [compact R2 receipt](issue-97-correctness-r2.json) preserves commands, exits, times, runtime/source/output identities, test summaries and raw artifact hashes. Full original manifests, stdout/stderr, output maps and process/cleanup evidence are under `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue97-correctness-ddc9f62-attempt2`. The separate [hosted CI run at a3e087c](https://github.com/deveshsangwan/html-inbox/actions/runs/42526569454) also passed all source, browser, skills and Verify jobs.

No benchmark, baseline overlay, parent output mutation, full local suite, browser run, reviewer launch or CI retry occurred in R2. This result establishes the granted focused correctness check; it establishes no performance benefit. The primary preselected metric remains source-peer ledger replacement bytes on unchanged authenticated HTTPS reconciliation. Baseline/candidate feasibility and later repeated paired measurements require new root scheduling. Both later fresh same-pin Sol High and Sonnet 5.5 Medium reviewers must receive the full rubric and each return functionality, code-quality and validation verdicts. Keep the PR draft; no merge or release.
