import path from "node:path";
import { realpath } from "node:fs/promises";
import { NodeCommandRunner, type CommandRunner } from "./command-runner";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { getOwnedWorkerStatus } from "./sync-worker-client";
import { assertExactKeys, parseChoice, parseObject, parseString, parseUuid } from "./sync-model";
import { readPublicSyncDefinition } from "./sync-public-definition";
import { inspectWorkerOwner } from "./sync-worker-records";

export interface SyncSupervisorDefinition {
  schemaVersion: 1;
  platform: "systemd" | "launchd";
  inboxId: string;
  home: string;
  user: string;
  nodePath: string;
  cliPath: string;
}

export async function createSyncSupervisorDefinition(home: string, platform: SyncSupervisorDefinition["platform"], user: string, cliPath = process.argv[1]) {
  const ledger = await assertManagedLifecycle(home);
  if (!ledger || !cliPath || !path.isAbsolute(cliPath)) {
    throw new Error("Supervisor rendering requires an enrolled inbox and an absolute CLI path");
  }

  if (!/^[a-z_][a-z0-9_-]{0,62}$/.test(user) || user === "root") {
    throw new Error("Sync supervisor requires a normal user name");
  }

  return { schemaVersion: 1, platform, inboxId: ledger.inboxId, home, user, nodePath: await realpath(process.execPath), cliPath: await realpath(cliPath) } satisfies SyncSupervisorDefinition;
}

export function renderSyncSupervisor(definition: SyncSupervisorDefinition): string {
  for (const value of [definition.home, definition.nodePath, definition.cliPath, definition.user]) {
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Supervisor paths and user must not contain control characters");
    }
  }

  if (![definition.home, definition.nodePath, definition.cliPath].every((value) => path.isAbsolute(value)) ||
      !/^[a-z_][a-z0-9_-]{0,62}$/.test(definition.user) || definition.user === "root") {
    throw new Error("Supervisor requires absolute paths and a normal user");
  }
  const label = `com.html-inbox.sync.${definition.inboxId}`;
  const metadata = Buffer.from(JSON.stringify(definition)).toString("base64url");
  const args = [definition.nodePath, definition.cliPath, "sync", "worker", "start", "--foreground", "--home", definition.home];
  const log = path.join(definition.home, "sync", "worker", "worker.log");
  if (definition.platform === "systemd") {
    const quote = (value: string, isCommand = false) => {
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
      return `"${isCommand ? escaped.replace(/\$/g, () => "$$") : escaped}"`;
    };
    const commandQuote = (value: string) => quote(value, true);
    return [`# html-inbox-sync-v1:${metadata}`, "[Unit]", `Description=HTML Inbox sync ${definition.inboxId}`, "Wants=network-online.target", "After=network-online.target", "StartLimitIntervalSec=60", "StartLimitBurst=5", "",
      "[Service]", "Type=exec", `User=${definition.user}`, `Group=${definition.user}`, `WorkingDirectory=${quote(definition.home)}`,
      `Environment=${quote(`HOME=${definition.home}`)}`, `Environment=${quote(`USER=${definition.user}`)}`, `Environment=${quote(`LOGNAME=${definition.user}`)}`,
      `Environment=${quote(`HTML_INBOX_HOME=${definition.home}`)}`, `Environment=${quote("HTML_INBOX_NAME=")}`, "Environment=NODE_ENV=production",
      `ExecStart=${args.map(commandQuote).join(" ")}`, "UMask=0077", "Restart=on-failure", "RestartSec=5", "TimeoutStartSec=20", "TimeoutStopSec=15", "KillMode=control-group",
      "StandardOutput=journal", "StandardError=journal", "", "[Install]", "WantedBy=multi-user.target", ""].join("\n");
  }

  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<plist version="1.0"><!-- html-inbox-sync-v1:${metadata} -->`, "<dict>",
    `<key>Label</key><string>${label}</string>`, `<key>UserName</key><string>${xml(definition.user)}</string>`,
    `<key>WorkingDirectory</key><string>${xml(definition.home)}</string>`, "<key>ProgramArguments</key><array>", ...args.map((arg) => `<string>${xml(arg)}</string>`), "</array>",
    `<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(definition.home)}</string><key>USER</key><string>${xml(definition.user)}</string><key>LOGNAME</key><string>${xml(definition.user)}</string><key>HTML_INBOX_HOME</key><string>${xml(definition.home)}</string><key>HTML_INBOX_NAME</key><string></string><key>NODE_ENV</key><string>production</string></dict>`,
    "<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>", "<key>ThrottleInterval</key><integer>5</integer>", "<key>ExitTimeOut</key><integer>15</integer>", "<key>Umask</key><integer>63</integer>",
    `<key>StandardOutPath</key><string>${xml(log)}</string>`, `<key>StandardErrorPath</key><string>${xml(log)}</string>`, "</dict></plist>", ""].join("\n");
}

export async function inspectSyncSupervisor(home: string, definitionPath: string, runner: CommandRunner = new NodeCommandRunner()) {
  const ledger = await assertManagedLifecycle(home);
  if (!ledger) {
    throw new Error("Supervisor inspection requires an enrolled inbox");
  }

  const contents = await readPublicSyncDefinition(definitionPath);
  const encoded = /html-inbox-sync-v1:([A-Za-z0-9_-]+)/.exec(contents)?.[1];
  if (!encoded) {
    throw new Error("Definition is not an owned HTML Inbox sync supervisor");
  }

  const value = parseObject(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), "supervisor definition");
  assertExactKeys(value, ["schemaVersion", "platform", "inboxId", "home", "user", "nodePath", "cliPath"]);
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported sync supervisor definition");
  }

  const definition: SyncSupervisorDefinition = { schemaVersion: 1, platform: parseChoice(value.platform, ["systemd", "launchd"]), inboxId: parseUuid(value.inboxId), home: parseString(value.home),
    user: parseString(value.user), nodePath: parseString(value.nodePath), cliPath: parseString(value.cliPath) };
  if (definition.home !== home || definition.inboxId !== ledger.inboxId || renderSyncSupervisor(definition) !== contents) {
    throw new Error("Supervisor definition content or inbox binding changed");
  }

  const expectedPath = definition.platform === "systemd" ? `/etc/systemd/system/html-inbox-sync-${ledger.inboxId}.service` : `/Library/LaunchDaemons/com.html-inbox.sync.${ledger.inboxId}.plist`;
  const command = definition.platform === "systemd" ? "/usr/bin/systemctl" : "/bin/launchctl";
  const args = definition.platform === "systemd" ? ["show", `html-inbox-sync-${ledger.inboxId}.service`, "--property=UnitFileState,ActiveState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload"] : ["print", `system/com.html-inbox.sync.${ledger.inboxId}`];
  const observation = await runner.run({ command, args, cwd: home, env: {}, timeoutMs: 3000 });
  let enabled = false;
  let pid = 0;
  let registeredPath = "";
  if (definition.platform === "systemd") {
    const fields = new Map(observation.stdout.trim().split("\n").map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    enabled = fields.get("UnitFileState") === "enabled" && fields.get("ActiveState") === "active" &&
      fields.get("DropInPaths") === "" && fields.get("NeedDaemonReload") === "no";
    pid = Number(fields.get("MainPID"));
    registeredPath = fields.get("FragmentPath") ?? "";
  } else {
    const disabled = await runner.run({ command, args: ["print-disabled", "system"], cwd: home, env: {}, timeoutMs: 3000 });
    const label = `com.html-inbox.sync.${ledger.inboxId}`;
    const envelope = /^\s*disabled services = \{([\s\S]*?)\}\s*$/.exec(disabled.stdout);
    let hasValidEnablement = disabled.code === 0 && envelope !== null;
    const entries = new Map<string, boolean>();
    for (const line of envelope?.[1].split("\n") ?? []) {
      if (!line.trim()) {
        continue;
      }

      const entry = /^\s*"([^"\r\n]+)"\s*=>\s*(true|false|enabled|disabled)\s*$/.exec(line);
      if (!entry || entries.has(entry[1])) {
        hasValidEnablement = false;
        break;
      }

      entries.set(entry[1], entry[2] === "true" || entry[2] === "disabled");
    }

    enabled = observation.stdout.includes("state = running") && hasValidEnablement && entries.get(label) !== true;
    pid = Number(/\bpid = (\d+)/.exec(observation.stdout)?.[1]);
    registeredPath = /\bpath = ([^\n]+)/.exec(observation.stdout)?.[1]?.trim() ?? "";
  }

  const worker = await getOwnedWorkerStatus(home);
  const owner = await inspectWorkerOwner(home);
  const bootSupervised = observation.code === 0 && enabled && registeredPath === definitionPath && definitionPath === expectedPath &&
    owner.state === "owned" && worker.running === true && owner.record?.pid === pid;
  return { definitionPath, platform: definition.platform, bootSupervised, manager: observation.code === 0 ? "observed" : "unknown", enabled,
    setupReasons: bootSupervised ? [] : ["Exact system boot definition, manager registration/enablement and matching owned process have not all been observed."] };
}
