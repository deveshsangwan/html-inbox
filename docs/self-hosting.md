# Run HTML Inbox on a home server

`html-inbox viewer` starts or reuses a detached viewer and returns after verifying that it is ready. The viewer survives terminal closure. `html-inbox viewer --foreground` keeps the process attached for debugging or an external service manager.

First startup listens on loopback. Choose `--lan` or `--tailscale` explicitly to share the viewer. LAN access trusts everyone who can reach the port. The browser can read documents; publishing and deletion remain CLI commands.

The last successful port and exposure are saved in the private inbox. Later starts and publishing reuse those settings unless you select a port or exposure explicitly. Stop the viewer before changing its exposure. `html-inbox viewer --loopback` resets saved exposure to loopback.

```sh
html-inbox viewer
html-inbox viewer status
html-inbox viewer stop
```

## Start at boot

Boot installation is an explicit administrator operation. It does not happen during normal viewer startup. Linux requires systemd as the system service manager. macOS uses a LaunchDaemon. Both run before user login, as the selected normal account rather than root.

Install HTML Inbox and Node at stable paths first. The service stores their resolved absolute paths. Moving the package, deleting its installation, or changing a Node version directory requires reinstalling the service. A shell's temporary Node shim is resolved to the installed binary. The installed CLI requires Node 20 or later.

The examples below use Alice's installed Node and CLI. Replace the paths with the outputs of `command -v node` and `command -v html-inbox` from Alice's shell. The service records the CLI path passed to Node, so use the installed package entry, not a source checkout that will be removed.

```sh
sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service install --user alice --loopback --port 3217
html-inbox viewer service status
sudo /absolute/path/to/node /absolute/path/to/html-inbox viewer service uninstall --user alice
```

`--user` selects the normal account. A sudo invocation can also use `SUDO_USER`. A root shell without a selected normal account must provide `--user`. The default inbox is that account's `~/.html-inbox`, even when sudo sets `HOME` to `/root`. Choose the normal account whose inbox the viewer will serve. The service cannot run as root; the administrator selects the intended account without a fixed UID threshold.

To preserve a custom inbox, set its absolute path for installation, status, and removal. The directory's parent must already exist, and an existing inbox must belong to the selected user. Installation creates a missing inbox and assigns it to that user. It never recursively changes document ownership.

```sh
sudo env HTML_INBOX_HOME=/home/alice/inboxes/reports \
  /absolute/path/to/node /absolute/path/to/html-inbox \
  viewer service install --user alice --lan --host 0.0.0.0 --port 3217

HTML_INBOX_HOME=/home/alice/inboxes/reports html-inbox viewer service status

sudo env HTML_INBOX_HOME=/home/alice/inboxes/reports \
  /absolute/path/to/node /absolute/path/to/html-inbox \
  viewer service uninstall --user alice
```

Install stops short of success until the service manager's PID matches a healthy viewer for the selected inbox. If a detached viewer already occupies the port, stop it with `html-inbox viewer stop` before installing the boot service.

Only one boot service definition is managed per machine. A command for another inbox refuses to replace or remove it. Modified, unrelated, symlinked, and hard-linked definitions are refused. Reinstalling the same settings is idempotent; changing settings updates the owned definition. A failed installation or removal restores the previous definition and service state when the manager permits rollback. An incomplete rollback is reported explicitly.

## What survives reboot

The service definition records the inbox path, port, exposure, optional host, selected user, absolute Node and CLI paths, and an absolute Tailscale executable path when needed. It sets the user's real `HOME`, a PATH built from resolved directories, and the inbox environment. It preserves `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, and `SSL_CERT_DIR` when present during installation. Other shell environment variables and secrets are not copied.

For Tailscale, install and sign in to Tailscale separately as the intended user. HTML Inbox does not provision Tailscale or grant operator access. Pass an absolute executable override when sudo's PATH does not contain the intended CLI.

```sh
sudo env HTML_INBOX_TAILSCALE_COMMAND=/absolute/path/to/tailscale \
  /absolute/path/to/node /absolute/path/to/html-inbox \
  viewer service install --user alice --tailscale --port 3217
```

Tailscale's hostname is resolved when the viewer starts. Service definitions do not freeze a machine's old hostname. Boot succeeds only if the selected user can use the required local Tailscale state and command at that time.

The inbox must be available before login. A home directory or custom inbox that remains encrypted or unmounted until login cannot support this boot requirement. The command does not configure mounts, encryption, or machine permissions.

## Diagnostics and removal

Detached viewer output goes to `viewer.log` inside the private inbox. Foreground mode writes to its attached terminal. Linux boot service output goes to the system journal; inspect it with `journalctl --unit=html-inbox-viewer.service`, using administrator access if your account cannot read that journal. A macOS boot service opens `viewer.log` itself after launchd switches to the selected user. The installer and boot managers never open an inbox log path with administrator privileges. The inbox has mode `0700`, and private logs have mode `0600`, owned by the viewer user.

On macOS, inspect service state with `launchctl print system/com.html-inbox.viewer` and read the selected inbox's `viewer.log`. If the log is unsafe or cannot be opened, the service fails before starting a listener. Run `html-inbox viewer --foreground` as the selected user to see the file error in the terminal and correct that log path. Service definitions have mode `0644` so the selected user can read service status. Do not put secrets in the preserved Node or certificate environment variables. Installing or removing boot configuration requires administrator privileges; the CLI never invokes sudo automatically.

Linux installs `/etc/systemd/system/html-inbox-viewer.service`, sets `User=`, invokes the foreground viewer with `Type=exec`, and enables `multi-user.target`. macOS installs `/Library/LaunchDaemons/com.html-inbox.viewer.plist`, sets `UserName`, and uses the system launchd domain with `RunAtLoad`. Both restart failed processes and allow 120 seconds for graceful shutdown, including verified Tailscale cleanup. Commands that wait for a stop or restart allow 150 seconds for the manager to finish. Service status checks the manager and the viewer's private readiness information.

Service readiness and status run the viewer status CLI as the selected user's UID and GID, including Tailscale checks. The administrator process invokes the system service manager, but does not execute the inbox's configured Tailscale command with administrator privileges.

Uninstallation stops and disables the owned service, removes its definition, and preserves documents, private records, and logs. Ordinary `viewer stop` stops the process without removing boot configuration. Use service uninstall to prevent boot startup.

An older viewer record blocks startup until you stop that viewer with its previous executable. If the older process already exited, its stop command may leave `viewer.json` behind. Verify that the recorded viewer process is gone and its listening port is unused, then remove only the stale `viewer.json` from the selected inbox and retry the current viewer. Keep the documents, saved configuration, and other private records.

The generated configuration follows the official [systemd service reference](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemctl reference](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), Apple's [LaunchDaemon guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), and Apple's [current LaunchDaemon tutorial](https://it-training.apple.com/compliance/tutorials/course/sec050/) for file permissions and system-domain commands. Development tests use temporary definitions and recording executables; they do not install a real service or test a reboot.
