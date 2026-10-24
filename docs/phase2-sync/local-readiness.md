# Phase 2 local readiness handoff

This report records the original local readiness snapshot. The later user request authorizes logical commits and a single stacked PR; [commit-sequence.md](commit-sequence.md) records that sequence and the fresh broad verification. All production/test source remains identical.

Status: tested local readiness. No observed local implementation or review blocker remains. This handoff does not authorize or certify deployment.

The implementation is in `/home/agent/.t3/worktrees/html-inbox/feat-phase2-sync` on `feat/phase2-sync`. Pinned review base and current HEAD are both `b843e126fdb10f7038e9305c6791707bcfee9ff5`. All changes are uncommitted and the index is empty. The app thread is attached to this worktree; the parent project is HTML Inbox, ID `cd1bab07-c95f-49c3-95c6-e922fffa2167`.

[approved-proposal.md](approved-proposal.md) retains the complete approved contract verbatim, SHA256 `adf73962209382ca60aa96b43c2fc81def153e87e98c3232bddcd7c6e6237da5`. Its six contracts and six acceptance groups are preserved. [required-contracts.md](required-contracts.md) retains the nine additional user contracts.

## Implemented behavior

Managed sync has actual payload push and independent pull, startup/reconnect/periodic catch-up, durable publication and obligations, a worker independent of the publisher/viewer, bounded retries and visible blocked states. Normal upload waits for the intended server's recoverable committed receipt within a finite deadline. Timeout or cancellation preserves the saved report and pending retries. Onward completion stays separate.

Explicit UUID mappings add imports alongside existing destination originals. Canonical origin identities, original metadata, hashes and provenance survive relay and local route collisions. Current holdings repair missing receiver bodies even with an empty source outbox; unchanged reconciliation reads no managed HTML. Signed origin tombstones reach onward replicas and dominate stale content. Mapping removal silences all traffic on that revision and retains detached copies. Explicit fresh reconnection reconciles trusted terminal history before live content or forwarding. Approved relay routes converge through cycles without duplicate materialization.

Verified HTTPS, explicit peer/origin/key/epoch/destination authorization and bounded wire validation protect ingestion. Push and pull share durable apply semantics. Reader, administrative control and ingestion listeners remain separate. Managed list/search/view preserve HTML bytes, CSP and iframe isolation. Static and cloud export preparation exclude imports and detached copies.

The store keeps one durable mutation/recovery authority with immutable bodies, migration fencing, atomic ledger replacement, signatures, receipts and obligations. Shared typed policies cover authorization, fencing and retry classification. Existing unenrolled libraries retain ordinary behavior. See [architecture.md](architecture.md), [protocol-interface.md](protocol-interface.md), [worker-interface.md](worker-interface.md) and [worker-operations.md](worker-operations.md) for schema, recovery and exact operational commands.

## Verification

| Check | Status |
| --- | --- |
| Unchanged `pnpm verify`, Node 24.19.0 | Exit 0; 734 tests, 729 passed, five documented skips, zero failures/cancellations/todos |
| Unit tests | 652 total, 650 passed, two skipped |
| Skill tests | 50 total, 48 passed, two skipped |
| Browser tests | 23 total, 22 passed, one skipped |
| Site tests | Nine passed; integrity passed for 14 HTML pages |
| Installed-package smoke | Both flows passed |
| Final affected suites, Node 24.19.0 and 20.20.2 | 336/336 on each runtime, zero failures/skips; includes all 30 independent protocol fault cases |
| Typecheck, build, whitespace and empty-index checks | Exit 0 |
| Reported R13 ordering and unrevoked controls | Four coordinator probes passed across both runtimes |

Exact final broad command:

```sh
python3 /tmp/html-inbox-phase2-checks-1mpkndv5/check-coordinator.py cancellation-r13-coordinator-broad bash /tmp/html-inbox-phase2-checks-1mpkndv5/verify.sh
```

The inner command is the unchanged `pnpm verify`. Its wrapper isolates HOME/XDG/ZDOTDIR, uses an owned-child subreaper and a private network namespace with a synthetic LAN interface and no external route. Host network/security settings and live services were untouched. [verification.json](verification.json) retains exact expanded commands, exits, log hashes, counts and earlier failed attempts. Counts overlap and must not be summed. [acceptance.md](acceptance.md) maps all six acceptance groups to evidence, simulations and remaining limits.

Five skips remain: three existing Windows-only checks, an opt-in live-CDN check and a generated IPv6 SAN fixture observation on Node 24. That TLS fixture passes on Node 20 with verification enabled. Linux managed-positive tests ran, including the actual archived old-viewer enrollment gate. Browser external requests were locally fulfilled or blocked.

Fault coverage includes real IPC/SIGKILL crash cuts, selected `FileHandle.sync()` EIO/ENOSPC failures, lost acknowledgements, simultaneous push/pull, exact metadata/byte collisions, filesystem-counted zero-body no-ops, signed offline A-to-B-to-C deletion, empty-outbox body repair, revocation during upload, terminal-first reconnect, clone/fork fencing and actual CLI/owned-worker timeout/SIGINT/restart behavior. Three actual worker subprocesses in disposable fixtures prove onward deletion through relay restart with the origin offline. Network faults, clock gaps, completed-outbox removal, saved-PID replacement and administrator boundaries are simulations where stated.

## Independent review and corrections

Two fresh independent whole-change reviewers, Codex 6.1 and Codex 6-astra, inspected the identical complete tracked/untracked change from the pinned base. Both used the full rubric, including security, data integrity, concurrency, lifecycle, compatibility, structure and meaningful tests. Both requested changes.

All accepted findings now have corrections and regression evidence: catalog journal recovery durability; completed-session exhaustion; administrator/owner service compatibility; remote history catch-up; holdings redistribution disclosure; audit retry fencing; shared policy structure; transient admission pressure; truncated error recovery; interrupted body-session cleanup; revocation observer ordering; and final cancellation result precedence. A staging quota fixture race was corrected with a deterministic durable-lease/no-stage pause and complete-pair wait. Original quotas, deadlines, custody and cleanup assertions remain. No check was disabled and no functional finding was rejected.

Fresh focused addenda assessed each substantive correction. Both final narrow reviewers ACCEPT R13 with no actionable unresolved finding. Each independently passed all three cancellation cases on both runtimes. Sol additionally passed completion-first revocation and unrevoked controls on both, preserving remote custody. See [Sol](review-cancellation-r4-sol.md) and [Astra](review-cancellation-r4-astra.md). Full reports and decisions are retained in [review-triage.md](review-triage.md). These final checks are narrow confirmations, not another exhaustive whole-change round. Claude was unauthenticated; no Claude or cross-provider review is claimed.

## Change inspection and cleanup

The tested 146-file CLI source manifest is `752186ddcd8f399fc54206451c9f045e7a93c755e785145bef3450f4abc78b1e`. [tested-source.sha256](tested-source.sha256) retains those relative-path hashes in the repository. From the worktree root, verify them with:

```sh
sha256sum -c docs/phase2-sync/tested-source.sha256
```

Both final narrow reviewers used the complete 101-file manifest SHA256 `771482e72130e41c1de19d64403c9757bbb66edc8343d5646770a9df4c35e2e4`, with all 31 tracked modifications and 70 untracked files. Final reports and readiness metadata are added after that freeze. No production/test source changes follow the verified run. The final change contains 105 files: 31 tracked modifications and 74 untracked files. Every changed/new file was inspected, including the final reports and result documents. The complete patch and final per-file inspection are retained at `/tmp/html-inbox-phase2-checks-1mpkndv5/final-complete.patch` and `final-inspection.json`. The patch was checked against a pristine archive of the pinned base and its resulting bytes matched all 105 files.

The final broad run reaped 119 adopted descendants with none remaining; its private namespace has no members. Test teardown closes owned workers/listeners, rebinds exact ports and removes synthetic stores/credentials. Final reviewer cleanup proves 126 and 76 recorded processes absent, 16 and 12 exact loopback ports rebound, and all fixture roots/credentials removed. Root rechecked process absence, source hashes, app binding, index, refs and namespace membership. No owned runtime remains. Coordinator HOME/config/runtime/TMPDIR are empty after removing inspected test cache leftovers. The ignored inventory contains only dependencies and generated dist/bundle files. Package manifests and lockfiles are unchanged. No unrelated process was signalled.

Root checkout remains clean. Local main and origin/main remain `b366bf505457f298e30ea84fa8c24e09aa5f0112`; phase1 remains `b843e126fdb10f7038e9305c6791707bcfee9ff5`. Sibling #77 remains `0953f4c9bac96fdd77bbca1b4b1e671cfac1bb64`, and #78 remains `d0b9c02ca1dcdccdcfbd7972b15eeb8245788a0a`.

No push, PR, merge, release, deployment, installed CLI/viewer change, live service change, real report-store access, production credential/grant or firewall/Tailscale setting was involved. The existing reader at 100.114.44.33:3217 and mobile-test home were not contacted. Real pairing/infrastructure validation was not attempted.

## Limits and remaining work

All six acceptance groups have tested local evidence, with the limits in [acceptance.md](acceptance.md). Real two-host LAN/Tailscale, OS sleep/wake/boot, live supervision, privileged manager transitions and physical power loss remain untested. Native Windows/macOS and exact Node 20.0 execution are untested. Managed enrollment is POSIX-only and rejects unsupported Windows before mutation. Ordinary unenrolled libraries remain available. File/directory fsync calls and crash recovery were exercised on Linux tmpfs/local ext storage; this does not establish hardware power-loss persistence.

Boot recovery requires explicit manual supervision setup, distinct from worker enabled/running status. No service was installed. Trusted old-owner recovery and general body reclamation are unavailable; quarantine followed by a new future-origin fork is supported. An indistinguishable same-anchor full restore cannot be detected automatically.

No local implementation/review blocker remains. Real pairing, deployment, manual boot-supervisor installation and infrastructure/platform validation require separate authorization and operational work. Nothing was published or deployed.
