# Normal full-qualification request after the paired evidence freeze

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Source preparation only. No local application/full-suite/review grant is active.
No new controller, test framework, production change or diagnostic patch is
included. Root must bind the published clean head and reviewed owned-controller
invocation before execution. Do not start from slot availability or hosted green.

Root accepted scoped integrated correctness, actual-parent smoke and the
[paired100-record benefit](paired-performance-c491419.md). Measurement source is
`c4914196d275b0dac2a60e9dc09353a29da49f01`; actual parent is
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. This publication changes only
reports/evidence/request documentation. It does not change the measured workload,
runner, application, CI or compatibility policy. Full issue readiness remains open.

## Frozen inputs and artifact reuse

Request reuse of the accepted44ef typecheck and79a build, scoped-correctness
receipts and caf/c491 bundle provenance. Do not repeat typecheck/build/identity
tests solely for documentation changes. Before execution, require exact clean
candidate HEAD from the subsequent grant, exact clean actual parent HEAD and
merge-base b249; compare all335 reusable tracked/config inputs,400 candidate
and392 parent generated files, both bundles,2 runtime maps and8+13 recorded tool
maps to the accepted c491 receipt. Capture fresh full tracked/index/ref maps.
Parent checkout `/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47` is read-only in
this request. No parent build, package, reference or output mutation is requested.

Candidate bundle is1283240bytes, SHA256
`7f8fa149cb7233b41cd1671089bcb76ac15ebdd2fb3323ce64a40ca644b70509`;
parent is1276123bytes, SHA256
`9e7b74b25117b23e64de30d16624dca18c4e503f4ce4375185d68af8c77afdd5`.
Candidate full400-file map aggregate is
`caf0bebd71a784a521077005f08a9a9d6afe7e17047e6e531ef2c2e681f4f64d`.
Maps use the recorded sorted compact JSON SHA256 convention. Full per-file maps
remain in the [lossless measured archive](paired-performance-c491419.tar.gz).
The earlier typecheck lacks retrospectively retained installed transitive
declaration/tool-library hashes. Accepted tracked/compiler/tool proof is retained;
this request does not turn that historical limitation into a full byte proof.

A normal release package requires its existing `prepack`, which recompiles dist
and bundles. Request exactly one Node24 `npm pack`, as the release-artifact
workflow does. This is the only requested candidate generated-output mutation.
Before it, preserve a lossless copy/hash inventory of the measured400 files and
bundle. After it, require exactly the same file set and bytes as measured, plus
archive-member/installed-bundle identity. No reproduction result is claimed now.
A mismatch stops qualification before application checks, preserving both maps,
originals and pack logs. Do not silently substitute new bytes, restore/retry or
claim that old timings qualify them. Root decides the next action.

Both runtime phases then use that single packaged artifact and identical measured
compiled bytes. There is no Node20 compiler/build claim. Hosted Source CI also
runs its default package-smoke prepack under its selected runtime; account for that
normal path separately rather than calling the local supplied-tarball route an
identical invocation. The supplied-tarball route is the existing package release
workflow's installed-artifact check.

## Exact executables and command schedule

All commands are sequential from the candidate root unless a cwd is stated.
These identifiers are notation for exact argv entries, not PATH-selected aliases:

- N20 = `/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node`,
  SHA256 `6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd`.
- N24 = `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node`,
  SHA256 `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
- NPM24 = `/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/npm/bin/npm-cli.js`.
- PACK = a fresh absolute controller-owned package-output directory outside
  source/dist; TGZ = its sole `html-inbox-0.6.1.tgz`. Record the resolved path and
  SHA256, never an ambiguous shell glob. No npm publish, tag or workflow dispatch.

First run N20 `--version` then N24 `--version`,15s each, after binary hashing.
Then N24 NPM24 `pack --pack-destination PACK`, cwd `packages/cli`,180s maximum.
Do not use `--ignore-scripts` for pack: existing prepack is part of this gate.
Use the exact Node24 bin directory first in PATH for npm lifecycle commands;
record compiler/ncc/lock/package inputs and fresh installed transitive tool files.
Do not enable Corepack or install dependencies. Stop on missing prerequisites.

Next run the following ten commands with N20, then the same ten with N24. N is
always the respective absolute binary, including children through process.execPath
and the controlled PATH. Each row is one command with its own bound:

| Order per runtime | Exact argv after N | Maximum seconds |
| ---: | --- | ---: |
| 1 | `scripts/run-unit-tests.mjs --test-shard=1/2` | 300 |
| 2 | `scripts/run-unit-tests.mjs --test-shard=2/2` | 300 |
| 3 | `--test packages/cli/dist/managed-view-retention-check.js` | 90 |
| 4 | `--test scripts/viewer-systemd-cleanup.test.mjs scripts/run-unit-tests.test.mjs scripts/release-policy.test.mjs` | 120 |
| 5 | `--test scripts/skill-cli-resolution.test.mjs scripts/skill-cli-windows.test.mjs` | 120 |
| 6 | `scripts/package-smoke.mjs TGZ` | 300 |
| 7 | `scripts/skill-cli-package-smoke.mjs` | 300 |
| 8 | `scripts/run-browser-tests.mjs` | 300 |
| 9 | `scripts/verify-site.mjs` | 30 |
| 10 | `--test scripts/site-theme.test.mjs` | 60 |

After the Node24 block, run exactly once,120s maximum:

```sh
python3 -m unittest discover -s scripts/bench -p 'test_*.py'
```

That existing CI route includes runner cleanup/comparator, strict raw-I/O parser
and six parent-identity controls. It follows the package build because cleanup
fixtures fingerprint the bundle. It is full normal bench-runner test discovery,
not another managed-read measurement or an extra isolated identity-test repeat.
Record the exact Python executable/version/hash without adding application tests.

Total:22 application commands plus2 version preflights. Maximum command caps
sum4170s. Request one4500s application deadline set once, including metadata/
audits, and a separate fixed120s final cleanup allowance. Expected roughly15–35
minutes is a forecast, not an extension. Admit a command only if its complete cap
fits remaining application time. Cap every wait/grace/reap to the appropriate
absolute deadline. No retry, repeat-until-green or silent partial qualification.

## Normal gate coverage and platform limits

This expands the normal components of `pnpm verify` without its redundant fresh
build, and includes normal Skills, explicit GC and Python routes from Verify.
Current discovery has93 compiled `.test.js` files. Record the sorted file list,
its hash and actual per-shard selections. Both shards together must cover every
file once per runtime. The actual-view44 wrapper is one discovered file and must
run once, not once per shard; its inner44 assertions/failures must propagate.
The separate GC wrapper owns its existing `--expose-gc` child and1 retained-state
case. Do not add the18 frozen historical characterization cases to normal unit
counts or pretend they replace current full discovery. Preserve all expected
POSIX/Windows skips and intentional child-failure assertions with raw diagnostics.

Normal browser discovery currently includes eight `*-browser.test.mjs` files,
including the stub fixture suite and the actual browser suites. This phase would
use REAL Playwright Chromium plus real reader/control and TLS/proxy fixtures,
real deletion helpers/sync workers, detached viewer processes and their existing
owned shutdown assertions. These are requested scopes, not currently authorized
execution. Do not replace the suites with stub-only coverage or change navigation,
acquisition, marker, ownership, timeout or protocol assertions.

Playwright is pinned1.63.0 and its browsers.json selects Chromium/headless revision
1243. Read-only inspection found both1243 executable paths and installation markers
under `/home/agent/.cache/ms-playwright`; presence is not a launch/dependency proof.
Request read-only reuse with explicit PLAYWRIGHT_BROWSERS_PATH pointing there,
recorded browser/package hashes. No browser download, OS dependency install,
container or version substitution is included. Missing/unlaunchable prerequisites
stop as setup failures, with originals retained. Browser behavior failures remain
behavior evidence until classified. This host is not the pinned CI container.

The packaged-cli smoke uses the actual freshly packed bundle installed into its
owned temporary consumer with its existing npm `--ignore-scripts` install. It
exercises foreground/detached concurrent viewer starts, publish/list/content/export,
CLI/UI deletion, restarts, loopback/LAN, recording Tailscale executable and stop.
The skill package smoke independently fetches pinned `html-inbox@0.5.0` through
its existing documented resolver into a fresh cache and empty consumer; it tests
that released fallback, not96 production. Request this outbound npm registry fetch
explicitly, with no project/global install or dependency update. It also owns
loopback listeners, detached viewers, recording Tailscale and refusal fixtures.
No real Tailscale account/route mutation, system service installation or release.

Read-only workflow accounting at the published qualification pin must include all
normal Verify leaves: Source Ubuntu20/24 and macOS20 two shards each, Windows24
one shard; Skills Ubuntu20/24, macOS20, Windows24; Browser Ubuntu20/24, macOS20,
Windows24; then aggregate Verify. That is15 leaves plus aggregate,16 workflow jobs;
watcher18 checks are a separate presentation count. macOS24 is excluded by the
existing workflow; POSIX GC is explicit and Windows skips these probe wrappers.
Linux results do not qualify native Windows/macOS behavior. Preserve actual hosted
build/test patch versions, merge checkout SHA and head SHA; CI floating20/24 labels
are not claims of the exact local binaries. New publication heads need their own
accounting, no automatic rerun request. Existing watch continues without registration.

No actual `test:systemd` host-service integration, publish/pages/resources/release
workflow or sustained workload is requested. Their permissions and operational
scope differ from normal Verify. No full cross-platform local matrix is implied.

## Process ownership, evidence and stop rules

Use the existing reviewed process-group/controller approach, with a source-pinned
adaptation reviewed by root before launch. No alternative runner or broad fs
interception. Per command create private0700 HOME/TMPDIR/catalog/npm-cache roots
before spawn, sanitize inherited HTML_INBOX_*/NODE_OPTIONS/test context, and put the
exact current runtime bin directory first in PATH. Do not set CI-only flags or
concurrency/timing overrides to alter test behavior. Record complete sanitized env,
argv/cwd/executables, monotonic start/end/deadlines/exits/signals, stdout/stderr,
source/ref/index/runtime/tool/browser maps and selected test counts/skips.

Normal unit/browser/package suites may intentionally create workers in fresh
process groups or detached viewers. Track exact PID/start/group identity and
known fixture/record identities in addition to sampled descendants. Outer100ms
/proc sampling alone can miss short-lived processes; never call it complete
native ownership proof. Retain/reap adopted owned children and drain pipes before
removing fixtures. Do not signal unrelated processes or use broad process-name
kills. Script cleanup assertions remain primary; record any controller cleanup
separately and never turn an assertion failure into a clean pass. Avoid the known
adopted-child/subreaper accounting confound and preserve unexpected reaps/statuses.

The sole npm pack tooling root may contain compiler/Corepack/npm output. After
owned processes join, inventory without following symlinks and remove only its
exact creator-owned private root with verified identity. Child0775 tool-cache
directories are not application storage policy. Application fixture/output roots
retain their existing cleanup assertions. No global ignore of TMPDIR residue.
The retained TGZ lives outside that disposed tool root until verification/package
publication completes. Do not archive managed ledgers, credentials or keys.

Capture installed tarball members/hashes and installed bundle identity, complete
published export outputs/manifests where normally observable, raw suite diagnostics
and deterministic fixture cleanup results. Any extra teardown capture must reuse
only the already-qualified export observer's intended prefixes, be disclosed as
observation overhead and leave unsupported fixtures unobserved. Do not intercept
all filesystem removal or claim every internal export was externally retained.
Existing exact measured outputs remain the equivalence evidence for that matrix.

Check same400 compiled/bundle bytes after pack and each runtime, immutable parent
392/bundle/tool maps at final postflight, full source/index cleanliness and every
observed/recorded PID/group/root. Keep distinct phase failure, timeout/setup,
instrumentation, asserted behavior and cleanup classifications. Stop at the first
command, audit, provenance, ownership or fixture mismatch, retain partial/unrun
records, and report before any correction. Do not fix-and-retry, weaken tests or
infer a native cause. Retain roots if owned work cannot settle. Explicitly RELEASE
after heavy work settles and before packaging/reviews. No generic interruption,
OS-close or exhaustive native-child guarantee follows from normal completion.

## Separate unresolved gates and original610 criterion

Read both shared ignored receipts completely during this source phase:
`perf-93-startup/artifacts/93/windows-hub-legacy-dc28-receipt.md` and
`perf-94-sigcache/artifacts/94/shared-protocol-length-triage-2026-11-08.md`.
Their exact hashes are in [source inspection](full-qualification-source-inspection.json).
Root owns diagnostic placement/execution. No related patch, focused rerun or
retry is part of this request. A passing full phase alone does not resolve them.

The Windows record logs lock-OPEN EPERM on the SHA256 legacy-original deletion
lock. A worker can send ok:false and exit0; joined failed handling is consistent
with a surviving original. Native cause and early-close attribution are unproven.
The LENGTH receiver counter increments before authentication/storage. Its0 is a
pre-admission observation; fault delivery/rejection and the later recovery checks
are unproven. Ordinary snapshot/readLedger refactors remain relevant. These are
separate correctness gates and neither is exonerated by later green CI or source
similarity. Older failure families retain their separate original records.

The contract also requires a combined-stack comparison against original
`610c931b7b22920cce59cf03e49c0de15ebaf2a2` before recommending integration.
The accepted c491 versus actual b249 matrix isolates96 and cannot satisfy that
criterion. Earlier610 one-record characterizations/smokes are not a combined
seven-pair practical-benefit result. Mark this requirement OPEN. No additional
measurement, parent89 checkout/output mutation or baseline rebuild is included.
Root must separately coordinate original-parent ownership/artifact provenance and
approve any combined-stack request. Do not subtract unrelated medians or relabel
actual-b249 gains as combined-stack results.

After full qualification and root disposition of open gates, freeze one clean
source/evidence pin for both fresh requested reviews. Functionality is GPT-6.1 Sol
High; quality is Claude Code Sonnet5.5 Medium. Both receive the complete diff,
issue/accepted partial policy, all evidence/limits and full rubric, and each gives
independent functionality/code-quality/performance verdicts. No reviewer launch
is requested now. Any production/harness fix invalidates the relevant frozen
qualification and measurement assumptions for root reassessment. Draft/no merge/
release/full96 closure remains the status.
