# Resolve the CLI

Resolve once before the first command in an operation. A global CLI installation is optional. Installing or updating this skill changes agent instructions and resources; npm installation changes the executable. Keep those installers independent and run either installer only when the user chooses it.

Check `node --version` first. Use Node.js 20 or newer. The fallback also needs npm and access to its configured registry, or a cached copy of the pinned package. If a prerequisite is missing, report it and stop before publishing. These runtime requirements apply to an already-installed skill. Installing or updating it with the current `npx skills` installer requires Node.js 22.20.0 or newer.

Use an installed `html-inbox` only when `--version` succeeds and its trimmed output matches `^0\.2\.(0|[1-9][0-9]*)$`. This accepts stable 0.2.x releases. Missing executables, failed checks, malformed versions, older versions, prereleases, and other minor or major versions select `npx --yes html-inbox@0.2.0`. Check that fallback's `--version` succeeds and prints exactly `0.2.0` before using it. Keep the version pinned; `latest` and unversioned npx are not this fallback.

Keep `HTML_INBOX_HOME`, `HTML_INBOX_PORT`, `HTML_INBOX_TAILSCALE_COMMAND`, and inherited authentication/environment settings unchanged for the check and every subsequent command. Preserve the selected library's `viewer-config.json`. Ordinary publish/start calls omit networking flags so the CLI retains saved exposure. A fallback does not authorize an exposure change.

## Bash or zsh

Run this in the shell that will execute the operation. `inbox` then invokes the selected command prefix with each argument preserved:

```bash
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("HTML Inbox requires Node.js 20 or newer"); process.exit(1); }' || exit 1

inbox_cli=(html-inbox)
if inbox_version=$(command html-inbox --version) && [[ $inbox_version =~ ^[[:space:]]*0[.]2[.](0|[1-9][0-9]*)[[:space:]]*$ ]]; then
  inbox_cli=(html-inbox)
else
  inbox_cli=(npx --yes html-inbox@0.2.0)
  inbox_version=$(command "${inbox_cli[@]}" --version) || exit 1

  if [[ ! $inbox_version =~ ^[[:space:]]*0[.]2[.]0[[:space:]]*$ ]]; then
    printf 'Unexpected HTML Inbox fallback version: %s\n' "$inbox_version" >&2
    exit 1
  fi
fi

inbox() {
  command "${inbox_cli[@]}" "$@"
}
```

## PowerShell on Windows

Replace `<installed-skill-directory>` with this skill's absolute installation path. Resolve native applications rather than aliases, functions, or npm's `.ps1` shims. The bundled [Windows dispatcher](../scripts/windows-cli.cjs) reads arguments as JSON and runs npm shims through their Node entry points. This avoids CMD reparsing filenames and titles containing shell-significant characters and works without changing PowerShell's script execution policy. Unsupported installed wrappers fail their check and select the npm fallback.

```powershell
$inboxNode = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$inboxNodeVersion = ((& $inboxNode.Source --version) -join "`n").Trim()
if ($LASTEXITCODE -ne 0 -or $inboxNodeVersion -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 20) {
  throw "HTML Inbox requires Node.js 20 or newer"
}

$inboxInstalled = Get-Command html-inbox -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$inboxExecutable = $null
$inboxPrefix = @()
$inboxRunner = Join-Path '<installed-skill-directory>' 'scripts/windows-cli.cjs'
if (-not (Test-Path -LiteralPath $inboxRunner -PathType Leaf)) { throw "Missing installed skill resource: $inboxRunner" }

function inbox {
  $inboxPreviousInvocation = $env:HTML_INBOX_SKILL_INVOCATION
  $env:HTML_INBOX_SKILL_INVOCATION = ConvertTo-Json -Compress -InputObject @{ command = $inboxExecutable; args = @($inboxPrefix + $args) }

  try {
    & $inboxNode.Source $inboxRunner
  } finally {
    $env:HTML_INBOX_SKILL_INVOCATION = $inboxPreviousInvocation
  }
}

if ($inboxInstalled) {
  $inboxExecutable = $inboxInstalled.Source
  try {
    $inboxVersion = ((inbox --version) -join "`n").Trim()

    if ($LASTEXITCODE -ne 0 -or $inboxVersion -notmatch '^0\.2\.(0|[1-9][0-9]*)$') {
      $inboxExecutable = $null
    }
  } catch {
    [Console]::Error.WriteLine("Installed HTML Inbox version check failed: $_")
    $inboxExecutable = $null
  }
}

if (-not $inboxExecutable) {
  $inboxExecutable = (Get-Command npx.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $inboxPrefix = @('--yes', 'html-inbox@0.2.0')
  $inboxVersion = ((inbox --version) -join "`n").Trim()

  if ($LASTEXITCODE -ne 0) { throw "HTML Inbox npm fallback failed; see the original npm error above" }
  if ($inboxVersion -cne '0.2.0') { throw "Unexpected HTML Inbox fallback version: $inboxVersion" }
}
```

Use `inbox publish ...`, `inbox viewer`, `inbox viewer status`, `inbox viewer stop`, and `inbox remote ...` throughout the operation. The skill's command examples use this wrapper. In a new shell or later operation, resolve again with the same inbox environment. Inspect or stop a detached viewer through the selected CLI even when the earlier npx invocation has exited. If calling commands directly, replace `inbox` with the complete selected prefix, including `--yes html-inbox@0.2.0` for the fallback.

Service status can use the selected prefix. Boot service installation and removal are separate, explicitly requested administrator operations through stable absolute Node and CLI paths in the [self-hosting guide](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md#start-at-boot). An npx cache path is not a durable service installation. A persistent CLI installation is needed only when the user chooses a boot service.

## Failures and older viewers

If npm, the registry, or the network fails, retain the original diagnostic and stop. Report the failed command and the missing prerequisite or npm failure. Retry only after that condition is resolved. A successful version check proves availability; publishing succeeds only when the publish command exits successfully and prints its document URL. Return no success URL after any failed command.

CLI compatibility does not prove an existing viewer's process identity or protocol compatibility. Status and stop can exit successfully while returning an `incompatible` or `conflict` JSON state. Inspect the state and reason; a zero exit code alone does not prove shutdown. If status/start/publish reports an older viewer or an unverified process record, leave its record and process intact. Stop the older viewer through its original executable or original foreground terminal, then retry resolution and startup. The resolver never deletes `viewer.json`, changes its PID, signals a recorded PID, or bypasses the CLI's private-control checks. Preserve the old executable until its viewer is stopped when updating skills or the CLI.

Separate manual recovery for an already-exited older viewer follows the [older-viewer instructions](https://github.com/deveshsangwan/html-inbox/blob/main/docs/self-hosting.md). Prove the recorded process is gone and its port is unused before removing only stale `viewer.json`. A fallback selection alone supplies neither proof.
