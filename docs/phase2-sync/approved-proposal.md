# Revised HTML Inbox phase 2 proposal

Status: final proposal for approval, not implementation authorization. Updated with the user's four product clarifications and the requested disconnection default: origin deletion propagates to managed onward replicas; disconnect stops communication and retains detached copies; explicitly authorized onward sync is supported; and normal upload waits for durable confirmation from the intended server within a bounded foreground wait. Explicit reconnection reconciles origin tombstones before content. This resolves the previously open disconnection question. Implementation requires the user's subsequent approval. This revision supersedes the earlier pull-first, separate-reading-set-only, native-only export and optional-wait recommendations. Earlier independent reviews cover the preceding draft; this update changes proposal text only.

The repositories, PR, installed CLI/skills, inbox contents, and running services were not changed. No commits, deployments, published reports, sync endpoints, or replication workers were created. Research notes and bounded assumption probes are in `/tmp` only.

## Recommendation

Use one versioned HTTPS replication contract, Tailscale-first with an explicitly trusted LAN option. Implement actual document-carrying push for prompt delivery to an awake home server and independent pull reconciliation for bootstrap, recovery, and missed changes. Both paths use the same record descriptors, target mapping, validation, identity lookup, state ordering, and receiver commit rule.

Map a source inbox into an explicitly selected EXISTING destination inbox. Imported reports become durable members of that inbox beside its own reports. They retain their canonical origin and do not become destination-owned originals merely because they arrived there. A separate hub remains optional; showing a remote source next to the destination in a hub is not sufficient.

Support onward replication through the server to explicitly connected devices and inboxes. Every hop preserves original identity and provenance, carries authorized origin deletion state, and uses the same durable delivery and reconciliation contract. Normal upload waits for the intended server's durable receipt within a finite deadline. Confirmation from that server does not imply that every onward destination has received the report.

For cheap repeat handling, use a persisted descriptor/index keyed by canonical origin identity, with a stored content digest, byte count, and original-metadata fingerprint. Creation-time hashing of the existing original-byte buffer, plus streaming verification during actual transfer, is the preferred candidate after comparison and a bounded probe. It still needs an immutability, migration, and crash-recovery contract before implementation.

## 1. Both delivery paths are mandatory

For one mapping, A's source inbox to B's existing inbox:

- Push: A commits locally and records durable pending delivery. Its worker offers metadata to B, uploads the body only when needed, and waits for a committed receiver receipt. The home server can then serve that report while the laptop sleeps.
- Pull: B independently checks A's approved inventory, compares descriptors with its local import index, fetches missing bodies, and applies explicit owner deletion records. It runs on startup/reconnect, on request, and periodically, even if push appears healthy.
- A laptop can also initiate a pull of the server's authorized inventory when it wakes. That inventory can include originals and explicitly approved onward replicas. Reciprocal mappings do not require the laptop to stay reachable as a server while asleep. Server-side pull from the laptop remains useful when both are reachable.

A notification saying "report ready" does not give B custody of the report. If A sleeps before B fetches the bytes, the report is still unavailable to B. Such webhooks or SSE hints can be optional optimizations, but cannot be the only push implementation under the agreed sleep requirement.

Nothing can transfer bytes after the only machine holding them has already gone to sleep. Normal upload waits for durable confirmation from the intended server before declaring synced success. The foreground wait has a finite, configurable overall deadline and bounded connection/request attempts. Display the target and waiting status. If the deadline expires, return a visible saved-locally, delivery-pending result, provided the report and retry obligation are durable. Never present that result as synced success. The exact finite default is an implementation setting, not a new product decision.

Cancellation stops the foreground wait and current attempt where possible. It preserves the locally saved report and durable pending work for the enabled worker to retry. Explicitly pausing future retries is a separate action. Cancellation cannot undo a server commit that already happened, so reconnect/status reconciliation must resolve an uncertain outcome. Local persistence or queue failure is an error, not durable pending. The normal wait covers the intended server only; onward destinations have separate delivery states. No request waits indefinitely or assumes it can prevent the operating system from sleeping.

## 2. Explicit mapping and stable identities

Example: the user maps laptop inbox `research`, UUID A, into the home server's already existing inbox `development`, UUID B. B keeps its name and UUID. Its normal list/search/view shows B's original reports and the imported A reports, with origin badges.

Names are configuration labels, not merge keys. Mapping setup verifies and pins the authenticated source, source inbox UUID, destination inbox UUID, and policy revision. Renaming an alias can preserve the mapping. Replacing the named destination with a new UUID suspends it. An in-flight upload must recheck mapping validity at commit; it cannot follow a reused name or changed mapping into another inbox.

B owns and serializes its receiver-side ingest grant/revision with installation. B can fence a late commit after B locally revokes that grant. A stopping its own configuration cancels future local sends and applicable source access, but cannot instantly change B's grant or retract already received bytes. A cross-machine revoke/detach operation, if added, needs its own acknowledged transition. Disconnecting retains existing copied reports and must not queue their deletion merely because the mapping stops. The disconnection and explicit reconnection contract is in section 3.

For onward sync, each route pins its authenticated immediate peer, destination inbox, allowed origin inboxes and redistribution scope. Authenticating relay B does not make B the origin owner of A's reports. The protocol must validate origin state through an explicitly trusted relay/delegation arrangement. Names, network reachability and membership in the same tailnet grant no route automatically. These are design requirements for later configuration, not permission to configure access now.

Keep these identities distinct:

| Identity | Purpose |
| --- | --- |
| Origin inbox ID + origin document ID | Canonical report identity, preserved across push, pull, retries, and destinations. IDs are opaque; preserve case for legacy document IDs. |
| Origin history epoch and state version | Source-authoritative ordering of live state and deletion. A normal process restart does not reset history. |
| Destination inbox ID | Existing inbox receiving the report. This never replaces the origin inbox ID. |
| Local storage/route ID | Optional opaque local handle needed to avoid collisions in today's bare-ID storage/routes. It is not the canonical report identity. |
| Mapping ID and revision | The approved relationship and its current policy, bound into offers, queued work, staging and receipts. |
| Delivery/attempt ID | Retry bookkeeping. A new request ID cannot create a new logical report. |

The destination should have a uniqueness rule for destination inbox plus canonical report identity. Two source libraries can both have `report-7` without colliding with B's own `report-7`. Two mappings bringing the same origin report into B create one visible report with separate membership references, not two copies. Another intentional destination can have its own membership in the same origin report.

Physical storage is a later decision. An imported-data area or sidecar index is acceptable if B's ordinary library operations genuinely include those records. A view-only mount that leaves B's own list unchanged is not. Normal `publish()` cannot be the importer because it creates new IDs and timestamps; an import must preserve original metadata and provenance.

## 3. Ownership, deletion, and loop prevention

The agreed deletion rule applies to managed replicas. A owns A's original immutable report and its terminal deletion record. Deleting the original propagates deletion to its managed synced copies, including onward replicas reached through B. B owns local visibility and mapping choices, but an extra active route or membership reference cannot exempt a managed copy of the same origin record from an authoritative origin deletion. Imports never grant B authority to invent A's state. Unrelated B originals are unaffected.

- A verified origin tombstone applies to managed copies of that canonical origin record and is durably forwarded along explicitly authorized routes. A relay can serve the tombstone while A is offline once it has received it.
- B hiding an imported report is a persistent destination-local suppression, not an upstream deletion. Reconciliation must not keep undoing that choice.
- Payload eviction is separate from hiding. A missing body invalidates any claim that it remains available; it needs repair or a distinct evicted state.
- Stopping/removing a mapping stops communication over that mapping and retains the reports already copied. Preserve their canonical identity, origin information, last known state and previous mapping information, and mark the affected mapping contributions detached. Disconnection itself creates no origin tombstone, purge request, independent original or automatic archive exemption. It grants no continuing access or deletion-only connection.
- An explicit independent local copy would have a new B identity and a `derivedFrom` reference. Disconnection must never perform that conversion automatically. Creating an archive exempt from origin deletion would need a separate explicit product choice.

Retain terminal source deletion identities initially, independently of delivery-queue and receipt cleanup. Persist deletion delivery obligations at each authorized hop, retry failures, and reconcile tombstones on reconnect. An offline device may keep a stale copy until it receives the deletion through an authorized route. Reconciliation checks terminal state before reattaching or forwarding stale content, so an old live offer cannot resurrect a deleted record. Report deletion as pending for unreachable replicas, not complete everywhere. Revoked access and permanent disconnection can prevent delivery indefinitely; the design cannot recall bytes from an unreachable device or promise immediate physical erasure of its backups.

### Disconnection and explicit reconnection

The requested default resolves retention and later origin deletion without preserving hidden access:

1. Removing a mapping stops its uploads, pulls, retries and background probes. Revoke its local communication/ingest grants and fence new local work and commits under its old revision. Disable pending delivery over that mapping without deleting the report or silently discarding origin deletion history needed elsewhere. No deletion-only grant survives automatically.
2. Keep existing copied reports and mark the affected contributions detached. Their origin identity remains intact. Detachment suspends tracking over that link; it does not transform them into independent archives or exempt them from origin deletion when explicitly reconnected.
3. Reconnection is an explicit action. Revalidate peer identity, verified transport, pinned origin and destination identities, and the route's approved scope under a fresh mapping revision. An old pending request cannot silently reconnect a removed mapping.
4. Reconcile trusted origin terminal state/tombstones before importing, reattaching or forwarding live content through the reconnected mapping. Apply an intervening origin deletion to its retained copies before any stale content can be restored. Missing, corrupt or incomplete inventory entries are not tombstones. If trusted history cannot be established, leave reconnection visibly blocked and preserve detached data rather than guessing a deletion or allowing stale content to win.
5. Deletion propagation cannot be guaranteed to disconnected or unreachable replicas until they explicitly reconnect and reconcile. Already authorized, still-active routes continue within their existing scope. A detached reference cannot shield the same canonical record from a verified tombstone delivered through another active managed route. No new path, recipient or access grant is created by disconnection.

This default requires no further product decision. Engineering must retain sufficient authoritative terminal state across relay, restore and offline periods, and distinguish mapping contributions from the one visible canonical report. An incomplete history blocks safe reconciliation; it does not authorize automatic purging, automatic trust expansion or an archive exception. Stopping one side cannot undo a remote commit that already completed or instantly update an unreachable peer's local configuration.

### Onward routes and loops

Onward replication is now in scope. A-to-B-to-C can forward A's report when B-to-C explicitly permits that origin and destination. B retains A's canonical identity, original metadata, content digest and origin state. Record relay provenance separately. Each route includes authorized deletion-state delivery as well as content; B cannot re-label a forwarded report as its own original or fabricate A's tombstone.

Use uniqueness per destination inbox and canonical origin identity, plus per-record applied origin state and per-route delivery receipts. Receiving an already applied report does not create another logical report or another origin event. Relay schedules only missing authorized destination state or membership, and duplicate offers/receipts terminate without producing another round of forwarding. Tombstones use the same identity and ordering rules. Reciprocal links and cycles therefore cannot multiply reports or bounce the same state indefinitely. A hop counter can bound pathological traffic but supplies neither authorization nor the primary loop rule.

Mapping into an already exposed B inbox intentionally gives its reader audience access to the imported reports. Setup must show that destination and audience. Permission to sync onward is limited to explicitly approved routes and recipients. Public, static and cloud export permission is not granted by this clarification; any expansion needs its own explicit policy and authorization.

## 4. Durable queue, receiver receipts, and shared recovery

Source publication must recover with its descriptor and delivery obligations. A directory rename followed by an unrelated queue append has a crash gap. Queue intent must be in the same recoverable mutation boundary, or be reliably derived from authoritative committed state. Mapping activation similarly needs a defined bootstrap cut so a report published between enrollment and the first inventory is not missed.

Every owner deletion has the same obligation: recoverably commit its terminal state/tombstone and applicable delivery obligations, including supersession of pending adds. Do not reclaim the last deletion evidence or required payload pins before that intent is recoverable. Recovery must finish or consistently roll back the logical mutation rather than leave an unrecorded disappearance.

Store pending work per mapping/destination, its stable record/version, attempts, next retry eligibility, and last error. Reference retained immutable bytes rather than copying a whole HTML file into every queue item. Pin content while an upload needs it. A later source delete may supersede an unsent creation only under an explicit current-state replication rule that also defeats an older upload already in flight.

A relay recoverably records installation of an accepted origin state together with its applicable onward delivery obligations. Relay receipts confirm that hop's durable storage, not delivery to every downstream device. Each downstream report and tombstone has separate pending, committed or blocked status. Repeated delivery of the same origin state does not create fresh forwarding obligations once the authorized route has acknowledged it.

Transient connection failures retry with bounded exponential backoff, jitter, per-attempt deadlines and bounded concurrency. Startup, wake and reconnect trigger catch-up. Retry limits never silently discard an undelivered obligation. Wrong target, revoked mapping, invalid credentials, incompatible schema, quota and integrity failures produce a visible paused/blocked result instead of a tight retry loop or false success. If queuing cannot be persisted, publication cannot claim that replication was queued.

Automatic synchronization requires an explicitly enabled, owned background worker whose lifetime outlasts the publishing CLI and does not depend on a reader tab/viewer remaining open. Specify how that worker starts after restart, resumes after wake, and is stopped. A shared machine/profile worker can handle several mappings; separate explicit profiles remain possible. If only one-shot sync is enabled, work stays pending until it is invoked. A durable queue by itself schedules nothing. Worker supervision/startup is an engineering decision for later implementation, and no service is installed by this proposal.

Proposed push exchange, independent of exact URL naming:

1. Authenticate and authorize the source-to-target mapping before revealing existence or accepting bytes.
2. Offer a bounded descriptor with origin identity, state version, stored digest/length and original metadata. Receiver says committed, missing membership, needs body, pending, superseded, or conflict.
3. Transfer missing original bytes into bounded private staging. Count and hash actual bytes while consuming them, validate metadata/UTF-8/HTML policy, and preserve the existing sandbox/CSP on later reading.
4. Commit body/reference, canonical descriptor, destination membership, applied origin state and repeatable receipt in one recoverable operation. Recheck mapping revision and any newer tombstone before visibility.
5. Return a receipt only after the promised durable commit. Bind it to receiver/target identity, mapping revision, canonical identity, origin state and descriptor. The sender persists the result before retiring pending work.

`202 Accepted`, an upload session, or a "body exists" answer alone is not a durable storage receipt. A superseded or locally suppressed disposition must not falsely claim that the original body is stored. HTTP retries are at-least-once attempts; the intended local effect is idempotent installation, not exactly-once network delivery.

Pull uses exactly the same receiver rules. If B pulls a report before A retries a push, that retry should discover the already committed record/membership and finish without uploading it again. If both paths race, a single uniqueness and version rule prevents two installations.

Do not rely exclusively on B's polling schedule during a short laptop wake window. A's wake/reconnect reconciliation queries B's mapping-scoped current holdings independently of whether A has pending outbox entries, compares those descriptors with A's authoritative index, and durably recreates repair work for missing acknowledged records. Return historical receipts separately from current body availability, so a past receipt cannot mask later body loss. Fill gaps through the same metadata-offer/upload path. Pull imports generate the same committed results; B can report them back to A when reachable, or A's next status query/offer discovers them. Any progress-report operation authenticates the reporting receiver and can acknowledge only its own authorized mapping.

Use complete, bounded, generation-bound manifests initially. They contain small descriptors and explicit tombstones, not HTML bodies. Pagination must retain one cut; missing/corrupt/inaccessible entries cannot be reported as deliberate deletes. Stage progress remains separate from a fully reconciled checkpoint.

An individual push receipt must never advance the complete pull checkpoint. Receiving source position 100 proves one item, not that 99 arrived. Likewise, an older pull snapshot must not overwrite a newer pushed tombstone. Keep per-item applied versions and completed inventory generations separate. Wire delta feeds can come later; durable local mutation/queue state is required immediately.

Receiver restores, lost receipts and missing bodies require reconciliation even after a previous success. A receipt proves custody at its commit point, not eternal storage or that the machine never restored an older backup.

## 5. Cheap deduplication: candidate comparison and recommendation

| Candidate | Benefit | Limitation / proposed use |
| --- | --- | --- |
| Canonical ID-only lookup | Cheap logical duplicate detection | Cannot detect conflicting bytes/metadata or missing body. Use as primary index, not the whole integrity contract. |
| Canonical ID + stored SHA-256, byte length and metadata fingerprint | Routine comparisons read only small descriptors; detects conflicts and identifies missing content | Preferred baseline candidate. Requires a correct persisted index and immutable-record/repair contract. |
| Content-addressed blob store + origin records | Can share physical bytes across distinct logical reports | Optional later. Adds reference counting, garbage collection, privacy and storage migration work. Current source checks reject hardlinked files. |
| Rehash or compare all HTML every sync | Observes current payload bytes | Violates the intended routine I/O cost. Reserve for explicit integrity audits or exceptional repair. |
| Size/mtime/stat cache | Cheap invalidation hint | Does not prove byte identity. Same-length modifications with restored mtime defeat a size/mtime key. |

For new originals, hashing the existing `originalBytes` buffer once is the least disruptive candidate: it adds a hash computation but no additional disk read. The digest must bind the exact bytes committed; ownership of a mutable input buffer or concurrent file changes must not break that association. Hashing while loading/writing is another candidate if the byte path is later refactored. The present validator still uses a complete decoded string, so streamed hashing does not make the full importer constant-memory.

Legacy reports have no saved digest. Compare eager bounded enrollment, lazy first-use hashing, or a hybrid. Recommend bounded enrollment of explicitly selected sources, with persisted progress and a lazy fallback. A document with unknown hash must be marked unknown or delayed, not invented as a cache hit. Protect the byte version during enrollment and define how supported writers are upgraded.

Hash exact original octets, including line endings and BOM, not rendered shells, parsed HTML or re-encoded text. A versioned descriptor must bind original metadata too. Define canonical metadata encoding or compare a fixed validated field projection; arbitrary JSON property order is not semantic equality. Exclude destination labels, receive times, mapping/attempt IDs and other local envelope fields from the origin fingerprint.

On actual incoming transfers, hash the stream once while staging and compare against the authenticated expected digest and length before commitment. That proves the bytes consumed in that transfer. Stored digests are trusted between transfers under an explicitly managed immutable-storage contract; they do not continuously detect external edits or bit rot. Detected drift, missing files, policy-version changes and explicit audits may require exceptional rereads. Never silently replace an expected digest under the same immutable origin identity after finding changed bytes.

Routine equality outcomes:

- Same origin key, same state/digest/metadata, committed membership and available verified body: return the repeatable committed result without reading or uploading HTML.
- Same record/body but missing mapping membership: commit that membership and receipt without republishing or rereading the body.
- Same identity but different immutable body/metadata: conflict or corruption; preserve prior state and block automatic overwrite.
- Same identity with absent/quarantined body: request repair bytes and verify them against the expected descriptor.
- Different origin key with the same hash: keep two logical reports. Retry idempotency must not collapse deliberate publications. Broader payload/storage reuse is a separate policy.
- Newer source tombstone or revoked mapping: do not let an old offer attach or resurrect a report.

Keep the initial no-body fast path scoped to the same authorized canonical record. A global `hasBlob(hash)` can reveal unrelated content and lets a sender claim data it never possessed. Cross-ID byte reuse can be added under an explicit trusted scope, or done privately after receiving/verifying a new logical record's bytes. It is not required for cheap retries.

Per-item index lookup can be constant/logarithmic work depending on storage. A changed full manifest still costs O(number of bounded descriptors). Hashing actual new/transferred bytes remains O(bytes). Do not claim the entire sync is O(1) or zero filesystem I/O.

## 6. Verified observations and their limits

Read-only inspection used phase1 commit `b843e126fdb10f7038e9305c6791707bcfee9ff5`. The metadata contract has a schema version but no stored content hash, origin or origin-state version; its parser reconstructs known fields and drops extras. Normal publish allocates a fresh ID/time. The loader already retains original bytes, while listing reads metadata and stats rather than HTML bodies. No current method supplies import receipts, outbox transactions or durable tombstones. Existing staging rename is not proof of a power-loss-safe multi-record commit.

An independent scratch probe, rerun by the coordinator with exit 0, used three synthetic files totaling 1,118,208 bytes:

- Five unchanged descriptor scans: 0 HTML opens, 0 HTML bytes, 0 hash computations; 1,885 metadata bytes read.
- Five source/replica full-byte comparison scans: 30 payload opens and 11,182,080 payload bytes read.
- A 1 MiB local stream copy: one source-payload read open, 1,048,576 bytes read/written and one digest computation, without destination readback; digest and size matched. The destination also had a write-stream open.
- An in-place same-size change with restored mtime defeated the tested weak stat key. Actual streamed digest verification detected it; truncation was detected too.

These are instrumented application-byte counts in a toy algorithm, not physical disk measurements, a production benchmark, or proof of protocol/concurrency/crash correctness. The copy never installed a document or acknowledged one. Current HTML-policy validation was not part of that copy. No network listener or sync implementation was used.

The challenge agent also called the existing pure metadata parser and confirmed extra origin/hash fields are dropped, demonstrated different raw JSON hashes for different field insertion order, and reproduced a weak stat-cache failure. These establish narrow assumptions only.

## 7. Alternatives and decisions

Recommended: a small HTTP/JSON descriptor API plus original-byte transfer, with payload push primary for prompt arrival and pull independently reconciling the same mapping. It reuses the existing runtime's HTTP facilities and is inspectable without adding an RPC ecosystem.

- Webhook notification plus pull: useful optional hint, insufficient as the only push path when the source sleeps before retrieval. A message containing and durably storing the actual payload is an ingestion path regardless of the webhook label.
- gRPC/streaming RPC: capable of the same design, especially with an existing multi-language RPC environment. It still needs the identical outbox, target mapping, application receipt, recovery and delete rules. No evidence yet justifies the additional tooling here.
- External file synchronization/rsync plus importer: viable if another managed engine is acceptable. It still needs portable data-only exports and the application identity/membership/validation layer. Synchronizing an entire live inbox home would copy process/configuration state and does not satisfy the chosen contract safely.
- SSE/WebSocket/long polling: later notification/latency optimizations. They do not replace durable queuing or reconciliation.

Tailscale remains the preferred network path. LAN uses the same paired-peer identity and library/mapping permissions with verified TLS or an explicitly trusted certificate/key. Addresses and matching names do not grant authority. Do not automatically downgrade trust on LAN. Preserve the current reader, private control endpoint, existing route ownership, original HTML policy, and sandbox/CSP. Actual push introduces a deliberately new scoped ingestion interface; it must not grant arbitrary target paths, publishing as another origin, local deletion commands, or process administration.

## 8. Proposed phases, after separate implementation authorization

1. Settle the model and proof obligations: canonical identities, mapping/membership, immutable metadata, source/destination delete policy, legacy enrollment, writer compatibility, queue retention, custody semantics, and a concrete recoverable storage design. This is preparation, not a useful partial sync feature.
2. First useful milestone includes BOTH payload push and independent pull into an existing named target, stored descriptors, durable outbox and receiver receipts, origin tombstones, local suppression, retained detached copies with explicit tombstone-first reconnection, explicitly authorized onward routes and loop prevention. Normal upload waits for the intended server's receipt within a bounded deadline. Demonstrate preservation of target originals, lost-ack retries, timeout/cancellation with durable pending state, dropped-push repair, source and relay crashes during deletion, worker restart after the original publishing CLI has exited, laptop sleep/wake, offline onward tombstone catch-up, cycles and duplicate routes, missing acknowledged-body repair with an empty outbox, concurrent push/pull, receiver-local revocation and target replacement during upload, stale snapshots, and metadata-only no-op scans in disposable fixtures before any rollout.
3. Improve scale/operations after measuring descriptor volume, queue age and transfer failures: delta feeds, batching, bounded long polling, byte-range resume, selective blob reuse and background integrity audits. Tombstone compaction and more advanced relay operation require explicit contracts; collaborative edits/multiwriter ownership remain a separate future proposal.

## Open decisions before building

The four clarified product decisions are settled: origin deletion propagates to managed copies including onward replicas; disconnection retains existing reports; explicit onward routes are supported; normal upload waits for the intended server's durable confirmation within a bounded foreground deadline. Public/static export and arbitrary recipients are not approved. Tailscale-first connectivity with a paired LAN option, both push and pull, existing-target mapping and cheap metadata-first dedup remain unchanged.

The requested disconnection default resolves the previous product ambiguity: stop all communication over the removed mapping, retain detached copies, preserve no hidden deletion-only grant, and reconcile origin tombstones before content on explicit reconnection. Deletion cannot be guaranteed on disconnected/unreachable replicas until reconnection. No further product decision blocks this contract; untrusted or unavailable history must block reconciliation safely.

Other recommendations remain proposals: immutable original body and metadata; identical content under different IDs remains distinct; destination hiding stays local. Public/static export expansion would require a separate request. Storage budgets, latency and finite wait settings remain implementation parameters rather than settled numeric requirements.

Engineering choices: persisted index/schema and canonical descriptor encoding; file journal versus transactional ledger with external immutable files; worker ownership/supervision and explicit startup/wake behavior; relay delegation and origin-state verification; legacy enrollment and enforceable support for older mutating CLIs; source/receiver clone and backup restoration rules; certificate/credential provisioning for LAN; exact durability failure class and supported filesystem flush behavior.

## Acceptance contract for later implementation

These are required test scenarios, not tests run against an implementation of this revision. Use disposable fixtures, synthetic peers and scratch storage. No production access grants, real-data deletion or live network/service changes are authorized.

1. Verified transport and authorization: run the same push/pull protocol through representative Tailscale and LAN endpoints. Correctly paired peers and approved routes succeed. Unknown peers, wrong certificate/identity, plaintext or automatic LAN trust, disallowed origins and unapproved destination inboxes fail before report disclosure or installation. Live infrastructure verification requires separate authorization.
2. Existing destination and cheap dedup: B's originals remain alongside imported A records with origin badges. Same bare document IDs from different origins remain distinct. Concurrent push/pull and lost acknowledgements install one logical record per destination and canonical origin key. Repeated unchanged scans read no HTML bodies. Same-content/different-ID reports remain distinct; corrupted or truncated transfers fail verification.
3. Bounded confirmed upload: foreground success requires the intended server's durable receipt, not an offer, relay notification or HTTP 202. Simulate crashes before and after commit, lost receipts, finite timeout and cancellation. Local report and queued work survive; pending is visible; retries resume without duplicates. Cancelling a wait does not claim a completed remote commit was undone. Intended-server success remains distinct from onward delivery.
4. Offline deletion and relay: A-to-B-to-C preserves A's identity. A's origin deletion reaches B and C, including C reconnecting after an offline period. Tombstones survive source/relay restart and cannot lose to stale pushed content or an older pull snapshot. Unreachable replicas remain deletion-pending. B cannot fabricate A state, and an unapproved C receives neither content nor deletion metadata.
5. Detach and reconnect: remove a mapping and observe no further traffic over it, including polling, retries and hidden deletion-only requests. Existing reports remain marked detached. Restart does not restore the grant. Delete at origin while disconnected, then explicitly reconnect and verify tombstone reconciliation precedes content so the deleted report cannot resurrect. Incomplete/untrusted history blocks reconnect without guessing a deletion. Other active authorized mapping references remain independent.
6. Cycles and recovery: A-to-B-to-C-to-A and duplicate authorized routes neither multiply rows nor repeatedly enqueue the same applied state. Restore or lose a previously acknowledged body with an empty sender outbox; metadata reconciliation creates durable repair work. Replacing a target UUID or revoking its mapping during upload fences commit.

## Workspace and branch strategy after approval

No implementation thread, worktree, branch or PR is created by this proposal update. After the user's subsequent approval, launch a dedicated implementation thread in an isolated worktree on `feat/phase2-sync`. Confirm the base contains the named-inbox/local-source contracts inspected at phase1 commit `b843e126fdb10f7038e9305c6791707bcfee9ff5`.

Prefer an up-to-date `main` after phase1 is merged. If phase1 is still unmerged when implementation is approved, create an explicitly stacked worktree from `feat/named-inboxes-local-hub` at its then-verified head and target that branch for review. Record the exact base and head before work. Leave the current root checkout and phase1 worktree untouched. No branch, release or merge is authorized now.

The implementation coordinator may use as many delegated agents as useful for storage/protocol development, CLI behavior, independent fault testing and reviews. Give code-writing agents isolated ownership or worktrees. Require integration verification and two independent whole-change reviews before a reviewable PR handoff. Any later PR work, production rollout, live network validation, access provisioning, release and merge must remain within the authorization then in force.

## Primary evidence

- [Phase1 publish input](https://github.com/deveshsangwan/html-inbox/blob/b843e126fdb10f7038e9305c6791707bcfee9ff5/packages/cli/src/publish-input.ts), [metadata contract](https://github.com/deveshsangwan/html-inbox/blob/b843e126fdb10f7038e9305c6791707bcfee9ff5/packages/cli/src/documents.ts), [backend](https://github.com/deveshsangwan/html-inbox/blob/b843e126fdb10f7038e9305c6791707bcfee9ff5/packages/cli/src/backend.ts), [read-only source](https://github.com/deveshsangwan/html-inbox/blob/b843e126fdb10f7038e9305c6791707bcfee9ff5/packages/cli/src/local-document-source.ts).
- [Node crypto hashing](https://nodejs.org/docs/latest-v20.x/api/crypto.html#hashupdatedata-inputencoding), [HTTP idempotence and status semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [HTTP digest coverage](https://www.rfc-editor.org/rfc/rfc9530.html), [JSON canonicalization](https://www.rfc-editor.org/rfc/rfc8785.html).
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [transactional outbox precedent](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), [SQLite atomic commit constraints](https://sqlite.org/atomiccommit.html). These are precedents and constraints, not dependencies selected or claims that those guarantees already exist here.

Supporting independent notes: `/tmp/html-inbox-phase2-revision-20261023-{delivery,mapping,dedup,challenge}.md`. Coordinator probe script/result: `/tmp/html-inbox-phase2-proposal.VZehhm/dedup-verification.mjs` and `dedup-verification.json`.
