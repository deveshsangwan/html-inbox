import type { CliCommand } from "./cli-args";
import path from "node:path";
import {
  clearDefaultInbox,
  createInbox,
  InboxInspectionError,
  inspectRegisteredInbox,
  readInboxCatalog,
  readNamedInbox,
  registerInbox,
  setDefaultInbox,
  type NamedInbox,
} from "./inbox-catalog";
import { getViewerStatus } from "./viewer-server";
import { readHubConfig, writeHubConfig } from "./hub-config";
import { startHub } from "./hub";
import { formatInboxCatalog, formatInboxReceipt } from "./cli-display";

export async function runInboxCommand(parsed: Extract<CliCommand, { command: `inbox ${string}` }>): Promise<void> {
  if (parsed.command === "inbox create" || parsed.command === "inbox register") {
    const operation = parsed.command === "inbox create" ? createInbox : registerInbox;
    const inbox = await operation(parsed.name, parsed.home);
    console.log(parsed.json ? JSON.stringify(inbox, null, 2) : formatInboxReceipt(parsed.command === "inbox create" ? "create" : "register", inbox));
    return;
  }

  if (parsed.command === "inbox default") {
    if (parsed.clear) {
      await clearDefaultInbox();
      console.log("Default cleared. Choose an inbox for each operation or set an explicit binding.");
      return;
    }

    if (!parsed.name) {
      throw new Error("inbox default requires a name");
    }

    await setDefaultInbox(parsed.name);
    console.log(`Default inbox: ${parsed.name}`);
    return;
  }

  if (parsed.command !== "inbox list") {
    throw new Error(`Unknown inbox command: ${parsed.command}`);
  }

  const catalog = await readInboxCatalog(undefined, { readOnly: true });
  const inboxes = await Promise.all(catalog.inboxes.map(async (inbox) => ({
    ...inbox,
    isDefault: inbox.name === catalog.defaultName,
    ...(await inspectInboxStatus(inbox)),
  })));
  const selected = parsed.running ? inboxes.filter((inbox) => inbox.state === "running" && "pid" in inbox && inbox.pid !== undefined) : inboxes;
  console.log(parsed.json ? JSON.stringify(selected, null, 2) : formatInboxCatalog(selected, parsed.running));
}

async function inspectInboxStatus(inbox: NamedInbox) {
  try {
    await inspectRegisteredInbox(inbox);
    return await getViewerStatus(inbox.home, undefined, { refreshLanUrls: false, readOnly: true, instanceId: inbox.instanceId });
  } catch (error) {
    return {
      state: error instanceof InboxInspectionError ? error.state : "incompatible",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runHubCommand(parsed: Extract<CliCommand, { command: "hub" | "hub init" }>): Promise<void> {
  if (!path.isAbsolute(parsed.config)) {
    throw new Error("--config requires an absolute path");
  }

  if (parsed.command === "hub init") {
    const sources: NamedInbox[] = [];
    for (const name of parsed.inboxes) {
      const entry = await readNamedInbox(name);
      if (!entry) {
        throw new Error(`Unknown inbox: ${name}`);
      }

      sources.push(await inspectRegisteredInbox(entry));
    }

    const config = await writeHubConfig(parsed.config, { schemaVersion: 1, name: parsed.name, sources });
    console.log(`Created ${config.name}: ${config.sources.map((source) => source.name).join(", ")}`);
    return;
  }

  const config = await readHubConfig(parsed.config);
  const hub = await startHub(config, { port: parsed.port, exposure: parsed.exposure, host: parsed.host });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= hub.close().catch((error: unknown) => {
      console.error(`html-inbox: Hub shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }).finally(() => {
      process.off("SIGTERM", close);
      process.off("SIGINT", close);
    });
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  hub.server.once("close", close);
  console.error(`html-inbox: ${config.name}. All reachable readers can read selected inboxes: ${config.sources.map((source) => source.name).join(", ")}`);
  console.log(hub.urls[0]);
}
