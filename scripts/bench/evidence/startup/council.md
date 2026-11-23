# Council review of PR #117

The user requested a council: one Anthropic and one OpenAI flagship reviewer, each at high effort. Both reviewers get the same brief and review the same exact revision, read-only, each in its own isolated worktree. Rounds repeat until both independently score at least 9.5/10 on the same revision. Scores are recorded as given, never averaged or rounded. Earlier stack-status and V1/V2 reviews in [reviews.md](reviews.md) do not count toward this council.

| Delegate | Exact settings | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 | Round 6 | Round 7 | Round 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Opus | provider `claudeAgent`, model `claude-opus-5-5`, `effort=high` | 9.0/10 | 9.2/10 | 9.3/10 | no score | 9.4/10 | 9.5/10 | 9.5/10 | 9.2/10 |
| GPT Sol | provider `codex`, model `gpt-6.2-sol`, `reasoningEffort=high` | 8.3/10 | 8.4/10 | 8.8/10 | 8.7/10 | 8.7/10 | 8.7/10 | 8.9/10 | 8.9/10 |

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

### Pending after round 2

The round 3 revision changes package scripts and harnesses after the `fee269e` qualification. Running the real package script from a disposable checkout pre-seeded with an obsolete chunk, the startup test and package smoke on both runtimes, and the source and installed hub browser cases on Node 24 all need a new root grant. Light checks so far: `node --check` on every changed script. Hosted CI on `fee269e` was still running when the reviewers looked.

## Round 3

Revision `6f12a372f8c6db31ee8d648953e45524a7717ea5`, base `08d5b2b`. Both reviewers again recomputed all 60 summary groups with zero mismatches and found no production-code defect. Both read the emitted `fee269e` installed bundle: canonical help/version return before any chunk load, and every command, parser, preflight and deletion-worker module sits behind a chunk request. Opus confirmed that hosted package smoke at `6f12a37` passed on Ubuntu Node 20, Ubuntu Node 24 and Windows Node 24, through the real `npm pack` → `prepack` → clean bundle path.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| The fallback viewer stop accepted exit 0 even when the state was `conflict` or `incompatible`, both of which leave the viewer unsignalled | Sol, Medium | Fixed. The fallback parses the JSON and requires `stopped`. Any other state is a cleanup failure, and the fixture is retained. |
| `Promise.all` over the three concurrent viewer starts let cleanup run while a sibling start was still in progress | Sol, Medium | Fixed. The starts stay concurrent, but every one is joined with `Promise.allSettled` before failures are reported and cleanup runs. |
| After a failed disable or PID probe, both worker postconditions were skipped | Sol, Low | Fixed. The runtime-record check always runs; the status check runs whenever enrollment succeeded. |
| A hub readiness failure followed by a clean close deleted the fixture | Sol, Low | Fixed. The handle records the startup failure, and `closeHubFixture` keeps the root and reports where. |
| The teardown addendum still said installed qualification was pending | Sol, Nit | Fixed. It points to the passed `fee269e` run and to this record for later heads. |
| No automatic check catches stale chunks in a tarball packed with `--ignore-scripts` | Opus, Low | Fixed. Package smoke now asserts that the installed bundle's chunk files equal the chunk IDs its code requests (`__nccwpck_require__.e(N)`). Against the retained bundles (read-only), the check passes the clean `fee269e` bundle, the single-file base and the measured candidate. It fails the 15 November bundle, naming exactly its 7 stale chunks. |
| The shared Tailscale recording fixture's `NODE_OPTIONS` change also affects `skill-cli-package-smoke.mjs`, and no record mentioned it | Opus, Low | Documented and kept. The fixture no longer forwards the caller's `NODE_OPTIONS`, so the Tailscale phase of both package smoke and the skill CLI smoke runs with only the fixture's preload. Package smoke is fully isolated. The skill smoke's other phases still inherit the shell's `NODE_OPTIONS`. CI sets no `NODE_*`, so CI behavior is unchanged. |
| "Production entry graph byte-identical" could be read as covering `cli-commands.ts`'s transitive imports | Opus, Nit | Fixed in the PR body, and refined in round 4: the six entry-related sources are byte-identical to `8ae19fd`. Canonical help/version load only `index.ts`, `cli-usage.ts`, `cli-entrypoints.ts` and `validation.ts`. Modules that `cli-commands.ts` imports changed through the `d812d25` merge. |

### Failure-path coverage

The hub fixture's failure paths can be driven with fake installed bundles, without production test hooks. The next qualification adds two expected-failure probes. In one, the fake bundle announces the wrong URL and then exits cleanly; the probe expects a reported startup failure and a retained fixture. In the other, the fake bundle announces the right origin but leaves a grandchild holding its pipes; the probe expects the "unjoined" report, the suite-level failure and a retained fixture. Package smoke's unconfirmed-stop, failed-concurrent-start and failed-disable paths cannot be triggered without production test hooks, so they rest on code review by both reviewers.

### Still required

The round 4 revision needs a root-granted qualification. It runs the real scripts-enabled `npm pack` and `npm run bundle` against a seeded obsolete chunk in a disposable project. The preserved tarball then feeds both Node smokes and the installed hub suite, plus the source-mode checks and the hub failure probes. Light checks so far: `node --check`, and the read-only stale-chunk check on retained bundles.

## Round 4

Revision `5d4f93fe22fb017b3f8bea542989f1a9cb342780`, base `08d5b2b`. Sol completed a full review and found no production-code defect. The Claude Opus delegate failed before returning a review because it hit a Claude API usage limit ("You've hit your 5-hour limit"). Round 4 therefore records **no score** for Opus. That is a delegate failure, not a pass. The next round reruns the same Opus settings on the next revision.

### Hosted Windows observation

Normal pull_request run 45203396820, attempt 1, job 137792582613: Source (windows-latest, 24, 1/1) on image `windows-2025-vs2026` 20261111.635 with Node 24.22.3. Two tests failed: "independent public deleters coordinate real child processes" (`EPERM` renaming a document into `.trash`) and "catalog replacement retries stop after a bounded number of changing files" (a continuously changing record was accepted). `Verify` (job 137800112888) failed only as the aggregate.

Neither test file changed, but the concurrent-deleter test forks `index.js` through `document-deletion.ts`, so it does exercise this PR's lazy IPC entry, which now loads the deletion worker through a dynamic import. Matched evidence comes from earlier revisions of this PR in the same workflow, not from the base: on the same image version and Node patch, the byte-identical `packages/` and `.github` at `6f12a37` passed both tests (job 137786605286). So did `fee269e` and `8041962` (jobs 137779572432 and 137771393768), whose differences are limited to `packages/cli/package.json` scripts and `cli-startup.test.ts`. `41727d5` and `f290211` passed on image 20261103.629 with Node 24.22.2. Logs and job metadata are preserved in the owner checkout's ignored `artifacts/93/ci/5d4f93f-windows-source-45203396820-137792582613/` (`summary.json` SHA256 `06decb5e69d50e52a3fb7ca34def0501f43f673a6b1e35ac02c2b1deff3e7fcd`). This establishes no cause and claims no exoneration. Root holds any retry and routes both Windows observations separately.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| Windows concurrent deletion and catalog replacement failed on the reviewed head | Sol, Medium | Not a code change. Matched evidence from earlier PR revisions on the same image and Node patch is recorded above. The base itself last passed on image 20261103.629 with Node 24.22.2. The lazy worker import is present and unchanged in every passing PR run. A head-specific timing effect of that import on the deleter race is not ruled out. Root holds the retry decision. |
| The foreground viewer close waited for `close` without a deadline, and a startup cleanup rejection could replace the readiness error | Sol, Medium | Fixed. The close wait has a 6 s deadline after SIGTERM, with SIGKILL at 3 s. An unjoined viewer is reported, its handles are released, and the fixture is retained. A startup failure and its cleanup failure are aggregated, and an outer close failure also retains the fixture. |
| A late `close` after the fixture destroyed its own pipe ends removed the hub's unjoined record | Sol, Low | Fixed. Every missed close deadline stays registered through suite teardown. A later close is only recorded as `lateCloseAfterLocalPipeDestroy`, and the suite-level hook fails while any record exists. |
| The stale-chunk check accepted unreachable chunks that reference themselves or each other | Sol, Low | Fixed. Shipped JavaScript must equal the set reachable from `index.js` through chunk requests. Checked read-only: the clean `fee269e` bundle, the single-file base and the measured candidate pass. The 15 November bundle fails, and so does a synthetic copy with a self-referencing stale chunk and a mutually referencing pair. The README now says that the clean-repack guarantee needs lifecycle scripts, and that package smoke catches `--ignore-scripts` packs. |
| "Canonical help/version load set" named `cli-args.ts` and `cli-commands.ts`, which canonical startup does not load | Sol, Nit | Fixed. The PR body calls them entry-related sources and lists the four modules canonical startup loads. |
| The wrong-URL probe should exit 0 only after SIGTERM | Sol, Nit | Already so: the fake waits for SIGTERM and then exits 0. |

### Pending after round 4

The round 5 revision needs the queued root-granted qualification, with the runner revised to expect the new suite-level message. It also needs a full Opus review and a fresh Sol review on the same revision.

## Round 5

Revision `4e3e6490f15cea1395d32857ce4a743a21143bed`, base `08d5b2b`. Both reviewers completed full reviews and found no production-code defect. Both recomputed all 60 summary groups with zero mismatches. Opus agreed with every earlier decline.

### Hosted CI on the round 5 revision

Normal pull_request run 45223882351, attempt 1, at `4e3e649`: all 16 Actions jobs succeeded, including Verify (job 137870057709) and Source (windows-latest, 24, 1/1) (job 137865076200, which passed the two tests that failed at `5d4f93f`). Package smoke ran through the real `npm pack` → `prepack` → `npm run bundle` path. It passed on Ubuntu Node 20 (job 137865076258), Ubuntu Node 24 (job 137865075893) and macOS Node 20 (job 137865075833), each printing the Tailscale, owner-preflight/managed-worker and foreground/detached lines. On Windows Node 24 (job 137865076200) it printed the foreground/detached line, and the POSIX-only blocks were skipped. Those runs covered the reachability check, the bounded foreground close and the strict fallback stop on their success paths. The default hub browser cases passed on every Browser job.

So this PR's Windows Source job has failed only at `5d4f93f`. That remains an observation with no established cause.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| Default `npm pack` lifecycle scripts can get `NODE_OPTIONS` back from npm's `node-options` configuration | Sol, Medium | Fixed. Every package-smoke child drops an inherited `npm_config_node_options` and gets an empty one, so npm injects no preload. |
| `run()` waits for `close` without a deadline after the command exits, so a descendant holding a pipe can block cleanup | Sol, Medium | Fixed. A command gets 5 s after `exit` to close. Otherwise it is reported as unjoined, its pipes are released and the fixture is retained. |
| A worker started by a command that then failed may be recorded only in `runtime.json`, which shutdown removes | Sol, Low | Fixed. A valid PID from `runtime.json` is captured before `disable` and probed with the others. Recorded PIDs are still never signalled. |
| The Windows record said the failing tests exercise no changed code and called earlier PR revisions base/head evidence | Sol, Low | Fixed. The concurrent-deleter test forks `index.js` and so exercises the lazy IPC entry. The matched runs are earlier PR revisions, and a head-specific timing effect is not ruled out. |
| The status record still said the changes after `fee269e` had not been executed | Opus, Low | Fixed. The run above is recorded, and the remaining gaps are stated below. |
| The foreground viewer `close()` was not memoized, so a second call waited another 6 s and duplicated the error | Opus, Low | Fixed. `close()` is memoized like the hub fixture's, and the final aggregate removes duplicate error objects. |
| Fixture retention was set by plain assignment in one place | Opus, Nit | Fixed with `||=`; retention only moves one way. |
| The owner-preflight success line printed when preflight was skipped under root | Opus, Nit | Fixed. A separate line says preflight was skipped under root. |
| The plan said later commits change only tests, scripts and evidence | Opus, Nit | Fixed. It now names the package build-script change and says it changes how the tarball is assembled, not its source. |
| No automated test covers the runner's kill-before-reap order, and package smoke's failure paths are review-only | Opus, Low | Acknowledged as the main residual risk. The order was checked in a scratchpad and by both reviewers. Package smoke's failure paths would need production test hooks. |

### Pending after round 5

The installed hub mode happy path ran at `fad6cd5` and `fee269e` (3/3 each, native exit and close 0/null). Outstanding is qualification of the successor head: both negative hub probes (a startup failure that closes cleanly, and an unjoined child), and both seeded-obsolete-chunk controls through the real package scripts (a scripts-enabled `npm pack` and a direct `npm run bundle`). These are queued for the root grant. Package smoke's own failure paths stay review-only.

## Round 6

Revision `79ed1589856243ddafb8230ca3c7d97abccdb5a7`, base `08d5b2b`. Both reviewers completed full reviews and found no production-code defect. Opus scored 9.5 and Sol 8.7, so the council is not yet satisfied on one revision. From this round on, the brief asks reviewers to label findings in pre-existing package-smoke code. Sol labelled finding 3 as pre-existing.

### Hosted CI on the round 6 revision

Normal pull_request run 45226185322, attempt 1, at `79ed158`: all 16 Actions jobs succeeded, including Verify (job 137878688478) and Source (windows-latest, 24, 1/1) (job 137873188926). Windows Source has now passed at `4e3e649` and `79ed158` after the single failure at `5d4f93f`. That failure was an `EPERM` rename and not a worker deadline, which a lost IPC message would produce. No cause is claimed. The source suites fork the tsc `dist/index.js`, where `module: node16` keeps a native asynchronous ESM `import()` of the deletion worker. The shipped ncc bundle instead loads that worker through a synchronous `require` inside a promise. So any timing effect seen in the dist-based Windows test does not carry over directly to the shipped artifact.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| npm ignores an empty `npm_config_node_options`, so a `node-options` line in `~/.npmrc` still reached lifecycle scripts | Sol, Medium | Fixed. Package-smoke children get separate, empty, fixture-owned `npm_config_userconfig` and `npm_config_globalconfig` files; inherited values of those and of `npm_config_node_options` are dropped. Checked on npm 10.8.2 and 11.17.0 with `npm config get`: a `~/.npmrc` sentinel `node-options` and `ignore-scripts=true` resolve to `null` and `false`. The round 5 empty override did not work, as Sol found. |
| An interrupt between spawn and the cleanup block could skip the benchmark runner's `killpg`/`wait4` | Sol, Medium | Fixed. The runner defers SIGINT and SIGTERM from spawn until reap, then re-raises the first one. In a scratchpad check of the extracted sample block, SIGTERM during a sample ended the process only after the sample's background process was killed and reaped. The exit code 143 recorded at the time came from that extracted copy; round 8 corrects it for the committed runner. The child keeps default dispositions, because exec resets caught signals. |
| The smoke's own `npm pack` inherits an `ignore-scripts` setting and can skip `prepack` | Sol, Low (pre-existing) | Fixed. The pack passes `--ignore-scripts=false`, which overrides an inherited `ignore-scripts=true`. The consumer install still disables scripts. |
| The stale-chunk check ignored JavaScript in `bundle/` subdirectories | Sol, Low | Fixed. It lists `bundle/` recursively. On Node 20 and 24 it fails a nested `old/obsolete.js` and the mutually referencing pair, and passes the clean bundles. |
| The teardown addendum said the success-path assertions are unchanged | Opus, Low | Fixed. It now says the success path keeps its earlier assertions and adds the first worker's exit check. |
| A zombie worker under a non-reaping init counts as still running | Opus, Low (speculative) | Fixed. On Linux, a `Z` state in `/proc/<pid>/stat` counts as exited; it was checked against a real zombie. Elsewhere, the reaping-init assumption stays. |
| `reviews.md` cites the old runner's line and `child.wait()` without saying so | Opus, Nit | Fixed with "(at `ac2b3b7`)". |
| Default in-process hub teardown now closes browser and hub concurrently and retains the root on a failed close | Opus, Nit | Recorded here. Startup in default mode is still exactly `startHub(configuration, 0)`; the teardown change fixes the base's hub leak when `browser.close` throws. |
| The stale-chunk check covers only JavaScript | Opus, Nit | Documented in the code and README: ncc emits no other assets for this package. |

### Pending after round 6

Same as after round 5: the queued root-granted qualification of the successor head, covering both negative hub probes and both seeded-obsolete-chunk package-script controls. Package smoke's own failure paths stay review-only.

## Round 7

Revision `f32c0cf18627421b073f6d679f98394562182b5a`, base `08d5b2b`. Both reviewers completed full reviews and found no production-code defect. Opus scored 9.5 and Sol 8.9.

### Hosted CI on the round 7 revision

Normal pull_request run 45227991728, attempt 1, at `f32c0cf`: all 16 Actions jobs succeeded, including Verify (job 137883805121) and Source (windows-latest, 24, 1/1) (job 137879574767). That makes three consecutive green heads since the single Windows failure at `5d4f93f`.

### Installed qualification of the round 7 revision: FAILED

Root grant `pr117-f32c0cf-installed-controls-20261123` ran once at exact `f32c0cf`, with runner SHA256 `8f04fdfce8a3c5b9240e46fe49a328dd5cb532c955b804554ec8421849e7f111`. It finished in 51.3 s of application time and 0.22 s of cleanup, and exited 1. The receipt is in the owner checkout's ignored `artifacts/93/f32c0cf-qualification-v1/receipt.json`, SHA256 `26d8b94f37f2e4f5cfd1c73d2f2d8d7a8aa52449ec85f17e9b4c69ed6670b79a`. The first failure is preserved, and nothing was rerun.

Passed:

- In a disposable project with no shared `.bin` ancestor and a seeded `999.index.js`, the real scripts-enabled `npm pack` ran the private shims [tsc-rs, ncc]. The seeded chunk was absent from both `bundle/` and the tarball, the tarball bundle matched ncc's emitted inventory, and the file set was exact. The tarball is 264,214 bytes, SHA256 `6507360d48ff1440c4a3df06da16e97415c2f873a41b0c30bf8034b02d470541`.
- After re-seeding, the real `npm run bundle` ran [tsc-rs, ncc, ncc], removed the seeded chunk and emitted the same inventory.
- Shared typecheck and clean build passed, and the shared and packed `dist` were identical.
- The startup parity test passed on Node 20.20.2 and 24.19.0.
- Package smoke of the exact tarball passed on both runtimes, including owner preflight and the managed worker.
- On Node 24, the source-mode hub browser passed 3/3, and installed mode passed 3/3 from a consumer whose bundle equals the tarball's.
- The `wrong-url` probe exited 1, reported both expected diagnostics, retained one fixture and left no strays.
- Cleanup was quiescent. The verified backup and preserved candidate allowed restoration, so the shared `dist` matches its pre-run state, the shared bundle was untouched, the tracked tree stayed clean and no process was left over.

Failed: the check `probe-hub-unjoined-reported`. The `unjoined` probe itself met its requirements:

- native exit 1, with no timeout or signal
- exactly one retained fixture
- the marked grandchild identified, reparented to the scoped subreaper, and reaped by the runner with exit -9
- the per-test diagnostic `nativeClose:"unjoined"`
- the suite-level "Installed hub children missed their close deadline", naming the retained root

The log did not contain "is unjoined: no close within 6 s" or "evidence retained at". Node 24's spec reporter printed only the test body's first error (`page.goto` `ERR_CONNECTION_REFUSED`), not the per-test `t.after` AggregateError that carries both strings, although the diagnostic shows that the hook ran. So the runner's expectation of what the reporter prints was wrong; the fixture behavior was not. The revision committed with this record, SHA256 `570e7e55c66da06cfca081c65d50ed1170d607615a0de072c304cac354fc8af8`, judges the probe by the diagnostic and the suite-level message, and requires that message to name the one retained root. At root's request it was tightened again before use (SHA256 `09245c99…0b7e`, round 8). Read-only against the preserved logs, the revised expectations hold. That evaluation does not change the recorded result.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| The consumer install inherits `npm_config_global` or `npm_config_location` and could install into a real npm prefix | Sol, Medium (pre-existing) | Fixed with explicit `--global=false --location=project`. |
| A hung benchmark sample ignored SIGINT and SIGTERM until its 30 s alarm, and a timeout could lose the recorded signal | Sol, Medium | Fixed. Signals interrupt only the wait; they are recorded while the child is created or cleaned up. The group is still killed before the leader is reaped, and the recorded signal is re-raised after cleanup, ahead of a timeout. Scratchpad checks of the extracted sample block: SIGTERM ended a slow sample in 0.51 s with its background process gone, and a 1 s alarm killed the group and raised `TimeoutError`. The exit code 143 recorded at the time came from that extracted copy; round 8 corrects it for the committed runner. |
| The SIGALRM or an interrupt could arrive at the start of the cleanup and skip `killpg`/`wait4` | Opus, Nit | Fixed. Handlers raise only while waiting and clear that state first, so nothing raises inside the cleanup. |
| An unreadable `runtime.json` was treated as absent | Sol, Low | Fixed. Only `ENOENT` means no worker. Any other read or validation error is a cleanup failure, and the fixture is retained. |
| An unjoined command or viewer could retain the fixture without printing where it is | Sol and Opus, Low | Fixed. The unjoined-command error names the fixture and includes an output tail. A retained-fixture primary failure is wrapped with the fixture path. |
| `sync worker disable` ran even when enrollment failed, adding a false cleanup failure | Opus, Low | Fixed. It runs only after enrollment succeeded; the runtime-record and PID checks still run. |
| The Windows record did not say the source tests fork the tsc `dist`, whose worker import differs from the bundle's | Opus, Low | Fixed in the round 6 CI note above and in the PR body. |
| Missing blank lines in the managed-worker block and the hub close body; `isZombie` defined away from its caller | Opus, Nit | Fixed. |

### Not changed

| Finding | Reviewer, severity | Reason |
| --- | --- | --- |
| Narrow `runCommand`'s parameter to exclude `help` and `version` | Opus, Nit | Kept. `cli-commands.ts` is an entry-related source that stays byte-identical to the measured `8ae19fd`, and the call site already narrows those cases. |

### Pending after round 7

A fresh root-granted qualification of the round 8 revision with the revised runner. It covers both negative hub probes and both seeded-obsolete-chunk package-script controls, plus the startup, smoke and hub happy paths. Package smoke's own failure paths stay review-only.

## Round 8

Revision `326426d71da2d933538add0e3ee6da47a5572dea`, base `08d5b2b`. Both reviewers completed full reviews and found no production-code defect. Opus scored 9.2 and Sol 8.9. Opus's review predates the qualification below and cites the unqualified head as a gap.

### Hosted CI on the round 8 revision

Normal pull_request run 45230018567, attempt 1, at `326426d`: all 16 Actions jobs succeeded, including Verify (job 137890375792) and Source (windows-latest, 24, 1/1) (job 137886710712).

### Installed qualification of the round 8 revision: PASSED

Root grant `pr117-326426d-installed-controls-20261123` ran once at exact `326426d`, using runner SHA256 `09245c99b040520a842f2d60bef87f249f7ff2a9b2a09fdb9f15880aaf4e0b7e`. That revision adds a cross-record check to the 570e7e55 runner. A copy of the runner that actually ran is retained beside the receipt. The run took 51.1 s of application time and 0.23 s of cleanup, and exited 0. All 14 steps and 23 checks passed. The receipt is in the owner checkout's ignored `artifacts/93/326426d-qualification-v1/receipt.json`, SHA256 `7e88e208643700676257878196666d16ef20b00e2059adb886d9885557d4a437`.

- The seeded-obsolete-chunk controls passed through the real scripts-enabled `npm pack` (private shims [tsc-rs, ncc]) and the real `npm run bundle` ([tsc-rs, ncc, ncc]). The tarball is 264,214 bytes, SHA256 `6507360d48ff1440c4a3df06da16e97415c2f873a41b0c30bf8034b02d470541`, with 8 bundle JS files. It is byte-identical to the `f32c0cf` tarball, because no packaged file changed between those heads.
- Shared typecheck and clean build passed, and the shared and packed `dist` were identical. The startup parity test passed on Node 20.20.2 and 24.19.0.
- Package smoke of the exact tarball passed on both runtimes, including owner preflight and the managed worker. On Node 24, the source hub passed 3/3, and the installed hub passed 3/3 from a consumer whose bundle equals the tarball's.
- The `wrong-url` probe exited 1, reported both diagnostics, retained one fixture and left no strays.
- The `unjoined` probe exited 1 with no timeout or signal, reported the expected strings and retained one fixture. Its cross-record check passed: the per-test `nativeClose:"unjoined"` diagnostic and the suite-level missed-deadline record both name pid 2172065, and the suite record's root equals the retained fixture. The marked grandchild (pid 2172073) was identified and reaped by the runner with exit -9.
- Cleanup was quiescent. The shared `dist` was restored to its pre-run state, the shared bundle was untouched, the tracked tree was clean and no process was left over.

### Fixed

| Finding | Reviewer, severity | Disposition |
| --- | --- | --- |
| Inside an npm workspace, the consumer install could resolve to an ancestor workspace root despite `--global=false --location=project` | Sol, Medium (pre-existing code) | Fixed with `--prefix=<consumer>` and `--workspaces=false`. Checked with `npm prefix` on npm 10.8.2 and 11.17.0 in a scratch workspace. Without `--prefix` the prefix resolved to the workspace root. With the new flags it resolved to the consumer, even with inherited `global=true` and `location=global`. |
| A hub fixture that timed out or was cancelled during preparation could spawn a child that teardown never saw | Sol, Low | Fixed. `t.signal` is checked immediately before the spawn, and the close handle is still published synchronously with it. |
| An inherited `npm_config_logs_dir` let npm write to and prune a developer's log directory | Sol, Low (pre-existing) | Fixed. npm logs go to a fixture-owned directory, and the inherited value is dropped. |
| With `HTML_INBOX_KEEP_PACKAGE_SMOKE=1`, a failure kept the fixture without naming it | Sol, Low | Fixed. One retention decision drives both removal and the retained-path reporting. |
| When the test body already failed, the hub fixture's retained path and teardown reasons were invisible, because the reporter drops `t.after` errors | Opus, Low | Fixed. The per-test native-outcome diagnostic now includes `root` and the derived failure messages. `closeHubFixture` also prints "Hub fixture shutdown failed; evidence retained at <root>: …" as a diagnostic before throwing. Round 7's "runner-expectation error" framing was accurate for the probe verdict, but this fixture reporting gap was real. |
| Rounds 6 and 7 recorded exit 143 for SIGTERM, but the committed runner's own SIGTERM handler raises `InterruptedError` | Opus, Low | Corrected above. End-to-end check of the committed runner against disposable consumers whose entry hangs: SIGTERM during a sample ended the runner in 0.02 s with exit 1 and `InterruptedError: signal 15`, and the sample process and its group were gone. |
| The README still described the round 6 interrupt deferral | Opus, Nit | Fixed. |
| The runner replaced an inherited `SIG_IGN`, so an ignored SIGINT could abort a run | Opus, Nit | Fixed. A signal whose disposition is `SIG_IGN` keeps it. The wait flag is now a `nonlocal` variable, and the block has paragraph breaks. |

### Still required

A fresh root-granted qualification of the round 9 revision with the same runner. It changes the hub fixture, package smoke and the benchmark runner after the `326426d` run. Package smoke's own failure paths stay review-only.

