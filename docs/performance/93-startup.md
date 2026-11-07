# CLI startup qualification plan

Issue: https://github.com/deveshsangwan/html-inbox/issues/93

Immediate benchmark parent: `610c931b7b22920cce59cf03e49c0de15ebaf2a2`, branch `perf/89-bench`, PR #114. The exploration reference `1ae641ac088e5e504fc222e39726ad631b342b8c` is historical, not the measurement baseline. Compatibility remains Node >=20. No runtime, package version, storage or release policy changes.

This change is provisional until the installed ncc artifact demonstrates a repeatable benefit. The lightweight entrypoint handles complete no-argument/help/version invocations. Other arguments retain the existing parser. Command handlers are loaded after parsing; internal owner inspection runs before parsing, and IPC deletion retains its original argument/connection gate. No command implementation or parser rules change.

## Preselected measurements

Primary success metric is elapsed time for installed `--help` and `--version`. Record CPU and peak RSS for each sample too. Compare base/candidate artifacts built with the same build runtime and dependencies, then npm-packed and installed into separate synthetic consumers. Run the actual installed ncc executable directly under Node 20 and Node 24 separately. Also record no-argument startup, `list --json` on an empty synthetic home, and invalid-command startup to detect regressions.

Measure `npm exec --offline -- html-inbox <args>` and `npx --offline html-inbox <args>` from each consumer separately from direct execution. Resolve npm/npx CLI entrypoints and invoke them with the selected Node executable; prepend that runtime's directory to PATH so the launched CLI uses the same runtime. Record actual runtime/npm versions, artifact hashes, exact commands, and base/candidate refs. No registry fetch is part of a timed sample.

Use a focused companion to the #89 Linux wait4 runner for paired installed artifacts, 20 alternating samples per variant/command/runtime/launcher, after two untimed warmups. Keep stdout, stderr and exit code, require exact equivalence for help/version/errors, and record per-sample elapsed/CPU/peak RSS plus min/median/max. Filesystem caches are uncontrolled and warm; no cold-cache claim. CPU includes waited descendants, while peak RSS is the largest process high-water mark, not aggregate tree RSS. Launcher overhead must remain separately labeled. Save raw results with a durable report reference before reviews.

## Qualification gates

- Install frozen dependencies, typecheck and build under the repository's build runtime.
- Inspect actual ncc output and all emitted assets; source imports do not prove improvement.
- Run focused startup/parser, export/display, owner-preflight, deletion-worker, viewer and sync lifecycle tests on Node 20 and 24, then expected repository checks in the exclusive slot.
- Run package smoke on both runtimes, including subsystem-load guards, ordinary commands, IPC deletion, concurrent detached viewer startup and cleanup. Qualify detached managed worker startup/stop using existing lifecycle tests or a focused installed companion.
- Reject the production change if practical benefit does not exceed measurement noise.
- Release the execution slot before fresh pinned Sol High and Claude Sonnet 5.5 Medium reviews with the full execution-contract rubric. Record findings and their disposition.

## Measurement outcome

The installed-artifact experiment supports retaining this change. Full raw samples, environment/compiler/artifact fingerprints, reproducible commands, spreads, tradeoffs and the decision are committed under `scripts/bench/evidence/startup/`. The measured production source is `8ae19fd9c746d335b0fbf0c8ca6e21ada1dd9f80`; later qualification work changes tests, scripts and evidence only. No runtime, package or storage policy changed.

Canonical help/version/noargs are deliberately the only parser bypass. Other argument forms retain the existing parser, including all validation/errors. Ordinary command handlers and helper bodies, and the full help text, match the pinned parent exactly. Installed subsystem guards and lifecycle qualification test the final emitted ncc chunks. Runtime and review receipts are recorded with the evidence.
