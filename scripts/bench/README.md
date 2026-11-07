# Resource measurements

This prerequisite for #89 changes no production behavior and claims no speedup. Use Linux, Python 3 and OpenSSL. Build tools use Node 24; select the measured runtime separately with `--node`. Engine requirements stay unchanged.

One command builds the release bundle and runs the ordinary baseline:

```sh
pnpm build && pnpm --filter html-inbox bundle && pnpm bench baseline --out artifacts/bench/baseline
```

Defaults are three samples, 0/100 records and 10 KiB/1 MiB/9 MiB parser inputs. The output directory must be new. Libraries, catalog, HOME/XDG paths and TLS credentials are synthetic and temporary. No real library or credential is accepted. The runner strips inherited configuration, tokens, proxies and NODE_OPTIONS. Runs are sequential. Durable managed publication can take minutes on slow filesystems.

Targeted commands after building:

```sh
pnpm bench cli --counts 0,100,1000,5000,10000 --out artifacts/bench/cli
pnpm bench viewer --counts 1000 --out artifacts/bench/viewer
pnpm bench worker --counts 0,100 --out artifacts/bench/worker
pnpm bench managed --counts 0,100 --out artifacts/bench/managed
pnpm bench sync --counts 0,100 --out artifacts/bench/peer
pnpm bench parser --out artifacts/bench/parser
pnpm bench parser --candidate /absolute/path/validator.cjs --out artifacts/bench/parser-candidate
pnpm bench baseline --node /absolute/path/to/node20 --out artifacts/bench/node20
pnpm test:bench
```

`--sizes` accepts comma-separated 10240,1048576,9437184. CLI/viewer/managed/sync use the first size; parser uses all sizes and both dense-element/text shapes. `--counts` accepts 0,100,1000,5000,10000. Large managed/sync runs preserve current durability and can be expensive. `--timeout` sets the per-child deadline, up to 3600 seconds. There are no timing assertions.

The parser candidate must export synchronous `validateHtml`. Exact validation results must match the production validator on the measured input and a small adversarial corpus before timing. This does not replace the full validation unit tests. Parser operation timings exclude module startup and input construction; process timings include them and behavior checks. Never compare parser microbenchmarks directly to end-to-end publication or full sync.

## Workloads

* CLI measures the release bundle. List checks record counts and IDs. Export checks document counts and reports logical/allocated output disk size. Each sample exports to a fresh destination.
* Viewer runs the production HTTP server on ephemeral loopback. Index requests check status and fixture content; content requests check exact bytes. Client and server share a process, so CPU/RSS include both. Idle uses a one-second window, not a long-term idle guarantee.
* Worker runs the production owned runtime with synthetic enrolled documents and no routes, waits for idle, measures one second, checks idle and closes. This is an unconfigured idle worker, not active sync.
* Managed storage measures enrollment, serial durable publications and snapshot/status reads with record checks.
* Peer sync runs production reconciliation and ingestion over authenticated loopback TLS. Every sample has fresh sender/receiver stores. Initial transfer, no-op reconciliation and missing-body repair have separate samples. Exact bodies, counts, receipts, confirmation and transferred counts must match. Commit counters count `ledger-renamed`; wire counters count server request/response payload bytes, excluding TLS/IP framing. CPU includes both in-process peers. These measure actual sync rather than prototype estimates.

## Results and limits

`environment.json` records SHA-256 fingerprints of the bundle, compiled JavaScript and optional candidate module, plus commit, dirty state, invocation, Node and bundled SQLite versions when exposed, parse5 version, kernel, filesystem type, bundle size, fixture root, counts, sizes and deadlines. Current storage has no SQLite dependency; Node's SQLite version is runtime metadata only. Rebuild after source changes. Compare the same build, runtime, machine, concurrency, fixtures and cache conditions. Alternate repeated base/candidate runs when practical. OS caches are uncontrolled and usually warm. Fresh fixtures do not imply cold caches.

`samples.jsonl` contains raw process and nested operation samples. Linux `wait4` provides process wall/CPU/peak RSS. CPU includes waited descendants; peak RSS is the largest process high-water mark, not summed process-tree RSS. No detached service is launched. Operation RSS is a resident snapshot. OS input/output block accounting is not logical bytes or proof of physical drive traffic. Operation `/proc/self/io` deltas report `rchar`/`wchar` syscall bytes including sockets, and kernel `read_bytes`/`write_bytes`/`cancelled_write_bytes`. Caching, filesystem and writeback affect interpretation. Reading counters adds overhead. These counters do not count fsync calls or prove device activity.

`summary.json` reports n/min/median/max elapsed time per label. No p95 is inferred from three samples. Raw CPU/RSS/I/O/counters remain in the samples. `failures.jsonl` records failed commands; earlier samples survive. `cleanup.json` records fixture removal and direct-child reaping. Each child has its own process group, deadline and TERM/KILL cleanup on success, failure, timeout, SIGINT and SIGTERM. TMPDIR is inside the fixture root, so the parent removes TLS credentials even after killing a child. SIGKILL of the runner or host failure cannot run cleanup; remove the recorded fixture root manually. Cleanup tests cover a nonzero exit and a descendant ignoring SIGTERM.

The cheap cleanup tests also run in Linux Node 24 verification CI. The manual measurement workflow is report-only. It builds on Node 24, then measures supported current code on Node 20 and 24 separately and uploads partial raw artifacts even on failure. Modern-only implementations must adjust their runtime matrix. No millisecond budget blocks CI.

Commit concise evidence under `scripts/bench/evidence/`; CI uploads full raw results. Performance PRs should include exact commands, revisions, spread, behavior and cleanup outcomes. Keep runtime-upgrade effects separate from source changes. This suite's acceptance is reproducibility and cleanup, not a runtime gain.

Sync uses an equal-size plain `x` body and peer-specific metadata; CLI/parser/viewer fixtures use the text/dense generators. Compare each workload against itself across revisions. Sync documents currently share their content and metadata, so byte/count checks do not qualify identity-preserving optimizations without additional identity assertions.

## Managed complete reads for #96

`managed-read` compares the clean common parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2` with the clean current checkout.
Build and bundle both checkouts with the same Node 24 toolchain before running.
Supply an existing app-managed parent checkout; this mode creates no checkout.
`environment.json` records both revisions, every compiled JS hash and both
release-bundle hashes. Build provenance still requires the recorded build
commands. All prior workloads retain their defaults.

```sh
python3 scripts/bench/run.py managed-read \
  --baseline-repo /absolute/path/to/clean-parent-checkout \
  --node /absolute/path/to/node20 \
  --counts 1,100 --sizes 10240 --samples 7 --timeout 60 \
  --out artifacts/bench/managed-read-node20
```

Repeat separately with the exact Node 24 binary and a new output directory.
Defaults for this mode are 1/100 owned records, 10 KiB bodies, concurrency one
and seven baseline/candidate pairs. Each pair reverses the preceding pair's
order. Setup enrolls real legacy records through `ManagedSyncStore.enroll`,
including its validation, signatures, identity anchor and durable commits.
Both revisions read the same enrolled home and body files. Body bytes differ
by record ID. No ledger is edited or accepted state fabricated. Setup, output
comparison and evidence copying occur outside primary process timings.

The primary metric is complete release CLI `export --json` elapsed time from
process launch through exit. The command includes real selection, validation,
body/copy rendering, manifest generation and output publication. It uses a
fixed capability and a fresh destination. Process CPU, peak RSS and kernel
block counts support that metric. The existing runner polls exit every 5 ms;
small elapsed deltas need to exceed that resolution and observed spread.

The companion's complete batch consumes the actual `LocalDocumentBackend`
interface. The parent lists then serially fetches every visible body; the
candidate enters its real `withReadView` callback and does the same work before
draining. There is no CLI batch command. Both consumers check metadata and
digest every complete body, releasing each buffer before the next read. Batch
operation elapsed/CPU and resident memory after drain exclude module/input
setup; separate process measurements include them. These are supporting
complete-read measurements, not parser or signature microbenchmarks.

Untimed controls export through the actual API with fixed capability, owner,
timestamp and appearance options. They compare every emitted path and byte,
complete metadata/body results, manifest entries and snapshot hashes. A second
real enrolled fixture includes colliding imported IDs with distinct bytes, an
owned tombstone and a suppressed import. Export must omit all imports; batch
must return exactly the visible owned and imported records. The frozen
mutation/lifetime probes qualify concurrent changes separately from timings.

The release CLI exposes no owner or generation-time flags. Primary CLI output
therefore retains those generated values. The comparator checks their exact
schemas and serialization, every manifest entry and derived hash, while
requiring equal bytes for every other file. It records the two precise nonce
files, owners and timestamps. `outputDir` also differs in the exact captured
stdout. This is explicit CLI nondeterminism, not whole-output byte equality.
The fixed-option API control supplies that stronger comparison. No broad
normalization or validation suppression is used. Unexpected stderr fails.

`pairs.jsonl` retains every metric, absolute/relative candidate-minus-parent
delta, order and output comparison. `paired-summary.jsonl` reports paired
delta min/median/max and median relative change without pooling runtimes.
`behavior.jsonl` records the untimed controls. `outputs/` preserves complete
generated export trees, including partial staging/backup trees on failures.
Libraries, ledgers, donor keys and catalog material remain only in the owned
temporary root and are removed after child cleanup. Raw stdout/stderr,
commands, exits and owned PIDs/groups stay in the existing runner receipts.

Separate count probes repeat complete CLI/batch operations with an explicit
preload. They count actual bounded ledger/body reads and `/proc/self/io`
deltas without skipping any native read or validation. Their elapsed/CPU/RSS
include instrumentation and startup and are excluded from primary timing
labels. Unchanged N-record fixtures should read N+2 complete ledgers for CLI
selection plus export, and N+1 for batch. Full serialized ledger bytes per
body remain O(N); fewer parses do not establish zero-I/O reads or full #96
completion. `/proc` and block counts do not prove physical device traffic.

The preload retains exact raw before/after `/proc/self/io` text. The Python
companion requires all seven named fields as decimal integers, rejects
missing/malformed/duplicate/unknown fields or decreasing counters, and saves
parsed before/after values and independently computed deltas alongside that
text. Missing values never become zero. It also checks syscall-read bytes
and counts against the separately observed native FileHandle activity.
Physical read/write byte counters may legitimately be zero. Parent-side
parsing occurs outside the count process metrics. Requalification evidence
must independently recompute the saved raw deltas without using this parser.

The initial 76b20f5 smoke exposed an invalid regex parser that wrote all-zero
`/proc` dictionaries. Its [partial receipt](evidence/issue-96/ci-harness-76b20f5.md)
preserves the original data and bounded passing facts. Those profiles do not
qualify this source repair or support zero-I/O/performance claims.

The new comparator unit cases use synthetic export files solely to test its
accept/reject rules. Application workloads always use real enrollment and
export. A smoke request should use `--counts 1 --samples 1`, exercise both
exact runtimes sequentially, and make no benefit claim. Sustained seven-pair
1/100 runs, 1,000 records and larger bodies need their separately scoped
execution grants in this coordinated investigation.
