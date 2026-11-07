# Per-render formatter reuse, issue #90

Baseline: `1b2009132b8df184540c1990091fd1e9911dbb00` on `release/0.7`. Measured candidate: `76a6f4b95565c085759d8735bb68094cbdc6dc4c`. Both were independently archived from the actual Git refs and compiled with tsc-rs 0.7.0. Subsequent report commits do not change production code. The only production difference is a lazy formatter scoped to each render.

## Method

Primary metric selected before implementation: full HTTP index-request CPU and elapsed time. Linux x86_64, same host, exclusive measurement slot, Node 20.20.2 and 24.19.0, concurrency one. Real LocalDocumentBackend storage with identical immutable 10- and 1,000-document fixtures, shared between baseline and candidate. Viewer and hub servers use their real routing, storage reads, rendering and HTTP response paths. No external network. Five independent process pairs per runtime/workload/route alternate AB/BA order. Each process records its first request separately and ten warm requests. Filesystem caches are warm; cold means a fresh application process, not cold physical storage. Server initialization and fixture publication are outside the request timer.

CPU is process user + system CPU for the server and same-process fetch client, including storage worker threads. It excludes child processes; no request-serving child process is used. RSS is process memory, not heap size. maxRSS is the process peak including initialization; final RSS is sampled after request eleven. GC is left at runtime defaults. The benchmark counts constructor calls using a Proxy only in the benchmark worker. Production never patches Intl. Wall/CPU timing ends after the complete body is consumed, before hashing.

Each table value is the median of five process medians, with the minimum and maximum process medians in brackets. Cold requests have one sample per process. Warm requests total 50 per configuration, grouped by process to avoid treating them as independent runs. No p95 claim.

## Warm requests

| Node | Documents | Route | Elapsed ms, before → after | CPU ms, before → after | Elapsed change, ms / % | CPU change, ms / % |
| --- | ---: | --- | --- | --- | ---: | ---: |
| v20.20.2 | 10 | viewer | 5.55 [5.47, 5.69] → 4.37 [4.17, 4.50] | 12.28 [11.20, 12.83] → 9.18 [9.07, 9.29] | -1.19 / -21.4% | -3.10 / -25.2% |
| v20.20.2 | 10 | hub | 5.54 [5.46, 5.65] → 4.34 [4.26, 4.57] | 11.13 [10.60, 12.55] → 9.26 [9.12, 9.47] | -1.20 / -21.6% | -1.88 / -16.9% |
| v20.20.2 | 1000 | viewer | 200.72 [196.91, 211.45] → 106.67 [106.50, 110.91] | 298.87 [297.21, 309.71] → 204.04 [203.85, 210.64] | -94.05 / -46.9% | -94.83 / -31.7% |
| v20.20.2 | 1000 | hub | 208.76 [200.77, 220.91] → 109.90 [109.22, 188.75] | 308.33 [300.42, 324.52] → 211.13 [205.14, 255.46] | -98.86 / -47.4% | -97.20 / -31.5% |
| v24.19.0 | 10 | viewer | 6.52 [6.31, 6.73] → 5.53 [5.07, 6.83] | 13.50 [13.23, 14.55] → 10.79 [9.86, 13.97] | -0.99 / -15.1% | -2.72 / -20.1% |
| v24.19.0 | 10 | hub | 6.63 [6.53, 6.74] → 5.66 [5.50, 5.86] | 13.65 [13.48, 14.01] → 10.80 [10.41, 11.72] | -0.97 / -14.7% | -2.85 / -20.8% |
| v24.19.0 | 1000 | viewer | 189.71 [181.88, 239.98] → 103.24 [101.05, 108.66] | 285.96 [278.47, 335.65] → 200.06 [195.19, 216.28] | -86.48 / -45.6% | -85.89 / -30.0% |
| v24.19.0 | 1000 | hub | 199.36 [189.14, 203.97] → 100.69 [97.67, 117.09] | 293.94 [285.60, 303.74] → 202.01 [201.13, 210.29] | -98.67 / -49.5% | -91.93 / -31.3% |

Decision: retain the production change. For all four large-workload runtime/route combinations, even the slowest candidate process median is faster than the fastest baseline process median. The repeated elapsed and CPU gains exceed the observed spread. Small-workload timing has more relative noise and is not the basis of the decision.

## First request and memory

| Node | Documents | Route | First-request ms, before → after | First-request CPU ms, before → after | Peak RSS MiB, before → after | Final RSS MiB, before → after |
| --- | ---: | --- | --- | --- | --- | --- |
| v20.20.2 | 10 | viewer | 67.86 [67.59, 72.95] → 67.12 [66.09, 69.18] | 75.32 [72.93, 80.53] → 74.72 [72.44, 75.75] | 92.37 [91.60, 93.37] → 86.00 [84.81, 86.38] | 91.87 [91.22, 92.87] → 85.50 [84.19, 85.77] |
| v20.20.2 | 10 | hub | 67.78 [67.41, 69.87] → 67.81 [67.06, 69.27] | 74.17 [72.85, 76.80] → 75.96 [74.76, 76.68] | 92.60 [92.07, 93.46] → 86.04 [85.06, 86.67] | 92.10 [91.70, 92.96] → 85.66 [84.56, 86.17] |
| v20.20.2 | 1000 | viewer | 393.36 [376.78, 402.72] → 306.20 [294.77, 318.40] | 543.07 [518.40, 552.50] → 448.56 [417.75, 467.45] | 405.86 [398.20, 406.27] → 146.88 [142.25, 147.52] | 398.34 [392.12, 399.04] → 146.88 [138.79, 147.52] |
| v20.20.2 | 1000 | hub | 411.11 [381.79, 416.46] → 311.12 [289.15, 350.17] | 563.97 [515.57, 574.09] → 467.59 [422.22, 520.08] | 419.97 [418.84, 428.14] → 148.90 [142.08, 150.18] | 419.85 [418.84, 428.01] → 148.90 [141.53, 150.18] |
| v24.19.0 | 10 | viewer | 66.93 [64.90, 68.98] → 64.89 [63.90, 71.37] | 72.44 [70.79, 74.22] → 70.69 [69.22, 76.68] | 107.41 [106.64, 107.56] → 106.91 [105.97, 107.78] | 99.45 [99.34, 100.06] → 97.38 [96.89, 97.85] |
| v24.19.0 | 10 | hub | 67.78 [66.51, 70.31] → 66.28 [64.09, 71.85] | 73.49 [72.38, 75.55] → 71.85 [69.57, 73.68] | 107.31 [106.90, 107.87] → 107.17 [107.10, 107.51] | 99.50 [99.20, 99.96] → 97.18 [96.98, 97.28] |
| v24.19.0 | 1000 | viewer | 371.06 [360.53, 432.70] → 306.61 [283.00, 401.84] | 476.04 [449.76, 478.31] → 392.83 [369.01, 405.99] | 436.40 [435.46, 456.21] → 184.43 [182.73, 184.51] | 436.40 [435.46, 456.21] → 183.53 [182.73, 184.13] |
| v24.19.0 | 1000 | hub | 382.48 [351.53, 400.69] → 285.13 [253.08, 307.10] | 480.39 [437.87, 486.64] → 372.92 [343.20, 394.44] | 439.02 [437.23, 459.72] → 183.05 [182.73, 184.34] | 439.02 [437.23, 459.72] → 183.05 [182.73, 184.34] |

## Equivalence and bounds

All 880 HTTP responses have paired matching byte lengths and SHA-256 values. For each workload/route, baseline and candidate read the same stored fixture. The additional equivalence pass compares complete serialized HTML strings directly, not just their hashes, on both runtimes under English, French and Arabic locale environments. It crosses runtime TZ changes UTC, America/New_York, Asia/Kolkata and Pacific/Auckland with local/default formatting and four explicit zones. It covers viewer, hub, static index options and document shells; DST transitions, offset strings, local strings, date-only strings, invalid strings and HTML escaping. Server locale intentionally remains English as before; browser locale localization remains existing client behavior.

Every measured baseline request constructs exactly 10 or 1,000 formatters; every candidate request constructs exactly one. Unit tests also verify zero construction for empty lists, all-invalid dates and filtered-out results, unchanged invalid-timezone errors on valid dates, and invalid-date fallback even with an invalid timezone. The closure becomes unreachable after each render; no global cache, eviction policy or runtime timezone invalidation is needed. Runtime TZ changes are tested within the same process.

## Check receipts

Raw results and exact per-check commands/exit codes are committed in [90-formatter-results.json](90-formatter-results.json). The external artifact directory also contains complete logs, archived-source builds, immutable fixtures and full equivalence output.

- `typecheck`: exit 0, 1.4s. Command: `pnpm typecheck`.
- `build`: exit 0, 1.6s. Command: `pnpm build`.
- `v20.20.2-unit`: exit 0, 360.1s. Command: `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node scripts/run-unit-tests.mjs --test-concurrency=2`.
- `v20.20.2-browser`: exit 0, 75.3s. Command: `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --test --test-concurrency=1 scripts/content-copy-browser.test.mjs scripts/deletion-isolation-browser.test.mjs scripts/document-deletion-browser.test.mjs scripts/document-isolation-browser.test.mjs scripts/hub-browser.test.mjs scripts/sync-reader-browser.test.mjs scripts/viewer-browser.test.mjs`.
- `v20.20.2-harness-skills-policy`: exit 0, 29.6s. Command: `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --test scripts/viewer-systemd-cleanup.test.mjs scripts/run-unit-tests.test.mjs scripts/release-policy.test.mjs scripts/skill-cli-resolution.test.mjs scripts/skill-cli-windows.test.mjs`.
- `v20.20.2-site`: exit 0, 0.2s. Command: `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node scripts/verify-site.mjs`.
- `v20.20.2-site-theme`: exit 0, 0.3s. Command: `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --test scripts/site-theme.test.mjs`.
- `v20.20.2-package`: exit 0, 10.2s. Command: `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node scripts/package-smoke.mjs`.
- `v24.19.0-unit`: exit 0, 307.7s. Command: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node scripts/run-unit-tests.mjs --test-concurrency=2`.
- `v24.19.0-browser`: exit 0, 73.2s. Command: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --test --test-concurrency=1 scripts/content-copy-browser.test.mjs scripts/deletion-isolation-browser.test.mjs scripts/document-deletion-browser.test.mjs scripts/document-isolation-browser.test.mjs scripts/hub-browser.test.mjs scripts/sync-reader-browser.test.mjs scripts/viewer-browser.test.mjs`.
- `v24.19.0-harness-skills-policy`: exit 0, 29.2s. Command: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --test scripts/viewer-systemd-cleanup.test.mjs scripts/run-unit-tests.test.mjs scripts/release-policy.test.mjs scripts/skill-cli-resolution.test.mjs scripts/skill-cli-windows.test.mjs`.
- `v24.19.0-site`: exit 0, 0.2s. Command: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node scripts/verify-site.mjs`.
- `v24.19.0-site-theme`: exit 0, 0.2s. Command: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node --test scripts/site-theme.test.mjs`.
- `v24.19.0-package`: exit 0, 8.9s. Command: `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node scripts/package-smoke.mjs`.
- `diff-check`: exit 0, 0.0s. Command: `git diff --check`.

The initial coordinator run completed all 80 request workers and paired response assertions, then exited 1 because the full HTML equivalence output exceeded the subprocess default 1 MiB buffer. The committed harness raises that limit to 32 MiB. The equivalence phase was rerun separately for both archived builds and all six runtime/locale combinations, exit 0 with exact 1,406,522-byte output equality each time; receipts are included in the committed JSON. No request timing or production code changed.

Local suite skips: the historical b843e126 CLI fixture was not supplied, the real Windows taskkill process-tree test needs Windows, Node 24.19.0 native IPv6 SAN verification has a documented skip, and live upstream CDN checks are opt-in. Deterministic local CDN fixtures ran. None of these skips concern formatter behavior.

Full-suite totals: Node 20 unit/integration 1,326 passed, 2 skipped; Node 24 unit/integration 1,325 passed, 3 skipped. Browser suites on each runtime: 75 passed, 1 skipped. All check commands exited 0.

## Reproduction and limits

From a dependency-installed repository, choose a new absolute OUTPUT path and run:

```sh
node scripts/performance/90-formatters.mjs run OUTPUT 1b2009132b8df184540c1990091fd1e9911dbb00 76a6f4b95565c085759d8735bb68094cbdc6dc4c /absolute/node20/bin/node /absolute/node24/bin/node
```

OUTPUT must not already contain baseline/candidate builds. The coordinator builds the refs from git archives and writes requests.json incrementally. It runs workers sequentially and asserts paired HTTP response hashes and exact equivalence output. The fixtures use newly generated IDs/timestamps, so hashes need only match within a reproduction. Raw values, process grouping and environment are in the committed JSON; no performance assertions run on shared CI.

External artifacts: `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue-90-measurements`; coordinator log is adjacent at `issue-90-benchmark.log`. This report and committed JSON are sufficient to inspect the measurements without that host.

This measures the compatibility branch on Linux and both supported runtime families, not a future 1.x code stack or macOS/Windows. Node20 and Node24 are compared independently; runtime differences are not attributed to this change. The full-request large workloads provide the go/no-go result; small workloads and first-request behavior are reported as checks on tradeoffs. Single-document shells retain one formatter construction and have no claimed speedup. Static output shares the optimized library path, but no static-export throughput claim is made. Release integration and forward-port qualification remain with root.
