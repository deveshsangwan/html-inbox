import assert from "node:assert/strict";
import { mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { getInboxInstanceId } from "../packages/cli/dist/viewer-records.js";
import { startHub } from "../packages/cli/dist/hub.js";
import { isolationHtml } from "./browser-fixtures.mjs";

test("hub dropdown applies filters immediately and preserves query, history and keyboard focus", { timeout: 30_000 }, async (t) => {
  const { page, context, origin } = await createFilterFixture(t);
  const inbox = page.getByRole("combobox", { name: "Inbox", exact: true });
  const search = page.getByRole("searchbox", { name: "Search documents" });

  await page.goto(origin);
  await assertFilterResults(page, "", "", ["home note", "home report", "office report"], "3 documents");
  await waitForReload(page, () => inbox.selectOption("home"));
  await assertFilterResults(page, "home", "", ["home note", "home report"], "2 documents");
  assert.equal(await inbox.evaluate((element) => element === document.activeElement), true);

  // A dropdown change also submits text that has not yet been searched.
  await search.fill("report");
  await waitForReload(page, () => inbox.selectOption("office"));
  await assertFilterResults(page, "office", "report", ["office report"], "1 of 1 documents");
  const sharedUrl = page.url();
  await waitForReload(page, () => inbox.selectOption(""));
  await assertFilterResults(page, "", "report", ["home report", "office report"], "2 of 3 documents");
  await waitForReload(page, () => inbox.selectOption("scratch"));
  await assertFilterResults(page, "scratch", "report", [], "0 of 0 documents");
  assert.equal(await page.getByRole("heading", { name: "No matching documents in scratch.", exact: true }).count(), 1);

  await page.goBack();
  await assertFilterResults(page, "", "report", ["home report", "office report"], "2 of 3 documents");
  await page.goBack();
  await assertFilterResults(page, "office", "report", ["office report"], "1 of 1 documents");
  await page.goForward();
  await assertFilterResults(page, "", "report", ["home report", "office report"], "2 of 3 documents");
  await page.reload();
  await assertFilterResults(page, "", "report", ["home report", "office report"], "2 of 3 documents");

  const sharedPage = await context.newPage();
  await sharedPage.goto(sharedUrl);
  await assertFilterResults(sharedPage, "office", "report", ["office report"], "1 of 1 documents");
  await sharedPage.close();

  await inbox.focus();
  await waitForReload(page, () => inbox.press("ArrowDown"));
  await assertFilterResults(page, "home", "report", ["home report"], "1 of 2 documents");
  assert.equal(await inbox.evaluate((element) => element === document.activeElement), true);
  await inbox.press("Tab");
  assert.equal(await search.evaluate((element) => element === document.activeElement), true);
  await search.fill("");
  await waitForReload(page, () => inbox.selectOption("scratch"));
  await assertFilterResults(page, "scratch", "", [], "0 documents");
  assert.equal(await page.getByRole("heading", { name: "No documents in scratch.", exact: true }).count(), 1);

  const description = await inbox.evaluate((element) => element.getAttribute("aria-describedby")
    .split(/\s+/).map((id) => document.getElementById(id).textContent).join(" "));
  assert.match(description, /use Search if results do not reload automatically/);
  assert.match(description, /0 documents/);
  assert.match(description, /No documents in scratch\./);

  await search.fill("note");
  await waitForReload(page, () => page.getByRole("button", { name: "Search", exact: true }).click());
  await assertFilterResults(page, "scratch", "note", [], "0 of 0 documents");
  await waitForReload(page, () => inbox.selectOption("home"));
  await assertFilterResults(page, "home", "note", ["home note"], "1 of 2 documents");
  await search.fill("report");
  await waitForReload(page, () => search.press("Enter"));
  await assertFilterResults(page, "home", "report", ["home report"], "1 of 2 documents");
});

test("hub GET search works with JavaScript disabled through Search and Enter", { timeout: 30_000 }, async (t) => {
  const { page, origin } = await createFilterFixture(t, { javaScriptEnabled: false });
  const inbox = page.getByRole("combobox", { name: "Inbox", exact: true });
  const search = page.getByRole("searchbox", { name: "Search documents" });

  await page.goto(origin);
  await inbox.selectOption("home");
  await search.fill("report");
  assert.equal(await page.locator("[data-search-text]").count(), 3);
  await waitForReload(page, () => page.getByRole("button", { name: "Search", exact: true }).click());
  await assertFilterResults(page, "home", "report", ["home report"], "1 of 2 documents");

  await inbox.selectOption("office");
  await waitForReload(page, () => search.press("Enter"));
  await assertFilterResults(page, "office", "report", ["office report"], "1 of 1 documents");
  await inbox.selectOption("");
  await waitForReload(page, () => search.press("Enter"));
  await assertFilterResults(page, "", "report", ["home report", "office report"], "2 of 3 documents");
});

async function waitForReload(page, change) {
  await Promise.all([page.waitForEvent("load"), change()]);
}

async function assertFilterResults(page, inbox, query, titles, count) {
  assert.equal(await page.getByRole("combobox", { name: "Inbox", exact: true }).inputValue(), inbox);
  assert.equal(await page.getByRole("searchbox", { name: "Search documents" }).inputValue(), query);
  assert.equal(new URL(page.url()).searchParams.get("inbox") ?? "", inbox);
  assert.equal(new URL(page.url()).searchParams.get("q") ?? "", query);
  const actualTitles = await page.locator(".doc__title").evaluateAll((links) => links.map((link) => {
    const title = link.cloneNode(true);
    title.querySelectorAll(".inbox-badge").forEach((badge) => badge.remove());

    return title.textContent.trim();
  }));
  assert.deepEqual(actualTitles.sort(), titles);
  assert.equal(await page.locator("[data-document-count]").textContent(), count);
}

async function createFilterFixture(t, contextOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-filter-browser-")));
  let browser;
  let hub;
  t.after(async () => {
    await browser?.close();
    await hub?.close();
    await rm(root, { recursive: true, force: true });
  });

  const sources = [];
  for (const name of ["home", "office", "scratch"]) {
    const home = path.join(root, name);
    const instanceId = await getInboxInstanceId(home);
    const backend = new LocalDocumentBackend(home);

    for (const type of name === "home" ? ["report", "note"] : name === "office" ? ["report"] : []) {
      await backend.publish({
        originalBytes: Buffer.from("<!doctype html><html><body>Document</body></html>"),
        title: `${name} ${type}`, type, sourceFileName: `${type}.html`,
      });
    }

    sources.push({ name, home, instanceId });
  }

  hub = await startHub({ schemaVersion: 1, name: "Filter test", sources }, 0);
  browser = await chromium.launch(process.env.HTML_INBOX_BROWSER_EXECUTABLE ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE } : {});
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);

  return { page, context, origin: hub.urls[0] };
}

test("hub reads colliding source IDs with search, filters, isolation and partial failure", { timeout: 30_000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-hub-browser-")));
  let browser;
  let hub;
  t.after(async () => {
    await browser?.close();
    await hub?.close();
    await rm(root, { recursive: true, force: true });
  });

  const sources = [];
  for (const name of ["home", "office"]) {
    const home = path.join(root, name);
    await new LocalDocumentBackend(home, undefined, () => "same-id").publish({
      originalBytes: Buffer.from(name === "home" ? isolationHtml : "<!doctype html><html><body><h1>Office content</h1><pre><code>  office();\n\treturn;  \n</code></pre></body></html>"),
      title: `${name} report`, type: "report", sourceFileName: `${name}.html`,
    });
    sources.push({ name, home, instanceId: await getInboxInstanceId(home) });
  }

  const hubName = "Development ".repeat(16).trim();
  hub = await startHub({ schemaVersion: 1, name: hubName, sources }, 0);
  const origin = hub.urls[0];
  browser = await chromium.launch(process.env.HTML_INBOX_BROWSER_EXECUTABLE ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    if (window !== window.top) {
      return;
    }

    window.copyWrites = [];
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText(text) { window.copyWrites.push(text); return Promise.resolve(); },
    } });
  });
  page.setDefaultTimeout(10_000);
  await page.goto(origin);
  assert.equal(await page.getByRole("heading", { name: hubName, exact: true }).count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.getByRole("link", { name: /^home report/ }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /^office report/ }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /^home report/ }).getAttribute("href"), "/sources/home/documents/same-id");
  assert.equal(await page.getByRole("link", { name: /^office report/ }).getAttribute("href"), "/sources/office/documents/same-id");

  await page.goto(`${origin}/?q=office`);
  assert.equal(await page.getByRole("link", { name: /^office report/ }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /^home report/ }).count(), 0);
  await page.setViewportSize({ width: 1280, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/?inbox=home`);
  assert.equal(await page.getByRole("link", { name: /^home report/ }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /^office report/ }).count(), 0);

  await page.getByRole("link", { name: /^home report/ }).click();
  const frame = page.frameLocator("iframe");
  await frame.locator("#isolation").getByText("isolated", { exact: true }).waitFor();
  await frame.locator("#network").getByText("network blocked", { exact: true }).waitFor();
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
  assert.equal(await page.locator("html").getAttribute("data-compromised"), null);
  assert.equal(await page.locator("iframe").getAttribute("src"), "/sources/home/documents/same-id/content");
  await assertScopedCopy(page, "/sources/home/documents/same-id/copy.json", "Quarterly results\nloading\nloading");
  await page.getByRole("link", { name: "Back to inbox" }).click();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.goto(origin);
  await page.getByRole("link", { name: /^office report/ }).click();
  await frame.getByRole("heading", { name: "Office content" }).waitFor();
  await assertScopedCopy(page, "/sources/office/documents/same-id/copy.json", "Office content\n  office();\n\treturn;  \n");
  await page.getByLabel("Viewer options", { exact: true }).click();
  await page.getByRole("button", { name: "Copy content...", exact: true }).click();
  await page.locator("[data-copy-content]:visible").waitFor();
  await page.getByLabel("Format", { exact: true }).selectOption("code");
  await page.getByRole("button", { name: "Copy code block 1", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-copy-status]").textContent === "Copied.");
  assert.deepEqual(await page.evaluate(() => window.copyWrites), ["Office content\n  office();\n\treturn;  \n", "Office", "  office();\n\treturn;  \n"]);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await rename(sources[1].home, path.join(root, "office-offline"));
  await page.getByLabel("Viewer options", { exact: true }).click();
  await page.getByRole("button", { name: "Copy content...", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-copy-status]").textContent.includes("Could not prepare content."));
  assert.equal(await page.locator("[data-copy-content]").isVisible(), false);
  assert.equal(await page.locator("[data-copy-preview]").inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
  await page.goto(origin);
  assert.match(await page.locator("body").innerText(), /incomplete/i);
  assert.equal(await page.getByRole("link", { name: /^home report/ }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /^office report/ }).count(), 0);
  assert.equal((await page.locator("body").innerText()).includes(root), false);
  await assert.rejects(stat(sources[1].home), { code: "ENOENT" });
  await page.getByRole("link", { name: /^home report/ }).click();
  await assertScopedCopy(page, "/sources/home/documents/same-id/copy.json", "Quarterly results\nloading\nloading");
});

async function assertScopedCopy(page, copyUrl, expected) {
  assert.equal(await page.locator("[data-copy-dialog]").getAttribute("data-copy-url"), copyUrl);
  await page.getByLabel("Viewer options", { exact: true }).click();
  await page.getByRole("button", { name: "Copy content...", exact: true }).click();
  await page.locator("[data-copy-content]:visible").waitFor();
  assert.equal(await page.locator("[data-copy-preview]").inputValue(), expected);
  assert.deepEqual(await page.evaluate(() => window.copyWrites), []);
  await page.getByRole("button", { name: "Copy all", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-copy-status]").textContent === "Copied.");
  assert.deepEqual(await page.evaluate(() => window.copyWrites), [expected]);
  await page.locator("[data-copy-preview]").evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, 6);
  });
  await page.locator("[data-copy-selection]:not(:disabled)").waitFor();
  await page.getByRole("button", { name: "Copy selection", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-copy-status]").textContent === "Copied.");
  assert.deepEqual(await page.evaluate(() => window.copyWrites), [expected, expected.slice(0, 6)]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
}
