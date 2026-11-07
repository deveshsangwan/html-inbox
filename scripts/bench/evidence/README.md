# Issue 89 qualification

Implementation base: `099dcbd6378e3b6f73216966cfe9ea7f91ed5d8e`.
Measured source and suite: `485273a2f7f20f604a2ae1e5e6a915396eba290e`, clean working tree for both runs.

Build on Node 24.19.0:

```sh
pnpm build
pnpm --filter html-inbox bundle
```

Measured sequentially on the same host in the exclusive benchmark slot:

```sh
python3 scripts/bench/run.py baseline --samples 2 --out artifacts/bench-89/node24
python3 scripts/bench/run.py baseline --samples 2 --node /home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node --out artifacts/bench-89/node20
```

Both commands exited 0. Both used 0/100 records and all three HTML sizes in text and dense-element shapes. All behavior assertions passed, including export bytes, original viewer bytes, actual TLS transfer counts, exact received bodies, receipts, no-op and one-body repair. Both cleanup receipts confirm fixture removal and child reaping. Every summary has 45 labels with its actual sample count and min/median/max. Viewer idle has one one-second window per record count; worker idle has two. These short idle observations do not qualify long-running service behavior.

The adjacent runtime directories contain complete environment metadata, summaries, cleanup receipts and gzip-compressed raw JSONL. Decompress with `gzip -dc scripts/bench/evidence/node24/samples.jsonl.gz`. These are the runner's original outputs, not selected samples. The compressed raw files are about 19 KB each. Full local artifacts remain under the commands' output paths; public reproducibility does not depend on those ignored paths.

This qualifies measurement infrastructure. There is no production candidate, before/after delta or claimed speedup. The two runtime runs are separate qualifications, not evidence of a source optimization. OS caches were uncontrolled/warm and I/O counters are subject to the limits in the suite README. Larger record counts are supported targeted workloads, not a claim that 1,000/5,000/10,000 records were measured here. Future modern-line forward ports and Node 26 qualification belong to their implementation and release gates.

Additional checks are recorded in the PR and review receipt. The socket-cleanup test was extended after these measurements; measured workload code is unchanged.
