import type { DocumentMetadata } from "./documents";
import type { InboxInspectionState, NamedInbox } from "./inbox-catalog";
import type { ViewerServiceStatus } from "./viewer-service";
import type { ViewerStatus } from "./viewer-status";

export interface InboxCatalogDisplayEntry {
  name: string;
  isDefault: boolean;
  state: ViewerStatus["state"] | InboxInspectionState;
  url?: string;
  reason?: string;
}

export function formatViewerStatus(status: ViewerStatus, inbox?: string): string {
  const readerLabel = status.state === "running" ? "Reader" : "Configured reader";
  const lines = [
    `Inbox: ${inbox ?? "unnamed"}`,
    `Viewer: ${status.state}`,
    `${readerLabel}: ${status.url}`,
  ];

  if (status.reason) {
    lines.push(`Reason: ${formatDisplayText(status.reason)}`);
  }

  if (status.state === "stopped") {
    lines.push(`Start with html-inbox viewer${formatInboxSelector(inbox)}.`);
  } else if (status.state === "conflict") {
    lines.push("Resolve the viewer ownership or port conflict before starting this inbox's viewer.");
  } else if (status.state === "incompatible") {
    lines.push("Use a compatible HTML Inbox CLI and stop the older viewer before starting this inbox's viewer.");
  }

  return lines.join("\n");
}

export function formatViewerStopResult(status: ViewerStatus, inbox?: string): string {
  const outcome = status.state === "stopped" ? "Viewer stopped." : "Viewer shutdown was not confirmed.";

  return `${outcome}\n${formatViewerStatus(status, inbox)}`;
}

export function formatViewerServiceResult(
  action: "install" | "status" | "uninstall",
  status: ViewerServiceStatus,
  inbox?: string,
): string {
  const lines = [
    `Inbox: ${inbox ?? "unnamed"}`,
    `Viewer service: ${status.state === "not-installed" ? "not installed" : status.state}`,
    `Boot startup: ${status.enabled ? "enabled" : "disabled"}`,
  ];

  if (status.user) {
    lines.push(`User: ${status.user}`);
  }

  if (action === "uninstall" && status.state === "not-installed") {
    lines.push("Viewer service removed. Stored documents are preserved.");
  } else if (status.state === "not-installed" || status.state === "stopped") {
    lines.push(`Start at boot with html-inbox viewer service install${formatInboxSelector(inbox)}.`);
  } else if (status.state === "failed") {
    lines.push(`Inspect the service logs and definition at ${status.definitionPath}, then retry installation.`);
  }

  return lines.join("\n");
}

export function formatInboxCatalog(inboxes: readonly InboxCatalogDisplayEntry[], running = false): string {
  if (inboxes.length === 0) {
    return running
      ? "No registered inboxes are running. Run html-inbox inbox list to see all registered inboxes."
      : "No named inboxes. Use html-inbox inbox create <name> --home <absolute-path> or html-inbox inbox register <name> --home <absolute-path>.";
  }

  const names = inboxes.map((inbox) => `${inbox.name}${inbox.isDefault ? " (default)" : ""}`);
  const nameWidth = Math.max("NAME".length, ...names.map((name) => name.length));
  const stateWidth = Math.max("STATE".length, ...inboxes.map((inbox) => inbox.state.length));
  const lines = [
    `${"NAME".padEnd(nameWidth)}  ${"STATE".padEnd(stateWidth)}  READER`,
    ...inboxes.map((inbox, index) => {
      const reader = inbox.state === "running" ? inbox.url ?? "unavailable" : "-";

      return `${names[index].padEnd(nameWidth)}  ${inbox.state.padEnd(stateWidth)}  ${reader}`;
    }),
  ];

  for (const inbox of inboxes) {
    if (inbox.reason) {
      lines.push(`\n${inbox.name}: ${formatDisplayText(inbox.reason)}`);
    }
  }

  return lines.join("\n");
}

export function formatDocumentTable(documents: readonly DocumentMetadata[]): string {
  if (documents.length === 0) {
    return "No documents.";
  }

  const titles = documents.map((document) => formatDisplayText(document.title));
  const types = documents.map((document) => formatDisplayText(document.type));
  const dates = documents.map((document) => formatDisplayText(document.createdAt));
  const titleWidth = Math.max("TITLE".length, ...titles.map((title) => title.length));
  const typeWidth = Math.max("TYPE".length, ...types.map((type) => type.length));
  const dateWidth = Math.max("CREATED".length, ...dates.map((date) => date.length));

  return [
    `${"TITLE".padEnd(titleWidth)}  ${"TYPE".padEnd(typeWidth)}  ${"CREATED".padEnd(dateWidth)}  ID`,
    ...documents.map((document, index) =>
      `${titles[index].padEnd(titleWidth)}  ${types[index].padEnd(typeWidth)}  ${dates[index].padEnd(dateWidth)}  ${document.id}`,
    ),
  ].join("\n");
}

export function formatInboxReceipt(action: "create" | "register", inbox: NamedInbox): string {
  return [
    `${action === "create" ? "Created" : "Registered"} inbox: ${inbox.name}`,
    `Home: ${inbox.home}`,
    `Use html-inbox list --inbox ${inbox.name} to inspect this inbox.`,
  ].join("\n");
}

function formatInboxSelector(inbox?: string): string {
  return inbox ? ` --inbox ${inbox}` : " using the same inbox selection";
}

function formatDisplayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
