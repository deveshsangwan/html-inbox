# Viewer lifecycle investigation, 22 October 2026

## Finding

Native detached startup survives the launching CLI exiting, but does not move the viewer out of its Linux systemd cgroup. Stopping the owning scope can therefore stop the viewer. A separate supervisor is the existing operational answer for persistent links. Ordinary startup should retain its cross-platform behavior and must not silently install services or weaken a manager's cleanup policy.

The incident is consistent with agent-scope cleanup, but its exact historical trigger is unproven. The previous viewer PID was not mapped to the old scope before it disappeared. An explicit viewer stop would also produce SIGTERM and the same clean bookkeeping.

A second outage was observed during this investigation. The recovered viewer's owning scope was known before it disappeared. At 18:08:36 UTC the manager stopped that scope during an agent interruption; the next check found the known viewer PID gone, no listener, and no process record. The tests stopped only their uniquely named synthetic units. Supported startup restored the original document URL to HTTP 200 again, with the document digest and saved configuration unchanged. This directly links a known viewer's lifetime to an observed scope stop, while the morning incident still lacks that mapping and neither incident has a recorded signal sender.

## Incident evidence

- The deployed executable was the installed npm CLI 0.2.1 under Node 24.19.0, separate from this project checkout.
- The report worked after publication around 06:00 UTC. At 17:52:47 UTC, viewer status was stopped, direct local requests were refused, and port 3217 had no listener.
- The report files and their expected stored digest were intact. Saved configuration was unchanged. The node was online, its configured interface was still present, and host uptime ruled out a recent reboot.
- The process record was absent. The log contained startup entries at 4 October 20:49:21 UTC and 22 October 05:48:31 UTC, with no exit reason. The old code removes its matching record during graceful shutdown but logs no successful shutdown. Status does not remove the record.
- No dedicated boot service was installed. A previous Codex scope stopped at 07:59:25 UTC. Its manager log identifies the Codex app server, but does not establish that it owned the missing viewer.
- Supported viewer startup restored the original link without changing document bytes or network settings. The recovered viewer was itself inside a transient Codex scope with `KillMode=control-group`, so the same lifetime risk remained.

No report content, private reader address, control endpoint, or token is needed to reproduce this mechanism.

## Reproduction and regression coverage

Run on Linux with an available user systemd manager:

```sh
corepack pnpm test:systemd
```

The suite uses a temporary library, synthetic HTML, an available loopback port, and uniquely named temporary user units. It never stops an existing agent scope or installs boot configuration. Bounded unit lifetimes and explicit cleanup limit test processes to the probe.

The native test publishes from a synthetic scope, proves the detached viewer is a session leader inside that same scope, and verifies HTTP 200. Stopping that scope makes status stopped, the URL unreachable, and the process record absent while preserving documents and settings. The installed 0.2.1 executable reproduced this result twice before the patch. It fails the new shutdown-diagnostic assertions because its log has no exit reason.

The comparison starts the foreground viewer through a separate transient user service, from inside the synthetic launching scope. The document remains HTTP 200 with the same viewer PID after that scope stops. The test then stops only its synthetic service and verifies graceful cleanup. This validates manager ownership separation, not system-service installation, boot ordering, or reboot behavior.

The same suite can target an installed or newly bundled executable:

```sh
HTML_INBOX_TEST_CLI=/absolute/path/to/bundle/index.js \
  node --test scripts/viewer-systemd.test.mjs
```

Portable lifecycle tests cover SIGTERM, SIGINT, verified stop, reader closure, startup rollback, repeated triggers, and completion after pending readiness writes and record cleanup. POSIX signal tests explicitly skip on Windows. The systemd suite is opt-in and is not part of ordinary cross-platform tests.

## Validation results

- The full compiled unit/integration rerun passed 220 tests with one existing skip. The final focused shutdown/startup-race run passed all seven tests.
- Both synthetic systemd tests passed against the source build and the newly bundled CLI. The installed 0.2.1 bundle failed their missing-diagnostic assertions as expected.
- Installed-package smoke checks and all nine site tests passed. No live Tailscale commands were used by tests; exposure checks used recording executables.
- The ordinary `corepack pnpm test` run reached a pre-existing failure in `zsh stops before CLI checks when Node is absent`. That test also failed on the untouched base commit. Shell startup reintroduced Node despite the fixture's restricted PATH. Running `test:skills` with `ZDOTDIR` set to a temporary empty directory passed 48 tests with two platform skips, without changing shell configuration.
- An earlier full run also had two transient failures in existing process-record and pending-route recovery tests. Neither reproduced in the clean-base comparison or the final full unit run. No unrelated recovery code was changed.
- After rebasing onto the separately merged compiler migration, the full `corepack pnpm verify` gate passed with an empty temporary `ZDOTDIR`, including type checking, unit/integration, skill, browser, site, and installed-package checks.

The standard combined gate is therefore not claimed as clean in this host's normal shell environment. This patch was tested on Linux; it did not perform native macOS/Windows, reboot, or real boot-service installation tests.

## Patch and limits

Graceful shutdown now writes timestamped, PID-linked request and completion records to the existing diagnostic stream. It preserves the first trigger across signals, reader closure, and startup rollback. Completion follows listener, owned-route, and matching process-record cleanup. Cleanup failures retain the existing failure handling and do not claim completion.

The patch preserves native detached spawning, readiness checks, process identity verification, networking, service definitions, and exit behavior. It introduces no automatic service dependency. SIGTERM records cannot identify the sender. SIGKILL, an OOM kill, or power loss may prevent a final log record. Manager journal correlation is still needed for attribution.

Closed [issue #57](https://github.com/deveshsangwan/html-inbox/issues/57) required terminal detachment and explicitly administered boot services. Those workflows already exist in the integrated lifecycle implementation, including its later process-cleanup fixes. The compiler migration merged separately and does not change this lifecycle.

## Proposed live remediation, not executed

Obtain explicit authorization for a brief reader interruption and administrator installation of the existing system service. This is separate from testing or preparing this patch. The [HTML Inbox skill](../skills/html-inbox/SKILL.md#manage-boot-startup) requires an explicit service-administration request. No network, Tailscale, firewall, or exposure change is required.

1. Use the current normal account and selected existing inbox. Resolve stable absolute paths to its installed Node binary and installed CLI entry. Retain that Node installation; removing its version directory would break the service. Do not point a permanent service at this worktree or an npm cache.
2. Read verified viewer and service status. Reconfirm the saved LAN mode, specific interface bind, port 3217, and report digest locally without disclosing the address or report. Omit networking flags throughout so installation preserves the saved configuration. Remove any conflicting port override from this maintenance operation.
3. Stop only the verified viewer with the installed CLI and selected inbox. Inspect the result and follow-up status for `stopped`.
4. As administrator, run the existing `viewer service install --user <normal-user>` with the same absolute `HTML_INBOX_HOME` and stable Node/CLI paths. The generated unit runs the foreground viewer as that normal user and starts before login. Do not change its exposure or add Serve/Funnel routes.
5. As the normal user, confirm service status is running and enabled, viewer status is running with the manager's PID, the original reader link responds, and documents/settings remain unchanged. Check that the viewer belongs to its dedicated service cgroup.
6. If installation fails, inspect its rollback result. Restore the detached viewer through supported startup only after confirming no dedicated service or other viewer still owns the listener. Do not delete process records or override unrelated units. If a service must be removed, use the owned service-uninstall workflow under the same explicit authorization.

The current installed executable can use its existing service workflow without waiting for this patch. Receiving the new diagnostics requires a separately tested release/update of the CLI; this source patch does not update the installed package or the currently running viewer. Live service installation and a reboot test were deliberately not performed.

## References

- [Node child-process detachment](https://nodejs.org/api/child_process.html#optionsdetached) describes a new process group/session and the separate `unref` requirement.
- [systemd kill policy](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html) specifies that control-group shutdown signals all remaining processes, normally beginning with SIGTERM.
- [systemd transient units](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html) distinguishes scope children from services started by the manager.
- [Existing service operation and recovery](self-hosting.md) covers durable executable paths, custom libraries, installation, status, and removal.
