# Pending actual-parent bundle and one-record smoke request

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
**Source/request preparation only. No execution grant.** Root accepted the
[integrated scoped correctness](integrated-correctness-ecffd7c.md) and released
its slot. #95 owns the next diagnostic slot. This replaces the former8+2
actual-parent request with five commands plus two version preflights.

## Reuse and reserved parent

Reuse the accepted400 candidate compiled files from the successful79a build,
verified by the ecffd12-check/two-version run. Do not rebuild/typecheck candidate
or repeat the six unchanged ParentIdentityTests solely for local coverage;
those passed hosted44ef CI. Preserve the missing retrospective transitive
declaration/tool-library hash proof for the reused44ef typecheck. Bundle is
still old/stale until explicitly rebuilt.

The actual parent is the existing app-owned checkout
`/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47`, exact clean
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. Owner93 reserved its generated
outputs read-only, with no conflicting pending use or matched owned process.
Root verified reservation receipt
`/home/agent/.t3/worktrees/html-inbox/perf-93-startup/artifacts/93/parent-output-reservation/receipt.json`,
SHA256 `f21101e2a32ead8cd1805585a4b29ba7945f274d773b8a76c73551f4394b2143`.
An exact copy is in the source archive. Its392 dist files and old bundle hash
are **presence fingerprints, not fresh-build/runtime proof**. Dependencies are
present. No source/ref change, checkout creation or install is requested.
Reservation is not authority to mutate outputs or start from elapsed time.

## Exact proposed execution

After a separate explicit root grant at the published clean docs/evidence pin:

1. Both exact absolute20.20.2/24.19.0 `--version` and binary/hash preflights,15s each.
2. Candidate exact24/Corepack pnpm11.7.0 `--filter html-inbox bundle`,180s.
3. Reserved exactb249 parent `build` with the same exact24/Corepack entry,120s.
4. Reserved parent `--filter html-inbox bundle`,180s.
5. Exact20 one-record smoke below,180s.
6. Exact24 equivalent smoke in a different fresh absolute output directory,180s.

The two versions are preflights, so this is **five application commands plus two
versions**. Node24 prefix for all three toolchain commands is:

```sh
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/corepack/dist/pnpm.js
```

Each smoke uses the existing #89 runner and unchanged complete workloads:

```sh
python3 scripts/bench/run.py managed-read \
  --baseline-repo /home/agent/.t3/worktrees/html-inbox/t3-26d1cd47 \
  --expected-baseline-commit b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad \
  --node /absolute/exact/runtime/node \
  --counts 1 --sizes 10240 --samples 1 --timeout 30 \
  --out /absolute/fresh/actual-b249-evidence
```

Absolute runtime paths remain
`/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node` and
`/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node`.
Each smoke has18 sequential owned children and concurrency1, complete release
CLI export and supported complete batch work, fixed-option API comparisons,
imports/suppression/tombstone controls and distinct body bytes. One AB/BA sample
pair is harness qualification only. No100-record or sustained measurements.

## Prepared controller and boundaries

The new ignored source is
`artifacts/issue-96/actual-parent-b249-prepared/execute.py`. It adapts the
accepted owned controller; it does not replace the workload process runner.
Controller, adjacent independent auditor and reservation copy are **unexecuted**.
Only AST syntax/function-diff and read-only hashes ran. It requires an explicit
full40-hex `--expected-head` and root's new `--grant` identifier; exact expected
parent, both clean source trees, immutable accepted build/correctness receipts,
400 candidate outputs, recorded tools and reservation fingerprints must match.
No automatic parent inference or baseline identity bypass exists.

The [lossless source archive](parent-b249-smoke-source.tar.gz) is32071bytes,
seven byte-verified members, SHA256
`dd4a57ef37006439e61a73e802c5f66d23e4c0e460ecd1f204f2e05ca1345c53`.
Controller SHA256:
`729c814da19fbc268d857e1da4ac3f499f7132bbb8cb65805873e72f96fc4ccf`.
Independent auditor SHA256:
`97cd899e54b69707c136b0dff88ac5d2af3da7c2802d9f4d4a95bc2b15064329`.
Controller diff SHA256:
`6d39cf4bf85477e38aa9a862ba2be2c4e837b9e3ba2c61d7226f34c65e27787d`.
It includes the exact owner reservation receipt and both complete source diffs.

Request the original one900s absolute application deadline plus separate fixed
120s cleanup allowance. Each full individual scope must fit remaining time;
cap every command/wait/reap to remaining deadlines. Stop at the first application,
setup, parser, output or audit mismatch. Preserve original logs/unrun list; no
fix/retry, oracle change or budget extension.

Owned process groups, sampled PID/start/descendant/adoption tracking and
per-command private HOME/TMPDIR/catalog isolation are reused. Proposed tooling
housekeeping is limited to the sole `node-compile-cache` subtree of the three
exact toolchain commands/cwds, after observed groups and children join. It checks
owned0700 enclosing TMPDIR, current UID/GID, real0775 cache directories and0600
single-link files, inventories/hashes first, then descriptor-safe removal.
Every other entry/command/type/link/mode still stops. This is a proposed private
**tooling-only** containment rule for root review, not a general permission
exception or application storage rule. No chmod or cache/runtime env workaround.

Candidate compiled bytes stay fixed. Parent source/ref stay clean/fixed;
parent build/bundle changes only their generated outputs under the forthcoming
explicit mutation grant. Preserve reservation/pre-build outputs before mutation
and record fresh parent maps after build, both bundles after packaging and all
identities after each smoke/finally. No further parent mutation during smokes.
Release after owned work/fixtures settle and before evidence packaging.

## Independent evidence and limits

Reuse the already corrected independent raw-I/O/output auditor, with only actual
b249/clean candidate commit admission and accurate source-pin attribution added.
It imports neither tested parser nor application modules. Reparse exact raw
before/after seven-field `/proc/self/io`, compare maps/deltas and applicable
native rchar/syscr bounds, allowing legitimate physical-I/O zeros. Derive opens,
body size/count from this run's fixture specification. Derived ledger size is
only cross-profile consistency; cite successful source-pinned live ledger.stat
assertions, not an independently retained stat or recovered ledger.

Retain all16 complete output trees/manifests across both runtimes, exact API
pairs, CLI/count-probe stable-byte pairs allowing only named ownership/manifest
nonce differences, original outputDir/owner/time values, diagnostics, process
and fixture cleanup. Check resolved expected SHA beside actual baseline/build
identity. Preserve source/runtime/compiler/lock/compiled/bundle hashes and exact
commands/env/cwd/exits. Disclose instrumentation separately from elapsed samples.
No physical-device I/O, generic interruption, cross-runtime whole-output equality
or practical-gain claim follows from this smoke.

No install, candidate build/typecheck, Python/helper tests, actual browser,
application listener/worker, full suite, reviewer, runtime/storage policy change
or measurement expansion is requested. Full per-body serialized ledger I/O
remains. Package qualification, practical1/100-record benefit and both fresh
measured-pin reviews stay later gates.
