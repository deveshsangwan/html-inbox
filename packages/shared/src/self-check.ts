import { strict as assert } from "node:assert";
import { validateHtml } from "./index";

assert.equal(validateHtml("<!doctype html><html><body>ok</body></html>").ok, true);
assert.equal(validateHtml("<html><body onclick='x()'></body></html>").ok, false);
assert.equal(validateHtml('<html><img src="https://example.com/a.png"></html>').ok, false);
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
