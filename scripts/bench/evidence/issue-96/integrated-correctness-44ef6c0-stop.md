# Integrated correctness stopped at tooling-cache postflight

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Grant `root-96-integrated-correctness-44ef-20261108-r1` tested clean
`44ef6c07eb261ee666b650203a51df69639b2895`, immediate parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. This is a partial receipt.

Exact absolute Node20.20.2 and24.19.0 version preflights exited0 and matched
their recorded binary hashes. The following command exited0:

```sh
/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node /home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/corepack/dist/pnpm.js typecheck
```

Corepack used the existing pnpm11.7.0 cache with network disabled. Each command
had a private HOME, TMPDIR and empty catalog before spawn. The controller then
stopped at its first unexpected postflight result. The private typecheck TMPDIR
contained nine Node compile-cache files totalling2244460bytes. The pinned
Corepack launcher explicitly calls `require('module').enableCompileCache?.()`.
The controller incorrectly classified those tooling files as application fixture
residue. This establishes a controller/setup fault, not an application test or
compiler failure. The original controller, receipt, error and logs are preserved.
No oracle, application, probe, wrapper or controller was changed to continue.

Build and all twelve runtime test commands were **not run**. There are no new
export outputs, actual-view, GC, lifetime or inherited listener-close results.
No Python tests, bundle, parent mutation, browser, worker or measurement ran.
The previously green hosted44ef checks remain separate evidence.

All538 tracked hashes stayed equal. All398 compiled files, including199JS,
and the old bundle remained unchanged and **stale** for the integrated source.
Both runtime and recorded compiler/tool hashes were unchanged. The raw receipt
contains full before/after source and compiled maps, command/env/cwd/bounds,
stdout/stderr and sampled process identities. The raw tooling cache is retained
losslessly; no managed ledger or key was captured.

Seven observed PIDs and three groups were absent after joining, with no adopted
children or signals. An additive receipt records copying only the owned tooling
cache, then removing all six command HOME/TMPDIR roots. The slot was explicitly
RELEASED at2026-11-08T16:44:56.937102Z, before packaging. Application wall time
to controller stop was2.658seconds. The entire interval from first command to
release was65.745491seconds, below the separate120second cleanup allowance.
Additive cleanup was not separately timed. Sampling every20ms can miss shorter
lived descendants; this is not a generic interruption or OS-close guarantee.

## Remaining request, not a grant

Root must inspect the stop before any continuation. The smallest proposed
controller correction is to distinguish Corepack's owned `node-compile-cache`
from application fixtures, verify its ownership/type, preserve its inventory and
remove it only after group/child drain. Keep unexpected fixture refusal and every
test expectation unchanged. No correction or retry has been executed.

Subject to a new explicit grant, the unrun phase is one candidate build and the
twelve commands in [the integration request](../../../../docs/performance/96-integration-120.md),
with exact version preflights, one900second deadline and separate120second
cleanup allowance. Root decides whether to reuse this typecheck result or repeat
it. The actual-b249 build/bundle/workload phase remains separately ungranted.
Practical measurements, package qualification and both fresh reviews remain open.

## Lossless raw evidence

[Archive](integrated-correctness-44ef6c0-stop.tar.gz), 840536bytes,
SHA-256 `b70f5570a9fc3c724a92d79cb4b1dfd675d4dce018463a9ce824d70d3f3d00db`. All26 archive members were compared byte-for-byte
to disk; `artifact-hashes.json` covers the other25 files. Unpack with
`tar -xzf integrated-correctness-44ef6c0-stop.tar.gz`. The original receipts
are unchanged; classification and cleanup are additive files.
