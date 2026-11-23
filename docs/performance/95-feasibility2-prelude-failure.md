# Feasibility controller admission failure

The granted attempt stopped before starting any classifier test, cleanup test,
build or workload. Five pin/runtime commands exited 0. The controller then
rejected the classifier command at its strict manifest guard, before creating
that command's fixture or process. No classifier, worker or resource result can
be inferred from this attempt.

Grant `root-95-feasibility-a2d9545-20261108-r1` ran once at clean source
`a2d954517455cd0b891b45298726857ffcf813b1`, using exact controller
`ea1421fa3e0bc0cb05994017bc77ba774825a04cd56bb610505d577945f611bc` and manifest
`4b56b9caaa0c3e4da0df477372b749332e2fc9d543b5e5a6eda9a03ef7e4e682`.
The controller exited 1 after 1.191 seconds. Its one fixed application deadline
and start-plus-5,460 final deadline were not extended or reached.

The test loop supplied the manifest's literal
`{repo}/scripts/bench/test_scheduler_cleanup.py` argument. `run` compared it
against the expanded absolute path and recorded the first unexpected result as
`command-manifest: classifier-tests`. Only argument 1 differed. The same raw-call
pattern exists for the unrun cleanup command; no cleanup-test failure was
observed. The guard worked and was not weakened.

Both owner and root static review missed this dispatch callsite. The earlier
source/hash/AST review established no controller, classifier or application
execution. The runtime admission failure is preserved separately from those
source checks. It is an operational-controller defect, not a classifier red,
worker regression or high-count feasibility result.

All seventeen classifier methods, five cleanup methods, nine runner preliminary
commands and 36 fresh workload cases remain unrun. The runner output directory
was never created. [The compact receipt](95-feasibility2-prelude-failure.json)
lists every fresh unrun case, exact started argv/exit, observed process identity,
failure vectors, clock bounds and output digest. The original untagged failure
and its separate 25 historical unrun cells remain unchanged.

Independent post-exit inspection found all six recorded PID/start identities and
six process groups absent. Scratch and all five command fixture paths were
absent. No application, TLS/control listener or fixture port started, so no port
was invented or rebound. No signal, forced reaping, timeout or interruption path
ran. LOCAL was explicitly released before packaging, and root independently
accepted the release. This does not qualify unused cleanup paths.

Original operational sources/manifests, launch/preflight data, all five command
outputs, first-failure receipt and cleanup audit remain under
`artifacts/performance-issues-2026-11-07/issue95-feasibility2-grant-1/` in the root
workspace, with a complete file hash index. Root subsequently prepared a separate
dispatch-only controller correction, SHA256
`66f43e6bb44b668a3088ba1304383d1318dfd3336010af475bbab6343d851c4e`.
It expands both test-loop command vectors before calling the unchanged guard.
Root's source review is not execution credit; neither controller has classifier
or application execution credit. A new versioned manifest at a clean docs pin
and another explicit grant are required before a corrected attempt.

No retry, resume, source fix, bound extension, new diagnostic or review ran under
this grant. Windows viewer-record EPERM and its aggregate Verify failure remain
a separate unresolved CI blocker. No browser or waiter/assertion/deadline change
is included. PR #121 remains draft, with resource benefit, mandatory high counts,
full behavior/checks, public raw artifacts and independent reviews still open.
