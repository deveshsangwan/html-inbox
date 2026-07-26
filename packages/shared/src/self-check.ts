import { strict as assert } from "node:assert";
import {
  assertDocumentMetadata,
  DOCUMENT_SCHEMA_VERSION,
  MAX_DOCUMENT_TITLE_LENGTH,
  validateHtml,
  validatePublishMetadata,
} from "./index";

const clean = validateHtml("<!doctype html><html><body>ok</body></html>");
assert.equal(clean.ok, true);
assert.deepEqual(clean.warnings, []);

// Tier 1: blocking validation. These reach the user through gaps the
// sandboxed frame and the document CSP do not close, so they block publishing.
for (const html of [
  '<html><a href="javascript:alert(1)">x</a></html>',
  // Regression: a `>` inside an earlier attribute used to hide the anchor from
  // the tag matcher, which let this exact document publish.
  '<html><a title=">" href="javascript:alert(1)">x</a></html>',
  '<html><!--><a href="javascript:alert(1)">x</a></html>',
  '<html><!---><a href="javascript:alert(1)">x</a></html>',
  '<html><!-- test --!><a href="javascript:alert(1)">x</a></html>',
  '<html><a href="JaVaScRiPt:alert(1)">x</a></html>',
  // The HTML parser resolves entities and strips embedded control characters
  // before the URL parser sees the scheme.
  '<html><a href="&#106;avascript:alert(1)">x</a></html>',
  '<html><a href="java&Tab;script:alert(1)">x</a></html>',
  '<html><a href="vbscript:msgbox(1)">x</a></html>',
  '<html><a href="data:text/html,<h1>hi</h1>">x</a></html>',
  '<html><a href="file:///etc/passwd">x</a></html>',
  '<html><a href="ms-msdt:-id%20PCWDiagnostic">x</a></html>',
  '<html><a href="ftp://example.com/file">x</a></html>',
  '<html><form action="javascript:alert(1)"></form></html>',
  '<html><body><div onclick="x()"></div><a href="smb://host/share">x</a></body></html>',
  '<html><a href="http://example.com">x</a></html>',
  '<html><a href="//example.com">x</a></html>',
  '<html><a href="\\\\example.com">x</a></html>',
  '<html><a href="&bsol;&bsol;example.com">x</a></html>',
  '<html><a href="mailto:docs@example.com">x</a></html>',
  // The browser accepts a bare target and decodes the pragma before applying it.
  '<html><head><meta http-equiv="refresh" content="0;url=https://example.com/?d=leak"></head></html>',
  '<html><head><meta http-equiv="refresh" content="0;https://example.com/?d=leak"></head></html>',
  '<html><head><meta http-equiv="re&#x66;resh" content="0"></head></html>',
  '<html><head><meta http-equiv="&#114efresh" content="0"></head></html>',
  '<html><head><meta http-equiv="refresh" content="0;u&#114;l=https://example.com/"></head></html>',
]) {
  assert.equal(validateHtml(html).ok, false, `expected a security error for: ${html}`);
}

// Tier 2: advisory lint. The runtime already fails these closed, so they are
// reported but must not block publishing.
for (const html of [
  "<html><body onclick='x()'></body></html>",
  '<html><img src="https://example.com/a.png"></html>',
  '<html><link rel="stylesheet" href="https://example.com/a.css"></html>',
  '<html><form action="https://example.com/submit"></form></html>',
  '<html><iframe src="https://example.com/frame"></iframe></html>',
  '<html><video poster="https://example.com/poster.png"></video></html>',
  '<html><video src="https://example.com/video.mp4"></video></html>',
  '<html><img srcset="https://example.com/a.png 1x"></html>',
  '<html><svg><use xlink:href="https://example.com/icon.svg#icon"></use></svg></html>',
  '<html><base href="https://example.com/"></html>',
  '<html><a href="https://example.com" ping="https://metrics.example.com">x</a></html>',
  '<html><script src="data:text/javascript,alert(1)"></script></html>',
  '<html><object data="data:text/html,test"></object></html>',
  '<html><img src="blob:https://example.com/id"></html>',
  '<html><img src="https&colon;//example.com/a.png"></html>',
  '<html><img src="https:\\\\example.com/a.png"></html>',
  '<html><script src="https:\\\\example.com/evil.js"></script></html>',
  '<html><img src="https:&bsol;&bsol;example.com/a.png"></html>',
]) {
  const result = validateHtml(html);
  assert.equal(result.ok, true, `expected lint rather than an error for: ${html}`);
  assert.ok(result.warnings.length > 0, `expected a warning for: ${html}`);
}

for (const href of [
  "https://effect.website/docs/runtime/",
  "https://example.com/docs/page?q=effect#runtime",
  "./details.html",
  "/details",
  "?tab=details",
  "#runtime",
]) {
  const result = validateHtml(`<html><a href="${href}">docs</a></html>`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [], `expected no warning for: ${href}`);
}

// data: is inert for media but navigable in an anchor, so the tier depends on
// the attribute rather than the scheme alone.
const inlineImage = validateHtml('<html><img src="data:image/png;base64,iVBORw0KGgo="></html>');
assert.equal(inlineImage.ok, true);
assert.deepEqual(inlineImage.warnings, []);
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
// A blocked script source is a broken document, not a compromised one.
for (const html of [
  '<html><script src="https://cdn.jsdelivr.net/npm/react@19"></script></html>',
  '<html><script src="//cdn.tailwindcss.com"></script></html>',
  '<html><img src="https://cdn.tailwindcss.com"></html>',
  '<html><script>import "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs"</script></html>',
]) {
  const result = validateHtml(html);
  assert.equal(result.ok, true, `expected lint rather than an error for: ${html}`);
  assert.ok(result.warnings.length > 0, `expected a warning for: ${html}`);
}

// The scanner must not mistake markup inside a raw-text element for a tag.
assert.equal(
  validateHtml(`<html><body><script>const s = "<a href='javascript:alert(1)'>"</scr` + `ipt></body></html>`).ok,
  true,
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
