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

`--sizes` accepts comma-separated 10240,1048576,9437184. CLI/viewer/managed/sync use the first size; parser uses all sizes and both dense-element/text shapes. `--counts` accepts 0,100,1000,5000,10000. Only `sync` also admits129, the smallest count crossing its128-entry manifest/holdings page. Existing defaults and duplicate checks are unchanged. Large managed/sync runs preserve current durability and can be expensive. `--timeout` sets the per-child deadline, up to 3600 seconds. There are no timing assertions.

`sync --sync-trace` explicitly enables issue97 diagnostic stderr JSON. Other workloads reject this flag. It passes a child argument through the existing isolated environment; an inherited environment variable cannot enable it. Unflagged invocations retain their existing arguments, environment, output fields and metric calculations.

Trace lines use prefix `issue97-sync-trace-v1` and `performance.now()` monotonic milliseconds. Each child emits at most 256 lines and 64 KiB, reserving room for one truncation notice. The runner permits at most six distinct sync counts, so an invocation has at most 1,536 trace lines and 384 KiB. Phase markers cover setup, reconciliation, validation, record I/O/emission and shutdown. Reconciliation status/counts, numerical counters and allowlisted error codes are captured before assertions. Fixture-local client observers report the first failed call and every 25 completed calls, preserve the exact original promise/result/error and restore the original property descriptors in finally. There is no polling or diagnostic timer. No credentials, headers, URLs, identifiers, bodies, error messages or stacks are included in these diagnostic fields. Unrecognized codes become `unclassified-error`.

Traced environment, process rows, summary and nested operation rows are explicitly performance-ineligible. Only logical-byte/control observations separately accepted by the root may qualify. Trace output itself adds overhead; it does not alter assertions or request/pass/lease/lock/child bounds. A record-emission return means the `console.log` call returned, not that another process observed or flushed stdout. Missing/truncated markers do not prove an internal stall. Original stdout/stderr and failures remain unmodified in the existing raw artifacts.

The parser candidate must export synchronous `validateHtml`. Exact validation results must match the production validator on the measured input and a small adversarial corpus before timing. This does not replace the full validation unit tests. Parser operation timings exclude module startup and input construction; process timings include them and behavior checks. Never compare parser microbenchmarks directly to end-to-end publication or full sync.

## Workloads

* CLI measures the release bundle. List checks record counts and IDs. Export checks document counts and reports logical/allocated output disk size. Each sample exports to a fresh destination.
* Viewer runs the production HTTP server on ephemeral loopback. Index requests check status and fixture content; content requests check exact bytes. Client and server share a process, so CPU/RSS include both. Idle uses a one-second window, not a long-term idle guarantee.
* Worker runs the production owned runtime with synthetic enrolled documents and no routes, waits for idle, measures one second, checks idle and closes. This is an unconfigured idle worker, not active sync.
* Managed storage measures enrollment, serial durable publications and snapshot/status reads with record checks.
* Peer sync runs production reconciliation and ingestion over authenticated loopback TLS. Every sample has fresh sender/receiver stores. Initial transfer, no-op reconciliation and missing-body repair have separate samples. Exact bodies, counts, receipts, confirmation and transferred counts must match. Commit counters count `ledger-renamed`. `ledgerReplacementBytes` sums actual replacement-file sizes observed by one stat after each rename in these successful, serial fixtures, separately for source and receiver. It includes every full ledger replacement, excludes lock/body writes, and does not claim physical drive traffic. That observation adds one stat per commit equally to baseline and candidate. Identity, metadata, signature, fingerprint and exact receipt comparisons plus receipt-backed delivery checks run in each pass. Wire counters count server request/response payload bytes, excluding TLS/IP framing. CPU includes both in-process peers. These measure actual sync rather than prototype estimates.

## Results and limits

`environment.json` records SHA-256 fingerprints of the bundle, compiled JavaScript and optional candidate module, plus commit, dirty state, invocation, Node and bundled SQLite versions when exposed, parse5 version, kernel, filesystem type, bundle size, fixture root, counts, sizes and deadlines. Current storage has no SQLite dependency; Node's SQLite version is runtime metadata only. Rebuild after source changes. Compare the same build, runtime, machine, concurrency, fixtures and cache conditions. Alternate repeated base/candidate runs when practical. OS caches are uncontrolled and usually warm. Fresh fixtures do not imply cold caches.

`samples.jsonl` contains raw process and nested operation samples. Linux `wait4` provides process wall/CPU/peak RSS. CPU includes waited descendants; peak RSS is the largest process high-water mark, not summed process-tree RSS. No detached service is launched. Operation RSS is a resident snapshot. OS input/output block accounting is not logical bytes or proof of physical drive traffic. Operation `/proc/self/io` deltas report `rchar`/`wchar` syscall bytes including sockets, and kernel `read_bytes`/`write_bytes`/`cancelled_write_bytes`. Caching, filesystem and writeback affect interpretation. Reading counters adds overhead. These counters do not count fsync calls or prove device activity.

`summary.json` reports n/min/median/max elapsed time per label. No p95 is inferred from three samples. Raw CPU/RSS/I/O/counters remain in the samples. `failures.jsonl` records failed commands; earlier samples survive. `cleanup.json` records fixture removal and direct-child reaping. Each child has its own process group, deadline and TERM/KILL cleanup on success, failure, timeout, SIGINT and SIGTERM. TMPDIR is inside the fixture root, so the parent removes TLS credentials even after killing a child. SIGKILL of the runner or host failure cannot run cleanup; remove the recorded fixture root manually. Cleanup tests cover a nonzero exit and a descendant ignoring SIGTERM.

The cheap cleanup tests also run in Linux Node 24 verification CI. The manual measurement workflow is report-only. It builds on Node 24, then measures supported current code on Node 20 and 24 separately and uploads partial raw artifacts even on failure. Modern-only implementations must adjust their runtime matrix. No millisecond budget blocks CI.

Commit concise evidence under `scripts/bench/evidence/`; CI uploads full raw results. Performance PRs should include exact commands, revisions, spread, behavior and cleanup outcomes. Keep runtime-upgrade effects separate from source changes. This suite's acceptance is reproducibility and cleanup, not a runtime gain.

Sync uses an equal-size plain `x` body and peer-specific metadata; CLI/parser/viewer fixtures use the text/dense generators. Compare each workload against itself across revisions. Sync documents currently share their content and metadata, so byte/count checks do not qualify identity-preserving optimizations without additional identity assertions.
