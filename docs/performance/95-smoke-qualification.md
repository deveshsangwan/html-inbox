# Bounded zero-record scheduler smoke

The final smoke run passed all twelve cells at candidate
`c00f61453823a3e15c6132fbd3cdbcb1d6e8a092` against the actual parent
`610c931b7b22920cce59cf03e49c0de15ebaf2a2`. This qualifies the harness's zero-record
behavior only. It establishes no high-count benefit, performance retention,
full-check, review, or integration approval.

All production TypeScript remained byte-equivalent to `fddde69` throughout this
grant. The newer test/harness pins are distinct from that production pin. The
explicit-wake reader-race test now has actual execution evidence on separately
archived parent/candidate builds and exact Node 20.20.2/24.19.0, all four checks
exiting 0 with their race-hit/identity/shutdown assertions intact.

The root-required preliminary-command cleanup correction was pinned at
`6e8a47d`. Builds, archive exports, filesystem probes and reader checks use owned
process groups, recorded PIDs/commands/exits/timeouts and finally-based group
joining before fixture removal. Combined command and cleanup failures retain
both causes. Five cleanup tests passed in 8.31 seconds under a 45-second outer
bound, exercising real descendants/ports, timeout, interruption and combined
failure. The outer collector found no surviving owned PIDs.

Attempt 1 is retained at `issue95-harness-smoke-1`. The parent's original `tick()`
did not join startup bookkeeping. The trace labeled initial settlement with zero
completed passes and included the first completion in the idle window. That
attempt was explicitly invalidated and stopped. Its original rows, including the
optimistic first-cell flag, remain alongside the invalidation audit. A completed
initial-pass barrier fixed the measurement boundary at `288205e`.

Attempt 2 is retained at `issue95-harness-smoke-2`. The parent outbound case
observed receiver state before sender ACK and pass completion, then correctly
failed the repair empty-outbox precondition. It was stopped for correction. The
final custody gate requires a matching current-incarnation receipt, exact live
bytes, the outbound sender's confirmed obligation, and completion of the latest
admitted pass before repair. This harness correction was pinned at `c00f614`.
No production code, test assertion, repair interval, request/pass/lease limit or
observation bound was relaxed.

The grant budget retained 123 seconds for attempt 1 and 337 seconds for attempt 2,
including conservative reserves. Attempt 3 received the remaining 1,340 seconds,
so the total runner budget stayed 1,800 seconds. The successful case elapsed
times sum to 989.18 seconds, plus 3.85 seconds for nine preliminary commands.
All twelve case exits and all nine preliminary exits were 0. Each runtime has
six passing cells: no routes, outbound and independent pull, each on actual
parent and candidate. Every idle interval lasted at least 65 actual seconds and
included two completed periodic passes.

All cases passed applicable wake/clock/retry, real external custody, independent
empty-outbox repair, stale-route and pending-read shutdown controls. Final cleanup
accounts for all 21 owned preliminary/timed groups, zero surviving processes,
removed fixture root and exact-port reuse. Both stopped attempts also have clean
group/fixture receipts. Root independently inspected the successful receipts and
all 21 groups before accepting the slot release.

[The compact receipt](95-smoke-results.json) records pins, commands, exits,
fingerprints and failure dispositions. Raw artifacts remain under the
orchestrator's `artifacts/performance-issues-2026-11-07/` directory in the three
named attempt directories and `issue95-smoke-grant-2026-11-08/`. They are retained
for audit, not a substitute for the durable public raw-artifact reference required
for future performance qualification. Local heavy work stopped and the slot was
explicitly released before this documentation and further source-only work.

The subsequently identified paused-startup path is outside this smoke receipt.
It was reproduced and corrected in the separately granted
[startup diagnosis](95-startup-correctness.md). That correction creates a new
scheduler candidate. This smoke remains historical harness evidence and does not
qualify the corrected scheduler's performance.
