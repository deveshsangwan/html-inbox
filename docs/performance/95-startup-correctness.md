# Startup scheduling correctness receipt

Both exact runtimes reproduced periodic starvation before the correction, then
passed all four regression cases and nine existing focused suites after it.
This is correctness evidence. The corrected scheduler has no performance
qualification or retention decision.

The actual parent remains `610c931b7b22920cce59cf03e49c0de15ebaf2a2`.
Red source was clean `ee3783aef4656525de3fc79cc06086b087d998b2`, whose production
matched `b19c769` / `fddde69`. Its only intervening test change atomically publishes
the unsafe-ledger fixture. Green production/test source was clean
`9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`. Later receipt-only commits must remain
distinct from this tested pin.

The staged regression ran sequentially on Node 20.20.2 and 24.19.0 before any
production edit. Each original run exited 1 with two failures at the intended
first-periodic-pass assertion and two passing controls. Genuine protocol catch-up
established active routes, retry time zero and empty outbox before paused or
disabled-before-admission startup. Independent store commits then enabled work
without a wake, foreground request or clock gap. At 18,250 / 24,250 / 30,250 ms
on the injected monotonic clock, both persistent modes still had zero passes and
zero requests. Full validated reads continued through 17,250 / 22,250 / 27,250 ms;
there was no fatal closure or gap wake. Assertions before the failed periodic
assertion confirmed the intended state and observation preconditions.

The correction sets the first finite monotonic reconciliation deadline when a
validated observation enables background work and the deadline is still infinite.
It preserves an existing finite deadline. On green, both modes admitted 1 / 2 / 3
passes and 3 / 6 / 9 real protocol requests at those same checkpoints, with no gap
wake or fatal closure. The temporary worker remained foreground-only after
external unpause/enable and accepted its separate explicit foreground control.
Direct disabled startup still failed enablement preflight. No production timing,
retry, validation, fencing, ownership or shutdown policy changed.

The regression was promoted to `sync-worker-startup-schedule.test.ts`. Only its
stale owned `.regression.js` output was removed before rebuilding; original
compiled bytes and their hash were retained. Node 24 typecheck/build passed,
followed by all four promoted cases on both exact runtimes and the existing
scheduler/runtime/fatal/credentials/pause-admission/revocation-order/
shutdown-ownership/shutdown-ingestion/attempt-lifetime suites, sequentially.
Each runtime finished with 109 passing tests, zero failures, cancellations or
skips in the final runs. All 22 final typecheck/build/test commands exited 0.
The fatal suite's 26 tests passed on both runtimes with the atomic injection;
this does not prove the cause of the historical hosted macOS failure.

One earlier Node 20 credentials attempt is retained as interrupted. Its first
functional body succeeded, but fixture teardown reported PID-disappearance
timeouts. `/proc` confirmed exited workers were zombies adopted by the wrapper's
subreaper. The wrapper could not wait for command completion before reaping them.
After stopping and joining every owned group, only the artifact wrapper changed:
it reaps adopted children while the direct command is pending. The remaining 15
commands then passed. The failed log and process identities remain in the receipt;
no assertion, source behavior or bound was relaxed.

There were 29 application commands in total: 26 exited 0, two expected original
reds exited 1, and the confounded credentials command was interrupted and joined.
Conservative application charge was 288.135 of 600 seconds, including the failed
attempt. Separately recorded cleanup used 3.420 of its 60-second allowance.
Final inspection found all 67 recorded owned groups absent, every command fixture
removed and no checkout heavy process. Tests joined their workers/listeners and
rebound exact ports. Root independently verified logs, counts, fingerprints,
observations and cleanup before accepting the explicit local-slot release.

[The compact receipt](95-startup-correctness-results.json) includes exact commands,
exits, time bounds, source/compiled/runtime hashes, observations and cleanup.
Complete logs, original red compiled files, all 29 command rows, wrapper versions
and the failed attempt remain under
`artifacts/performance-issues-2026-11-07/issue95-startup-correctness/` in the root
workspace. Root's independent audit is
`issue95-startup-correctness-root-receipt.json` in that artifact directory's parent.
The corrected compiled aggregate covers 198 JavaScript files and hashes to
`742950a6` (full value in the receipt).

The `c00f614` zero-record smoke remains historical harness evidence. All new
candidate performance, required high-count feasibility, five-pair resource/
reaction qualification, public raw-artifact reference, full checks, fresh
independent reviews and root integration gates remain open. No further local
application execution followed the release.
