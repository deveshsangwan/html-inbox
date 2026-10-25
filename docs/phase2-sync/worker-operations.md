# Operating a managed sync worker

Managed sync is an explicit per-inbox format upgrade. Make a backup and stop or upgrade undiscoverable older readers and writers before enrollment. Windows enrollment is unsupported and rejects before managed mutation. Ordinary unenrolled libraries remain available.

For a consistent backup, stop the inbox's sync worker as well as its viewer and every hub that mounts it, and verify those owned processes have settled before copying. A stopped reader does not stop the independent sync worker.

Live viewer and hub Delete actions use the existing managed mutation authority after verifying the captured root and inbox UUID. Deleting an original queues signed deletion for authorized copies on reconnection; deleting an imported copy hides it only locally. Bodies remain retained and no disk reclamation is reported. Unenrolled inboxes keep the legacy physical-deletion worker.

Create or register an existing named library, then enroll it:

```sh
html-inbox sync enroll --inbox research --yes --json
```

A reader is optional. If a viewer already exists, enrollment requires its local home/process ownership evidence and protocol-3 managed-schema-1/dynamic-switching capabilities. Old, copied, malformed or ambiguous records block enrollment before contacting their endpoints or writing migration intent. A verified capable viewer can stay open. Existing matching viewer supervision must be stopped and upgraded explicitly first.

Use the exact private runtime and mapping JSON formats in [worker-interface.md](worker-interface.md). Credentials, CA files and TLS keys are provisioned separately by the operator. This implementation does not pair peers, discover certificates, alter Tailscale/firewalls or install services. Every receiving inbox must already exist and be enrolled. Each endpoint gets its own explicit matching route ID/revision, UUIDs, origin keys and approved scope. The immediate peer ID of a worker equals its inbox UUID.

```sh
html-inbox sync configure --inbox research --config /absolute/private/runtime.json --json
html-inbox sync mapping add --inbox research --config /absolute/private/mapping.json --json
html-inbox sync target set DESTINATION_UUID --peer PEER_UUID --inbox research --json
html-inbox sync worker enable --inbox research --json
html-inbox sync status --inbox research --json
```

`enable` persists enablement and attempts startup. An unsuccessful startup still leaves enabled true and reports the failure. `start` requires enablement. `startup` starts an enabled worker and otherwise succeeds with skipped true. `stop` stops the current owned process, and later authorized publish/sync work can restart an enabled worker. `disable` persists disabled state before stopping. Neither operation detaches mappings. Viewer shutdown leaves the worker and its ingestion listener running.

`pause` persistently stops locally initiated uploads, pulls, holdings, probes and retries. Authorized incoming pushes can continue and queue onward work. `resume` restores scheduling without clearing blocked work. `retry --route UUID` explicitly clears that route's item and route-level attempts/backoff/blocked state. `run` makes one bounded pass inside the same exclusive owned runtime, or a temporary runtime holding its lifetime lock when no worker exists. It does not enable automatic synchronization.

After rotating a credential file, explicitly retry a permanently blocked route. Outgoing credentials are read when that route becomes eligible, so another route's earlier pass cannot reuse a token captured before the retry. File replacement alone does not reset blocked state. Listener credentials still follow the configured runtime-revision replacement.

An unrecoverable state-read or shutdown cleanup failure stops the worker with exit 1 and one sanitized diagnostic in stderr or its existing private worker log. Inspect the inbox before restarting; an unsafe ledger is never retried blindly or rewritten to record its own error. A completed remote commit remains committed despite a later local cleanup failure. Successful stop/disable, signals and configuration/incarnation replacement do not produce the fatal diagnostic. Ordinary route failures keep their durable blocked/backoff state and leave the worker running.

Stop waits for admitted ingestion mutations as well as outbound work. If ingestion does not drain within its configured request bound, shutdown fails and retains its ownership names while closing retained descriptors. Listener disappearance alone does not prove that admitted work settled. A retained or unknown ownership record requires inspection under the existing recovery rules; a saved PID or elapsed time never authorizes removal. Early startup cleanup failure uses the same sanitized unsuccessful CLI outcome and preserves its original causes for explicit library callers.

Startup, wake, controlled scheduling-gap detection, periodic reconciliation and eligible retry deadlines trigger coalesced catch-up. Healthy routes inspect current receiver holdings even with an empty outbox; approved inbound routes independently pull. Identity/manifest/pull failures without item obligations still have persistent route retries. Transient backoff starts at one second, is capped at five minutes with jitter, and blocks after twenty consecutive failures. Wake and status do not reset it. Local cancellation does not consume transient-failure allowance.

Normal managed publication saves the report, immutable descriptor, obligations and intended peer/destination in one recoverable ledger commit. Its default foreground wait is thirty seconds with five-second absolute requests, including worker startup and receipt persistence. Override these within the documented bounds using `--wait-ms` and `--request-timeout-ms`. `--target-peer` and `--target-inbox` override that publication's target together. Later target changes cannot rewrite the saved intent.

Publication exits 0 for a current exact committed receipt from that intended server, or an explicitly unconfigured local-only save. It exits 2 for durable pending, 3 for durable blocked, 130 for SIGINT after save, and 1 for validation/persistence/uncertain durability errors. JSON prints one final saved result; progress goes to stderr. Viewer failure is separate. Suppression, deletion, supersession, readiness, HTTP 202 and another server's receipt do not confirm live body custody. Onward destinations are not awaited. Timeout/SIGINT cancels its foreground ticket where possible while leaving durable retry obligations intact; a completed remote commit cannot be undone.

Removing a mapping advances its revision, revokes local admission and grants, aborts/drains bounded attempts and invalidates its local sessions. Check `removed` and `quiesced` in the result. A failed drain reports quiesced false and exit 3. Retained reports stay detached with their original provenance. No hidden deletion-only or retry connection survives. Reconnect explicitly at both endpoints using matching fresh revisions. Trusted tombstones reconcile before live content or reattachment. Unavailable history blocks safely.

## Manual boot supervision

Enabled and currently running do not prove restart after host boot. Render a template without installing it:

```sh
html-inbox sync worker supervisor render --inbox research --platform systemd --user NORMAL_USER
html-inbox sync worker supervisor render --inbox research --platform launchd --user NORMAL_USER
```

The rendered command uses absolute Node/CLI paths and `sync worker start --foreground --home /canonical/home`. Definitions are named with the inbox UUID and are separate from viewer services. The user must already own the enrolled inbox and referenced private credentials. The template explicitly sets HOME to the selected inbox home, USER/LOGNAME to the selected normal user, and a private working directory/environment. Keep the Node/CLI installation at the rendered absolute paths. Standard output contains only the definition; rendering grants no supervision evidence.

For systemd, an administrator can save the reviewed output as `/etc/systemd/system/html-inbox-sync-UUID.service`, with root ownership and no group/world write permission, then manually run `systemctl daemon-reload` and `systemctl enable --now html-inbox-sync-UUID.service`. Inspect with `systemctl show` and the unit journal. To remove it, manually disable/stop the exact unit, remove its exact reviewed file, then reload the manager. The template uses multi-user startup, a normal user/group, UMask 0077, restart-on-failure and bounded start/stop/restart settings.

For launchd, an administrator can save the reviewed output as `/Library/LaunchDaemons/com.html-inbox.sync.UUID.plist`, with root ownership and no shared write permission, then manually enable and bootstrap that exact label in the `system` domain. Inspect with `launchctl print system/com.html-inbox.sync.UUID` and its private worker log. To remove it, manually boot out and disable that exact system label before removing its reviewed file. The template uses a normal UserName, RunAtLoad, unsuccessful-exit restart, throttle and bounded shutdown. A LaunchAgent gives login startup, not reboot supervision.

After manual setup, use `sync worker supervisor status --inbox research --definition /absolute/installed-definition --json`. True boot supervision requires exact definition bytes/path, manager registration/enablement, no systemd drop-ins or pending daemon reload, and the verified matching owned worker PID. Unknown manager state stays unproven. Ordinary worker status leaves boot supervision unknown and reports setup required. The explicit supervisor inspection supplies the current manager observation; no persisted boolean is used as proof. Rendering, enablement and detached startup alone never imply it. Tests use recording manager runners and disposable fixture supervisors. No live systemd/launchd command or installation was executed for this implementation.

## Offline copies, restore quarantine and fork

Ordinary managed entry points validate ledger/format barrier, reader UUID and canonical home/device/inode before credentials or endpoints. A copied/moved home, a barrier missing its ledger or an unexplained UUID mismatch blocks safely. Never copy a runtime record elsewhere and use its PID or endpoint to find the original process.

```sh
html-inbox sync restore inspect --home /canonical/copied-home --json
html-inbox sync restore quarantine --home /canonical/copied-home --expect-inbox OLD_UUID --yes --json
html-inbox sync fork --home /canonical/copied-home --expect-inbox OLD_UUID --yes --json
```

The expected UUID is checked locally before stopping runtimes or changing files. Quarantine rotates custody incarnation and disables signing/workers/routes while clearing runtime configuration, target intent, receipts/checkpoints and copied control/exposure records. Fork gives future originals a new inbox UUID/peer ID, epoch and signing key. Inherited records/tombstones retain old canonical identities as detached imports, and existing export restrictions apply. Same-home owned workers stop through authenticated control. Same-home viewers use the existing verified local ownership/private-health shutdown behavior, under startup/lifecycle exclusions. Unknown/live ambiguity blocks. Copied or unverified endpoints and PIDs are never contacted or signalled by maintenance.

Registered identity replacement uses a durable catalog transition naming only the expected home/name/old UUID and chosen fresh UUID. Re-run the same explicit fork command after interruption to finish that recorded transition. It cannot select another registration by guessing. An unregistered copied home can fork without changing the original registration, then be registered separately. Trusted recovery of the old owner history is unavailable; quarantine followed by a fresh fork is the supported continuation. An indistinguishable full restore cannot be detected automatically.

The tested platform is Linux with Node 24.19.0 and Node 20.20.2 in disposable stores. POSIX file/directory fsync behavior and process-crash cuts have been exercised; this does not prove physical persistence across real host power loss, reboot, OS sleep or two-host LAN/Tailscale. Windows rejection is exercised through an isolated simulated platform on Linux; native Windows execution remains untested here. General orphan/body reclamation and trusted old-owner recovery remain unavailable. No real report stores, installed viewers/CLIs, live services, access grants or network settings were changed.

Managed viewer service administration validates the selected normal owner through the existing privilege-drop boundary before reading saved viewer settings or contacting a manager. Installed status/removal verify the definition account against the current account lookup, so they do not depend on SUDO_USER. A copied home, damaged ledger/barrier, reader mismatch or failed owner preflight remains an error before service effects. This correction is covered by simulated administrator/owner boundaries and recording managers; no real setuid, systemd or launchd operation was executed for its validation.
