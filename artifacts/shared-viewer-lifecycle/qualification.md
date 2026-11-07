# Shared viewer shutdown repair

Base: 610c931b7b22920cce59cf03e49c0de15ebaf2a2, local perf/89-bench. Initial status clean. Worktree /home/agent/.t3/worktrees/html-inbox/t3-26d1cd47, branch t3/shared-viewer-lifecycle-repair.

This correctness repair joins the existing owned shutdown before browser fixture root removal. It preserves startViewer's http.Server contract and existing startup, mutation, Tailscale and record ownership logic. Static fixtures retain native HTTP close. Failure journaling is memoized and joined before owned close rejects. Shutdown failure retains fixture evidence and combines any browser close error.

The regression was added and run before production edits, against an exact-parent build. parent-red.log contains the full original failure, exit 1: `fixture root removal started while owned cleanup was gated`. The real production viewer's record cleanup is held at a promise gate after listener closure; an instrumented root rm detects premature removal. A setImmediate callback barrier drains native-close callbacks, without a sleep or EPERM assertion. Finally releases the gate and removes the test root. The first test is unchanged between red and green.

focused-node24.log: 59 passed, exit 0, including real Chromium deletion cases, Tailscale startup/shutdown, pending managed mutations, both listeners, matching/successor ownership, repeated close, backward-compatible callers, cleanup rejection and browser-close errors. All logs carry exact commands and exit codes. Build tooling and frozen install use Node 24.19.0. Final qualification is complete, as recorded below.

Context: tracker #87, affected PRs #113 and #119. PR117 remains f290211f440f65c11c877dd5baf50b88cda2d969 and was only read. Original diagnostic files remain unchanged. This does not establish the historical Windows handle owner, fix every EPERM, or implement the separate unproven rename hypothesis. Linux results do not qualify Windows/macOS. No benchmark or speedup claim. Independent reviews and remote CI belong to the parent.

## Final local qualification

The tested implementation commit is 4b43e0062d4b6d1f4fb01fca83db3885a21141cc. The subsequent commit adds qualification evidence only; production and test source hashes remain those in identity.txt. The final committed head is reported in the implementation handoff.

- `fnm exec --using=20.20.2 node --test packages/cli/dist/viewer-owned-lifecycle.test.js packages/cli/dist/viewer-mutation-shutdown.test.js packages/cli/dist/viewer-shutdown.test.js packages/cli/dist/viewer-startup-races.test.js packages/cli/dist/viewer-tailscale-lifecycle.test.js scripts/viewer-fixture-browser.test.mjs scripts/document-deletion-browser.test.mjs`: exit 0, 59 passed. The identical Node24 command is in focused-node24.log, also exit 0, 59 passed.
- `fnm exec --using=24.19.0 pnpm verify`: exit 0. Includes Rust compiler typecheck/build, all source tests with 1326 passed and 3 skipped, harness with 15 passed, skills with 146 passed and 2 skipped, full browser suite with 78 passed and 1 skipped, site integrity with 9 passed, and installed package smoke covering foreground/detached/Tailscale/publish/deletion/shutdown behavior. Full output is verify-node24.log.
- Frozen install, parent and candidate build commands and exits are in their named logs. Parent red is exit 1 by design. No checks were weakened or retried to hide a failure. No benchmark was run.

identity.txt records runtime paths/versions, compiler version, lockfile and affected source/compiled SHA256s. All eight original diagnostic manifest artifacts were rehashed and match their original hashes. Original diagnostic logs were never edited. The raw red log contains reporter whitespace, preserved intentionally; source/script `git diff --check` passes.

cleanup.txt records a clean implementation status, the code diffstat of 5 files, 240 insertions and 28 deletions, no remaining worktree fixture/heavy processes, and unchanged PR117 pin. Browser failure evidence is retained by the fixture, asserted by regression tests, then explicitly removed by the test owner. All local heavy work is FINISHED and the slot can be released before independent reviews. No reviews/helpers were started and no PR was watched, merged or released.

Draft PR: https://github.com/deveshsangwan/html-inbox/pull/120. Originating coordination item: https://github.com/deveshsangwan/html-inbox/issues/87. backlinks.txt confirms both GitHub body links. Issue87's prior body was preserved as an exact prefix, including existing backlinks. No closing keyword was used. Remote CI and two independent fresh reviews are pending parent qualification; no Windows/macOS conclusion follows from these Linux checks.

## Review-fix round2

The first reviewed6546267 is REQUEST CHANGES; its original receipts remain historical qualification only. See [round2/qualification.md](round2/qualification.md) for candidate5829 red/green, complete new checks, hashes, restoration and cleanup. The three failed assertions on reviewed production were preserved. Raw log filenames above now resolve through log-archives.json to lossless .log.gz archives; use gzip -dc to recover exact original bytes. Complete first-round reviews and dispositions are archived beside this report. Fresh focused round2 reviews and final qualified-head CI/root audit remain required.
