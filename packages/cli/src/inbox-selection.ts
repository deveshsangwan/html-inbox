import { assertManagedLifecycle } from "./sync-lifecycle";
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

export interface InboxSelectionOptions {
  requireSelection?: boolean;
  chooseInbox?: (inboxes: readonly NamedInbox[]) => Promise<string>;
  inspectHome?: (home: string) => Promise<{ home: string; instanceId?: string }>;
}

export class InboxSelectionRequiredError extends Error {
  readonly availableNames: readonly string[];

  constructor(availableNames: readonly string[]) {
    super(`Inbox selection required. Available inboxes: ${availableNames.join(", ")}. Use --inbox <name> to choose an inbox for this operation.`);
    this.name = "InboxSelectionRequiredError";
    this.availableNames = [...availableNames];
  }
}

export async function resolveInboxSelection(
  selection: InboxSelection = {},
  env: NodeJS.ProcessEnv = process.env,
  legacyHome?: string,
  options: InboxSelectionOptions = {},
): Promise<ResolvedInboxSelection> {
  const catalogHome = getInboxCatalogHome(env);
  const hasExplicitSelection = selection.inbox !== undefined || selection.home !== undefined;
  const hasEnvironmentSelection = Boolean(env.HTML_INBOX_NAME || env.HTML_INBOX_HOME);
  const catalogOptions = { includeDefault: !hasExplicitSelection && !hasEnvironmentSelection, readOnly: true };
  const catalog = await readInboxCatalog(catalogHome, catalogOptions);
  if (hasExplicitSelection) {
    return resolveSelectors(selection, catalog.inboxes, "explicit", options.inspectHome);
  }

  if (hasEnvironmentSelection) {
    // Relative HTML_INBOX_HOME keeps its legacy meaning, relative to this operation's cwd.
    const home = env.HTML_INBOX_HOME ? path.resolve(env.HTML_INBOX_HOME) : undefined;
    return resolveSelectors({ inbox: env.HTML_INBOX_NAME || undefined, home }, catalog.inboxes, "environment", options.inspectHome);
  }

  if (catalog.defaultName) {
    return resolveSelectors({ inbox: catalog.defaultName }, catalog.inboxes, "default", options.inspectHome);
  }

  if (catalog.inboxes.length > 0) {
    if (options.chooseInbox) {
      // A chooser may wait while the catalog changes. Keep its entries separate from the captured bindings.
      const name = await options.chooseInbox(catalog.inboxes.map((entry) => ({ ...entry })));
      return resolveSelectors({ inbox: name }, catalog.inboxes, "explicit", options.inspectHome);
    }

    if (options.requireSelection) {
      throw new InboxSelectionRequiredError(catalog.inboxes.map((entry) => entry.name));
    }
  }

  return resolveSelectors({ home: legacyHome ?? getInboxHome(env) }, catalog.inboxes, "legacy", options.inspectHome);
}

async function resolveSelectors(
  selection: InboxSelection,
  inboxes: readonly NamedInbox[],
  source: ResolvedInboxSelection["source"],
  inspectHome?: InboxSelectionOptions["inspectHome"],
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

    return { ...await inspectRegisteredInbox(entry, inspectHome), source };
  }

  if (home === undefined) {
    throw new Error("Inbox selection requires a name or home");
  }

  const requestedHome = path.resolve(selection.home ?? home);
  const entry = inboxes.find((candidate) => candidate.home === requestedHome)
    ?? inboxes.find((candidate) => candidate.home === home);
  if (entry) {
    return { ...await inspectRegisteredInbox(entry, inspectHome), source };
  }

  const inspected = inspectHome ? await inspectHome(home) : undefined;
  if (inspected && inspected.home !== home) {
    throw new InboxInspectionError("conflict", "Selected home has a different canonical location");
  }

  const instanceId = inspected ? inspected.instanceId : await readInboxIdentity(home);
  if (instanceId && inboxes.some((candidate) => candidate.instanceId === instanceId)) {
    throw new InboxInspectionError("conflict", `Inbox home contains an identity registered at another location: ${home}`);
  }

  if (!inspectHome) {
    await assertManagedLifecycle(home);
  }

  return { home, ...(instanceId ? { instanceId } : {}), source };
}
