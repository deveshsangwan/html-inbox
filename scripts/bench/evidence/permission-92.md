# Redundant permission repair investigation

Issue: https://github.com/deveshsangwan/html-inbox/issues/92

Immediate parent and inspected HEAD: `52cdb70cc4a504fa8b983e6cdbcb23432d295592`
on `perf/92-chmod`, stacked on `perf/91-listing`. The proposed PR targets
`perf/91-listing`. Inherited listing, storage-policy and runtime changes are
outside this investigation's diff.

## Provisional decision

The shortcut is provisionally rejected on source inspection. There is no
production change, measured performance result or completed runtime validation.
Root accepted qualification into the queue after #93 releases the exclusive
slot. Queue acceptance is not a slot grant.

Both `hardenPrivateFile` and `hardenPrivateDirectory` currently inspect the path
with `lstat`, reject unexpected types and symlinks, then call path-based `chmod`.
Skipping that call when the inspected mode is already private changes observable
behavior at these controlled interleavings:

1. Remove the inspected object after the real `lstat` completes, before the helper
   resumes. The current chmod should report `ENOENT`; the shortcut would return
   successfully using the earlier stat.
2. Replace the inspected object with a loose-mode object of the same type at that
   point. The current chmod should repair the replacement; the shortcut would
   leave the replacement loose.

`packages/cli/src/private-storage.test.ts` adds these cases for files and
directories. These are proposed regression oracles, still unrun. They describe
specific observable interleavings, not a claim that path-based chmod is race-free.
Another lstat moves the race. Descriptor-based identity and storage-ownership
changes require separate review and are outside this compatibility optimization.
Ownership and EPERM equivalence remain a separate unresolved concern; no
foreign-user or privileged execution result has been established.

Windows production behavior remains unchanged. POSIX mode-repair assertions are
skipped on Windows. chmod is not owner-only ACL enforcement. Read-only source
and catalog behavior, the eight shared listing read slots and sibling draining
remain unchanged.

## Qualification after an explicit slot grant

First establish that the four regressions pass on the pinned parent under Node
20 and Node 24. If baseline behavior contradicts an oracle, report and reassess
before reaching a final decision.

Then compare a temporary mode-only candidate against those regressions in the
owned checkout, using synthetic fixtures only. Pin and preserve source bytes,
diffs, exact commands, runtime versions, exit codes and logs. Restore production
source byte-for-byte in `finally`, and verify restoration before final checks or
PR creation. The candidate is authorized only for this adversarial comparison.

If the comparison confirms the conflict, stop performance experiments. Deliver
the useful regressions and evidence in a decision PR without a production
optimization or speedup claim. Qualify relevant existing permission, storage,
listing, read-only and managed behavior, and required repository/package checks.
Release the slot before the two fresh pinned reviews specified by the execution
contract. Record all three verdicts and every finding disposition.

The preselected performance metric had been process CPU for repeated local
listings, with elapsed time, RSS, Node API counts and separately traced syscalls
as supporting evidence. No such measurement is justified if the shortcut fails
the required behavior gate. The historical 15,004 chmod API calls are not fresh
evidence and are not syscall counts.

## Source-phase checks

No dependencies installed, builds run, runtime tests run or measurements taken.
`git diff --check` and
`git diff --no-index --check /dev/null packages/cli/src/private-storage.test.ts`
exited 0 before this note was added. The test file has 71 lines; an earlier slot
request incorrectly described it as 75 lines.
