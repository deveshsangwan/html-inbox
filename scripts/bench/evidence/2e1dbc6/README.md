# Resource harness qualification

The runner at commit `2e1dbc62a559832e696df5fc600a2eac6ed87063`, tree `ea2f229364ec433e9272e4820e74d6dce7a78189`, completed on Linux with Node 24.19.0 and Node 20.20.2. The working tree was clean for both runs. The immediate release/0.7 base was `c4bdc98b91acc15fa67ecf5fdc2ed754e2f090fd`. Both runtimes used the same freshly compiled CLI and bundle. This qualifies measurement infrastructure for that compatibility line.

| Observation | Node 24.19.0 | Node 20.20.2 |
| --- | ---: | ---: |
| Baseline elapsed, seconds | 204.69 | 359.80 |
| Raw rows / nested operations / summary groups | 32 / 58 / 52 | 32 / 58 / 52 |
| Launch control peak RSS, KiB, start / end | 22,824 / 22,824 | 22,824 / 22,824 |
| CLI version peak RSS, KiB, both samples | 68,372 / 68,140 | 53,640 / 53,704 |
| Dense 9 MiB parser process peak RSS, KiB | 1,452,736 | 1,102,948 |

The raw data reproduced the sample count, minimum, median and maximum in all 52 groups on each runtime. With 100 records, both repeats on each runtime transferred 100 bodies initially, zero on the second pass and one after deleting a receiver body. The peer workload verified canonical identities, metadata and body hashes, route receipts, and document bytes after each pass. The CLI list and export checks passed. Both runner cleanup receipts report all children reaped, process groups empty and the fixture directory removed. The qualification verifier also checked fixture absence on disk.

Each runtime directory holds the original environment, summary and cleanup JSON, the verifier result and the complete raw JSONL compressed with gzip. See [Node 24](node24) and [Node 20](node20).

## Reproduction

Use Linux with tmpfs for the temporary fixtures and the two Node versions above. Build with Node 24.19.0. Set `NODE24` and `NODE20` to the corresponding absolute executable paths.

```sh
pnpm build && pnpm --filter html-inbox bundle
python3 -m unittest discover -s scripts/bench -p 'test_*.py'
TMPDIR=/tmp python3 scripts/bench/run.py baseline --samples 2 --counts 0,100 --node "$NODE24" --out artifacts/bench-reproduction/node24
TMPDIR=/tmp python3 scripts/bench/run.py baseline --samples 2 --counts 0,100 --node "$NODE20" --out artifacts/bench-reproduction/node20
```

The qualification first verified that the runner refused an old build with exit 2. It then ran the installed tsc-rs 0.7.0 compiler with `-p tsconfig.json` and a private byte-matched copy of ncc 0.44.1 with `build dist/index.js -o bundle`, both from `packages/cli`. Both exited 0. The bundle SHA-256 was `6e34827440c576add5dc4a02d6c46315a340bbb577062dfc96183f9eb68e59ae`. All 19 synthetic tests passed. Node 24 ran first, followed by Node 20. The supervisor joined all six steps, reported zero stray or surviving processes, and restored the original generated trees. The complete run took 589 seconds of the 1,710-second allocation. Each step ran once.

The measurements used an exclusive local slot, two samples, 10 KiB document bodies and all three parser sizes. The viewer idle sample covers one second per count. OS caches were uncontrolled. The parser RSS above covers the process running both nested samples. These data provide no before/after CLI speedup estimate. The 1,000 to 10,000 record workloads and the modern release line still require separate qualification. Earlier evidence and its RSS limitations are recorded in the [historical qualification](../README.md).
