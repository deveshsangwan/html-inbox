# QA004 ledger snapshot correction

This source-interface gate is frozen against `d3eaaf9fab4ae84e4d66eed0292027da8f023a48`. It authorizes a ledger-only, bounded replacement-read correction. General private-file, HTML/key, ownership-lock, worker/CLI shutdown and persisted schemas remain unchanged.

## Evidence and qualification

The complete independent physical producer summary and snapshot trace were read from `workers/qa004-repro-d3/` in the copied QA evidence. During a181.555462s window, office-mac C's snapshot guard error led to worker closed/beforeExit0/exit0 at80.444685s. A/B retained their original worker identities; every observation retained one readable canonical sentinel. All three fixtures were stopped/disabled and ports rebound. The fixture used a qualified30s session lease solely to bypass QA002, reconcileMs1000, no fault injection, no chmod and read-only permission inspection. It is not evidence of default-lease success.

The native failed stat attribute was not recorded. Do not label that native incident an nlink0 race. A bounded Linux unchanged-Stats stress observed606 real commits,12726snapshots and13802lstat checks with zero errors. That does not establish the native cause either.

The local controlled red does establish a safe-replacement gap. A real production ledger commit replaces a retained inode; the test delivers that inode's actual post-rename fstat as the lstat result. The stale inode remains a regular private current-UID bounded file with nlink0; a fresh canonical lstat has the same device and a different safe single-link inode. Both actual snapshot and owned tick fail with the same native guard message. A separate retained foreground CLI/HTTPS producer with successful terminal handshake and actual receiver custody also fails its same-worker-survives assertion at this tick-specific seam. This is controlled syscall-result delivery, not a claim about native lstat behavior. Keep all failed probes and their cleanup receipts, including the earlier incorrectly selected lock-held seam.

## Implementation scope and interface

The behavior is confined to the private managed-ledger read. Use a small internal `sync-ledger-reader.ts` module with one operation, `readManagedLedgerBytes(ledgerPath: string): Promise<Buffer>`, fixed `SYNC_LIMITS.ledgerBytes` and the existing maximum four attempts. This encapsulates checked file reading and descriptor cleanup without expanding the store's mutation authority or introducing a generic configurable filesystem abstraction. `sync-store.ts` calls it from its private readLedger method, then retains the existing parseLedger, origin signature verification and caller anchor/barrier/reader-identity checks.

The author may add that single helper module alongside sync-store.ts and the dedicated new ledger-read tests/helper. Do not edit sync-files.ts, its general openPrivateFile/readPrivateFile policy, sync-worker.ts, CLI production, QA001/QA002 sources, reserved independent tests or coordinator docs. The QA003 lock contract is unchanged. Any further interface/scope change returns to the coordinator first.

## Accepted samples and retry evidence

Before opening, lstat must establish a regular nonsymlink file owned by the current account, private mode, bounded size and nlink1. Use read-only/no-follow/nonblocking open. Compare the held handle's fstat with the checked pathname sample: identical dev/ino, regular type, UID, private mode, bounded size and nlink1. Read bounded bytes only from an accepted handle. Check the held handle after reading as well; an unsafe or unlinked sample supplies no bytes to the parser. Close every handle on success, retry and failure.

A retry is permitted only after fresh, narrow replacement evidence:

- A stale lstat sample is regular, nonsymlink, current-UID, private and bounded with exactly nlink0, and a fresh canonical lstat is regular, nonsymlink, current-UID, private, bounded and exactly nlink1 on the same device with a different inode.
- A previously checked safe inode becomes unlinked on its opened handle, with unchanged safe identity/type/UID/mode/bounds, and fresh canonical metadata proves the safe different single-link replacement on the same device.
- A safe lstat/open inode mismatch has safe single-link samples on the same device and a fresh safe canonical sample matching the opened inode. Retry from the beginning rather than accepting bytes on mismatched evidence.

After-read replacement uses the same proof, discards the sampled bytes, closes the handle, and consumes an attempt. Metadata or size changes inconsistent with immutable replacement fail closed. Compare device/inode without lossy coercion. A coherent, linked, validated snapshot is a point-in-time cut; later commits do not make previously validated bytes an authority for new mutations or request admission, which retain their existing locked checks.

Every retry starts with full validation again. The fourth failed attempt produces an honest coherent-snapshot error. There is no catch-all retry, error-message-based widening, unbounded loop, delay expansion or change to retry scheduling. A missing current canonical path does not establish replacement. Merely receiving the old generic guard error does not establish replacement.

## Fail-closed controls

Stable directory, symlink, hardlink, wrong UID, insecure mode, oversize, unknown/missing path or unexpected link count remains an immediate failure, including when a stale safe inode was sampled before an unsafe replacement. Never open a symlink target or read bytes from a sample that failed validation. A safe replacement must have a different inode on the same device; a stable unsafe inode is never relabeled benign.

Malformed JSON, invalid ledger invariants, bad origin signatures, changed owner anchor, wrong reader identity and migration/barrier failures remain failures. They do not consume this read-replacement retry mechanism. No repair write, chmod, recovery mutation, ownership guess, stale authorization, hidden endpoint contact or HTML reread/rehash is added by the reader.

## Required checks and limits

Keep deterministic red controls on the base and require exactly hit controlled seams before and after the fix. Extend tests for first-stat and opened-handle replacement, replacement after read, repeated replacement through exhaustion, and safe lstat/open inode changes. Include stable and replacement-to-unsafe controls, malformed JSON/signature/anchor/identity controls, bounded reads, finite attempts and handle closure.

Use actual public store snapshots, real production commits, owned worker ticks and retained CLI children. A successful terminal handshake before publication avoids the separate unfixed QA001 on the author's base. Default verified HTTPS lease remains unchanged in the local CLI proof. Require the same worker process identity to survive proven benign replacement and subsequently perform actual custody/repair, with exact bytes, canonical counts and committed receipts. The unsafe controls must still fail closed.

Run typecheck/build and affected checks on Node20/24 in the isolated author worktree, then coordinator combined checks/broad verification and two fresh focused reviews against one complete pin. Reap retained children, rebind exact listeners, remove synthetic roots/credentials, and retain exact command/exit/log-hash receipts. A bounded at-least180s CLI/viewer-off liveness and empty-outbox repair observation is required for the integrated/default-path retest; local controlled proof does not replace native physical QA.

Native guard-field identification remains pending the unchanged-Stats Mac observer or exact fixed-SHA retest. A successful controlled correction does not retroactively prove the native trigger. Genuine unsafe snapshot failures still stop safely under the existing shutdown policy. That policy's silent clean exit is a separate unresolved diagnostic/exit-status question, not authorization to retry unsafe state or invent a persisted failure schema in this patch.
