# Council review of PR #117

The user requested a council: one Anthropic and one OpenAI flagship reviewer, each at high effort. Both reviewers get the same brief and review the same exact revision, read-only, each in its own isolated worktree. Rounds repeat until both independently score at least 9.5/10 on the same revision. Scores are recorded as given, never averaged or rounded. Earlier stack-status and V1/V2 reviews in [reviews.md](reviews.md) do not count toward this council.

| Delegate | Exact settings | Round 1 | Round 2 |
| --- | --- | --- | --- |
| Claude Opus | provider `claudeAgent`, model `claude-opus-5-5`, `effort=high` | 9.0/10 | 9.2/10 |
| GPT Sol | provider `codex`, model `gpt-6.2-sol`, `reasoningEffort=high` | 8.3/10 | 8.4/10 |

## Round 1

Revision `8041962cf6fc90859c6b691752a1c5b70dc1827b`, base `08d5b2b056515ad876ac8aec2a164eea82050fa0`. Neither reviewer installed, built, ran tests or started services. Both recomputed all 60 summary groups from the 1,200 raw timed samples and found no mismatch. Both confirmed that the emitted ncc entry defers command code, and that the help text, parser fallback, private entry gates and moved handler bodies match the base. Neither found a production-code defect.

Before round 1, root rejected an intermediate teardown approach (`8feebd0`, ps-then-SIGKILL) for its PID-reuse race and for treating an unconfirmed identity as a successful shutdown. `5601566` replaced it before either reviewer started.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| `startup.py` sent SIGKILL to the process group after reaping the leader, so a reused group ID could be signalled | Sol, Medium | Fixed. The runner now waits with `waitid(WNOWAIT)`, kills the group, then reaps with `wait4`. The committed evidence was produced by the earlier runner, SHA256 `af079526…6795`. The README now copies that exact runner from `ac2b3b7` to reproduce it, and explains that the change does not affect what is timed. |
| On macOS outside CI, owner preflight returns `/private/var/...` while the smoke fixture uses `/var/...` | Sol, Medium | Fixed. The fixture root is canonicalized with `realpath` right after `mkdtemp`. |
| Installed hub mode on Windows cannot produce a graceful SIGTERM exit | Sol and Opus, Low | Fixed. Installed mode is rejected up front on `win32`, and the in-process mode stays available. |
| The installed hub child inherited `HTML_INBOX_*` and `NODE_*` settings from the developer shell | Opus, Low | Fixed. The child environment drops both prefixes before setting its isolated paths. |
| The hub close wait had no deadline after forced cleanup | Sol, Low | Fixed. The close wait has a 6 s deadline. Missing it reports the child as unjoined (`nativeClose: "unjoined"`, with its PID), and the fixture is retained. |
| Outer smoke cleanup could replace the primary failure; one worker postcondition failure suppressed the other | Sol, Low | Fixed. Cleanup failures are appended to the primary failure in an `AggregateError`, and the status and runtime-record checks run independently. |
| The README reproduced the candidate from the moving branch, and its tarball name no longer matches the head's version | Sol, Low | Fixed. The candidate is pinned to `8ae19fd`, and the tarball hashes are checked against `build-environment.json.gz` before timing. |
| The README and plan did not separate the measured artifact from production changes merged later from the parent stack | Sol and Opus, Low | Fixed. Both now say the timing belongs to `8ae19fd` on `610c931`, that `d812d25` brought in the parent stack's production changes, and that the integrated head was checked for correctness only, not re-timed. |
| The startup subsystem guard could not detect a deferred chunk load | Opus, Low | Fixed. The guard also rejects `*.index.js` requests. On a scratch copy of the retained `fad6` installed bundle, all five canonical forms passed the stricter guard, and the negative control `--help --json` failed on `./138.index.js`. |
| The parity test asserted inside the `try` whose `catch` builds the expected error | Opus, Nit | Fixed. The help/version assertion moved after the `try`. |
| The addendum called the success path "unchanged" | Opus, Nit | Fixed. It now says the assertions are unchanged and the postconditions run after the PID wait. |

### Not changed

| Finding | Reviewer, severity | Reason |
| --- | --- | --- |
| Port probe-then-bind race in installed hub mode | Sol and Opus, Low | Kept as a documented limitation. The CLI rejects `--port 0`, and the readiness line must equal the chosen origin, so a lost port fails visibly and never connects to a foreign listener. Adding retries would add fixture complexity for an optional mode. |
| A failed hub startup can be reported twice through `t.after` | Opus, Nit | Kept. The repeat is the same rejected close promise, so it is noise only. Clearing the handle would let fixture cleanup delete evidence that the failure path deliberately retains. |
| Double blank line in `index.ts`, and no blank line before `getCliVersion`'s `return` | Opus, Nit | Kept. The entry-graph sources stay byte-identical to the measured `8ae19fd`, so the shipped entry is the measured one. |
| `index.ts` no longer re-exports moved command helpers | Opus, informational | No change. The package is bin-only (`files: ["bundle"]`, no `main` or `exports`), and every in-repo importer was updated. |

### Hosted CI on the round 1 revision

Normal pull_request run 45197376919, attempt 1, at `8041962`: Source (ubuntu-latest, 20, 2/2) failed one test, "listening receiver admits new inbound route and rotates revision credentials without a manual worker restart", with `Managed ledger must have exactly one link`. Neither that test nor the ledger reader changed from base. The same signature is already recorded as a shared ledger observation with an unresolved cause (diagnostic owner #92). This record establishes no cause or exoneration. Root preserved run 45197376919 attempt 1, job 137771394033, and deferred any rerun on `8041962`; the next published head gets normal hosted CI. The exactly-one-link check stays strict, and its shared diagnosis stays separate.

### Still required

Installed package-smoke execution of the revised harness on Node 20 and 24 waits for a root-granted LOCAL slot, as does the hub browser installed mode. Light checks so far: `node --check` on both scripts, `py_compile` of the runner, a scratchpad check of the `waitid` ordering, and the scratch-copy guard check.

## Round 2

Revision `fee269ef752f9f0d1e475be009d3ee90e615c8d1`, base `08d5b2b`. Both reviewers again recomputed all 60 summary groups with zero mismatches. Both confirmed that the canonical entry graph is byte-identical to the measured `8ae19fd` and loads no chunk, and both verified every round 1 fix in the code. Neither found a production-code defect. Opus agreed with all four round 1 declines. Sol agreed that keeping the startup-failure handle beats losing the fixture.

### Installed qualification of the round 2 revision

Root grant `pr117-fee269e-installed-qualification-20261123` ran once at exact `fee269e` and passed in 42.2 s. All 13 steps exited 0 with no timeout, no group straggler and no leftover process referencing the run roots:

- typecheck, clean build and clean bundle with the private ncc 0.44.1; 8 emitted JS files
- startup parity test on Node 20.20.2 and 24.19.0
- one `npm pack --ignore-scripts` (264,161 bytes, SHA256 `a85ae4369af09c8f45e03104495cbaaab37330e03387f461dedbdcaa8178dcfd`, 8 bundle JS byte-equal to the build)
- package smoke on both runtimes as uid 1001, including the positive owner preflight, managed worker lifecycle and the stricter chunk guard
- hub browser on Node 24, 3/3 from source and 3/3 against a consumer installed from that tarball, with three native exit/close outcomes of 0/null

Pre-run generated outputs were restored by set, kind, mode, mtime_ns, size, sha256 and link target, not inode or ctime. The receipt is in the owner checkout's ignored `artifacts/93/fee269e-qualification-v1/receipt.json`, SHA256 `9c5e91c54fc03fb0e2caab36dc60c261d83f75d99326eac7ef954881618abca6`. Root matched the receipt, tarball hashes, exits and restoration record.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| Packing over an existing `bundle/` ships stale chunks. The 15 November tarball held 15 bundle files, 7 of them byte-identical leftovers from the measured candidate. | Sol, Medium | Confirmed by the clean `fee269e` build (8 files). `bundle` now clears `bundle/` before ncc, and `prepack` builds through `npm run bundle`, so packing and bundling share one portable path. The evidence README now carries a packaging correction. The historical receipt is unchanged, and its functional results stand because the entry requests only its own build's chunk IDs. |
| Installed CLI children inherit shell `HTML_INBOX_*` settings, such as a Tailscale configuration that could reach a real daemon | Sol, Medium | Fixed. Every package-smoke child, including the fallback viewer stop, gets the shell environment minus `HTML_INBOX_*` and `NODE_*`, plus the fixture's explicit settings. The Tailscale recording fixture no longer forwards the shell's `NODE_OPTIONS`. |
| The fallback `viewer stop` dropped the fixture port and swallowed every error | Sol, Medium | Fixed. Once a viewer may have started, the fallback stop uses the fixture environment. An unconfirmed stop is a cleanup failure, and the fixture is retained. |
| The executable reproduction recipe ran the historical runner with the reap-before-kill race | Sol, Medium | Fixed. The recipe copies the current runner. The original runner hash stays recorded as provenance, and the README explains that a reproduction records a different `runner_sha256`. |
| An unjoined hub child keeps the test process alive through its handles | Sol, Low | Fixed. The unjoined child is registered, then its pipes are destroyed and the child is unreferenced. A late close is logged with the retained fixture path, and a suite-level `after` hook fails while any child stays unjoined. |
| The evidence README still described the teardown gap as open, and the plan pointed to the dated receipt for current status | Opus, Low | Fixed. The README notes the later hardening, and the plan points to the PR body and this record for current status. |
| The first worker PID was checked only after the final disable, and a probe error lost its PID | Opus, Nit | Fixed. The success path asserts that the first worker exits right after `stop`, and probe errors name the PID. |
| `startFixtureHub` mixed validation, environment construction and teardown in compressed blocks | Opus, Nit | Partly fixed without behavior change. Installed-executable validation, the isolated child environment and child signalling are extracted; compressed `try` and `if` lines are expanded. The close and readiness logic stays inline, because splitting it further would mean restructuring tested teardown without a behavior benefit. |

### Still required

The round 3 revision changes package scripts and harnesses after the `fee269e` qualification. Running the real package script from a disposable checkout pre-seeded with an obsolete chunk, the startup test and package smoke on both runtimes, and the source and installed hub browser cases on Node 24 all need a new root grant. Light checks so far: `node --check` on every changed script. Hosted CI on `fee269e` was still running when the reviewers looked.
