# Corrective QA handoff

The physical-QA corrections and hosted-CI follow-ups are locally verified and independently accepted. The source checksum manifest is `tested-source-qa.sha256`: 165 files, aggregate `99261687aadcfad5f973a50e7e9abcf8d6a1e6020a45f4e01f9a07338180fc30`. The implementation coordinator releases one complete committed SHA after publishing these identical bytes and checking hosted results. Physical QA remains parked until that explicit release. Do not retarget to a partial commit.

Changes cover accurate pending/blocked diagnoses when custody inspection is temporarily unavailable, transient history waiting, peer lease clock differences, complete atomic managed-owner publication, safe ledger-generation replacement, visible fatal shutdown and resource draining, current per-route credentials, publication confirmation/cancellation including uncertain acknowledgement, and portable-file cleanup. No real inbox, installed CLI, live service, credentials, network/security setting or physical host was changed by implementation verification.

| Local check | Result |
| --- | --- |
| Unchanged `pnpm verify`, exact hosted Node 24.21.0 | 1094 tests: 1090 passed, four documented skips, zero failures |
| Complete compiled units, Node 20.20.2 | 1012 tests: 1011 passed, one Windows-only skip, zero failures |
| Publication containing and affected suites | 60/60 and 125/125 on each runtime, counts overlap |
| Final independent focused reviews | Accepted; 56 and 31 independent cases per runtime |

Counts overlap. Broad verification also passed typecheck/build, 14-page site integrity and package smoke. Its four skips are Windows taskkill, two Windows PowerShell cases and optional live CDN. Exact Node24.21.0 passes IPv6 SAN verification; the earlier24.19 limitation is historical. Exact commands, exits, timestamps, hashes, prior failures and cleanup qualifications are in `verification-qa.json`; the full review reports are retained beside it. No Claude or cross-provider review is claimed.

## Physical retest entry points

Build the same released full SHA in separate disposable project checkouts on all hosts. Read Fleet and repository instructions in the independently authorized Mac QA thread. Compare source manifests and recorded build/runtime details before running applications. Use synthetic private inboxes and temporary scoped test trust only.

Relevant compiled regression files under `packages/cli/dist/`:

- `sync-publication.test.js`, `sync-publication-inspection.test.js`, `sync-worker-integration.test.js`: history waiting, intended-server publication and short-inspection versus overall-deadline reporting.
- `sync-review-regressions.test.js`: session-capacity longevity. Its single composite observation budget is 120 seconds; production request, lease and foreground deadlines are unchanged.
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

The two original hosted failure actors remain unidentified. Controlled native-lock and paced-I/O reproductions establish sufficient mechanisms without assigning historical cause. The accepted session-budget change preserves every assertion and uses an explicit composite observation budget. Both final confirmation reports and the full chronology remain in this directory. See `qa-hosted-ci-continuation-verification.md` and `qa-ci-followup-commit-sequence.md` for current evidence.
