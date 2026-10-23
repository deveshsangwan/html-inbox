import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { startHub } from "../packages/cli/dist/hub.js";
import { getInboxInstanceId } from "../packages/cli/dist/viewer-records.js";
import { createBrowserFixture, publishBrowserDocument } from "./browser-fixtures.mjs";

const fullTitle = 'Quarterly results with a full title, "quoted details", and enough words to wrap on a phone';
const statefulHtml = await readFile(new URL("./fixtures/document-appearance.html", import.meta.url), "utf8");

async function publishDocuments(backend) {
  return [
    await publishBrowserDocument(backend, fullTitle, "quarterly-results.html", statefulHtml),
    await publishBrowserDocument(backend, "Keep this note", "keep.html", "<!doctype html><html><body><h1>Keep this note</h1></body></html>", "note"),
  ];
}

function rowFor(page, title) {
  return page.locator(".doc").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

async function openReaderDeletion(page) {
  await page.getByLabel("Viewer options", { exact: true }).click();
  await page.locator(".viewer-menu__delete").click();
  await page.getByRole("dialog", { name: "Delete document?" }).waitFor();
}

async function confirmDeletion(page, expectedUrl) {
  await Promise.all([
    page.waitForURL(expectedUrl),
    page.getByRole("button", { name: "Delete document", exact: true }).click(),
  ]);
  await page.locator("[data-deletion-notice]:visible").waitFor();
}

async function assertFocused(locator) {
  await locator.evaluate((element) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const check = () => {
      if (element === document.activeElement) {
        resolve();
      } else if (performance.now() >= deadline) {
        reject(new Error("Expected focus was not restored"));
      } else {
        requestAnimationFrame(check);
      }
    };

    check();
  }));
}

async function assertNoOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

for (const width of [390, 1280]) {
  test(`live list deletion confirms the full document and preserves search at ${width}px`, { timeout: 30_000 }, async (t) => {
    const { page, inboxUrl, documents, home } = await createBrowserFixture(t, "local", publishDocuments);
    await page.setViewportSize({ width, height: 844 });
    const filteredUrl = `${inboxUrl}?q=quarterly`;
    await page.goto(filteredUrl);
    const row = rowFor(page, fullTitle);
    const action = row.locator("[data-delete-document]");
    const bounds = await action.boundingBox();
    assert(bounds.width >= 44 && bounds.height >= 44);
    await assertNoOverflow(page);
    await action.click();
    const dialog = page.getByRole("dialog", { name: "Delete document?" });
    await dialog.waitFor();
    assert.equal(await dialog.locator("[data-delete-title]").textContent(), fullTitle);
    assert.equal(await dialog.locator("[data-delete-file]").textContent(), "quarterly-results.html");
    assert.equal(await dialog.locator("[data-delete-inbox]").textContent(), "Inbox");
    await assertFocused(dialog.getByRole("button", { name: "Cancel", exact: true }));
    await assertNoOverflow(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await assertFocused(action);
    assert.equal(await row.count(), 1);
    assert.equal(page.url(), filteredUrl);

    await action.click();
    const token = await dialog.getAttribute("data-delete-token");
    const requestPromise = page.waitForRequest((request) => request.method() === "DELETE");
    await confirmDeletion(page, filteredUrl);
    const request = await requestPromise;
    assert.equal(new URL(request.url()).pathname, `/api/documents/${documents[0].id}`);
    assert.equal(request.postData(), null);
    assert.equal(request.headers()["x-html-inbox-csrf"], token);
    assert.equal(page.url(), filteredUrl);
    assert.match(await page.locator("[data-deletion-notice]").textContent(), /was deleted/);
    assert.equal(await page.locator(".doc").count(), 0);
    assert.equal(await page.getByRole("heading", { name: "No matching documents" }).isVisible(), true);
    assert.equal(await page.locator("[data-document-count]").textContent(), "0 of 1 documents");
    await assertFocused(page.getByRole("searchbox", { name: "Search documents" }));
    assert.equal(await new LocalDocumentBackend(home).getDocumentMetadata(documents[0].id), null);
    assert(await new LocalDocumentBackend(home).getDocumentMetadata(documents[1].id));
    assert.equal(await page.evaluate((credential) => [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) => value.includes(credential)), token), false);

    await page.reload();
    assert.equal(await page.locator("[data-deletion-notice]").isVisible(), false);
    await page.goto(inboxUrl);
    await rowFor(page, "Keep this note").locator("[data-delete-document]").click();
    await confirmDeletion(page, inboxUrl);
    await page.getByRole("heading", { name: "No documents yet" }).waitFor();
  });

  test(`reader cancellation preserves iframe state and restores menu focus at ${width}px`, { timeout: 30_000 }, async (t) => {
    const { page, inboxUrl, documents } = await createBrowserFixture(t, "local", publishDocuments);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(inboxUrl);
    await page.getByRole("link", { name: fullTitle, exact: true }).click();
    const documentFrame = page.locator("[data-document-frame]");
    const originalFrame = await documentFrame.elementHandle();
    const frame = page.frameLocator("[data-document-frame]");
    await frame.getByRole("button", { name: "Increment", exact: true }).click();
    await frame.locator("body").evaluate(() => scrollTo(0, 350));
    const initialScroll = await frame.locator("body").evaluate(() => scrollY);
    await openReaderDeletion(page);
    const dialog = page.getByRole("dialog", { name: "Delete document?" });
    await assertFocused(dialog.getByRole("button", { name: "Cancel", exact: true }));
    assert.equal(await page.locator("[data-viewer-menu]").getAttribute("open"), null);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await assertFocused(page.getByLabel("Viewer options", { exact: true }));
    assert.equal(await documentFrame.evaluate((element, original) => element === original, originalFrame), true);
    assert.equal(await frame.locator("#counter").textContent(), "1");
    assert.equal(await frame.locator("body").evaluate(() => scrollY), initialScroll);
    assert.equal(await documentFrame.getAttribute("sandbox"), "allow-scripts");

    await page.getByRole("button", { name: "Hide frame", exact: true }).click();
    await page.getByRole("button", { name: "Show frame", exact: true }).click();
    assert.equal(await frame.locator("#counter").textContent(), "1");
    await openReaderDeletion(page);
    await confirmDeletion(page, inboxUrl);
    assert.equal(await page.locator(".doc").count(), 1);
    assert.equal(await page.getByRole("link", { name: "Keep this note", exact: true }).isVisible(), true);
    await page.goBack();
    assert.notEqual(new URL(page.url()).pathname, `/documents/${documents[0].id}`);
  });
}

test("list removal waits for the response, blocks dismissal and submits only once", { timeout: 30_000 }, async (t) => {
  const { page, inboxUrl, documents } = await createBrowserFixture(t, "local", publishDocuments);
  await page.goto(inboxUrl);
  const row = rowFor(page, fullTitle);
  let release;
  let requestStarted;
  let attempts = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { requestStarted = resolve; });
  await page.route(`**/api/documents/${documents[0].id}`, async (route) => {
    attempts += 1;
    requestStarted();
    await gate;
    await route.continue();
  });
  t.after(() => release());
  await row.locator("[data-delete-document]").click();
  await page.getByRole("button", { name: "Delete document", exact: true }).click();
  await started;
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.getAttribute("aria-busy"), "true");
  assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole("button", { name: "Delete document", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.locator("[data-delete-form]").evaluate((form) => form.requestSubmit());
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await row.count(), 1);
  assert.equal(attempts, 1);
  release();
  await page.locator("[data-deletion-notice]:visible").waitFor();
  assert.equal(await row.count(), 0);
  await assertFocused(page.getByRole("link", { name: "Keep this note", exact: true }));
});

test("list deletion restores the next document and scroll position after reloading", { timeout: 30_000 }, async (t) => {
  const { page, inboxUrl } = await createBrowserFixture(t, "local", async (backend) => {
    const documents = [];
    for (let index = 0; index < 26; index += 1) {
      documents.push(await publishBrowserDocument(backend, `Report ${index}`, `report-${index}.html`, "<!doctype html><html><body>Report</body></html>"));
    }
    return documents;
  });
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto(inboxUrl);
  const row = page.locator(".doc").nth(15);
  const nextPath = await page.locator(".doc__title").nth(16).getAttribute("href");
  await row.locator("[data-delete-document]").click();
  const initialScroll = await page.evaluate(() => scrollY);
  assert(initialScroll > 0);
  await confirmDeletion(page, inboxUrl);
  await assertFocused(page.locator(`.doc__title[href="${nextPath}"]`));
  assert.equal(await page.evaluate(() => scrollY), initialScroll);
});

for (const outcome of ["absent", "cleanup", "expired", "changed", "unknown", "lost"]) {
  test(`reader deletion reports ${outcome} without inventing the document state`, { timeout: 30_000 }, async (t) => {
    const { page, inboxUrl, documents, home } = await createBrowserFixture(t, "local", publishDocuments);
    await page.goto(`${inboxUrl}documents/${documents[0].id}`);
    const backend = new LocalDocumentBackend(home);
    await page.route(`**/api/documents/${documents[0].id}`, async (route) => {
      if (outcome === "absent" || outcome === "cleanup" || outcome === "lost") {
        await backend.deleteDocument(documents[0].id);
      }

      if (outcome === "lost") {
        await route.abort("connectionreset");
        return;
      }

      const statuses = { absent: 404, cleanup: 200, expired: 403, changed: 409, unknown: 500 };
      await route.fulfill({
        status: statuses[outcome],
        contentType: "application/json",
        body: outcome === "cleanup" ? JSON.stringify({ status: "removed", cleanup: "failed" }) : "{}",
      });
    });
    await openReaderDeletion(page);
    await page.getByRole("button", { name: "Delete document", exact: true }).click();

    if (outcome === "absent" || outcome === "cleanup") {
      await page.locator("[data-deletion-notice]:visible").waitFor();
      assert.equal(page.url(), inboxUrl);
      assert.match(await page.locator("[data-deletion-notice]").textContent(), outcome === "absent" ? /already absent/ : /removed.*could not be cleaned up/);
      assert.equal(await page.getByRole("link", { name: fullTitle, exact: true }).count(), 0);
      return;
    }

    const error = page.locator("[data-delete-error]:visible");
    await error.waitFor();
    const expected = {
      expired: /Reload the page/,
      changed: /inbox has changed/,
      unknown: /couldn't confirm whether the document was deleted/,
      lost: /couldn't confirm whether the document was deleted/,
    };
    assert.match(await error.textContent(), expected[outcome]);
    assert.equal(new URL(page.url()).pathname, `/documents/${documents[0].id}`);
    assert.equal(await page.locator("[data-document-frame]").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Delete document", exact: true }).isDisabled(), true);
    await page.getByRole("link", { name: "Check inbox", exact: true }).click();
    assert.equal(await page.getByRole("link", { name: fullTitle, exact: true }).count(), outcome === "lost" ? 0 : 1);
  });
}

async function createHubFixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-delete-hub-")));
  let browser;
  let hub;
  t.after(async () => {
    await browser?.close();
    await hub?.close();
    await rm(root, { recursive: true, force: true });
  });

  const sources = [];
  const backends = {};
  for (const name of ["home", "office"]) {
    const home = path.join(root, name);
    const backend = new LocalDocumentBackend(home, undefined, () => "same-id");
    await publishBrowserDocument(backend, `${name} report`, `${name}.html`, statefulHtml);
    backends[name] = backend;
    sources.push({ name, home, instanceId: await getInboxInstanceId(home) });
  }

  hub = await startHub({ schemaVersion: 1, name: "Work inboxes", sources }, 0);
  browser = await chromium.launch(process.env.HTML_INBOX_BROWSER_EXECUTABLE ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10_000);

  return { page, origin: hub.urls[0], backends };
}

test("hub deletion keeps colliding IDs in their own inbox and preserves list filters", { timeout: 30_000 }, async (t) => {
  const { page, origin, backends } = await createHubFixture(t);
  const listUrl = `${origin}/?q=report&inbox=home`;
  await page.goto(listUrl);
  const action = page.locator("[data-delete-document]");
  assert.equal(await action.getAttribute("data-delete-url"), "/api/sources/home/documents/same-id");
  await action.click();
  assert.equal(await page.locator("[data-delete-inbox]").textContent(), "home");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertFocused(action);
  await page.getByRole("link", { name: /^home report/ }).click();
  await openReaderDeletion(page);
  await confirmDeletion(page, listUrl);
  assert.equal(await page.getByRole("combobox", { name: "Inbox", exact: true }).inputValue(), "home");
  assert.equal(await page.getByRole("searchbox", { name: "Search documents" }).inputValue(), "report");
  assert.equal(await page.locator(".doc").count(), 0);
  assert.equal(await backends.home.getDocumentMetadata("same-id"), null);
  assert(await backends.office.getDocumentMetadata("same-id"));

  await page.goto(`${origin}/sources/office/documents/same-id`);
  await openReaderDeletion(page);
  assert.equal(await page.locator("[data-delete-inbox]").textContent(), "office");
  assert.equal(await page.locator(".viewer-menu__delete").getAttribute("data-delete-url"), "/api/sources/office/documents/same-id");
  await confirmDeletion(page, `${origin}/?inbox=office`);
  assert.equal(await backends.office.getDocumentMetadata("same-id"), null);
});

for (const listPath of ["https://example.com/?q=report", "/documents/elsewhere", "/?q=report&unexpected=1", "/?inbox=office"]) {
  test(`reader deletion rejects an invalid return destination ${listPath}`, { timeout: 30_000 }, async (t) => {
    const { page, origin } = await createHubFixture(t);
    await page.goto(origin);
    await page.evaluate((listPath) => sessionStorage.setItem("html-inbox-list-return", JSON.stringify({
      documentPath: "/sources/home/documents/same-id", listPath, scrollY: 0,
    })), listPath);
    await page.goto(`${origin}/sources/home/documents/same-id`);
    await openReaderDeletion(page);
    await confirmDeletion(page, `${origin}/?inbox=home`);
  });
}

test("hub list deletion uses the source-qualified URL at desktop size", { timeout: 30_000 }, async (t) => {
  const { page, origin, backends } = await createHubFixture(t);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  const home = page.locator(".doc").filter({ has: page.getByRole("link", { name: /^home report/ }) });
  await home.locator("[data-delete-document]").click();
  const request = page.waitForRequest((request) => request.method() === "DELETE");
  await confirmDeletion(page, `${origin}/`);
  assert.equal(new URL((await request).url()).pathname, "/api/sources/home/documents/same-id");
  assert.equal(await page.getByRole("link", { name: /^office report/ }).count(), 1);
  assert(await backends.office.getDocumentMetadata("same-id"));
  await assertNoOverflow(page);
});

test("static exports contain no deletion controls or credentials and remain immutable", { timeout: 30_000 }, async (t) => {
  const { page, inboxUrl, documents, home } = await createBrowserFixture(t, "static", publishDocuments);
  const response = await page.goto(inboxUrl);
  assert.equal(response.headers()["content-security-policy"].includes("connect-src 'self'"), false);
  assert.equal(await page.locator("[data-delete-document], [data-delete-dialog], [data-delete-token]").count(), 0);
  await new LocalDocumentBackend(home).deleteDocument(documents[0].id);
  await page.reload();
  await page.getByRole("link", { name: fullTitle, exact: true }).click();
  await page.getByLabel("Viewer options", { exact: true }).click();
  assert.equal(await page.locator("[data-delete-document], [data-delete-dialog], [data-delete-token]").count(), 0);
  await page.frameLocator("[data-document-frame]").getByRole("heading", { name: "Theme-aware document" }).waitFor();
});
