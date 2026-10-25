import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { createBrowserFixture, publishBrowserDocument } from "./browser-fixtures.mjs";

test("stored HTML cannot read deletion credentials or send a deletion command", { timeout: 30_000 }, async (t) => {
  const html = `<!doctype html><html><body><pre id="probe">pending</pre><script>
    const result = {};
    try { result.token = parent.document.querySelector('[data-delete-token]').dataset.deleteToken; }
    catch { result.token = 'blocked'; }
    parent.postMessage({ type: 'html-inbox:delete', id: 'anything' }, '*');
    fetch('/api/documents/anything', { method: 'DELETE', headers: { 'X-HTML-Inbox-CSRF': 'forged' } })
      .then(() => { result.request = 'allowed'; })
      .catch(() => { result.request = 'blocked'; })
      .finally(() => { document.querySelector('#probe').textContent = JSON.stringify(result); });
  </script></body></html>`;
  const f = await createBrowserFixture(t, "local", async (backend) => [
    await publishBrowserDocument(backend, "Isolation probe", "probe.html", html),
  ]);
  const mutationRequests = [];
  f.page.on("request", (request) => {
    if (request.method() === "DELETE") mutationRequests.push(request.url());
  });

  await f.page.goto(`${f.inboxUrl}documents/${f.documents[0].id}`);
  const probe = f.page.frameLocator("iframe").locator("#probe");
  await probe.getByText('"request":"blocked"', { exact: false }).waitFor();
  assert.deepEqual(JSON.parse(await probe.textContent()), { token: "blocked", request: "blocked" });
  assert.deepEqual(mutationRequests, []);
  assert(await new LocalDocumentBackend(f.home).getDocument(f.documents[0].id));
});

test("live deletion shells cannot be embedded by another page", { timeout: 30_000 }, async (t) => {
  const f = await createBrowserFixture(t, "local", async (backend) => [
    await publishBrowserDocument(backend, "Private shell", "shell.html", "<!doctype html><html><body>Report</body></html>"),
  ]);
  const attacker = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body><iframe src="${f.inboxUrl}"></iframe></body></html>`);
  });
  t.after(() => new Promise((resolve, reject) => attacker.close((error) => error ? reject(error) : resolve())));
  await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  const address = attacker.address();
  assert(address && typeof address !== "string");
  const refused = f.page.waitForEvent("console", {
    predicate: (message) => message.type() === "error" && message.text().includes("frame-ancestors"),
  });

  await f.page.goto(`http://127.0.0.1:${address.port}`);
  await refused;
  assert.equal(await f.page.locator(".doc__actions, [data-delete-document]").count(), 0);
  assert(await new LocalDocumentBackend(f.home).getDocument(f.documents[0].id));
});
