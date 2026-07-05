import { strict as assert } from "node:assert";
import { validateHtml } from "./index";

assert.equal(validateHtml("<!doctype html><html><body>ok</body></html>").ok, true);
assert.equal(validateHtml("<html><script>alert(1)</script></html>").ok, false);
assert.equal(validateHtml("<html><body onclick='x()'></body></html>").ok, false);
assert.equal(validateHtml('<html><img src="https://example.com/a.png"></html>').ok, false);
