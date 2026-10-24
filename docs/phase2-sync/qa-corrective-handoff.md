# Corrective QA handoff

The physical-QA corrections are locally verified and independently accepted. The source checksum manifest is `tested-source-qa.sha256`: 164 files, aggregate `03951da690ff22fe34e4b5773f5911c30f6697ebce7d3d8c19b9587117aa9de7`. The implementation coordinator releases one complete committed SHA after packaging these identical bytes and checking the published head. Do not retarget physical QA to a partial commit.

Changes cover transient history waiting, peer lease clock differences, complete atomic managed-owner publication, safe ledger-generation replacement, visible fatal shutdown and resource draining, current per-route credentials, publication confirmation/cancellation including uncertain acknowledgement, and portable-file cleanup. No real inbox, installed CLI, live service, credentials, network/security setting or physical host was changed by implementation verification.

| Local check | Result |
| --- | --- |
| Unchanged `pnpm verify`, Node 24.19.0 | 1075 tests: 1070 passed, five documented skips, zero failures |
| Complete compiled units, Node 20.20.2 | 993 tests: 992 passed, one Windows-only skip, zero failures |
| Transport and protocol-fault containing suites | 39/39 on each runtime |
| Final independent focused reviews | Accepted; 51 and 55 independent cases per runtime |

Counts overlap. Broad verification also passed typecheck/build, 14-page site integrity and package smoke. Its five skips are the Node24 generated IPv6 SAN verification limitation, Windows taskkill, two Windows PowerShell cases and optional live CDN. Exact commands, exits, timestamps, hashes, prior failures and cleanup qualifications are in `verification-qa.json`; the full review reports are retained beside it. No Claude or cross-provider review is claimed.

## Physical retest entry points

Build the same released full SHA in separate disposable project checkouts on all hosts. Read Fleet and repository instructions in the independently authorized Mac QA thread. Compare source manifests and recorded build/runtime details before running applications. Use synthetic private inboxes and temporary scoped test trust only.

Relevant compiled regression files under `packages/cli/dist/`:

- `sync-publication.test.js`, `sync-worker-integration.test.js`: history waiting and intended-server publication.
- `sync-clock-skew.test.js`: local elapsed-time lease handling.
- `sync-ownership-publication.test.js`, `sync-ownership-worker.test.js`: atomic owner publication, crash cuts and real CLI restart/queued recovery.
- `sync-ledger-read-race.test.js`: bounded verified generation replacement.
- `sync-worker-fatal.test.js`: sanitized fatal reporting and normal shutdown controls.
- `sync-worker-credentials.test.js`: fresh credentials at route eligibility.
- `sync-shutdown-ownership.test.js`, `sync-shutdown-ingestion.test.js`: ownership disposal and admitted mutation drainage.
- `sync-finalization-lifecycle.test.js`: late and unacknowledged-ticket cancellation, pending bind/close and cleanup causes.
- `sync-portable-acquisition.test.js`: actual portable descriptor and ordinary catalog behavior.
- `sync-transport-lifecycle.test.js`, `sync-protocol-faults.test.js`, `sync-revocation-order.test.js`: transport failures, teardown boundaries and cancellation/revocation controls.

Use unmodified default 60000 ms transport leases for physical acceptance. Some historical diagnostic fixtures used a shorter lease only to bypass the original clock issue; those are not default-path successes. Real three-host LAN and Tailscale, actual viewers, long-lived owned workers and failure/recovery acceptance belong to the independent QA thread. Mac-to-agent LAN initiation remains an infrastructure limit; agent-initiated LAN pull and Tailscale are distinct paths. No firewall/VPN/security setting change is authorized.

## Compatibility and remaining limits

Managed enrollment requires supported local POSIX file/directory durability. Managed ownership schema 2 requires coordinated participating CLI/worker versions; older binaries fail closed. Ordinary portable catalog behavior and unenrolled viewers remain supported, with the catalog’s historical create-before-owner-write crash limitation. Unknown locks, interrupted `.reap`, macOS null-start/PID ambiguity, pre-install candidate accumulation, hostile same-account path replacement, trusted old-owner recovery/general reclamation and indistinguishable same-anchor restore remain explicit limits. No physical power-loss claim follows from SIGKILL tests.

Corrected-head native macOS/Windows, exact Node20.0, real OS sleep/boot/power loss and live privileged manager/supervisor transitions remain unproven locally. The historical transport cleanup failure’s original writer remains unknown; the retained-runner correction addresses a proved possible watcher mechanism. No historical failure is erased or reclassified by later green checks.

No merge, deployment or real-data deletion is part of this handoff. Physical QA must report exact tested SHAs, actual routes/interfaces, application custody and checksums, outages/recovery, cleanup and untested paths. Connection or ping success alone is insufficient.
