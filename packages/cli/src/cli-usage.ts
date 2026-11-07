export const USAGE = `Usage: html-inbox <command> [options]

Commands:
  publish <file.html> --title <title> --type <type> [--json]
      Save an HTML document. Unenrolled plain output is its active viewer URL.
      Managed output separates durable local storage, delivery and viewer readiness.

  sync enroll --inbox <name> --yes [--json]
  sync configure --inbox <name> --config <absolute-runtime-json> [--json]
  sync status [--document <local-id>] [--json]
  sync mapping add --config <absolute-mapping-json>
  sync mapping remove <route-uuid> --revision <current>
  sync mapping reconnect <route-uuid> --revision <current> --config <absolute-json>
  sync target set <destination-uuid> --peer <peer-uuid> | sync target clear
  sync run [--route <uuid>] | sync retry --route <uuid> | sync pause | sync resume
  sync worker enable | start [--foreground] | startup | status | stop | disable | wake
  sync worker supervisor render --platform <systemd|launchd> --user <normal-user>
  sync worker supervisor status --definition <absolute-definition>
  sync restore inspect --home <canonical-home>
  sync restore quarantine --home <canonical-home> --expect-inbox <uuid> --yes
  sync fork --home <canonical-home> --expect-inbox <uuid> --yes
      Managed replication uses explicit matching peer grants and its own owned worker.
      All sync commands accept --json; offline restore/fork require explicit --home.
      Enrollment is an explicit POSIX-only format upgrade; ordinary Windows libraries remain supported.
      Configure routes, credentials and TLS separately. Viewer stop does not stop a sync worker.
      Managed publish accepts --wait-ms <100..300000> (default 30000),
      --request-timeout-ms <100..30000> (default 5000), and paired
      --target-inbox <uuid> / --target-peer <uuid>; unenrolled publish rejects these flags.
      Managed JSON includes local.durable, delivery, worker and viewer.url.
      Exits: 0 confirmed or unconfigured local-only, 2 durable pending, 3 durable blocked,
      130 cancellation after save when a saved result is present; 1 error/uncertain persistence.
      Preserve saved reports and intended targets rather than duplicate-publishing on delivery failure.

  list [--json]
      List locally stored documents.

  preferences [--appearance <system|light|dark>] [--json]
      Show or set the default viewer and generated-document appearance.
      System follows device settings and is the default.

  delete <id> [--force] [--json]
      Delete a document after confirmation.

  export --out <directory> [--capability <value>] [--json]
      Build a static snapshot of eligible local originals only.
      Synced imports, detached imports and fork-inherited originals are excluded.

  remote init --account <id> --project <name> [--branch <name>] [--adopt] [--json]
  remote publish [--json]
  remote status [--json]
  remote reconcile [--adopt] [--recover-lock] [--json]
      Recover preserved intent; --recover-lock verifies and replaces an abandoned lock.
  remote revoke [--yes] [--json]
      Configure and manage an unlisted bearer-capability inbox on Cloudflare Pages.

  viewer [--foreground] [--loopback|--lan|--tailscale] [--host <ip>] [--port <port>]
      Start or reuse a background viewer after verifying readiness.
      --foreground stays attached. First startup is loopback-only.
      Use viewer service install for supervision beyond the launching agent's lifetime.
      LAN trusts all reachable readers; Tailscale uses existing HTTPS Serve.
      Every reachable live reader can read and permanently delete stored documents.
      Omitted networking options reuse the saved configuration.

  viewer status [--json]
  viewer stop [--json]
      Inspect or stop the verified viewer through its local control endpoint.

  viewer service install [--user <normal-user>] [viewer networking options] [--json]
  viewer service uninstall [--user <normal-user>] [--json]
  viewer service status [--user <normal-user>] [--json]
      Manage boot startup with systemd or a macOS LaunchDaemon.
      Install and uninstall require administrator privileges; the viewer runs as a normal user.

  inbox create <name> --home <absolute-path> [--json]
  inbox register <name> --home <absolute-path> [--json]
  inbox list [--running] [--json]
  inbox default <name> | inbox default --clear
      Name independent libraries, inspect their local state, or choose a fallback.

  hub init --config <absolute-path> --inbox <name> [--inbox <name> ...] [--name <title>]
      Capture explicit library membership in a new local config.
  hub --config <absolute-path> [--port <port>] [--loopback|--lan] [--host <ip>]
      Serve selected local libraries in the foreground. Default: loopback port 3218.
      Every reachable reader can read and delete from all selected libraries. Ctrl-C stops the hub.

Options:
  --inbox <name>  Select a registered library for this operation.
  --home <path>   Select an absolute library path for this operation.
  --json         Machine-readable results where supported; never prompt.
  -h, --help       Show this help.
  -v, --version    Print the installed version.

Environment:
  HTML_INBOX_NAME                 Registered library name.
  HTML_INBOX_CATALOG_HOME         Private catalog, default ~/.config/html-inbox.
  HTML_INBOX_HOME                 Library directory, default ~/.html-inbox.
  HTML_INBOX_PORT                 Port override, default 3217 on first startup.
  HTML_INBOX_MAX_BYTES            Ordinary input/read limit, default 10485760 bytes.
                                  Does not raise the managed 10 MiB body cap.
  HTML_INBOX_TAILSCALE_COMMAND    Path to an existing Tailscale executable.

Selection:
  Explicit selection, then environment, then configured default.
  With named inboxes and no selection, interactive terminals offer a picker.
  Scripts and JSON mode require --inbox, --home, an environment binding, or a default.
  Without named inboxes, the legacy ~/.html-inbox home remains available.`;
