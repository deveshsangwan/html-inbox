import { strict as assert } from "node:assert";
import {
  assertDocumentMetadata,
  DOCUMENT_SCHEMA_VERSION,
  MAX_DOCUMENT_TITLE_LENGTH,
  validateHtml,
  validatePublishMetadata,
} from "./index";

assert.equal(validateHtml("<!doctype html><html><body>ok</body></html>").ok, true);
assert.equal(validateHtml("<html><body onclick='x()'></body></html>").ok, false);
for (const href of [
  "https://effect.website/docs/runtime/",
  "https://example.com/docs/page?q=effect#runtime",
  "./details.html",
  "/details",
  "?tab=details",
  "#runtime",
]) {
  assert.equal(validateHtml(`<html><a href="${href}">docs</a></html>`).ok, true);
}
for (const href of [
  "http://example.com",
  "//example.com",
  "javascript:alert(1)",
  "data:text/html,hello",
  "mailto:docs@example.com",
  "ftp://example.com/file",
]) {
  assert.deepEqual(validateHtml(`<html><a href="${href}">docs</a></html>`).errors, [
    "HTML links must use HTTPS, relative, or fragment URLs",
  ]);
}
for (const html of [
  '<html><img src="https://example.com/a.png"></html>',
  '<html><link rel="stylesheet" href="https://example.com/a.css"></html>',
  '<html><form action="https://example.com/submit"></form></html>',
  '<html><iframe src="https://example.com/frame"></iframe></html>',
  '<html><video poster="https://example.com/poster.png"></video></html>',
  '<html><video src="https://example.com/video.mp4"></video></html>',
  '<html><img srcset="https://example.com/a.png 1x"></html>',
  '<html><svg><use xlink:href="https://example.com/icon.svg#icon"></use></svg></html>',
]) {
  assert.equal(validateHtml(html).ok, false);
}
assert.equal(
  validateHtml(
    '<html><head><script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script></head></html>',
  ).ok,
  true,
);
assert.equal(
  validateHtml(
    '<html><head><script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script></head></html>',
  ).ok,
  true,
);
assert.equal(
  validateHtml(`<html><body><pre class="mermaid">graph LR; A-->B</pre><script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  </script></body></html>`).ok,
  true,
);
assert.equal(validateHtml('<html><script src="https://cdn.jsdelivr.net/npm/react@19"></script></html>').ok, false);
assert.equal(validateHtml('<html><script src="//cdn.tailwindcss.com"></script></html>').ok, false);
assert.equal(validateHtml('<html><img src="https://cdn.tailwindcss.com"></html>').ok, false);
assert.equal(
  validateHtml(
    '<html><script>import "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs"</script></html>',
  ).ok,
  false,
);

assert.equal(
  validatePublishMetadata({ title: "Report", type: "report", sourceFileName: "report.html" })
    .ok,
  true,
);
assert.equal(
  validatePublishMetadata({
    title: "x".repeat(MAX_DOCUMENT_TITLE_LENGTH + 1),
    type: "report",
    sourceFileName: "report.html",
  }).ok,
  false,
);

const legacyMetadata: unknown = {
  id: "legacy-id",
  title: "Legacy report",
  type: "report",
  createdAt: "2026-07-16T00:00:00.000Z",
  sourceFileName: "legacy.html",
};
assertDocumentMetadata(legacyMetadata);
assert.equal(legacyMetadata.schemaVersion, DOCUMENT_SCHEMA_VERSION);
