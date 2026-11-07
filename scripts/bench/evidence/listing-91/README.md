# Ordinary listing bounds, issue #91

Immediate parent: `610c931b7b22920cce59cf03e49c0de15ebaf2a2` on `perf/89-bench`, Node >=20 release line. No inherited benchmark or compatibility policy changes.

## Decision and scope

Primary decision metric: peak process RSS of ordinary metadata listing at 5,000 records, with exact output and safety behavior preserved. Record elapsed time and CPU tradeoffs at 100/1,000/5,000 records, for one direct list, four simultaneous lists across backend instances, and four simultaneous production viewer HTTP index requests. Compare the unbounded parent with fixed loops at 8 and 32, sharing the same respective aggregate limit across instances. No runtime-upgrade speedup claims.

The change affects ordinary `LocalDocumentBackend.listDocuments`. Managed dispatch and the read-only `LocalDocumentSource` remain unchanged. It retains validation, hardening, corruption warnings and stable createdAt sorting. Concurrent warning arrival order was already nondeterministic under the parent's Promise.all; warning contents and valid record order are preserved.

Only 8 worker promises per listing are created. A process-shared FIFO admits at most 8 active metadata reads across backend instances and homes loaded from this module. Each metadata read can have two file-hardening operations in flight; those siblings drain even on failure before the slot is released. Thus at most 16 filesystem operations from these metadata reads are active. Storage preparation, enrollment checks, readdir, direct getDocumentMetadata and managed/source reads are outside this limit. Workers stop admitting records after a fatal error and drain before the listing rejects. The first original error is preserved.

A request has at most 8 pending/active worker continuations and slot waiters. For R concurrent requests these scale as O(8R), independently of record count. Directory entries, indexed metadata results, sorting/filtering arrays and HTTP rendering/response strings remain O(N) per request, or O(NR) across concurrent requests. This is not a global request or total-memory cap. The existing backend reads each metadata file in full before validation, so unusually large metadata files can still consume large buffers within those eight slots; no new byte limit is imposed. No result cache, persistent worker, service or general concurrency framework was added.

## Reproduce

Build tooling uses Node 24.19.0 and pnpm 11.7.0 with the frozen lockfile. Measured runtimes are Node 20.20.2 and 24.19.0. On Linux with Python 3, from this revision with either source limit:

```sh
pnpm install --frozen-lockfile
python3 scripts/bench/listing.py --out artifacts/listing-final --node20 /absolute/node20 --node24 /absolute/node24 --samples 3
```

The companion temporarily builds the pinned parent backend and 8/32 candidates, restores the source in finally, and copies compiled build artifacts beneath the output directory. It creates synthetic fixtures under that directory, never accepts a real library, strips inherited runtime configuration, runs children sequentially with a 180-second deadline and closes each production HTTP server. Fixtures are removed in finally. Give `--out` an ext4 workspace path and keep it off tmpfs. No checkout or parent-branch mutation is involved.

This host uses ext4 on `/dev/nvme0n1p2`; `/tmp` is tmpfs and was not used for these listing fixtures. Fixtures contain distinct IDs/titles and 10 KiB bodies, with tied createdAt timestamps exercising stable order. Files are initially written with private permissions. OS caches are uncontrolled and warm after fixture construction and one direct list per child; HTTP cases also warm one request. No cold-cache or physical disk traffic result is claimed.

Three fresh child samples per variant/runtime/count/mode rotate base/8/32, 8/32/base, 32/base/8. Direct timings include production listing; HTTP timings include in-process clients/server, rendering and transfer. Assertions run after the measured operation. Peak RSS is the process high-water mark, including startup, warmup, client/server and completed operation, not an operation-only resident delta. Process CPU is cumulative user+system CPU; operation CPU excludes startup/warmup. Driver wall time also includes child startup, behavior checks and server close. No p95 is inferred from three samples.

Each direct result equals independently constructed full metadata, including order. Each HTTP response equals a warmed full production response, and SHA-256 response hashes must match across every variant and both runtimes. No warning is permitted for valid fixtures. Separate regression tests cover corruption, missing HTML/records, metadata and directory symlinks, unsafe entry names, permission hardening, injected EACCES propagation, aggregate active reads and sibling drain on chmod failure. Existing read-only source and managed-reader tests qualify unchanged dispatch/safety behavior.

`environment.json` records actual filesystem/kernel, runtime/build identifiers, backend source hashes and SHA-256 of all compiled JS files. `samples.jsonl.gz` preserves every raw command/result, sample and stdout/stderr. `cleanup.json` records fixture removal. Results are warm filesystem comparisons, not device measurements.

## Attempts and limitations

The preliminary run is retained separately. It measured the first worker-loop candidate before the failed-hardening sibling-drain fix and explicit first-error preservation while draining workers. Process CPU reporting was added while that preliminary run was active, so earlier preliminary rows lack this field. Do not use it as final-head evidence. No preliminary sample failed. The final repeat uses fixed source and workload files for all samples.

The workloads do not measure packaged CLI startup because this change affects long-lived/in-process listing, not module startup or packaging. Full builds and package smoke tests separately qualify the bundle. No total-memory guarantee is possible without request admission/streaming or API changes, which are outside #91. Hardware and cache conditions can change the best limit; report both candidates rather than extrapolating universal throughput.

## Selected setting and result

Use 8 workers per listing and 8 process-shared metadata slots. Primary memory gains repeat beyond the sample spread on both runtimes. Compared with 32, 8 reduces single-list and large HTTP peak RSS while retaining most throughput gains. This is a memory-first choice, not a claim that 8 is always faster. The production source SHA-256 is `a71a57af866018854f56434c893f783a8c48dc752e6fa87a006a839eb66795aa`, identical to the final measured 8-reader build.

At 5,000 records, median parent → selected candidate:

| Node | Operation | RSS MiB, delta | Elapsed ms, delta | Process CPU ms, delta |
|---|---|---|---|---|
| v20.20.2 | direct1 | 226.9 → 74.7, -152.2 (-67.1%) | 595.6 → 541.1, -54.5 (-9.1%) | 2923.7 → 2413.2, -510.5 (-17.5%) |
| v20.20.2 | direct4 | 515.2 → 95.7, -419.5 (-81.4%) | 2569.7 → 2226.5, -343.2 (-13.4%) | 7228.7 → 5570.1, -1658.7 (-22.9%) |
| v20.20.2 | http4 | 1018.0 → 408.1, -609.8 (-59.9%) | 4508.3 → 4289.0, -219.4 (-4.9%) | 11042.7 → 9613.5, -1429.2 (-12.9%) |
| v24.19.0 | direct1 | 258.0 → 86.4, -171.6 (-66.5%) | 515.2 → 504.0, -11.2 (-2.2%) | 2487.5 → 2210.6, -276.9 (-11.1%) |
| v24.19.0 | direct4 | 549.4 → 104.2, -445.2 (-81.0%) | 2387.4 → 2061.9, -325.5 (-13.6%) | 6441.6 → 5576.9, -864.7 (-13.4%) |
| v24.19.0 | http4 | 1045.6 → 409.4, -636.2 (-60.8%) | 4013.9 → 3796.9, -217.0 (-5.4%) | 9979.4 → 8858.1, -1121.3 (-11.2%) |

The final 5,000-record direct-list RSS ranges do not overlap the parent ranges. Single-list Node 24 elapsed ranges overlap; its 2.2% median reduction is not a reliable speedup claim. Four-list elapsed improves by 13.4%/13.6% on Node 20/24. HTTP elapsed improves by 4.9%/5.4% in medians, but some ranges overlap. CPU and the large memory reduction support the decision without relying on those small latency changes.

At 5,000 records, 8 versus 32 has 15.2%/14.0% less single-list RSS on Node 20/24, at 7.2%/0.4% more elapsed time. Four-list elapsed is 8.5%/3.8% higher for 8; process CPU is 1.5%/6.3% higher. HTTP RSS is 36.8%/29.2% lower for 8; HTTP elapsed is 4.4% higher on Node 20 and 4.8% lower on Node 24. See [all medians and ranges](results.md) and [machine-readable summary](summary.json) rather than extrapolating these three-sample comparisons.

Small-workload regressions are disclosed: Node 20 at 100 records HTTP peak RSS rises from 112.2 to 114.1 MiB, and Node 24 at 100 records cumulative HTTP CPU rises from 423.1 to 445.2 ms. Single-list elapsed at 100 records on Node 24 rises from 13.6 to 14.4 ms; at 1,000 records on Node 20 it rises from 111.8 to 113.6 ms. The latter elapsed ranges overlap. Results and response allocation still dominate HTTP memory, so no constant-RSS guarantee is claimed. Eight slots can stagger request completions and rendering allocations differently from 32, so their HTTP RSS difference includes scheduling and GC effects rather than only metadata buffers.

Both preliminary and final samples have zero failures. Both fixture trees were removed. No measurement job overlapped a suite or another local measurement in this issue slot. Runtime comparisons are separated in every table. Full source/bundle verification results are recorded alongside the evidence after qualification.

`direct4` and `http4` elapsed values are batch completion times for four simultaneous requests, not per-request percentile distributions. The HTTP companion uses the production index handler with the backend, loopback ephemeral ports and control-server lifecycle, without preferences or deletion capabilities. This keeps the complete HTML deterministic across processes. It does not measure viewer service startup, preference-file I/O or mutation controls.

For an exact adversarial before/after comparison after the listing runner, use the compiled artifacts it saved:

```sh
/absolute/node20 scripts/bench/listing-behavior.cjs "$PWD/artifacts/listing-behavior-20" "$PWD/artifacts/listing-final/dist-base" "$PWD/artifacts/listing-final/dist-8" "$PWD/artifacts/listing-final/dist-32"
/absolute/node24 scripts/bench/listing-behavior.cjs "$PWD/artifacts/listing-behavior-24" "$PWD/artifacts/listing-final/dist-base" "$PWD/artifacts/listing-final/dist-8" "$PWD/artifacts/listing-final/dist-32"
```

This refuses an existing fixture path, compares full returned metadata, sorted exact warning strings, hardened modes and injected EACCES propagation across the same three production builds, and removes its fixture tree. Warning arrival order is deliberately ignored because the parent made it nondeterministic. The injected EACCES uses `getDocumentMetadata` to avoid the parent's early-reject listing leaving pending filesystem work during fixture replacement; the regression suite separately checks listing-level propagation and candidate draining.


## Verification

Frozen install, typecheck and build passed. The selected source and compiled backend hashes match the final measured 8-reader artifacts. [Fingerprints](fingerprints.json) also identify both runtime binaries, the companion scripts and the packaged bundle.

All 17 recorded commands exited 0; see [exact commands and durations](checks.jsonl) and compressed raw logs in `checks/`.

- Node 20.20.2: 37 targeted tests; full suite 1,328 passed, two skipped; harness/skills 161 passed, two skipped; browser 73 passed, one skipped; installed-package smoke passed.
- Node 24.19.0: 37 targeted tests; full suite 1,327 passed, three skipped; harness/skills 161 passed, two skipped; browser 73 passed, one skipped; installed-package smoke passed.
- Benchmark cleanup, website checks and pinned published skill-fallback smoke passed.
- Exact adversarial comparison passed for parent/8/32 on both runtimes, including full diagnostic strings within each runtime. Both owned behavior fixture trees were removed.

Existing skips include the optional old `b843e126` CLI not supplied, Windows-only taskkill coverage, live CDN checks not enabled, and Node 24.19.0's native generated IPv6 SAN rejection. No test was weakened or skipped for this change. macOS/Windows and final-head CI still require the PR matrix; local evidence is Linux only. Reviews and root verification are separate gates and are not claimed by these test results.

Resource CPU and high-water RSS are sampled in the child after the measured operation and result assertions, before output hashing/serialization and server close. They cover startup, warmup and the operation through that point, rather than exited-process wait4 accounting. Driver wall time includes the entire child lifecycle. No whole-process-tree, physical-I/O or cold-cache claim is made.

Evidence packaging initially asserted 18 check rows, but the command manifest contains 17 successful checks. That archival assertion failed before copying logs, and was corrected to 17. No test or measurement failed, and no production code changed in this correction.
