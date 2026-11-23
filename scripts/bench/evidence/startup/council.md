# Council review of PR #117

The user requested a council: one Anthropic and one OpenAI flagship reviewer, each at high effort. Both reviewers get the same brief and review the same exact revision, read-only, each in its own isolated worktree. Rounds repeat until both independently score at least 9.5/10 on the same revision. Scores are recorded as given, never averaged or rounded. Earlier stack-status and V1/V2 reviews in [reviews.md](reviews.md) do not count toward this council.

| Delegate | Exact settings | Round 1 |
| --- | --- | --- |
| Claude Opus | provider `claudeAgent`, model `claude-opus-5-5`, `effort=high` | 9.0/10 |
| GPT Sol | provider `codex`, model `gpt-6.2-sol`, `reasoningEffort=high` | 8.3/10 |

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
