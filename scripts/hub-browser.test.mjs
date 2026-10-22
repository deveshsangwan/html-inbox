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
      originalBytes: Buffer.from(name === "home" ? isolationHtml : "<!doctype html><html><body><h1>Office content</h1></body></html>"),
      title: `${name} report`, type: "report", sourceFileName: `${name}.html`,
    });
    sources.push({ name, home, instanceId: await getInboxInstanceId(home) });
  }

  const hubName = "Development ".repeat(16).trim();
  hub = await startHub({ schemaVersion: 1, name: hubName, sources }, 0);
  const origin = hub.urls[0];
  browser = await chromium.launch(process.env.HTML_INBOX_BROWSER_EXECUTABLE ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
  await page.getByRole("link", { name: "Back to inbox" }).click();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.goto(origin);
  await page.getByRole("link", { name: /^office report/ }).click();
  await frame.getByRole("heading", { name: "Office content" }).waitFor();

  await rename(sources[1].home, path.join(root, "office-offline"));
  await page.goto(origin);
  assert.match(await page.locator("body").innerText(), /incomplete/i);
  assert.equal(await page.getByRole("link", { name: /^home report/ }).count(), 1);
  assert.equal(await page.getByRole("link", { name: /^office report/ }).count(), 0);
  assert.equal((await page.locator("body").innerText()).includes(root), false);
  await assert.rejects(stat(sources[1].home), { code: "ENOENT" });
});
