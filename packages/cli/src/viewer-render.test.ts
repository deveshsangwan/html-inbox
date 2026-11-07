import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type DocumentMetadata } from "./documents";
import { renderDocumentShell, renderHubIndex, renderIndex } from "./viewer-render";

const dates = [
  "2026-03-08T06:59:00.000Z",
  "2026-03-08T07:01:00.000Z",
  "2026-11-01T05:59:00.000Z",
  "2026-11-01T06:01:00.000Z",
  "2026-01-01T00:15:00+05:30",
  "2026-11-07T12:34:00",
  "2026-11-07",
  "invalid<&\"'",
  "",
];
const documents: DocumentMetadata[] = dates.map((createdAt, index) => ({
  schemaVersion: 1, id: `doc-${index}`, title: `Report ${index}`, type: "report",
  sourceFileName: "fixture.html", createdAt,
}));

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function originalDate(value: string, timeZone?: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

function renderedDates(html: string): string[] {
  return Array.from(html.matchAll(/<time\b[^>]*>(.*?)<\/time>/g), (match) => match[1]);
}

test("viewer, hub and static dates match the original formatter across runtime timezones", (t) => {
  const previousTimeZone = process.env.TZ;
  t.after(() => {
    if (previousTimeZone === undefined) {
      delete process.env.TZ;
      return;
    }

    process.env.TZ = previousTimeZone;
  });

  for (const runtimeTimeZone of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
    process.env.TZ = runtimeTimeZone;

    for (const timeZone of [undefined, "UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
      const expected = documents.map((document) => escapeHtml(originalDate(document.createdAt, timeZone)));
      assert.deepEqual(renderedDates(renderIndex(documents, "", { timeZone })), expected);
      assert.deepEqual(renderedDates(renderIndex(documents, "", {
        basePath: "/i/static", clientSearch: true, timeZone,
      })), expected);

      const hubDocuments = [...documents].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      assert.deepEqual(renderedDates(renderHubIndex([
        { name: "reports", available: true, documents },
      ], "", "", { timeZone })), hubDocuments.map((document) => escapeHtml(originalDate(document.createdAt, timeZone))));

      for (const document of documents) {
        assert.deepEqual(renderedDates(renderDocumentShell(document, { timeZone })), [escapeHtml(originalDate(document.createdAt, timeZone))]);
      }
    }
  }
});

test("formatters are lazy and bounded to one per render, including filtered results", (t) => {
  let constructions = 0;
  const Original = Intl.DateTimeFormat;
  t.mock.method(Intl, "DateTimeFormat", new Proxy(Original, {
    construct(target, args) {
      constructions += 1;
      return Reflect.construct(target, args);
    },
  }));
  const validDocuments = documents.slice(0, 7);

  renderIndex([], "", { timeZone: "invalid-zone" });
  renderIndex(documents.slice(7), "", { timeZone: "invalid-zone" });
  renderIndex(validDocuments, "no matches", { timeZone: "invalid-zone" });
  renderDocumentShell(documents[7], { timeZone: "invalid-zone" });
  assert.equal(constructions, 0);

  renderIndex(validDocuments, "");
  assert.equal(constructions, 1);
  renderIndex(validDocuments, "", { timeZone: "UTC", basePath: "/i/static" });
  assert.equal(constructions, 2);
  renderHubIndex([{ name: "reports", available: true, documents }], "", "");
  assert.equal(constructions, 3);
  renderDocumentShell(documents[0]);
  assert.equal(constructions, 4);
  assert.throws(() => renderIndex(validDocuments, "", { timeZone: "invalid-zone" }), RangeError);
});
