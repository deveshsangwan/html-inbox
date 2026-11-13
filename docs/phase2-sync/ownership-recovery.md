# Ownership anchor changes and offline recovery

An ownership anchor mismatch means original ownership is unproven. It does not establish that a copy or move occurred. Ordinary publication, signing, worker startup and viewer lifecycle still require the exact canonical home/device/inode anchor and reader identity. Offline inspection reports stored and current anchors, storage incarnation and reader identity without contacting saved endpoints. The error names the differing anchor fields.

The November 2026 laptop investigation found unchanged canonical paths/inodes and a device-number transition across three managed libraries. Its cause was not established. No historical volume UUID or before/after mount trace was available. Neither reboot nor copying is an established cause.

## Narrow maintenance repair

Explicit quarantine can now proceed when a same-home worker or anchored viewer is conclusively dead despite an anchor mismatch. Death means ESRCH or a known non-null process-start mismatch. A live numeric PID with null start, unavailable start evidence, denied probe, malformed owner, or unanchored viewer remains ambiguous. No changed-anchor endpoint is contacted and no recorded PID is signalled. This permission applies only to deliberate offline maintenance, never to ordinary signing or publication.

Maintenance holds viewer startup, worker startup and worker lifetime exclusions. It independently inspects lifetime ownership even without a runtime record, rejects live/unknown owners and disagreement with a runtime record, and acquires the lifetime lock using the existing checked dead-lock reaper. A copied lock is no longer removed with unchecked `rm`.

Before acquiring lifetime ownership, maintenance durably records a claim containing its token, canonical home, expected inbox UUID and a digest of the former worker record. An interrupted claim can justify a lock/record token mismatch only when those bindings still match, lifetime ownership is conclusively dead and any same-home runtime is conclusively dead. Each retry records the installed dead maintenance token alongside a fresh acquisition token before checked reclaim. Either may survive interruption. Fresh acquisition tokens avoid collisions with orphaned private candidate files; unrelated orphan candidates remain retained under the existing no-general-reclamation policy. The claim is removed only after lifetime ownership is released. Unknown, malformed or unrelated claims do not authorize a disagreeing lock.

Copied locks that happen to name a live local PID conservatively block too. A copied record's endpoint is never used to find its original owner.

Identity, anchors, runtime records and the maintenance claim are reread after acquiring exclusions and again inside quarantine/fork mutation transactions, including interrupted-fork recovery. Quarantine refresh preserves the reader identity; a fork must finish with the exact recorded new UUID and matching reader identity. Replacement blocks mutation. Each acquired exclusion has its own cleanup scope, including later acquisition failure. Fork completion and catalog replacement are awaited before releasing exclusions. These guarantees cover cooperating lifecycle/store writers. They do not defend against arbitrary concurrent filesystem mutation by the trusted local account. Existing generic lock-reaper tests cover guarded inode replacement; maintenance tests cover runtime/reader replacement during mutation acquisition.

## Recovery outcomes

Quarantine preserves document bodies and initially retains the UUID, but rotates storage incarnation, retires old owner keys, disables signing/worker operation, blocks routes and clears custody receipts/checkpoints, publication intents, runtime configuration and intended target. It also clears `viewer.json`, `viewer-config.json` and `tailscale-serve.json`. Removing a copied Tailscale journal does not establish ownership of, or remove, any live Serve route. Do not replay that journal.

Quarantine is not publication recovery. Trusted recovery of the former owner history remains unavailable. Fork is a separate explicit decision: it creates a new inbox/peer UUID, history epoch and signing key, clears routes, and retains former originals and tombstones as detached imports under their original canonical identities. Inherited originals do not become new originals or automatically become exportable/redistributable. Peer grants and supervisor configuration require coordination. Replaying old route JSON cannot supply new authority.

For a suspected normal mount change, preserve the original store and stop at investigation unless the operator explicitly accepts the consequences of quarantine or a fresh identity. No automatic fork or legacy anchor rewrite is supported.

## Durable evidence proposal, not implemented

[XNU getattrlist(2)](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/getattrlist.2) describes `ATTR_CMN_DEVID` as the mounted device number corresponding to `st_dev`; `ATTR_VOL_UUID` is a separate filesystem UUID. Neither statement is a clone/rollback protection guarantee. Requested attributes require checking filesystem support and returned-attribute validity. [Foundation volumeIdentifier](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumeidentifier) explicitly does not persist across restarts. It is unsuitable as a durable replacement.

A future version should introduce an explicitly tagged anchor format rather than reinterpret schema-2 home/dev/ino records. A candidate format would retain the observed anchor and record platform/filesystem, validated volume identity and stable object identity, plus a reference to independently held owner authority. A random marker, private key or filesystem UUID copied with the store is insufficient by itself. Original-identity recovery needs external continuity evidence and fencing of competing owners, including complete terminal history and rollback protection. Device number can remain useful session evidence without being the sole durable identity criterion.

Before choosing that format, validate native APIs on supported APFS/HFS+ and unsupported/network filesystems, ordinary remount/restart, file replacement, same-volume directory copies, cloned volumes, snapshots/rollback and restored backups. Define behavior for unavailable/zero identifiers and uncertain evidence. Independent authority loss must remain explicit and fail closed. Upgrades must first prove the current legacy anchor under lifecycle exclusions; gathering evidence after a mismatch cannot retroactively authenticate a legacy store. Mixed-version writers need an explicit migration barrier. No new anchor schema or original-identity recovery is shipped by this repair.

## Proposed live deployment and recovery sequence

This sequence is planning only. It was not performed by the project repair.

1. Review the patch and validate its built CLI on native macOS with disposable stores under the deployed Node runtime and the current shell runtime. Run the CLI quarantine/fork cases, live/null-start and permission-denied cases, lifetime-only ownership, replacement races, owned endpoint traps and process/listener cleanup. Linux device-number simulation proves branch behavior, not real reboot/remount safety. Native reboot/remount testing needs separately authorized disposable volumes and before/after evidence.
2. Deploy the reviewed CLI explicitly to the stable executable path used by the work supervisor. Do not assume an existing viewer or worker has loaded upgraded code. CLI deployment and service changes require separate authorization. The shared Fleet Mac test bridge currently targets Apple Health AI Bridge and requires committed changes; do not submit this uncommitted HTML Inbox checkout to it.
3. Work only on the explicitly selected work library. Reverify a private backup and document-byte inventory without logging content. Reinspect current process ownership and service definitions; historical absent PIDs are not current authority. Arrange an authorized supervisor pause and prove current lifecycle settlement without signalling unverified PIDs. Leave personal and scratch libraries alone.
4. Choose the outcome explicitly. Preserving the old identity requires separately designed and reviewed trusted recovery tooling; this patch does not provide it. Do not quarantine merely to try publishing again. If accepting quarantine, use the reviewed CLI's explicit canonical `--home`, `--expect-inbox OLD_UUID`, `--yes` operation, inspect the result and confirm bodies remain. A fork needs a further explicit acceptance of new identity and peer coordination.
5. If a fresh fork is authorized, complete its durable catalog transition, record the new UUID/epoch and coordinate fresh grants, route revisions, runtime credentials and intended target at both peers. Render/review supervisor configuration for the new identity before any authorized startup. The former four work routes cannot simply be restored unchanged.
6. Quarantine removes saved viewer networking. Only after identity and ownership validation, explicitly restore the authorized work viewer with `html-inbox viewer --home WORK_HOME --loopback --host 127.0.0.1 --port 3228`. Verify saved config and private readiness. Do not restore a copied Tailscale journal or alter Serve, sync listeners or routes as part of this step. Any remaining journal/route conflict needs its own authorized investigation.
7. Verify local bodies, actual worker state and peer custody separately. The pending report has no publication identity or reader URL; do not read, duplicate-publish or publish it during repair. Publication requires its own authorization after recovery and deployment are validated.

## Repair validation

Validated on Linux with Node 24.19.0, using disposable stores and fixture-owned processes/listeners only:

- `node_modules/.bin/tsc-rs -p packages/cli/tsconfig.json --noEmit`: passed.
- After compiling with `node_modules/.bin/tsc-rs -p packages/cli/tsconfig.json`, `node scripts/run-unit-tests.mjs`: 1,361 passed, 3 skipped, zero failures. The maintenance file contributes 38 regressions, including eight actual owned-child crash cases.
- `node --test scripts/viewer-systemd-cleanup.test.mjs scripts/run-unit-tests.test.mjs scripts/skill-cli-resolution.test.mjs scripts/skill-cli-windows.test.mjs`: 157 passed, 2 Windows PowerShell skips, zero failures.
- `git diff --check`: passed.

The default execution sandbox denied loopback listeners; the successful network suites ran with permission for synthetic fixture listeners. Existing installed development dependencies were temporarily linked into the worktree for compilation, without installing or upgrading the live CLI. This local validation did not exercise native macOS or reboot/remount. No live inbox access, peer configuration, service operation or publication was performed. Hosted CI provides separate synthetic platform coverage, not evidence of actual reboot/remount safety. Browser rendering was not part of this ownership repair.

PR review follow-up adds actual owned-child crash cuts before and after quarantine/fork commits and during partial cleanup; negative claim-binding/live/denied-owner cases; a repeated acquisition-interruption case; and post-commit reader/recovery-lock replacement tests. No new live-recovery authority is introduced.
