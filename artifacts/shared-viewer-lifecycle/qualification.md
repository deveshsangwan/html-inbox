# Shared viewer shutdown repair

Base: 610c931b7b22920cce59cf03e49c0de15ebaf2a2, local perf/89-bench. Initial status clean. Worktree /home/agent/.t3/worktrees/html-inbox/t3-26d1cd47, branch t3/shared-viewer-lifecycle-repair.

This correctness repair joins the existing owned shutdown before browser fixture root removal. It preserves startViewer's http.Server contract and existing startup, mutation, Tailscale and record ownership logic. Static fixtures retain native HTTP close. Failure journaling is memoized and joined before owned close rejects. Shutdown failure retains fixture evidence and combines any browser close error.

The regression was added and run before production edits, against an exact-parent build. parent-red.log contains the full original failure, exit 1: `fixture root removal started while owned cleanup was gated`. The real production viewer's record cleanup is held at a promise gate after listener closure; an instrumented root rm detects premature removal. A setImmediate callback barrier drains native-close callbacks, without a sleep or EPERM assertion. Finally releases the gate and removes the test root. The first test is unchanged between red and green.

focused-node24.log: 59 passed, exit 0, including real Chromium deletion cases, Tailscale startup/shutdown, pending managed mutations, both listeners, matching/successor ownership, repeated close, backward-compatible callers, cleanup rejection and browser-close errors. All logs carry exact commands and exit codes. Build tooling and frozen install use Node 24.19.0. Further final qualification is pending.

Context: tracker #87, affected PRs #113 and #119. PR117 remains f290211f440f65c11c877dd5baf50b88cda2d969 and was only read. Original diagnostic files remain unchanged. This does not establish the historical Windows handle owner, fix every EPERM, or implement the separate unproven rename hypothesis. Linux results do not qualify Windows/macOS. No benchmark or speedup claim. Independent reviews and remote CI belong to the parent.
