# Shutdown read diagnostic receipt

The deterministic diagnostic identified a worker timer read that the actual
parent closes without joining. The candidate retains lifetime ownership until
that read is released. Both exact runtimes produced this result under the same
strict worker-owned lifetime assertion. The original routed failure's caller
remains untagged, and its row remains failed with all 25 feasibility cells unrun.

Grant `root-95-shutdown-read-d320-20261108-r1` ran once at clean diagnostic source
`d320bb0d100e016ce6a84a1df36c02293ac2f868`. Actual parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2` and candidate
`9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f` were separately archived and compiled.
Production and the three measured harness files remained frozen. The staged
setup correction registered teardown before enrollment/enablement, and the
controller owned each command's temporary root before launching it.

All thirteen manifest commands ran. Nine preflight/version/archive/build commands
and both candidate probe files exited 0. Both parent probe files exited 1 with
their timer-observation test explicitly `not ok`, classified as
`expected-strict-parent-contract-red` and `passing_cell: false`. The controller's
exit 0 means diagnostic completion; it does not turn those reds into passing
behavioral or performance cells. No unexpected setup, caller, contract or cleanup
failure occurred, and no command was unrun.

For the timer case, the selected parent stack identifies `tick`, its actual
interval callback and `MockTimers.tick`. The read was still active when close
finished and removed lifetime/runtime evidence, before explicit gate release.
On Node 24, close occurred at 149.017 ms, release at 149.328 ms and read completion
at 150.899 ms within that case. Node 20 showed the same ordering, with close at
170.734 ms, release at 171.062 ms and read completion at 172.698 ms. These clocks
share each case's process and time origin.

The candidate's selected stack identifies `refreshSchedule`, `observeSchedule`
and `drain`. During the bounded one-second held-read window, close remained
pending and both ownership records remained present. Close completed after
release and read completion on both runtimes. The synthetic scheduling clocks
advanced in ordinary 250 ms steps; no gap wake occurred.

The foreground-lifecycle control selected `assertManagedLifecycle`. Both parent
and candidate retained ownership and joined that read. The explicitly separate
external-store observer control permitted worker close on both revisions while
that external read remained active. The caller stack, explicit store identity,
live-read set and release/finish timestamps distinguish these cases; event names
alone were not used to select a cause.

There were twelve mode outcomes: two strict parent reds and ten `ok` controls,
zero cancelled or skipped tests. All original assertions remain. This is a
bounded probe with frozen interval scheduling and real enrolled stores, owned
worker handles and listeners. It holds at the snapshot method boundary before
the original read, matching the measured hook; it does not suspend a kernel read
already in progress or reproduce the original routed workload's full history.

Complete extracted source identities cover 198 parent files and 201 candidate
files. Complete compiled identities cover 195 / 198 JavaScript files and match
the original aggregates `41663c8a...` / `742950a6...`; full values, per-command
outputs, source/compiled identity-file digests and runtime hashes are in
[the compact receipt](95-shutdown-read-results.json). The full per-file tables,
original archives, redacted TAP outputs and original output digests remain in
`artifacts/performance-issues-2026-11-07/issue95-shutdown-read-1/` in the root
workspace. Only the specified synthetic controlToken was redacted.

Total controller time was 10.852 seconds within the fixed 600-second application
deadline and fixed application-plus-60 final deadline. The final independent
inspection found all eighteen observed PID/start identities and fourteen observed
groups absent. All twelve exact control ports were rebound, active-read sets and
cleanup failures were empty, and the scratch root was removed. The local slot
was explicitly released before this packaging. No timeout, interruption,
TERM/KILL grace or forced-cleanup path was exercised or qualified.

This establishes the minimized parent observation-lifetime defect and candidate
joining behavior. It does not identify the old routed caller, reclassify the
failed feasibility row, qualify any missing large-count workload, establish a
practical CPU benefit, or authorize another run. Production/harness changes,
feasibility continuation, resource qualification and independent reviews require
the remaining explicit gates; PR #121 stays draft.
