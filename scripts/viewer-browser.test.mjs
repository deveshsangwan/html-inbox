import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBrowserFixture,
  installCdnFixtures,
  isolationHtml,
  publishBrowserDocument,
  publishLibraryFixtures,
} from "./browser-fixtures.mjs";

async function publishReports(backend) {
  return [
    await publishBrowserDocument(backend, "Quarterly Report", "results.html", isolationHtml),
    await publishBrowserDocument(
      backend,
      "Deployment notes",
      "operations.html",
      "<!doctype html><html><body><h1>Deployment checklist</h1></body></html>",
      "note",
    ),
  ];
}

for (const mode of ["local", "static"]) {
  test(`${mode} inbox preserves themes and isolates routed documents`, { timeout: 30_000 }, async (t) => {
    const fixture = await createBrowserFixture(t, mode, publishReports);
    const { page, inboxUrl, documents, requests } = fixture;
    const response = await page.goto(inboxUrl);
    assert.equal(response.status(), 200);
    await assertTheme(page, "dark");

    await page.getByText("Light", { exact: true }).click();
    await page.reload();
    await assertTheme(page, "light");
    await page.getByText("Dark", { exact: true }).click();
    await page.reload();
    await assertTheme(page, "dark");
    await page.getByText("System", { exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await assertTheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await assertTheme(page, "dark");
    await page.getByText("Light", { exact: true }).click();

    const documentPath = `${new URL(inboxUrl).pathname}documents/${documents[0].id}${mode === "static" ? "/" : ""}`;
    await page.getByRole("link", { name: "Quarterly Report", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, documentPath);
    await page.getByRole("heading", { name: "Quarterly Report", exact: true }).waitFor();
    await assertTheme(page, "light");
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(await page.locator("iframe").getAttribute("src"), `${documentPath.replace(/\/$/, "")}/content${mode === "static" ? "/" : ""}`);

    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Quarterly results", exact: true }).waitFor();
    await frame.locator("#isolation").getByText("isolated", { exact: true }).waitFor();
    await frame.locator("#network").getByText("network blocked", { exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-compromised"), null);
    await page.reload();
    await frame.locator("#isolation").getByText("isolated", { exact: true }).waitFor();

    await page.getByRole("link", { name: "Back to inbox" }).click();
    assert.equal(page.url(), inboxUrl);
    assert.equal(await page.locator("[data-search-text]").count(), 2);
    await assertTheme(page, "light");
    await page.getByRole("link", { name: "Deployment notes", exact: true }).click();
    await frame.getByRole("heading", { name: "Deployment checklist", exact: true }).waitFor();

    if (mode === "static") {
      assert(requests.includes(documentPath));
      assert(requests.includes(`${documentPath}content/`));
      assert.equal(requests.includes("/health"), false);
      const rootResponse = await page.goto(fixture.origin);
      assert.equal(rootResponse.status(), 200);
      assert.equal(await page.getByRole("link").count(), 0);
      assert.equal(await page.getByText("Quarterly Report", { exact: true }).count(), 0);
    }
  });
}

test("generated static inbox searches title, type, and file without server queries", { timeout: 30_000 }, async (t) => {
  const { page, inboxUrl, requests } = await createBrowserFixture(t, "static", publishReports);
  await page.goto(`${inboxUrl}?q=REPORT%20REPORT`);
  assert.equal(await page.locator("[data-search-text]:visible").count(), 1);
  assert.equal(await page.getByRole("link", { name: "Quarterly Report", exact: true }).isVisible(), true);
  const search = page.getByRole("searchbox", { name: "Search documents" });
  assert.equal(await search.inputValue(), "REPORT REPORT");
  const requestCount = requests.length;

  for (const [query, title] of [["qUaRtErLy", "Quarterly Report"], ["note", "Deployment notes"], ["operations.html", "Deployment notes"]]) {
    await search.fill(query);
    assert.equal(await page.locator("[data-search-text]:visible").count(), 1);
    assert.equal(await page.getByRole("link", { name: title, exact: true }).isVisible(), true);
    assert.equal(await page.locator("[data-document-count]").textContent(), "1 of 2 documents");
    assert.equal(new URL(page.url()).searchParams.get("q"), query);
  }

  await search.fill("missing");
  await search.press("Enter");
  assert.equal(await page.locator("[data-search-text]:visible").count(), 0);
  assert.equal(await page.locator("[data-client-empty]").isVisible(), true);
  assert.equal(new URL(page.url()).searchParams.get("q"), "missing");
  await page.locator("[data-search-clear]").click();
  assert.equal(await page.locator("[data-search-text]:visible").count(), 2);
  assert.equal(await page.locator("[data-client-empty]").isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.has("q"), false);
  assert.equal(await search.inputValue(), "");
  assert.equal(requests.length, requestCount);

  await search.fill("operations.html");
  await page.reload();
  assert.equal(await search.inputValue(), "operations.html");
  assert.equal(await page.locator("[data-search-text]:visible").count(), 1);
});

test("local inbox searches stored reports with server rendering", { timeout: 30_000 }, async (t) => {
  const { page, inboxUrl } = await createBrowserFixture(t, "local", publishReports);
  await page.goto(`${inboxUrl}?q=REPORT%20REPORT`);
  assert.equal(await page.locator("[data-search-text]").count(), 1);
  const search = page.getByRole("searchbox", { name: "Search documents" });
  await search.fill("operations.html");
  await Promise.all([
    page.waitForURL(`${inboxUrl}?q=operations.html`),
    page.getByRole("button", { name: "Search", exact: true }).click(),
  ]);
  assert.equal(await page.locator("[data-search-text]").count(), 1);
  assert.equal(await page.getByRole("link", { name: "Deployment notes", exact: true }).isVisible(), true);
});

for (const mode of ["local", "static"]) {
  test(`${mode} document allows supported CDN entry points and Mermaid module imports with fixtures`, { timeout: 60_000 }, async (t) => {
    await assertLibraryRendering(t, mode, false);
  });
}

test("live CDN Tailwind and Mermaid rendering", {
  skip: process.env.HTML_INBOX_LIVE_CDN !== "1" ? "Set HTML_INBOX_LIVE_CDN=1 for current upstream library checks" : false,
  timeout: 180_000,
}, async (t) => {
  for (const mode of ["local", "static"]) {
    await t.test(mode, async (subtest) => {
      await assertLibraryRendering(subtest, mode, true);
    });
  }
});

async function assertTheme(page, theme) {
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
}

async function assertLibraryRendering(t, mode, useLiveCdn) {
  const { page, context, inboxUrl, documents } = await createBrowserFixture(t, mode, publishLibraryFixtures);
  const cdn = useLiveCdn ? null : await installCdnFixtures(context);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(useLiveCdn ? 45_000 : 10_000);

  for (const document of documents) {
    const documentUrl = `${inboxUrl}documents/${document.id}${mode === "static" ? "/" : ""}`;
    await page.goto(documentUrl);
    const frame = page.frameLocator("iframe");
    await frame.locator("#mermaid-result").getByText("rendered", { exact: true }).waitFor();
    await frame.locator(".mermaid svg").waitFor();
    assert.match(await frame.locator(".mermaid svg").textContent(), /Stored/);
    assert.match(await frame.locator(".mermaid svg").textContent(), /Rendered/);
    await frame.locator("#tailwind-result").evaluate((element) => new Promise((resolve, reject) => {
      const deadline = performance.now() + 10_000;
      const checkStyle = () => {
        const style = getComputedStyle(element);

        if (style.paddingTop === "16px" && style.fontWeight === "700") {
          resolve();
          return;
        }

        if (performance.now() >= deadline) {
          reject(new Error(`Tailwind utilities did not apply: padding=${style.paddingTop}, weight=${style.fontWeight}`));
          return;
        }

        requestAnimationFrame(checkStyle);
      };

      checkStyle();
    }));
    const style = await frame.locator("#tailwind-result").evaluate((element) => {
      const computed = getComputedStyle(element);

      return { padding: computed.paddingTop, weight: computed.fontWeight };
    });
    assert.deepEqual(style, { padding: "16px", weight: "700" });
  }

  assert.deepEqual(pageErrors, []);

  if (cdn) {
    for (const document of documents) {
      assert(cdn.requestedUrls.includes(new URL(document.entryPoint).href), `Entry point was not requested: ${document.entryPoint}`);
    }

    assert(cdn.requestedUrls.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"));
    assert(cdn.requestedUrls.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/chunks/fixture-render.mjs"));
    assert.deepEqual(cdn.unexpectedUrls, []);
  }
}
