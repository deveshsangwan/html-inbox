# QA003 managed lock publication correction

This implementation gate is frozen against `d3eaaf9fab4ae84e4d66eed0292027da8f023a48`. It authorizes a narrow correction to future managed ownership creation. It does not claim arbitrary-cut automatic recovery. The original approved contracts, unknown-owner safety rules, general private-file checks and managed-platform limits remain in force.

## Evidence and disposition

Independent physical QA killed a retained foreground worker during the zero-byte `mutation.lock` create-before-owner-write window. Restart failed closed. Its ingestion/control ports were released. No publication was pending at that cut; earlier documents had reached C. No data loss or queue recovery is established by that case. A separate idle/paused kill-and-restart passed.

The minimized native Mac Node24.16 receipt at the pinned SHA records creation at `2026-10-24T10:31:18.993Z`, SIGKILL two milliseconds later, PID4169 reaped, then a400ms acquisition deadline failing after402ms with the exact unknown/live-owner error and canonical zero bytes retained. QA reports three deterministic red runs; the copied JSON directly records one. The coordinator read the complete script and receipt at `/home/agent/programming/html-inbox-qa-evidence-20261024/qa003-lock-window.cjs` and `qa003-minimal.json`. The script's Mac paths were not executed on the server.

The useful worker-restart expectation is unmet at this creation cut. Refusal to steal the resulting unknown owner is required safety behavior. Correct the publication window; do not guess ownership of existing empty/partial/malformed locks.

## Interface, format and compatibility

Preserve `acquireSyncOwnership(lockPath, deadline, signal?)` and its `{owner, release()}` result. Add a narrow fourth option `{mode?: "managed" | "portable"}`, defaulting to managed. `readSyncOwnership` still returns the existing `{token,pid,start}` triple or null.

Managed mutation, worker startup and worker lifetime callers use the default atomic path. The ordinary inbox-catalog registration call explicitly selects portable mode, retaining its existing creation/file-sync behavior, without mandatory POSIX directory fsync or managed-platform rejection. Its historical creation-window limitation remains. Do not silently change ordinary unenrolled catalog support.

New managed disk records are bounded UTF-8 JSON with exactly `{schemaVersion:2,token,pid,start}`. Require a canonical UUID v4 token, positive bounded PID, bounded nonempty start identity or null, and at most4096bytes. Legacy exact `{token,pid,start}` remains readable only as a valid single-link record. Unknown fields, versions or malformed values block. Never rewrite an existing record merely to upgrade it. No ledger, runtime-record or replication schema changes.

For canonical trusted public path `L`, derive `C` as `join(dirname(L), "." + basename(L) + ".owner-" + token)`. No embedded or externally supplied candidate path is accepted. New readers accept old records; old readers reject version2 records safely. Mixed-version managed liveness is unsupported. Stop and upgrade participating managed processes together.

## Atomic publication and exact flush order

Managed parents must be canonical, account-owned private0700 directories established through the existing checked mutation boundary. Do not chmod suspicious existing files into acceptability. Create at most one unique candidate per invocation, exclusively and no-follow, private0600 and single-link. Never replace a candidate collision.

1. Write the complete bounded owner bytes, sync the writable handle, validate its inode/type/UID/mode/link/size, then close it.
2. Reopen read-only with no-follow/nonblocking checks. Compare inode to the created inode and bytes to the expected record. Retain this checked handle through installation and release. No writes follow publication.
3. Sync the checked parent directory to establish the completed candidate entry. Check cancellation/deadline before installation.
4. `fs.link(C,L)` is the atomic no-replace linearization point. EEXIST never overwrites L. Validate the held inode and exact authorized pair; sync the retained read-only file handle, then sync the checked parent directory.
5. Unlink only verified C. Validate L still names the held inode with nlink1. Sync the retained handle again, then sync the parent directory.
6. Recheck cancellation/deadline before returning ownership or entering protected work. Every required sync rejection is an error; no fallback on EINVAL or unsupported durability.

Reuse the same candidate during EEXIST retries. On final loss, cancellation or failure, clean only this invocation's exact candidate after proving its inode. Never remove L as EEXIST cleanup. Substitution leaves the path untouched with an error.

## Lock-specific snapshot checks

Keep `openPrivateFile`, `readPrivateFile` and HTML hardlink guards unchanged. A private lock reader uses bounded same-handle reads, lstat, no-follow/nonblocking open, before/after fstat, and pathname revalidation. Recheck regular-file type, private mode, current UID, size, dev and inode.

The only two-link exception requires all of: exact version2 schema; valid token-derived C; both L and C regular, non-symlink, private and current-UID; both names and the held/opened handles name the same dev/inode; and exactly two links. Check/open C too. This identifies the complete pair without admitting an extra outside hardlink.

Reject legacy hardlinked records, nlink above2, absent/mismatched C, unsafe tokens, wrong UID, insecure modes, oversized or substituted files. A bounded retry may resolve the legitimate2-to1 unlink transition. Ambiguity never establishes owner death. Version2 discriminates the protocol, not malicious same-account provenance. Hostile same-account fabrication/directory replacement remains outside the existing managed-writer contract; Node pathname APIs offer no atomic conditional unlink.

## Release, reaping and uncertainty

Only the live holder releases its verified full owner identity and held inode. Only the serialized reaper with conclusive original-owner death removes a dead lock. Compare current bytes, full identity, UID/type/mode/link evidence and dev/inode, not token alone. Keep the checked handle until final unlink checks finish.

A nonmutating death precheck may avoid creating `.reap` for live/unknown contention. Repeat all proofs after acquiring the existing exclusive guard. A verified dead pair is normalized by removing C, validating the remaining L/nlink1, syncing retained file metadata then its directory, revalidating L, unlinking L, then syncing the directory. Normal release similarly flushes after the final public unlink. Release need not create a new crash-persistent reaper guard.

After a reaper removes L it must never target L again, including finally. A successor can install immediately. Finally touches only the reaper's own checked guard inode, with identity checks before cleanup. Existing `.reap` files remain untouched. A crash during reaping may require explicit inspection. An absent L can permit new acquisition despite an old guard, but that guard still prevents future dead-owner reclamation. Recursive owner-tagged reaper reclamation is outside scope.

Any failed write, sync, close, installation or validation prevents acquisition success and protected work. After invoking link, an error can represent an uncertain installed namespace: inspect against the held inode rather than assuming rollback. Cleanup may remove only proven-owned names and must flush; otherwise retain evidence and report blocked uncertainty. Do not casually strand a known live-owned lock on ordinary error/cancellation. Subsequent managed work validates and flushes its namespace baseline before claiming recovery. A release failure does not roll back completed ledger work.

## Bounds and residual limits

One candidate per invocation, finite deadlines, constant-number exact-name checks and verified ordinary cleanup bound each attempt. Pre-install partial candidates are non-authoritative and do not block an absent L. General orphan scavenging is deferred: no glob deletion, age/mtime rule or filename-derived PID authority. Repeated pre-install crashes can accumulate files; no global orphan-storage bound is claimed. Disk-full is an error.

Keep process identity rules unchanged. ESRCH proves absence; EPERM or unavailable identity is inconclusive. On Linux, a validated non-null boot/start mismatch proves the old owner gone without signalling the replacement PID. Matching live identity blocks. macOS currently has null start identity, so live PID reuse conservatively blocks. Do not add saved-PID signals or process scans.

Managed atomic publication targets the existing local Linux/macOS POSIX durability contract. Windows managed enrollment remains unsupported; portable catalog stays available. Native advisory locking could provide stronger crash-release authority, but core Node lacks flock/fcntl and a dependency/mixed-version migration is a separate design. Plain overwrite rename, non-atomic exclusive copy or mkdir-before-owner-write are unsuitable replacements.

## Required verification

Retain the original minimized red on the base. Adapt paths and recognize numeric exclusive flags as well as wx. The fixed test must prove its hook reaches the new candidate: exactly one IPC cut with path/inode/nlink/bytes, canonical L absent before install, retained-child SIGKILL/reaping, then actual public acquisition success. A missed hook or acquired-without-cut is not success.

Exercise creation at zero/partial/complete bytes, before/after file sync and writable close/reopen, candidate-directory flush, before link, immediately after successful link with the exact complete two-name pair, installation flush, candidate unlink, final flush, before return and held ownership. Exercise release and reaper cuts before/after name removal and flushes, including explicit expected `.reap` blockage and successor retention.

Inject EIO/ENOSPC and close/link/unlink errors at acquisition/cleanup boundaries, including link-performed-then-rejected. Require no callback/false acquisition success, no foreign deletion, retained uncertainty and verified normal cleanup. Falsification controls cover existing empty/partial/invalid/extra-key/unknown-version records; live/null-start/inconclusive/reused PID; symlink/FIFO/directory/oversize/wrong UID/insecure mode; legacy and third hardlinks; mismatched token/inode; and substitution at reader/release/reaper checks. General private-file/body hardlink tests remain active.

Use separate-process contenders and same-process promises to prove one holder, preserved mutations, bounded normal remnants, and no late cleanup deleting a successor. Exercise mutation/startup/lifetime ownership and inherited handshake, old-reader fail-closed behavior, legacy recovery, and portable ordinary catalog registration/concurrency with managed durability unavailable and Windows simulation.

Use a real retained foreground CLI worker: establish readiness, arm a precise subsequent mutation-lock candidate cut, SIGKILL/reap, preserve evidence without removing canonical authority, restart through the CLI and verify ownership/listeners. Separately seed durable pending publication before a creation/link cut and prove autonomous recovery, exact receiver bytes, one canonical record, intended committed receipt and durable outbox retirement; preserve paused/blocked state. Reap children, rebind exact ports, remove synthetic stores/credentials. Run affected checks on Node20/24, coordinator integration/broad checks, independent focused review and authorized native QA. SIGKILL does not prove physical power-loss persistence.

Existing unknown locks, interrupted reapers, process-identity ambiguity, hostile same-account tampering, orphan accumulation and physical power-loss verification remain explicit limits after this narrow correction. QA004 silent worker disappearance is a separate unresolved observation and does not authorize unrelated shutdown changes.
