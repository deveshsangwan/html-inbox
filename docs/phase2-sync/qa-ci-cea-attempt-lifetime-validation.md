# Attempt lifetime validation

The corrective snapshot was reviewed as uncommitted work on `feat/phase2-sync`, based on `cea30b48cbef814511e2eedfc83d1793bc011354`. Its 169-source manifest SHA-256 is `4967ad40861e64dfe33932a3383216c47b25a978f49ec736dd2dd15c792a5eba`. Author and root output match all 336 files, aggregate `88393e78f3292bc7fbd61b78e5deb4fe6bec909e0795987e7515f714a33d069a`.

The frozen [lifetime contract](qa-ci-cea-attempt-lifetime-contract.md) and [observation contract](qa-ci-cea-activation-observation-contract.md) define the scope. Five production files add owned watcher cancellation, a stable awaited close, and joins in all three production owners. Two existing tests adapt direct attempt ownership and the cleanup mock. Two new test/helper files exercise actual producer, lock, cancellation, client and HTTP lifetimes.

| Author check | Node 20.20.2 | Node 24.21.0 |
| --- | --- | --- |
| Typecheck and build | Exit 0 | Exit 0 |
| Affected set | 463/463, no skips | 463/463, no skips |
| Shutdown containing file | 11/11 | Included above |
| Controlled activation transport miss | Original timeout retained | Not repeated |
| Matched activation control | Passed original assertions | Not repeated |

The prior dedicated lifetime suite passed 25/25 on both runtimes. Its production, test and helper bytes remain identical. Counts overlap and are not a distinct-test total. Baseline viewer compatibility executed rather than skipping in the final affected runs.

The table records the lifetime author source `fb9b5da57f33450997881995d71941e266fed2c3bbe344708835cbd37ee914f5`, before the subsequent one-file positive backoff fixture correction. Those source and compiled manifests remain historical evidence.

The earlier affected Node20 failure remains recorded. Its activation counter was not retained. Independent observation showed a sufficient pre-activation transport mechanism, with a genuine result held until the existing 400ms socket timer closed the connection. That does not identify the original actor or establish an awaitable-close regression. The new diagnostics preserve all original timeouts, predicates and assertions.

Author evidence is retained at `/tmp/qa-case203-observation-author-5t2cteya/`:

- `terminal-result.txt`, SHA-256 `390b27f89e467091055877dad5cb923f83cce603050b162f54405cc4f7f51896`.
- `parent-relative-nine-file.patch`, SHA-256 `4260f722758ba94fa62deb39b7191fff7852c5ffdc7f17bd05cf00ddd2285561`.
- `runtime/receipts/affected20.log`, SHA-256 `fea28cd4c254abcdf4906426a2bec4835431f79c1dcf9b1a562771a9b9e3a19f`.
- `runtime/receipts/affected24.log`, SHA-256 `723ac3c2a01ce64a423d1e15225ea0ff88e8ebbe2a191f962f18cb0f58f09cdc`.

Parent verified all 1,137 immutable artifact hashes and all fourteen command-log hashes. Eight files are identical to the previously inspected lifetime implementation; only local activation observation changed afterward. All 160 borrowed nonowned states were restored. The parent index remains empty and byte-identical. The child raw index changed while all staged entries still matched HEAD; no metadata-only or binary-preservation claim is made for that child.

## Cleanup qualification

The cleanup helper introduced a tuple dictionary key. Its final JSON serialization failed after hash, PID, handle, rebind and scratch assertions and private removals. The command remains exit 1. The in-memory per-endpoint UTC receipts were lost and were not reconstructed. Control flow supports completion of 827 exact loopback rebind/close operations, without separately serialized timestamps. Twelve child close callbacks were not captured; all 4,850 created child objects had native exit callbacks.

A new parent read-only postflight verified 5,042 recorded PIDs absent, all ten private runtime paths removed, empty remaining-child lists and no recorded open handles at observed exits. It made no application invocation, socket bind, process signal or cleanup mutation. Its receipt is `/tmp/html-inbox-qa-history-amcemjlx/cea-activation-observation-handoff-parent-verification.json`. The original failed command, helper and qualification remain unchanged.

## Remaining gates

Combined Node24 verification stopped after 250.376813 seconds with 1,051 units: 1,049 passed, one failed and one Windows-only skip. The queue-backoff child expected `pending` and received `aborted`. Typecheck/build passed; later verification groups and the required full Node20 command did not run. The failing ticket's deadline and stage were not retained. The [complete failed-run report](qa-ci-cea-attempt-lifetime-combined-attempt3.txt) is preserved.

Parent verified 65 immutable artifacts and all 406 frozen nonignored files. All 296 recorded run PIDs are absent. The original run left one synthetic fixture with 23 entries; parent subsequently removed precisely those entries after ownership and inode checks, without reading credential contents. The initial incomplete-cleanup receipt remains unchanged. No test was rerun.

The [subsequent bounded diagnosis](qa-ci-cea-queue-backoff-diagnosis.txt) demonstrates one sufficient mechanism. Holding a completed native final-snapshot read result caused the real 300ms pass timer to fire after normal attempt close. Returning `aborted` was correct. Baseline and matched control passed all original assertions; the historical cause remains unknown. Parent verified 403 artifact hashes and 42 known PIDs absent. A [new one-file observation gate](qa-ci-cea-queue-backoff-observation-contract.md) preserves the original 100/300/140ms limits and adds bounded ticket evidence. It does not establish a deterministic timing fix. Production cancellation remains unchanged.

The [observation author then stopped](qa-ci-cea-queue-backoff-observation-stopped.txt) on a natural instrumented Node24 expiry during close. Node20 containing passed 6/6; Node24 passed five with one failed strict assertion. That source version was not integrated. Parent verified 428 artifact hashes and 37 known PIDs absent. The subsequent [positive fixture budget gate](qa-ci-cea-queue-backoff-positive-budget-contract.md) permitted one fixed 1000ms enclosing worker pass for the retryable 100ms queue timeout. The separate 300ms whole-pass cancellation negatives and all assertions remained unchanged. At that stop, validation was incomplete; the gate itself supplied no green or deterministic scheduling claim.

The [positive-budget author](qa-ci-cea-queue-backoff-positive-budget-implementation.txt) subsequently passed both complete containing files 6/6 without external preloads. One actual-result hold of 110ms passed every original backoff, limit, reset and custody assertion with 641ms remaining at result selection. A separate 1100ms hold fired the real pass timer and failed the unchanged strict assertion with `aborted/local-acquisition-deadline` and zero requests. That negative remains native exit 1. Both engines typechecked and built identical output. All 100 original assertion-bearing lines, direct 100/300ms negatives, 100ms request, 140ms holder and other watchdogs remain unchanged. Parent verified 470 artifact hashes and 47 known PIDs absent, then integrated only the owned test. This bounded correction does not guarantee deterministic OS scheduling or establish the historical combined cause. The [new combined run passed](qa-ci-cea-current-verification.md) both required commands on this exact source.

Required combined checks and both new independent reviews are accepted. The sole nonblocking stale-summary suggestion was resolved with documentation changes only. Physical QA awaits one exact replacement head after hosted checks pass. Native corrected-head LAN/Tailscale and physical-device acceptance remain with independent QA. Close joins an admitted watcher, preserves generic public-abort classification, and does not certify namespace recovery, detached-pin completion or exclusion of future attempts.
