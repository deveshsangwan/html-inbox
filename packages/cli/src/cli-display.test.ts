import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDocumentTable,
  formatInboxCatalog,
  formatInboxReceipt,
  formatViewerServiceResult,
  formatViewerStatus,
  formatViewerStopResult,
  type InboxCatalogDisplayEntry,
} from "./cli-display";
import type { DocumentMetadata } from "./documents";
import type { ViewerServiceStatus } from "./viewer-service";
import type { ViewerStatus } from "./viewer-status";

const viewer: ViewerStatus = {
  state: "running",
  url: "http://127.0.0.1:4321",
  urls: ["http://127.0.0.1:4321"],
  exposure: "loopback",
  port: 4321,
  pid: 4242,
};

const service: ViewerServiceStatus = {
  state: "running",
  enabled: true,
  definitionPath: "/etc/systemd/system/html-inbox-viewer.service",
  user: "alice",
  pid: 4242,
};

test("viewer status names the inbox and reader without dumping lifecycle records", () => {
  const status = {
    ...viewer,
    instanceId: "7c8d868e-ddb4-48b2-b165-03262a0f9ee6",
    controlUrl: "http://127.0.0.1:54321/private-control",
  };

  assert.equal(formatViewerStatus(status, "office"), [
    "Inbox: office",
    "Viewer: running",
    "Reader: http://127.0.0.1:4321",
  ].join("\n"));
  assert.match(formatViewerStatus(viewer), /^Inbox: unnamed\n/);
});

test("stopped and unverified viewer states label configured URLs and give next steps", () => {
  const stopped = formatViewerStatus({ ...viewer, state: "stopped" }, "office");
  assert.match(stopped, /Viewer: stopped\nConfigured reader: http:\/\/127\.0\.0\.1:4321/);
  assert.match(stopped, /Start with html-inbox viewer --inbox office\./);

  const conflict = formatViewerStatus({ ...viewer, state: "conflict", reason: "Viewer belongs to another inbox" }, "office");
  assert.match(conflict, /Viewer: conflict/);
  assert.match(conflict, /Reason: Viewer belongs to another inbox/);
  assert.match(conflict, /Resolve the viewer ownership or port conflict/);

  const incompatible = formatViewerStatus({ ...viewer, state: "incompatible" }, "office");
  assert.match(incompatible, /Viewer: incompatible/);
  assert.match(incompatible, /compatible HTML Inbox CLI/);
});

test("stop receipts report the returned state rather than assuming success", () => {
  assert.match(formatViewerStopResult({ ...viewer, state: "stopped" }, "office"), /^Viewer stopped\.\nInbox: office/);

  for (const state of ["running", "conflict", "incompatible"] satisfies ViewerStatus["state"][]) {
    const output = formatViewerStopResult({ ...viewer, state }, "office");

    assert.match(output, /^Viewer shutdown was not confirmed\./);
    assert.ok(output.includes(`Viewer: ${state}`));
  }
});

test("service receipts describe installation state, startup setting and selected account", () => {
  assert.equal(formatViewerServiceResult("install", service, "office"), [
    "Inbox: office",
    "Viewer service: running",
    "Boot startup: enabled",
    "User: alice",
  ].join("\n"));

  const stopped = formatViewerServiceResult("status", { ...service, state: "stopped", enabled: false }, "office");
  assert.match(stopped, /Viewer service: stopped\nBoot startup: disabled/);
  assert.match(stopped, /html-inbox viewer service install --inbox office/);

  const failed = formatViewerServiceResult("status", { ...service, state: "failed" }, "office");
  assert.match(failed, /Viewer service: failed/);
  assert.ok(failed.includes(`Inspect the service logs and definition at ${service.definitionPath}`));

  const absent: ViewerServiceStatus = { state: "not-installed", enabled: false, definitionPath: service.definitionPath };
  assert.match(formatViewerServiceResult("status", absent), /Inbox: unnamed\nViewer service: not installed/);
  assert.match(formatViewerServiceResult("status", absent), /viewer service install/);
  assert.match(formatViewerServiceResult("uninstall", absent, "office"), /Viewer service removed\. Stored documents are preserved\./);
  assert.doesNotMatch(formatViewerServiceResult("uninstall", absent, "office"), /retry installation|viewer service install/);
  assert.doesNotMatch(formatViewerServiceResult("uninstall", { ...service, state: "failed" }, "office"), /service removed/);
});

test("catalog columns align and only running readers appear as links", () => {
  const inboxes = [
    { name: "office", isDefault: true, state: "running", url: "https://office.example.test" },
    { name: "home", isDefault: false, state: "stopped", url: "http://127.0.0.1:4321" },
    { name: "archive", isDefault: false, state: "missing", reason: "Library home is missing" },
    { name: "conflict", isDefault: false, state: "conflict", reason: "Inbox identity changed", url: "http://127.0.0.1:4322" },
    { name: "old", isDefault: false, state: "incompatible", reason: "Older viewer process record" },
  ] satisfies InboxCatalogDisplayEntry[];

  assert.equal(formatInboxCatalog(inboxes), [
    "NAME              STATE         READER",
    "office (default)  running       https://office.example.test",
    "home              stopped       -",
    "archive           missing       -",
    "conflict          conflict      -",
    "old               incompatible  -",
    "",
    "archive: Library home is missing",
    "",
    "conflict: Inbox identity changed",
    "",
    "old: Older viewer process record",
  ].join("\n"));
});

test("catalog messages distinguish an empty catalog from an empty running result", () => {
  assert.match(formatInboxCatalog([]), /No named inboxes/);
  assert.match(formatInboxCatalog([]), /inbox create <name> --home <absolute-path>/);
  assert.match(formatInboxCatalog([]), /inbox register <name> --home <absolute-path>/);
  assert.equal(formatInboxCatalog([], true), "No registered inboxes are running. Run html-inbox inbox list to see all registered inboxes.");
});

test("catalog formatting ignores private homes, IDs and control endpoints", () => {
  const inboxes = [{
    name: "office",
    isDefault: false,
    state: viewer.state,
    url: viewer.url,
    home: "/private/office",
    instanceId: "7c8d868e-ddb4-48b2-b165-03262a0f9ee6",
    controlUrl: "http://127.0.0.1:54321/private-control",
  }];

  const output = formatInboxCatalog(inboxes, true);

  assert.ok(output.includes(viewer.url));
  assert.doesNotMatch(output, /private|7c8d868e|54321/);
});

test("document tables label title, type and complete copyable IDs", () => {
  const documents: DocumentMetadata[] = [
    { schemaVersion: 1, id: "doc_1-abc", title: "Quarterly report", type: "report", createdAt: "2026-10-23T00:00:00Z", sourceFileName: "quarterly.html" },
    { schemaVersion: 1, id: "7c8d868e-ddb4-48b2-b165-03262a0f9ee6", title: "Note", type: "note", createdAt: "2026-10-22T00:00:00Z", sourceFileName: "note.html" },
  ];

  assert.equal(formatDocumentTable(documents), [
    "TITLE             TYPE    ID",
    "Quarterly report  report  doc_1-abc",
    "Note              note    7c8d868e-ddb4-48b2-b165-03262a0f9ee6",
  ].join("\n"));
  assert.equal(formatDocumentTable([]), "No documents.");
});

test("human rows and reasons keep metadata line breaks and control characters out of columns", () => {
  const documents: DocumentMetadata[] = [{
    schemaVersion: 1, id: "copyable-id", title: "Quarterly\nreport\t\u001b", type: "monthly\rreport",
    createdAt: "2026-10-23T00:00:00Z", sourceFileName: "report.html",
  }];

  const table = formatDocumentTable(documents);
  const status = formatViewerStatus({ ...viewer, reason: "Missing\r\nprocess\tidentity\u0000" }, "office");

  assert.equal(table.split("\n").length, 2);
  assert.match(table, /Quarterly report/);
  assert.match(table, /monthly report  copyable-id/);
  assert.doesNotMatch(table, /[\r\t\u001b]/);
  assert.match(status, /Reason: Missing process identity$/);
  assert.doesNotMatch(status, /[\r\t\u0000]/);
});

test("created and registered inbox receipts show a home and explicit selector without identity dumps", () => {
  const inbox = { name: "office", home: "/libraries/office", instanceId: "7c8d868e-ddb4-48b2-b165-03262a0f9ee6" };

  for (const action of ["create", "register"] satisfies ("create" | "register")[]) {
    const output = formatInboxReceipt(action, inbox);

    assert.equal(output, [
      `${action === "create" ? "Created" : "Registered"} inbox: office`,
      "Home: /libraries/office",
      "Use html-inbox list --inbox office to inspect this inbox.",
    ].join("\n"));
    assert.doesNotMatch(output, /7c8d868e|default/);
  }
});
