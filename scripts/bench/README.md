# Resource measurements

This prerequisite for #89 changes no production behavior and claims no speedup. Use Linux 5.3 or newer, Python 3.9 or newer (for `pidfd_open`) and OpenSSL. Build tools use Node 24; select the measured runtime separately with `--node`. Engine requirements stay unchanged.

One command builds the release bundle and runs the ordinary baseline:

```sh
pnpm build && pnpm --filter html-inbox bundle && pnpm bench baseline --out artifacts/bench/baseline
```

Defaults are three samples, 0/100 records and 10 KiB/1 MiB/9 MiB parser inputs. The output directory must be new. The runner refuses to start when the bundle or compiled output is missing, when CLI sources, `package.json`, either tsconfig or the lockfile are newer than the newest compiled file, or when the bundle predates the compiled output. These checks use modification times, so they catch edits, checkouts and a bundle rebuilt over old output, but not every possible mismatch; the recorded fingerprints identify the measured bytes. `--allow-stale-build` overrides the check and is recorded with the stale paths; such runs are not comparison evidence.

Libraries, catalog, HOME/XDG paths and TLS credentials are synthetic and temporary. No real library or credential is accepted. Workloads and metadata probes get only `PATH` plus synthetic HOME/XDG/TMPDIR values, so inherited configuration, tokens, proxies and `NODE_OPTIONS` do not reach them. Runs are sequential. Durable managed publication can take minutes on slow filesystems.

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

Every seeded, worker and peer document has an equal-size body carrying its own label, so byte checks also verify which document was returned.

* CLI measures the release bundle. List checks the exact fixture IDs. Export checks the exported IDs and compares each body with its own source, then reports logical/allocated output file size. Each sample exports to a fresh destination.
* Viewer runs the production HTTP server on ephemeral loopback. Index requests check status and one fixture title; content requests rotate through the documents and check exact bytes, which are built before timing. Client and server share a process, so CPU/RSS include both. Idle uses a one-second window, not a long-term idle guarantee.
* Worker runs the production owned runtime with synthetic enrolled documents and no routes, waits for idle, then checks it is still idle at the end of each one-second window before closing. This is an unconfigured idle worker, not active sync.
* Managed storage measures enrollment, serial durable publications and snapshot/status reads, then checks every document's title and bytes.
* Peer sync runs production reconciliation and ingestion over authenticated loopback TLS. Every sample has fresh sender/receiver stores; source setup is labelled `peer/source-*`, separate from the managed workload. Initial transfer, no-op reconciliation and missing-body repair have separate samples. The receiver must hold exactly the sender's canonical identities with matching body and metadata hashes, one receipt per identity on the configured route, and each document's own bytes. Commit counters count `ledger-renamed`; wire counters count server request/response payload bytes, excluding TLS/IP framing. CPU includes both in-process peers. These measure actual sync rather than prototype estimates.

Process rows for managed and sync cover the whole helper process: TLS setup, store creation and the per-document verification above, which reparses the ledger for each document and grows faster than linearly with record count. Compare production work with the nested operation samples, not these process totals.

## Results and limits

`environment.json` records SHA-256 fingerprints of the bundle, compiled JavaScript, the measured Node binary, the three harness files and optional candidate module. It also records stale build inputs, commit, dirty state, invocation, Node and bundled SQLite versions when exposed, parse5 version, kernel, CPU model and count, memory, Python version, load average, filesystem type, bundle size, fixture root, counts, sizes and deadlines. Current storage has no SQLite dependency; Node's SQLite version is runtime metadata only. Rebuild after source changes. Compare the same build, harness, runtime, machine, concurrency, fixtures and cache conditions. Alternate repeated base/candidate runs when practical. OS caches are uncontrolled and usually warm. Fresh fixtures do not imply cold caches.

`samples.jsonl` contains raw process and nested operation samples. Process wall time ends when the child's pidfd reports exit; Linux `wait4` then provides CPU/peak RSS. CPU includes waited descendants; peak RSS is the largest process high-water mark, not summed process-tree RSS. No detached service is launched. Operation RSS is a resident snapshot. OS input/output block accounting is not logical bytes or proof of physical drive traffic. Operation `/proc/self/io` deltas report `rchar`/`wchar` syscall bytes including sockets and the counter reads themselves, and kernel `read_bytes`/`write_bytes`/`cancelled_write_bytes`. On tmpfs the kernel byte counters stay near zero. Caching, filesystem and writeback affect interpretation. These counters do not count fsync calls or prove device activity.

`summary.json` reports n/min/median/max elapsed time per label and the load average after the run. No p95 is inferred from three samples. Raw CPU/RSS/I/O/counters remain in the samples. `failures.jsonl` records failed commands, including launch errors and failed behavior checks, with the original cause when cleanup also failed; earlier samples survive.

`cleanup.json` records fixture removal, direct-child reaping and whether every owned process group was verified empty, with the fixture root and any surviving group members. A run succeeds only when its workloads and all three cleanup checks pass; otherwise the runner exits nonzero even if every workload passed. Each child has its own process group and deadline. After the child exits, times out or the runner receives SIGINT, SIGTERM or SIGHUP, the runner sends TERM to the group, waits two seconds for live members, sends KILL and verifies the group through `/proc` before reaping the leader. The unreaped leader keeps its group ID reserved, so these signals cannot reach a recycled group. A descendant that outlives a successful leader fails the run. Those three signals only set a flag that the runner checks while waiting and between commands, so cleanup is never interrupted and a repeated signal does not skip it. Processes that leave the group with `setsid` are outside this guarantee. TMPDIR is inside the fixture root, so the parent removes TLS credentials even after killing a child. SIGKILL of the runner or host failure cannot run cleanup; remove the recorded fixture root manually.

`pnpm test:bench` drives the public runner with synthetic Node executables. It covers a successful run, a failed behavior check, a fixture root that cannot be removed, a nonzero exit, a timed-out group ignoring SIGTERM, SIGINT/SIGTERM/SIGHUP to the runner and a descendant outliving a successful leader. These tests need an existing build only because the runner fingerprints it.

The cheap tests also run in Linux Node 24 verification CI. The manual measurement workflow is report-only. It builds on Node 24, then measures supported current code on Node 20 and 24 separately with two samples, and uploads partial raw artifacts even on failure. It has not been executed yet: `workflow_dispatch` only becomes available once the workflow exists on the default branch. Modern-only implementations must adjust their runtime matrix. No millisecond budget blocks CI.

Commit concise evidence under `scripts/bench/evidence/`; CI uploads full raw results. Performance PRs should include exact commands, revisions, spread, behavior and cleanup outcomes. Keep runtime-upgrade effects separate from source changes. This suite's acceptance is reproducibility and cleanup, not a runtime gain. Compare each workload against itself across revisions.
