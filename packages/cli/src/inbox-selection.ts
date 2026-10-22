import path from "node:path";
import { getInboxHome } from "./backend";
import { canonicalizeInboxHome, readInboxIdentity } from "./inbox-home";
import { getInboxCatalogHome, InboxInspectionError, inspectRegisteredInbox, readInboxCatalog, type NamedInbox } from "./inbox-catalog";

export interface InboxSelection {
  inbox?: string;
  home?: string;
}

export interface ResolvedInboxSelection {
  home: string;
  name?: string;
  instanceId?: string;
  source: "explicit" | "environment" | "default" | "legacy";
}

export async function resolveInboxSelection(
  selection: InboxSelection = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedInboxSelection> {
  const catalogHome = getInboxCatalogHome(env);
  const catalog = await readInboxCatalog(catalogHome);
  if (selection.inbox !== undefined || selection.home !== undefined) {
    return resolveSelectors(selection, catalog.inboxes, "explicit");
  }

  if (env.HTML_INBOX_NAME || env.HTML_INBOX_HOME) {
    // Relative HTML_INBOX_HOME keeps its legacy meaning, relative to this operation's cwd.
    const home = env.HTML_INBOX_HOME ? path.resolve(env.HTML_INBOX_HOME) : undefined;
    return resolveSelectors({ inbox: env.HTML_INBOX_NAME || undefined, home }, catalog.inboxes, "environment");
  }

  if (catalog.defaultName) {
    return resolveSelectors({ inbox: catalog.defaultName }, catalog.inboxes, "default");
  }

  const home = await canonicalizeInboxHome(getInboxHome(env), true);
  return { home, source: "legacy" };
}

async function resolveSelectors(
  selection: InboxSelection,
  inboxes: NamedInbox[],
  source: ResolvedInboxSelection["source"],
): Promise<ResolvedInboxSelection> {
  const home = selection.home === undefined ? undefined : await canonicalizeInboxHome(selection.home, true);
  if (selection.inbox !== undefined) {
    const entry = inboxes.find((candidate) => candidate.name === selection.inbox);
    if (!entry) {
      throw new Error(`Unknown inbox: ${selection.inbox}`);
    }

    if (home !== undefined && home !== entry.home) {
      throw new InboxInspectionError("conflict", `Inbox name ${selection.inbox} and home select different libraries`);
    }

    return { ...await inspectRegisteredInbox(entry), source };
  }

  if (home === undefined) {
    throw new Error("Inbox selection requires a name or home");
  }

  const entry = inboxes.find((candidate) => candidate.home === home);
  if (entry) {
    return { ...await inspectRegisteredInbox(entry), source };
  }

  const instanceId = await readInboxIdentity(home);
  if (instanceId && inboxes.some((candidate) => candidate.instanceId === instanceId)) {
    throw new InboxInspectionError("conflict", `Inbox home contains an identity registered at another location: ${home}`);
  }

  return { home, ...(instanceId ? { instanceId } : {}), source };
}
