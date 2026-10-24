# QA correction contract: shutdown and ownership failures

This is an implementation gate for the four accepted findings in `review-qa-r1-sol.md` and `review-qa-r1-astra.md`. Both reviewers inspected the same complete uncommitted correction against `d3eaaf9fab4ae84e4d66eed0292027da8f023a48`. All 37 review hashes and 158 source hashes remained unchanged through their terminal reports. That freeze is released. The previous green checks precede these findings and do not close them.

The approved proposal and all nine required contracts remain authoritative. The existing lock-creation, compound-error, ledger-read, fatal-worker and credential contracts remain in force except for the additive ownership method explicitly specified here. No wire, ledger, runtime-record or lock-disk schema changes are authorized. Existing unknown locks, interrupted `.reap`, process-identity ambiguity, orphan accumulation and physical power-loss limits remain.

## Findings and evidence

1. **QA-R1, Medium, both reviewers:** failed worker shutdown skips lifetime release and leaves its actual file and directory descriptors open. Retaining uncertain names is correct. Actual handle inspection on Node 20 and 24 proves the descriptor leak without a close fault.
2. **QA-R2, Medium, both reviewers:** lifetime acquisition/preflight failure followed by startup-release failure masks the original error before fatal notification exists. Actual filesystem fault probes reproduce missing original causes and zero notification on both runtimes.
3. **QA-R3, High, Astra:** closing ingestion sockets is not settlement of admitted mutations. A real signed deletion paused before receiver apply remains pending after successful worker close, removed lifetime authority and rebound listeners. Releasing it then changes the receiver after close. No data loss or forged receipt was demonstrated.
4. **QA-R4, Medium, Astra:** the two reaper `lockSnapshot` catch-all consumers discard actual read-plus-close failures. A later retry reclaims the dead owner and runs protected work in the same acquisition. Both boundaries reproduce on both runtimes. A later independent successful acquisition does not excuse swallowing the earlier failure.

## Ownership handles and namespace authority

Keep `acquireSyncOwnership(lockPath, deadline, signal?, options?)` and its existing `owner` and `release()` behavior. Add exactly one purpose-specific operation, `closeHandles(): Promise<void>`, to both managed and portable results. It closes this acquisition's retained descriptors without unlinking, renaming, reaping, rewriting or claiming release of any ownership names. Managed mode closes the retained owner handle and checked directory handle; portable mode closes its retained file and gains no POSIX directory-flush requirement.

`closeHandles` must attempt independent descriptor cleanup even if one close rejects, preserve all failures and have a stable repeated-call result. Coordinate it with `release` so concurrent or repeated calls cannot remove evidence after handle disposal or falsely claim namespace release. Calling release after handles have been disposed must fail closed unless that acquisition already completed release. Normal release must still perform every required validation and flush before reporting success, and close its descriptors even when namespace cleanup fails. Do not add a global registry or expose raw file handles.

Worker shutdown that cannot establish safe namespace release must call handle cleanup while retaining the uncertain names. Preserve both the primary failure and disposal failures. Never release lifetime authority while admitted replication work can still run. Retained names remain conservative evidence; descriptor disposal creates no permission for another worker or reaper.

## Early startup failure and fatal notification

Initialize the existing no-payload, once-only fatal notification before any startup-release cleanup can fail. This notifier must be safe before store, control listener, closing promise or runtime record initialization. A throwing or asynchronously rejecting observer must not interrupt cleanup or create an unhandled rejection.

If acquisition/preflight fails and startup cleanup also fails, retain both errors in an AggregateError, notify exactly once, and attempt remaining independent handle cleanup. A normal preflight/acquisition rejection with successful cleanup remains an ordinary startup error without a fatal notification. Preserve the existing later fatal shutdown semantics and avoid self-await between drain and close. The CLI's existing fixed diagnostic and unsuccessful exit must cover fatal cleanup before readiness without printing an original exception, path, credential or stack. Explicit callers must continue receiving cleanup rejection.

## Ingestion shutdown and admitted mutations

Track the actual promises of admitted HTTPS handlers inside `createSyncIngestionServer`. A successful `close()` must mean no admitted handler can perform a later store mutation. Cache the close promise. Stop admission before closing sockets/listener, destroy owned connections, and await admitted handler settlement. Do not confuse request/socket closure with settlement of `apply`, `applyStream`, history completion, activation or other store work already awaited by a handler.

Use the existing finite `requestMs` as the shutdown drain bound, with no new configuration setting. If admitted work does not settle within that bound, reject close. Worker shutdown must then retain lifetime namespace evidence and close retained handles, notify fatal failure, and never report a successful close. A completed remote mutation cannot be rolled back. Failed shutdown may leave a bounded unresolved operation; this is distinct from successful quiescence and must remain visible.

Preserve R10's read-only body behavior: the GET-body handler already races pinning against response termination. Destroying its response permits that handler to settle while a late read-only pin cleans its own handle. Do not begin waiting for the detached read-only pin promise itself. Retain response-before-pin termination handling, active busy leases, session/attempt cleanup and error observation. Normal per-request protocol/auth errors remain per-request outcomes, not global worker failures. Observe any unexpected handler rejection without an unhandled rejection or discarded shutdown failure.

## Reaper error classification

Replace both catch-all reaper snapshot consumers with one private, typed distinction. Known absent, malformed, unknown, unsafe or unstable ownership evidence never establishes death and must continue to block or conservatively retry under the existing finite deadline. Actual I/O failures and required inspection/cleanup failures must escape the acquisition with original causes intact. An AggregateError containing an unverifiable-record cause plus a close failure is operational failure and must not become null.

Use private error types or an equally explicit typed result at the snapshot validation seam. Do not classify by arbitrary error strings or broadly wrap filesystem failures as malformed records. Pure decoding/schema validation and known metadata-invariant failures can be marked unverifiable; filesystem failures remain operational except explicitly handled absence. Public `readSyncOwnership` retains its existing owner-or-null contract. Keep owner-death proofs, inode/pair checks, exclusive reaper guard, no-successor-unlink rule and portable catalog behavior unchanged. No age rule, force removal, unknown-lock reclamation or signal authority is added.

## Write ownership and verification

One resumed worker implementation workstream owns production edits to `sync-files.ts`, `sync-worker.ts`, `sync-http-server.ts`, and `sync-cli.ts` only if needed for the existing sanitized fatal boundary. It may update its existing fatal tests/helpers and add uniquely named shutdown/ownership regression tests and helpers. Other source, existing independent reserved tests, coordinator fixture synchronizations, credentials, ledger reader, publication, reconciliation, docs and original gates remain untouched.

The writer must refresh exact current parent dependencies into its isolated app-owned worktree before work, hash them, and restore/remove all nonowned snapshots afterward. Refresh the parent's actual-completion synchronization in the owned fatal test before editing it. Source starts at the current uncommitted integrated correction, not merely committed d3. Return an exact delta against that refreshed baseline as well as the complete owned diff, commands, exit codes, counts, log hashes, retained reds and cleanup proof. No commits, pushes, services, real stores or public/LAN listeners are authorized to the child.

Required meaningful tests on Node 20 and 24 include:

- Actual retained-handle inspection after failed cleanup: all descriptors closed, authority names retained, no foreign unlink; ordinary release and repeated/concurrent release/disposal controls.
- Both early-startup reproducers and ordinary failures, actual original-plus-cleanup causes, throwing/rejecting observer isolation and a real foreground CLI sanitized fatal failure before readiness.
- Real HTTPS signed terminal and body mutation held during close: successful close waits; timeout rejects with retained authority; exact bytes/custody survive; no mutation occurs after successful close. Include history activation where its lifetime differs. A successor cannot gain authority while admitted work is unresolved.
- Existing interrupted read-only pull/pin, lease, pressure, revocation and late read-error controls continue to drain without leaked handles or deadlock.
- Both reaper boundaries with actual read and close faults: exact one-shot hits, no protected callback, all causes retained, guard/foreign names safe; separate later explicit recovery and malformed/unknown/live controls remain conservative.
- Existing lifecycle stop/disable/signals/config replacement, temporary completion, publication history, clock lease, atomic ownership cuts/worker recovery, ledger races and credential rotation tests remain green without widened deadlines or weakened assertions.

Use only synthetic private homes, temporary trust material and bounded loopback listeners. Reap all child handles, verify exact port rebinds, retained evidence cleanup and no fixture processes. Root will independently inspect the complete tracked/untracked delta, run affected and broad checks, and obtain two fresh focused confirmations with the original spec, both reports and responses. Only then can logical commits and one immutable physical-QA retest SHA be handed off. Native networking, macOS behavior, privileged services, real sleep/reboot and power loss are not established by these local tests.
