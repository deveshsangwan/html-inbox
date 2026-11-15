# Issue 88 prerequisite validation

Base: `099dcbd6378e3b6f73216966cfe9ea7f91ed5d8e`. Initial branch `perf/88-runtime` was clean. Candidate is the commit containing this report; no production CLI version, runtime, storage or wire change is included.

Environment: Linux, Node v24.19.0, pnpm 11.7.0. This is a policy prerequisite, with no latency/CPU/memory improvement claim. It enables the separately measured compatibility and modern work in #87. No benchmark or full package/runtime matrix ran; #89 owns the first measurement slot.

Commands and results:

| Command | Exit | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 | Frozen dependencies installed; no lockfile change |
| `node --test scripts/release-policy.test.mjs` | 0 | First candidate: 3 passed; final candidate: 4 passed, including latest rollback protection |
| `node --test scripts/skill-cli-resolution.test.mjs scripts/skill-cli-windows.test.mjs` | 0 | 148 total, 146 passed, 2 skipped on Linux |
| `node scripts/verify-site.mjs` | 0 | 15 pages passed |
| `node --test scripts/site-theme.test.mjs` | 0 | 9 passed |
| `node --check scripts/package-smoke.mjs` | 0 | Syntax only; package execution deferred |
| `git diff --check` | 0 | No whitespace errors |

Initial website integrity/theme attempts failed to load `parse5` because this fresh worktree had no dependencies. Both passed after the frozen install. This was a setup failure, not an application failure.

Remaining validation: source/package/browser suites on actual 0.7 candidates, modern driver/minimum qualification, unsupported-runtime pre-storage rejection, Node 24.19.0/26 exact archive tests, format-aware skill routing and migration safety tests. See [release policy](../release-policy.md). The new archive engine assertion has only a syntax check locally and needs package CI. CI results and independent review dispositions belong in the PR receipt.

## Completed prerequisite and remaining gates

This prerequisite supplies branch/tag publication guards, lightweight policy tests, verification on `release/0.7` pushes, and consistent staged guidance. Source tests still cover Node 20/24; the workspace build runtime remains separate from the package engine. It does not certify package behavior or speed on a new runtime.

Before #88 can close:

- Qualify 0.7.x packages on Node 20 and a modern runtime, preserving existing behavior.
- Select the modern driver and qualify the actual Node >=24.19.0 minimum. Raising that minimum later requires a deliberate release-policy change, never a silent patch.
- Build a modern candidate with an entry point that rejects unsupported runtimes before imports or initialization can touch storage. An `engines` declaration alone is insufficient.
- Test the exact modern archive at the minimum and Node 26, including unsupported-runtime rejection with an untouched library. Add the modern CI matrix and publish artifact gates together with activation.
- Implement runtime/format resolution and adversarial tests in both skills, including incompatible installed CLIs, modern stores, fallback refusal and shutdown/backup handling. Promote only published, independently tested fallback pins.
- Update package engines, CI, package smoke checks, READMEs, website and both skills together at activation. Perform releases and tag changes only after explicit release authorization.

Heavy runtime/package matrices and benchmarks require a slot from the #87 orchestrator. #89 owns the first slot. This prerequisite uses source inspection and lightweight policy/skill/site checks only.


## First review findings and disposition

Pinned revision: `157722a9649eb409852c4ed14936c983ff70afc9`. Codex gpt-6.1-sol High passed functionality, quality and prerequisite evidence, with one suggestion. Claude Code claude-sonnet-5-5 Medium passed functionality/evidence and requested quality changes. The quality reviewer skipped the execution contract; the second fresh review must read it in full.

- Accepted functionality suggestion: reject moving npm latest backward; regression tests cover minor and numeric patch ordering.
- Accepted quality findings 1 and 2: use a footer policy link inside the existing shell; move temporary tracking and gates here from durable policy.
- Accepted quality finding 3: share the version pattern, parse once, separate diagnostic guards and explain continued 0.6 patch support while 0.7 is unpublished. Re-publishing an existing version remains npm's own rejection.
- Quality finding 4: retain explicit tag selection as required by the orchestrator; document the deliberate double check in code.
- Accepted quality finding 5: explain the exact engine string in the diagnostic.
- Quality suggestion 6: reduce the website notice to a policy link; retain short runtime notices in READMEs and safety guidance in both self-contained skill copies because coordinated activation is required.
- Quality suggestion 7: retain the existing direct-node CI test pattern because pnpm 11 requires the build runtime and these steps execute on Node 20 as well. No unrelated CI refactor.

Second candidate validation: `node --test scripts/release-policy.test.mjs` passed 4 tests; site integrity and 9 theme tests passed; `git diff --check` passed. No production runtime or package change was added by review fixes. Both fresh final review verdicts will be recorded in the PR.


## Final independent reviews

Both fresh reviewers inspected base `099dcbd6378e3b6f73216966cfe9ea7f91ed5d8e` through `8b9fbb4d1267a2157057966f29fa2ee52fd20494` and confirmed reading the entire execution contract. Codex gpt-6.1-sol High and Claude Code claude-sonnet-5-5 Medium each passed functionality, code quality and prerequisite performance evidence. No material findings remain.

Final dispositions:

- Accepted quality Low 1–3: rejection tables now match expected diagnostic messages, use one row per line and single blank lines; the validation table labels first versus final policy-test counts. These are test/reporting polish only, with no production change after the reviewed revision.
- Quality suggestion 4: retain existing diagnostic order; a 0.6 release after modern latest is rejected either way. Guard-specific tests now make the rejection clear.
- Quality suggestion 5: keep draft pending package CI. Source/package/browser/runtime matrix execution has not run locally.
- Quality suggestion 6: retain intentional self-contained skill copies and coordinated activation documentation.
- Functionality suggestion: maintenance-tag rollback protection remains an explicit activation gate. Before enabling modern publication, read the current `node20` tag as well as `latest` and reject a lower maintenance version, including numeric patch ordering regression tests. The current prerequisite only guards `latest`; no modern release is enabled here.

Final lightweight rerun: 4 policy tests passed and `git diff --check` passed. GitHub Verify was in progress when inspected on the reviewed revision; that is not a package-pass claim. The PR remains draft until required CI finishes successfully.
