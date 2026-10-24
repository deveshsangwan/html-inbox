import { parseArgs } from "node:util";
import { parseCanonicalFilePath } from "./sync-runtime-config";
import { parseInteger, parseUuid } from "./sync-model";

export type SyncCommand = (
  | { command: "sync enroll"; yes: boolean }
  | { command: "sync configure"; config: string }
  | { command: "sync status"; document?: string }
  | { command: "sync mapping add"; config: string }
  | { command: "sync mapping remove"; routeId: string; revision: number }
  | { command: "sync mapping reconnect"; routeId: string; revision: number; config: string }
  | { command: "sync target set"; destinationInboxId: string; peerId: string }
  | { command: "sync target clear" | "sync pause" | "sync resume" }
  | { command: "sync run"; routeId?: string }
  | { command: "sync retry"; routeId: string }
  | { command: "sync worker"; action: "enable" | "start" | "startup" | "status" | "stop" | "disable" | "wake"; foreground: boolean }
  | { command: "sync worker supervisor render"; platform: "systemd" | "launchd"; user: string }
  | { command: "sync worker supervisor status"; definition: string }
  | { command: "sync restore inspect" }
  | { command: "sync restore quarantine" | "sync fork"; expectedInboxId: string; yes: boolean }
) & { json: boolean };

export function parseSyncCommand(argv: string[]): SyncCommand {
  const action = argv[0];
  const jsonFlag = { json: { type: "boolean" } } satisfies Record<string, { type: "boolean" }>;
  if (action === "enroll") {
    const { values } = parseArgs({ args: argv.slice(1), options: { ...jsonFlag, yes: { type: "boolean" } } });
    return { command: "sync enroll", yes: values.yes ?? false, json: values.json ?? false };
  }

  if (action === "configure") {
    const { values } = parseArgs({ args: argv.slice(1), options: { ...jsonFlag, config: { type: "string" } } });
    return { command: "sync configure", config: parseCanonicalFilePath(values.config), json: values.json ?? false };
  }

  if (action === "status") {
    const { values } = parseArgs({ args: argv.slice(1), options: { ...jsonFlag, document: { type: "string" } } });
    return { command: "sync status", ...(values.document ? { document: values.document } : {}), json: values.json ?? false };
  }

  if (action === "mapping") {
    const operation = argv[1];
    if (operation === "add") {
      const { values } = parseArgs({ args: argv.slice(2), options: { ...jsonFlag, config: { type: "string" } } });
      return { command: "sync mapping add", config: parseCanonicalFilePath(values.config), json: values.json ?? false };
    }

    if (operation === "remove" || operation === "reconnect") {
      const { values, positionals } = parseArgs({ args: argv.slice(2), allowPositionals: true, options: { ...jsonFlag, revision: { type: "string" },
        ...(operation === "reconnect" ? { config: { type: "string" } } : {}) } });
      const routeId = parseUuid(singlePositional(positionals));
      const revision = parseCliNumber(values.revision, 1, Number.MAX_SAFE_INTEGER);
      return operation === "remove" ? { command: "sync mapping remove", routeId, revision, json: values.json ?? false } :
        { command: "sync mapping reconnect", routeId, revision, config: parseCanonicalFilePath(values.config), json: values.json ?? false };
    }
  }

  if (action === "target") {
    if (argv[1] === "clear") {
      const { values } = parseArgs({ args: argv.slice(2), options: jsonFlag });
      return { command: "sync target clear", json: values.json ?? false };
    }

    if (argv[1] === "set") {
      const { values, positionals } = parseArgs({ args: argv.slice(2), allowPositionals: true, options: { ...jsonFlag, peer: { type: "string" } } });
      return { command: "sync target set", destinationInboxId: parseUuid(singlePositional(positionals)), peerId: parseUuid(values.peer), json: values.json ?? false };
    }
  }

  if (action === "pause" || action === "resume") {
    const { values } = parseArgs({ args: argv.slice(1), options: jsonFlag });
    return { command: `sync ${action}`, json: values.json ?? false };
  }

  if (action === "run" || action === "retry") {
    const { values } = parseArgs({ args: argv.slice(1), options: { ...jsonFlag, route: { type: "string" } } });
    const routeId = values.route === undefined && action === "run" ? undefined : parseUuid(values.route);
    if (action === "retry") {
      return { command: "sync retry", routeId: parseUuid(routeId), json: values.json ?? false };
    }

    return { command: "sync run", ...(routeId ? { routeId } : {}), json: values.json ?? false };
  }

  if (action === "worker") {
    if (argv[1] === "supervisor") {
      if (argv[2] === "render") {
        const { values } = parseArgs({ args: argv.slice(3), options: { ...jsonFlag, platform: { type: "string" }, user: { type: "string" } } });
        if (values.platform !== "systemd" && values.platform !== "launchd") {
          throw new Error("Supervisor platform must be systemd or launchd");
        }

        if (!values.user || !/^[a-z_][a-z0-9_-]{0,62}$/.test(values.user) || values.user === "root") {
          throw new Error("Supervisor requires a normal user name");
        }

        return { command: "sync worker supervisor render", platform: values.platform, user: values.user, json: values.json ?? false };
      }

      if (argv[2] === "status") {
        const { values } = parseArgs({ args: argv.slice(3), options: { ...jsonFlag, definition: { type: "string" } } });
        return { command: "sync worker supervisor status", definition: parseCanonicalFilePath(values.definition), json: values.json ?? false };
      }
    }

    const operation = argv[1];
    if (operation === "enable" || operation === "start" || operation === "startup" || operation === "status" || operation === "stop" || operation === "disable" || operation === "wake") {
      const { values } = parseArgs({ args: argv.slice(2), options: { ...jsonFlag, ...(operation === "start" ? { foreground: { type: "boolean" } } : {}) } });
      return { command: "sync worker", action: operation, foreground: values.foreground === true, json: values.json ?? false };
    }
  }

  if (action === "restore" && argv[1] === "inspect") {
    const { values } = parseArgs({ args: argv.slice(2), options: jsonFlag });
    return { command: "sync restore inspect", json: values.json ?? false };
  }

  if (action === "fork" || action === "restore" && argv[1] === "quarantine") {
    const { values } = parseArgs({ args: argv.slice(action === "fork" ? 1 : 2), options: { ...jsonFlag, yes: { type: "boolean" }, "expect-inbox": { type: "string" } } });
    return { command: action === "fork" ? "sync fork" : "sync restore quarantine", expectedInboxId: parseUuid(values["expect-inbox"]), yes: values.yes ?? false, json: values.json ?? false };
  }

  throw new Error("Unknown sync command. Run html-inbox --help for usage.");
}

export function parseCliNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("Numeric flags require a bounded decimal integer");
  }

  return parseInteger(Number(value), minimum, maximum);
}

function singlePositional(values: string[]): string {
  if (values.length !== 1 || !values[0]) {
    throw new Error("Sync command requires exactly one identifier");
  }

  return values[0];
}
