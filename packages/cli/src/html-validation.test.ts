import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseDocumentMetadata, DOCUMENT_SCHEMA_VERSION, MAX_DOCUMENT_TITLE_LENGTH, validatePublishMetadata } from "./documents";
import { validateHtml } from "./html-validation";

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
for (const html of [
  '<html><script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script></html>',
  '<html><script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script></html>',
  '<html><script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";</script></html>',
]) {
  const result = validateHtml(html);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [], `expected supported script without warnings: ${html}`);
}
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
assert.equal(parseDocumentMetadata(legacyMetadata).schemaVersion, DOCUMENT_SCHEMA_VERSION);
assert.equal("schemaVersion" in Object(legacyMetadata), false);

test("HTML requires a parsed document marker rather than matching text", () => {
  for (const html of ["<html-not-real>text</html-not-real>", "&lt;html&gt;", "<!-- <html> -->", "<script>const text = '<html>';</script>", "<!doctype html-not-real>"]) {
    assert.equal(validateHtml(html).ok, false, html);
  }

  for (const html of ["<HTML><body>ok</body></HTML>", "<!DOCTYPE html><p>ok</p>", "<html lang='en'><p>ok</p></html>"]) {
    assert.equal(validateHtml(html).ok, true, html);
  }
});

test("document-relative asset warnings explain the CSP and remediation without blocking publish", () => {
  for (const markup of [
    '<img src="chart.png">',
    '<img src="./assets/chart.png">',
    '<img src="../chart.png">',
    '<img src="/assets/chart.png">',
    '<img src="?chart=weekly">',
    '<img src="#chart">',
    '<img src="assets&sol;chart.png">',
    '<img src="assets\\chart.png">',
    '<script src="app.js"></script>',
    '<link rel="stylesheet" href="styles.css">',
    '<link rel="stylesheet" href="../styles/report.css">',
    '<link rel="alternate STYLESHEET" href="report.css">',
    '<link rel="icon" href="favicon.png">',
    '<link rel="preload" href="font.woff2" as="font">',
    '<video src="movie.mp4" poster="poster.png"></video>',
    '<audio src="audio.mp3"></audio>',
    '<video><source src="movie.webm"><track src="captions.vtt"></video>',
    '<input type="image" src="submit.png">',
    '<iframe src="frame.html"></iframe>',
    '<embed src="report.pdf">',
    '<object data="report.pdf"></object>',
    '<svg><image href="chart.svg"></image></svg>',
    '<svg><image xlink:href="chart.svg"></image></svg>',
    '<svg><use href="icons.svg#chart"></use></svg>',
    '<svg><use xlink:href="icons.svg#chart"></use></svg>',
  ]) {
    const result = validateHtml(`<!doctype html><html>${markup}</html>`);

    assert.equal(result.ok, true, markup);
    assert.deepEqual(result.errors, [], markup);
    assert.ok(result.warnings.length > 0, markup);
    assert.ok(result.warnings.every((warning) =>
      warning.includes("document-relative asset") &&
      warning.includes("CSP will block") &&
      warning.includes("only the HTML file is stored") &&
      /Embed|Inline/.test(warning),
    ), markup);
  }

  const script = validateHtml('<html><script src="app.js"></script></html>');
  const stylesheet = validateHtml('<html><link rel="stylesheet" href="styles.css"></html>');

  assert.match(script.warnings[0], /Inline the JavaScript or use a supported Tailwind or Mermaid script entry URL/);
  assert.match(stylesheet.warnings[0], /Inline stylesheet CSS in a <style> element/);
});

test("srcset warns for relative candidates even after an embedded or external image", () => {
  for (const markup of [
    '<img srcset="a">',
    '<img srcset="a 1x, b 2x">',
    '<img srcset="chart.png">',
    '<img srcset="chart.png 1x, chart@2x.png 2x">',
    '<img srcset="./small.png 320w, ../large.png 640w" sizes="100vw">',
    '<picture><source srcset="/small.webp 320w, /large.webp 640w"></picture>',
    '<img srcset="data:image/png;base64,iVBORw0KGgo= 1x, chart.png 2x">',
    '<img srcset="data:image/png;base64,iVBORw0KGgo=, chart.png 2x">',
    '<img srcset="chart.png 1x, data:image/png;base64,iVBORw0KGgo= 2x">',
    '<img srcset="https://example.com/chart.png 1x, chart.png 2x">',
    '<img srcset="chart.png 1x, https://example.com/chart.png 2x">',
    '<img srcset="data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, chart.png 2x">',
    '<img srcset="&#32;chart.png&#9;1x,&#10;large.png 2x">',
  ]) {
    const result = validateHtml(`<!doctype html><html>${markup}</html>`);

    assert.equal(result.ok, true, markup);
    assert.deepEqual(result.errors, [], markup);
    assert.ok(result.warnings.some((warning) =>
      warning.includes("srcset references a document-relative asset") &&
      warning.includes("Embed the resource"),
    ), markup);
  }
});

test("navigation, embedded resources, and supported CDN entry points have no relative-asset warnings", () => {
  for (const markup of [
    '<a href="chart.png">chart</a>',
    '<a href="./details.html">details</a>',
    '<a href="../details.html">details</a>',
    '<a href="/details">details</a>',
    '<a href="?tab=details">details</a>',
    '<a href="#chart">chart</a>',
    '<map><area href="details.html"><area href="#chart"></map>',
    '<svg><a href="#chart">chart</a><use href="#chart"></use></svg>',
    '<svg><use xlink:href=" &#35;chart "></use></svg>',
    '<img src="data:image/png;base64,iVBORw0KGgo=">',
    '<img srcset="data:image/png;base64,iVBORw0KGgo=">',
    '<img srcset="data:image/png;base64,iVBORw0KGgo= 1x, data:image/png;base64,iVBORw0KGgo= 2x">',
    '<picture><source srcset="data:image/webp;base64,UklGRg== 320w, data:image/webp;base64,UklGRg== 640w"></picture>',
    '<img srcset="data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x, data:image/png;base64,iVBORw0KGgo= 2x">',
    '<audio src="data:audio/mpeg;base64,AAAA"></audio>',
    '<video src="data:video/mp4;base64,AAAA" poster="data:image/png;base64,AAAA"></video>',
    '<svg><image href="data:image/png;base64,AAAA"></image></svg>',
    '<svg><image xlink:href="data:image/png;base64,AAAA"></image></svg>',
    '<svg><filter><feImage href="data:image/png;base64,AAAA"></feImage></filter></svg>',
    '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>',
    '<script src="https://cdn.tailwindcss.com"></script>',
    '<script src="https://cdn.tailwindcss.com?plugins=forms,typography"></script>',
    '<script type="module" src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"></script>',
    '<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";</script>',
    '<div src="chart.png" href="chart.png" data="chart.png"></div>',
    '<input type="text" src="chart.png">',
    '<link rel="canonical" href="report.html">',
    '<link rel="alternate" href="report.html">',
    '<img alt="chart.png"><script>const markup = \'<img src="chart.png">\';</script>',
    '<img src=""><img srcset=" ">',
  ]) {
    const result = validateHtml(`<!doctype html><html>${markup}</html>`);

    assert.equal(result.ok, true, markup);
    assert.deepEqual(result.errors, [], markup);
    assert.deepEqual(result.warnings, [], markup);
  }
});

test("srcset keeps executable schemes blocking even in a later candidate", () => {
  for (const value of [
    "javascript:alert(1) 1x",
    "data:image/png;base64,AAAA 1x, javascript:alert(1) 2x",
    "chart.png 1x, &#106;avascript:alert(1) 2x",
    "chart.png 1x, vbscript:msgbox(1) 2x",
  ]) {
    const result = validateHtml(`<html><img srcset="${value}"></html>`);

    assert.equal(result.ok, false, value);
    assert.ok(result.errors.some((error) => /must not use (javascript|vbscript):/.test(error)), value);
  }
});

test("invalid srcset descriptors are ignored without changing the advisory result", () => {
  const result = validateHtml('<html><img srcset="ignored.png invalid, chart.png 2x"></html>');

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /srcset references a document-relative asset/);
});

test("repeated relative assets produce one warning per element and attribute", () => {
  const result = validateHtml(`<html>
    <img src="chart.png"><img src="other-chart.png">
    <img srcset="small.png 1x, large.png 2x">
    <img srcset="other-small.png 1x, other-large.png 2x">
  </html>`);

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 2);
});
