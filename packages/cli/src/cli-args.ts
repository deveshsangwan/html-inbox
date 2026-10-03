import { parseArgs } from "node:util";
import type { PublishRequest } from "./publish-input";
import type { RemoteInitOptions } from "./remote-workflow";
import type { ViewerExposure, ViewerNetworkOptions } from "./viewer-network";

export type CliCommand =
  | { command: "help" | "version" }
  | { command: "publish"; options: PublishRequest }
  | { command: "list"; json: boolean }
  | { command: "delete"; id: string; force: boolean; json: boolean }
  | { command: "export"; options: { outputDir: string; capability?: string; json: boolean } }
  | { command: "viewer"; action?: "status" | "stop"; foreground?: boolean; port?: number; exposure?: ViewerExposure; host?: string }
  | { command: "viewer service"; action: "install" | "uninstall" | "status"; user?: string; port?: number; exposure?: ViewerExposure; host?: string }
  | { command: "remote init"; options: RemoteInitOptions & { json: boolean } }
  | { command: "remote publish" | "remote status"; json: boolean }
  | { command: "remote reconcile"; adopt: boolean; recoverLock: boolean; json: boolean }
  | { command: "remote revoke"; yes: boolean; json: boolean };

export function parseCommand(argv: string[]): CliCommand {
  const name = argv[0] === "remote" ? `remote ${argv[1] ?? ""}` : argv[0];
  const args = argv.slice(argv[0] === "remote" ? 2 : 1);

  switch (name) {
    case undefined:
    case "--help":
    case "-h":
      parseArgs({ args, options: {} });
      return { command: "help" };

    case "--version":
    case "-v":
      parseArgs({ args, options: {} });
      return { command: "version" };

    case "publish": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { title: { type: "string" }, type: { type: "string" } },
      });

      return {
        command: name,
        options: {
          filePath: requirePositional(positionals, "publish requires one file path"),
          title: requireValue(values.title, "publish requires --title"),
          type: requireValue(values.type, "publish requires --type"),
        },
      };
    }

    case "list":
    case "remote publish":
    case "remote status": {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
      return { command: name, json: values.json ?? false };
    }

    case "delete": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { force: { type: "boolean" }, json: { type: "boolean" } },
      });

      return {
        command: name,
        id: requirePositional(positionals, "delete requires one document ID"),
        force: values.force ?? false,
        json: values.json ?? false,
      };
    }

    case "export": {
      const { values } = parseArgs({
        args,
        options: { out: { type: "string" }, capability: { type: "string" }, json: { type: "boolean" } },
      });

      return {
        command: name,
        options: {
          outputDir: requireValue(values.out, "export requires --out <directory>"),
          capability: values.capability === undefined
            ? undefined
            : requireValue(values.capability, "export --capability requires a value"),
          json: values.json ?? false,
        },
      };
    }

    case "viewer": {
      if (args[0] === "service") {
        const action = args[1];
        if (action !== "install" && action !== "uninstall" && action !== "status") {
          throw new Error("viewer service requires install, uninstall, or status");
        }

        if (action !== "install") {
          const { values } = parseArgs({ args: args.slice(2), options: { user: { type: "string" } } });
          const user = values.user === undefined ? undefined : requireValue(values.user, "viewer service --user requires a normal user name");
          return { command: "viewer service", action, ...(user ? { user } : {}) };
        }

        const { values } = parseArgs({ args: args.slice(2), options: { ...viewerNetworkFlags, user: { type: "string" } } });
        const user = values.user === undefined ? undefined : requireValue(values.user, "viewer service --user requires a normal user name");
        return { command: "viewer service", action, ...(user ? { user } : {}), ...parseViewerFlags(values) };
      }

      const { values, positionals } = parseArgs({
        args,
        options: { ...viewerNetworkFlags, foreground: { type: "boolean" } },
        allowPositionals: true,
      });
      const action = positionals[0];
      if (positionals.length > 1 || (action !== undefined && action !== "status" && action !== "stop")) {
        throw new Error("viewer accepts only status, stop, or service");
      }

      if (action !== undefined) {
        if (Object.keys(values).length > 0) {
          throw new Error(`viewer ${action} does not accept startup options`);
        }

        return { command: name, action };
      }

      return { command: name, ...(values.foreground ? { foreground: true } : {}), ...parseViewerFlags(values) };
    }

    case "remote init": {
      const { values } = parseArgs({
        args,
        options: {
          account: { type: "string" }, project: { type: "string" }, branch: { type: "string" },
          adopt: { type: "boolean" }, json: { type: "boolean" },
        },
      });

      return {
        command: name,
        options: {
          accountId: requireValue(values.account, "remote init requires --account <id>"),
          projectName: requireValue(values.project, "remote init requires --project <name>"),
          branch: values.branch === undefined
            ? undefined
            : requireValue(values.branch, "remote init --branch requires a value"),
          adopt: values.adopt ?? false,
          json: values.json ?? false,
        },
      };
    }

    case "remote reconcile": {
      const { values } = parseArgs({
        args,
        options: { adopt: { type: "boolean" }, "recover-lock": { type: "boolean" }, json: { type: "boolean" } },
      });

      return { command: name, adopt: values.adopt ?? false, recoverLock: values["recover-lock"] ?? false, json: values.json ?? false };
    }

    case "remote revoke": {
      const { values } = parseArgs({ args, options: { yes: { type: "boolean" }, json: { type: "boolean" } } });
      return { command: name, yes: values.yes ?? false, json: values.json ?? false };
    }

    default:
      throw new Error(`Unknown command: ${name?.trim()}. Run html-inbox --help for usage.`);
  }
}

function requireValue(value: string | undefined, message: string): string {
  if (!value?.trim()) {
    throw new Error(message);
  }

  return value;
}

function requirePositional(positionals: string[], message: string): string {
  if (positionals.length !== 1) {
    throw new Error(message);
  }

  return requireValue(positionals[0], message);
}

const viewerNetworkFlags = {
  port: { type: "string" },
  host: { type: "string" },
  loopback: { type: "boolean" },
  lan: { type: "boolean" },
  tailscale: { type: "boolean" },
} satisfies Record<string, { type: "string" | "boolean" }>;

function parseViewerFlags(values: { port?: string; host?: string; loopback?: boolean; lan?: boolean; tailscale?: boolean }) {
  if ([values.loopback, values.lan, values.tailscale].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --loopback, --lan, or --tailscale");
  }

  const exposure = values.loopback ? "loopback" : values.lan ? "lan" : values.tailscale ? "tailscale" : undefined;
  const host = values.host === undefined ? undefined : requireValue(values.host, "viewer --host requires an IP address");
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!/^[0-9]+$/.test(values.port ?? "") || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("viewer --port must be an integer from 1 to 65535");
  }

  return {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(exposure !== undefined ? { exposure } : {}),
  } satisfies Partial<ViewerNetworkOptions>;
}
