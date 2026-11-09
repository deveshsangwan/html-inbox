# First scheduler feasibility attempt: stopped

The single granted attempt stopped at its first unqualified case. Ten zero-record
cases passed; the Node 24 parent inbound case failed its pending-read shutdown
ownership assertion. Twenty-five cases remain unrun, including every 1,000- and
10,000-record case. This is incomplete feasibility evidence, with no performance
qualification or retention decision.

The clean candidate was `a7f87190129a353689ee8759756292164ec8ff87`, with application
source identical to tested `9fd509e4bc7be62b17bffa4eb3c47b6cb9f9d51f`. Actual parent
was `610c931b7b22920cce59cf03e49c0de15ebaf2a2`. Both exact Node 20.20.2/24.19.0
binaries, separate archived builds, output hashes and exact commands are retained
in [the compact receipt](95-feasibility-1-results.json). No source change, retry,
resume, count reduction or deadline extension occurred during the attempt.

All nine preliminary commands exited 0, including four enabled-worker reader-race
checks on separately built parent/candidate and both runtimes. All six Node 20
zero-record cases passed, as did Node 24 parent/candidate none and outbound.
Each successful case observed at least 65 actual idle seconds and two completed
periodic passes, plus its applicable wake/retry/clock/custody/repair/fencing/
pending-read shutdown controls. The new setup marker was observed within the
90-second limit in these cases; its timeout branch was not exercised.

The failed case was `24.19.0-0-inbound-0-parent`. It exited 1 after 128.628 seconds,
with setup observed at 0.786 seconds. Its idle observation lasted 65.006 seconds
and included two completed periodic passes. External custody completed in
30.689 seconds and independent lost-body repair in 30.301 seconds. Stale-route
fencing then passed. The subsequent real read hold emitted `read-held`, followed
by `stopping`, then `closed` before the held read had been released. The harness
failed at `scheduler-workload.cjs:324` because `lifetime.lock` was absent. The
runtime-record assertion and explicit read release were not reached.

This is observed behavior on the actual parent, not proof of a candidate
regression or of the held read's caller. The parent's `tick()` awaits a snapshot
outside `draining`; its `close()` joins `draining`. The fixture's existing hold
intercepts every snapshot, so a timer observation can plausibly be held while a
different pass completes. The trace does not tag that caller. This is a
source-supported diagnosis hypothesis requiring a separate bounded check; no
production or harness correction was made from it. The failed assertion remains
unchanged. The unrun Node 24 inbound candidate must not be inferred to pass from
other cases or the prior smoke.

The first-failure checkpoint stopped execution and `summary.json` explicitly
lists all 25 unrun cases. Earlier CPU/elapsed/RSS and reaction observations remain
raw evidence, including the failed case's completed idle interval. The five
successful zero-record pairs each have one observation per revision; they cannot
establish noise, practical benefit, high-count behavior or retention. No missing
count, direction or runtime was omitted from the required matrix.

The exact outer command/PID/group/start/deadline/exit were recorded. The runner
exited 1 after 987.395 of its 5,400-second budget; final outer cleanup took 0.289
of its separate 60-second allowance. All eleven workload cleanup events reported
joined children and no failures, and rebound 18 exact listener ports. Independent
final inspection found all 21 groups (20 preliminary/timed groups plus the outer
runner), all 32 sampled PID/start identities and the fixture root absent, with no
checkout heavy process. The local slot was explicitly released before packaging.

Neither global/case/setup timeout nor forced interruption was exercised. The
outer controller's source waits up to 50 seconds after deadline TERM before
starting another cleanup timer. Before reuse, it needs a single absolute
runner-plus-cleanup deadline so those allowances cannot accumulate. The actual
run stopped far before that path and stayed within its granted limits. This
receipt does not claim generic timeout/interruption qualification.

Raw outputs remain at
`artifacts/performance-issues-2026-11-07/issue95-feasibility-1/`. Outer records,
complete case cleanup events and the independent final scan are in
`issue95-feasibility-grant-2026-11-08/` beside it. Original failure, process traces,
checkpoint and unrun list are preserved. Any diagnosis, source correction or
continuation needs a new bounded request/grant. Full high-count feasibility,
five alternating pairs per mandatory cell, behavior/resource qualification,
public raw artifacts, full checks and fresh same-pin independent reviews remain
open; PR #121 stays draft.

Owner CI triage also retained the historical `9fd509e` Ubuntu Node 24 browser
failure: `sync-reader-browser.test.mjs:136` counted zero cards instead of three
immediately after Back to inbox. That script has no diff from the parent, and
the current `a7f8719` browser check was green when inspected. The evidence was
sent to root for shared CI coordination, with no base reproduction or cause
claim, local browser run, or unrelated source change.
