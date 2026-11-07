# Issue 88 prerequisite validation

Base: `099dcbd6378e3b6f73216966cfe9ea7f91ed5d8e`. Initial branch `perf/88-runtime` was clean. Candidate is the commit containing this report; no production CLI version, runtime, storage or wire change is included.

Environment: Linux, Node v24.19.0, pnpm 11.7.0. This is a policy prerequisite, with no latency/CPU/memory improvement claim. It enables the separately measured compatibility and modern work in #87. No benchmark or full package/runtime matrix ran; #89 owns the first measurement slot.

Commands and results:

| Command | Exit | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 | Frozen dependencies installed; no lockfile change |
| `node --test scripts/release-policy.test.mjs` | 0 | 3 passed; branch, engine, version, premature tag and modern activation rejection |
| `node --test scripts/skill-cli-resolution.test.mjs scripts/skill-cli-windows.test.mjs` | 0 | 148 total, 146 passed, 2 skipped on Linux |
| `node scripts/verify-site.mjs` | 0 | 15 pages passed |
| `node --test scripts/site-theme.test.mjs` | 0 | 9 passed |
| `node --check scripts/package-smoke.mjs` | 0 | Syntax only; package execution deferred |
| `git diff --check` | 0 | No whitespace errors |

Initial website integrity/theme attempts failed to load `parse5` because this fresh worktree had no dependencies. Both passed after the frozen install. This was a setup failure, not an application failure.

Remaining validation: source/package/browser suites on actual 0.7 candidates, modern driver/minimum qualification, unsupported-runtime pre-storage rejection, Node 24.19.0/26 exact archive tests, format-aware skill routing and migration safety tests. See [release policy](../release-policy.md). The new archive engine assertion has only a syntax check locally and needs package CI. CI results and independent review dispositions belong in the PR receipt.
