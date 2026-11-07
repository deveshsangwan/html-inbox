# Unsafe-ledger CI fixture race

The [macOS Node 20 source job at `2fda6c0`](https://github.com/deveshsangwan/html-inbox/actions/runs/42402966489/job/128494633405)
failed the foreground fatal-worker test: zero `unsafe-observed` messages instead
of exactly one. The preceding fatal exit, sanitized diagnostic and no-path-leak
assertions passed; child joining and exact-port cleanup completed. The shard
reported 452 passed, one failed, zero cancelled and one skipped.

The fixture removed `ledger.json` before creating its unsafe symlink. The new
metadata observation can encounter that missing-file window and correctly stop
before the observer ever sees a symlink. This is a source-supported explanation,
not a locally reproduced diagnosis of the macOS event. The later unchanged
`b19c769` source matrix passed, including that macOS shard, so this failure is
intermittent rather than an established persistent macOS failure.

All three CLI unsafe-ledger fixtures now prepare a sibling symlink and atomically
rename it over the ledger. The foreground test still requires exactly one unsafe
observation, zero subsequent ledger opens, exit 1, the unchanged sentinel and
joined children/listeners within the original timing bounds. No production code
or timeout changes accompany this correction. The existing focused fatal suite
will verify this test-only pin during the granted correctness run; native macOS
confirmation remains an Actions gate.

The original sanitized log is retained as
`issue95-focused-1/ci-2fda6c0-128494633405.log` under the orchestration artifacts.
Its SHA-256 is
`f45088414ec24fd01e11ea9595392e29535e279d959b240344f616146197a875`.
