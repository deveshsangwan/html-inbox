import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { startViewer } from "../packages/cli/dist/viewer-server.js";
import { renderIndex } from "../packages/cli/dist/viewer-render.js";

test("browser theme, static search, and document isolation", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-browser-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const backend = new LocalDocumentBackend(home);
  const published = await backend.publish({
    title: "Quarterly Report",
    type: "report",
    sourceFileName: "results.html",
    originalBytes:
      Buffer.from(`<!doctype html><html><body><p id="isolation">loading</p><p id="network">loading</p><script>
      let isolated = false;
      try { parent.document.documentElement.dataset.compromised = 'yes'; } catch { isolated = true; }
      document.querySelector('#isolation').textContent = isolated ? 'isolated' : 'parent allowed';
      fetch('/health').then(() => document.querySelector('#network').textContent = 'network allowed')
        .catch(() => document.querySelector('#network').textContent = 'network blocked');
    </script></body></html>`),
  });
  const server = await startViewer(backend, home, 0);
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch(
    process.env.HTML_INBOX_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE }
      : {},
  );
  t.after(() => browser.close());
  const page = await browser.newPage({ colorScheme: "dark" });
  await page.goto(origin);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByText("Light", { exact: true }).click();
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");

  const documents = await backend.listDocuments();
  await page.route(`${origin}/static*`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: renderIndex(documents, "", { clientSearch: true }),
    }),
  );
  await page.goto(`${origin}/static?q=REPORT%20REPORT`);
  assert.equal(await page.locator("[data-search-text]:visible").count(), 1);
  await page.locator('input[name="q"]').fill("missing");
  assert.equal(await page.locator("[data-search-text]:visible").count(), 0);
  assert.equal(await page.locator("[data-client-empty]").isVisible(), true);
  assert.equal(new URL(page.url()).searchParams.get("q"), "missing");
  await page.locator("[data-search-clear]").click();
  assert.equal(await page.locator("[data-search-text]:visible").count(), 1);
  assert.equal(new URL(page.url()).searchParams.has("q"), false);
  assert.equal(await page.locator('input[name="q"]').inputValue(), "");

  await page.goto(`${origin}/?q=REPORT%20REPORT`);
  assert.equal(await page.locator("[data-search-text]").count(), 1);
  await page.goto(`${origin}/documents/${published.id}`);
  const frame = page.frameLocator("iframe");
  await frame.locator("#isolation").getByText("isolated", { exact: true }).waitFor();
  await frame.locator("#network").getByText("network blocked", { exact: true }).waitFor();
  assert.equal(
    await page.locator("html").getAttribute("data-compromised"),
    null,
  );
});
