# Moving a local inbox to Cloudflare Pages

Remote publishing does not move or mutate the local library. The selected library's `documents/` remains the only document source of truth; each remote update is a complete generated snapshot.

Use the same intended selection for every command, including status and recovery. For the 0.3 upgrade, see [named-inbox migration](named-inboxes.md#upgrade-from-02x). Registered entries require an explicit selector, process binding, or configured default in automation.

## Before publishing

1. Stop any running viewer with the executable that started it before updating, so the next start loads the new code. A 0.1.0 viewer must be stopped with its original executable.
2. Upgrade the installed CLI with `npm install --global html-inbox@latest` and confirm it with `html-inbox --version`.
3. Confirm the local library with `html-inbox list` and open the viewer.
4. Inspect a provider-independent export with `html-inbox export --out ./html-inbox-export`.
5. Treat every document in the local library as part of one shared remote capability. Delete anything that should not be in that snapshot.

Versions 0.2.x, 0.3.x, and 0.4.x share protocol version 3 and a private loopback control endpoint to match shutdown requests to a specific process. A new CLI refuses to reuse or signal an incompatible viewer. Stop a foreground viewer with Ctrl-C before upgrading, or use its original CLI to stop a detached viewer. Documents remain in the existing inbox.

## Configure Cloudflare

Authenticate with Wrangler browser login, or export a token scoped to Account / Cloudflare Pages / Edit:

```sh
npx --yes wrangler@4.86.0 login
```

Create a dedicated Pages target:

```sh
html-inbox remote init \
  --account <cloudflare-account-id> \
  --project <new-pages-project>
```

Prefer a new project. `--adopt` is deliberately required for an existing project because the next publish replaces its complete deployed contents.

## Publish and verify

```sh
html-inbox remote publish
html-inbox remote status
```

Open the production capability URL, check search and at least one document, then test at a narrow viewport. Share only the `/i/<capability>/` URL. The Pages root has no inbox listing.

If the command loses its response or reports preserved intent, do not repeatedly publish by hand:

```sh
html-inbox remote reconcile
```

Reconciliation checks deployment history for the snapshot digest before it retries.
If an ambiguous `remote init` later discovers the project, inspect the reported account and project before running `html-inbox remote reconcile --adopt`; adoption authorizes HTML Inbox to replace that project's complete deployed contents.

## Recover after a terminated command

A killed command can leave `remote/mutation.lock` alongside its durable operation journal. `remote status` still reads that journal. Ordinary mutations keep refusing the lock until you explicitly request recovery.

After confirming the previous command and its child processes terminated, run these commands on the same machine and with the same `HTML_INBOX_HOME` as that command:

```sh
html-inbox remote status
html-inbox remote reconcile --recover-lock
html-inbox remote status
```

`--recover-lock` requires a complete JSON lock record with a positive integer PID, a version 4 UUID token, and a valid creation timestamp. It replaces the lock only when the operating system reports that PID does not exist. A live PID, including a PID reused by another process, blocks recovery regardless of lock age. Permission errors and other inconclusive process checks also block recovery. The command never sends a termination signal. Use the manual procedure below if the original command's PID now belongs to another process.

Recovery uses an exclusive `remote/mutation.lock.recovery` guard while it verifies and replaces the abandoned lock. Concurrent recovery attempts fail. If a normal command acquires the mutation lock before recovery can acquire its replacement, recovery stops and preserves the normal command's lock. Once recovery owns the mutation lock, it reconciles the existing journal and checks deployment history before retrying. It preserves `state.json`, `operation.json`, and the journal's snapshot throughout lock recovery.

If initialization recovery still requires project adoption, inspect the reported target, then run `html-inbox remote reconcile --adopt`. Lock recovery does not authorize adoption.

### Manual lock recovery

Empty, partial, malformed, or incomplete lock records stay untouched because their owner cannot be verified. An interrupted recovery can leave its recovery guard behind; the CLI also leaves that guard untouched. Neither lock age nor another `--recover-lock` attempt overrides these checks. Non-regular lock paths, such as symlinks, are refused.

For these cases, or a shared home whose owner ran on another machine:

1. Stop every HTML Inbox remote command and automation that uses this home. Coordinate with any other machine that shares it. Verify that the terminated command and its child processes have exited, and keep other commands stopped until reconciliation starts. A saved PID alone does not establish process identity.
2. Back up the complete private `remote` directory. Keep the backup private because it contains capability URLs.
3. Remove only `mutation.lock` and `mutation.lock.recovery`. Preserve `state.json`, `operation.json`, and `work` so reconciliation can use the original intent and snapshot.
4. Run `html-inbox remote reconcile`, then confirm `html-inbox remote status` reports no pending operation. If adoption is required, inspect the target before adding `--adopt`.

After completing step 1, this Unix shell example performs steps 2 through 4:

```sh
# Set this to the absolute home of the selected library.
inbox_recovery_home="/absolute/path/to/selected-inbox"
inbox_recovery_backup="$(mktemp -d)"
cp -R "$inbox_recovery_home/remote" "$inbox_recovery_backup/remote" && \
  rm -f -- "$inbox_recovery_home/remote/mutation.lock" "$inbox_recovery_home/remote/mutation.lock.recovery" && \
  html-inbox remote reconcile --home "$inbox_recovery_home" && \
  html-inbox remote status --home "$inbox_recovery_home"
```

Keep the backup until reconciliation succeeds. If you cannot establish that every command using this home has stopped, leave both lock paths in place.

## Revoke or roll back

```sh
html-inbox remote revoke
```

Revoke replaces the production site and rotates away from the shared capability. It does not delete older immutable deployment URLs. Remove sensitive historical deployments from the Cloudflare dashboard before treating the old content as inaccessible.

The local viewer remains available throughout this process. Removing remote state or a Pages deployment is not a substitute for deleting local documents deliberately with `html-inbox delete`.

## Copy controls in 0.4.0 snapshots

Updating the local CLI does not change a deployed snapshot. An owner-controlled export or remote publish with 0.4.0 generates the new copy dialog and a sibling `copy.json` per document. The JSON is included in snapshot digests and provider file-count validation. Preserve it with the rest of the snapshot and install the generated security policy rules. Serve `copy.json` as `application/json; charset=utf-8` with the common no-store/nosniff headers. The MIME rule is separate from provider-neutral `security-headers.json`; the Cloudflare adapter supplies it, while a generic host must configure it itself. Existing capabilities and original content bytes keep their meaning; copying grants no remote mutation authority. See [copying saved content](architecture.md#copying-saved-content) for fidelity and size limits.
