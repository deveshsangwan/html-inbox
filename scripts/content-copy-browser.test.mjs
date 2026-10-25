import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium, firefox } from "playwright";
import { MAX_DOCUMENT_COPY_JSON_BYTES } from "../packages/cli/dist/document-copy.js";
import { createBrowserFixture, publishBrowserDocument } from "./browser-fixtures.mjs";

const codeBlocks = ['  const value = "<tag>";\n\treturn value;  \n\n', "graph TD\n  A --> B\n"];
const documentText = `Saved copy fixture\nA & B, emoji 🐈 and שלום.\n${codeBlocks.join("")}`;
const browserType = process.env.HTML_INBOX_COPY_BROWSER === "firefox" ? firefox : chromium;

async function publishCopyDocument(backend) {
  const html = await readFile(new URL("./fixtures/document-copy.html", import.meta.url), "utf8");

  return [await publishBrowserDocument(backend, "Copy fixture", "document-copy.html", html)];
}

async function createCopyFixture(t, mode, publish = publishCopyDocument, beforeNavigate) {
  const fixture = await createBrowserFixture(t, mode, publish, { browserType });
  await fixture.context.addInitScript(() => {
    if (window !== window.top) {
      return;
    }

    // These stubs check application payloads and feedback, not browser clipboard support.
    window.copyWrites = [];
    window.copyActivations = [];
    window.pendingWrites = [];
    window.copyWriteBehavior = "resolve";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(text) {
          window.copyWrites.push(text);
          window.copyActivations.push(navigator.userActivation.isActive);

          if (window.copyWriteBehavior === "reject") {
            return Promise.reject(new DOMException("Policy denied", "NotAllowedError"));
          }

          if (window.copyWriteBehavior === "pending") {
            return new Promise((resolve, reject) => window.pendingWrites.push({ resolve, reject }));
          }

          return Promise.resolve();
        },
      },
    });
  });
  const shellUrl = `${fixture.inboxUrl}documents/${fixture.documents[0].id}${mode === "static" ? "/" : ""}`;
  const copyUrl = `${shellUrl.replace(/\/$/, "")}/copy.json`;
  await beforeNavigate?.(fixture);
  // The shell can copy saved content while an untrusted document is still loading.
  await fixture.page.goto(shellUrl, { waitUntil: "domcontentloaded" });

  return { ...fixture, shellUrl, copyUrl };
}

async function openCopy(page, ready = true) {
  await page.getByLabel("Viewer options", { exact: true }).click();
  await page.getByRole("button", { name: "Copy content...", exact: true }).click();
  await page.locator("dialog[open]").waitFor();

  if (ready) {
    await page.locator("[data-copy-content]:visible").waitFor();
  }
}

async function assertStatus(page, text) {
  await page.waitForFunction((text) => document.querySelector("[data-copy-status]").textContent.includes(text), text);
}

async function writes(page) {
  return page.evaluate(() => window.copyWrites);
}

async function deferredFetch(page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.copyRequests = [];
    window.fetch = (url, options) => {
      if (!String(url).endsWith("/copy.json")) {
        return originalFetch(url, options);
      }

      // Intentionally ignore cancellation so stale-completion protection is exercised too.
      return new Promise((resolve, reject) => window.copyRequests.push({ url, signal: options.signal, resolve, reject }));
    };
  });
}

async function resolveFetch(page, index, text) {
  await page.evaluate(({ index, text }) => {
    window.copyRequests[index].resolve(new Response(JSON.stringify({ schemaVersion: 1, status: "ready", text, codeBlocks: [] }), {
      headers: { "Content-Type": "application/json" },
    }));
  }, { index, text });
}

for (const mode of ["local", "static"]) {
  test(`${mode} prepares copy while the isolated document is still loading`, { timeout: 30_000 }, async (t) => {
    let releaseDocument = () => {};
    const documentGate = new Promise((resolve) => { releaseDocument = resolve; });
    let signalDocumentRequest = () => {};
    const documentRequested = new Promise((resolve) => { signalDocumentRequest = resolve; });

    try {
      const { page } = await createCopyFixture(t, mode, publishCopyDocument, async ({ context }) => {
        await context.route(/\/documents\/[^/]+\/content\/?$/, async (route) => {
          signalDocumentRequest();
          await documentGate;
          await route.continue();
        });
      });
      await documentRequested;
      assert.equal(await page.evaluate(() => document.readyState), "interactive");

      await openCopy(page);
      await page.getByRole("button", { name: "Copy all", exact: true }).click();
      await assertStatus(page, "Copied.");
      assert.deepEqual(await writes(page), [documentText]);
      assert.equal(await page.evaluate(() => document.readyState), "interactive");

      releaseDocument();
      await page.frameLocator("iframe").getByRole("button", { name: "Increment runtime", exact: true }).waitFor();
      await page.waitForLoadState("load");
    } finally {
      releaseDocument();
    }
  });

  test(`${mode} copies displayed selection offsets while preserving CR and CRLF in whole text and code`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode, async (backend) => [
      await publishBrowserDocument(backend, "CR selection", "cr-selection.html", "<!doctype html><html><body><p>Before</p><pre><code>a&#13;b&#13;&#10;c</code></pre><p>After</p></body></html>"),
    ]);
    await openCopy(page);
    const preview = page.locator("[data-copy-preview]");
    assert.equal(await preview.inputValue(), "Before\na\nb\nc\nAfter");
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Copied.");
    await page.getByLabel("Format", { exact: true }).selectOption("code");
    assert.equal(await preview.inputValue(), "a\nb\nc");
    await page.getByRole("button", { name: "Copy code block 1", exact: true }).click();
    await assertStatus(page, "Copied.");
    const expectedWrites = ["Before\na\rb\r\nc\nAfter", "a\rb\r\nc"];
    assert.deepEqual(await writes(page), expectedWrites);
    await page.getByLabel("Format", { exact: true }).selectOption("text");

    for (const [start, end, text] of [[0, 6, "Before"], [7, 12, "a\nb\nc"], [13, 18, "After"]]) {
      await preview.evaluate((element, { start, end }) => {
        element.focus();
        element.setSelectionRange(start, end);
      }, { start, end });
      await page.locator("[data-copy-selection]:not(:disabled)").waitFor();
      await page.getByRole("button", { name: "Copy selection", exact: true }).click();
      expectedWrites.push(text);
      assert.deepEqual(await writes(page), expectedWrites);
      await assertStatus(page, "Copied.");
    }
  });

  test(`${mode} uses the saved document URL after the preview navigates and across shell aliases`, { timeout: 30_000 }, async (t) => {
    const fixture = await createCopyFixture(t, mode, async (backend) => [
      ...await publishCopyDocument(backend),
      await publishBrowserDocument(backend, "Other document", "other.html", "<!doctype html><html><body><h1>Other preview content</h1></body></html>"),
    ]);
    const { page, documents, inboxUrl, shellUrl, copyUrl } = fixture;
    const aliases = mode === "static" ? [shellUrl.slice(0, -1), `${shellUrl}index.html`, shellUrl] : [shellUrl];

    for (const alias of aliases) {
      await page.goto(alias);
      const otherContent = `${new URL(inboxUrl).pathname}documents/${documents[1].id}/content${mode === "static" ? "/" : ""}`;
      await page.frameLocator("iframe").locator("body").evaluate((_element, otherContent) => { location.href = otherContent; }, otherContent);
      await page.frameLocator("iframe").getByRole("heading", { name: "Other preview content" }).waitFor();
      await openCopy(page);
      assert.equal(await page.locator("[data-copy-dialog]").getAttribute("data-copy-url"), new URL(copyUrl).pathname);
      assert.equal(await page.locator("[data-copy-preview]").inputValue(), documentText);
      await page.getByRole("button", { name: "Copy all", exact: true }).click();
      await assertStatus(page, "Copied.");
      assert.deepEqual(await writes(page), [documentText]);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.frameLocator("iframe").getByRole("heading", { name: "Other preview content" }).waitFor();
    }
  });

  test(`${mode} copies exact saved text, selections and numbered blocks on fresh activations`, { timeout: 30_000 }, async (t) => {
    const { page, copyUrl, context } = await createCopyFixture(t, mode);
    const copyRequests = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/copy.json")) copyRequests.push(request.url());
    });
    await page.reload();
    assert.deepEqual(copyRequests, []);
    assert.equal(await page.locator("[data-copy-dialog]").getAttribute("data-copy-url"), new URL(copyUrl).pathname);
    await openCopy(page);
    assert.deepEqual(copyRequests, [copyUrl]);
    assert.match(await page.locator("#copy-saved-help").innerText(), /CSS-hidden text may be included/);
    assert.deepEqual(await writes(page), []);
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), documentText);
    assert.equal(await page.locator("[data-copy-preview]").getAttribute("wrap"), "soft");
    assert.equal(await page.locator("[data-viewer-menu]").getAttribute("open"), null);
    assert.equal(await page.getByRole("button", { name: "Close", exact: true }).evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator("[data-copy-selection]").isDisabled(), true);

    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), [documentText]);
    assert.equal(await page.locator("[data-copy-all]").evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    await assertStatus(page, "Copied.");

    const preview = page.locator("[data-copy-preview]");
    const start = documentText.indexOf(codeBlocks[0]);
    const end = start + codeBlocks[0].length;
    await preview.evaluate((element, { start, end }) => {
      element.focus();
      element.setSelectionRange(start, end);
    }, { start, end });
    await page.locator("[data-copy-selection]:not(:disabled)").waitFor();
    await page.getByRole("button", { name: "Copy selection", exact: true }).click();
    await assertStatus(page, "Copied.");

    await preview.focus();
    await preview.evaluate((element) => element.setSelectionRange(0, 5));
    await page.locator("[data-copy-selection]:not(:disabled)").waitFor();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("[data-copy-selection]").evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Space");
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), [documentText, documentText, codeBlocks[0], "Saved"]);

    await page.getByLabel("Format", { exact: true }).selectOption("code");
    assert.equal(await preview.getAttribute("wrap"), "off");
    assert.equal(await page.locator("[data-copy-code-block] option").count(), 2);
    assert.equal(await page.locator("[data-copy-preview]").count(), 1);
    assert.equal(await preview.inputValue(), codeBlocks[0]);
    await page.getByRole("button", { name: "Copy code block 1", exact: true }).click();
    await assertStatus(page, "Copied.");
    await page.getByLabel("Code block", { exact: true }).selectOption("1");
    assert.equal(await preview.inputValue(), codeBlocks[1]);
    await page.getByRole("button", { name: "Copy code block 2", exact: true }).focus();
    await page.keyboard.press("Enter");
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), [documentText, documentText, codeBlocks[0], "Saved", ...codeBlocks]);
    assert.deepEqual(await page.evaluate(() => window.copyActivations), Array(6).fill(true));
    assert.equal(copyRequests.length, 1);

    const head = await context.request.head(copyUrl);
    assert.equal(head.status(), 200);
    assert.match(head.headers()["content-type"], /^application\/json/);
    assert.equal(head.headers()["x-content-type-options"], "nosniff");
    assert.equal(head.headers()["content-security-policy"], undefined);
    assert.equal((await head.body()).length, 0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openCopy(page);
    assert.equal(copyRequests.length, 2, "Reopening prepares fresh content");
  });

  test(`${mode} keeps text selectable when clipboard access is missing or rejected`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    await openCopy(page);
    await page.evaluate(() => { window.copyWriteBehavior = "reject"; });
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Could not copy.");
    assert.match(await page.locator("[data-copy-status]").textContent(), /Ctrl\+C or Command\+C.*touch Copy/);
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), documentText);
    assert.equal(await page.locator("[data-copy-all]").evaluate((element) => element === document.activeElement), true);
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    assert.deepEqual(await page.locator("[data-copy-preview]").evaluate((element) => ({
      start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element,
    })), { start: 0, end: documentText.length, focused: true });
    assert.equal((await page.locator("[data-copy-status]").textContent()).includes("Copied."), false);

    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }); });
    await page.getByRole("button", { name: "Copy selection", exact: true }).click();
    await assertStatus(page, "Clipboard copy is unavailable");
    assert.deepEqual(await writes(page), [documentText]);
    await page.getByLabel("Format", { exact: true }).selectOption("code");
    await page.getByLabel("Code block", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Copy code block 2", exact: true }).click();
    await assertStatus(page, "Clipboard copy is unavailable");
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    assert.deepEqual(await page.locator("[data-copy-preview]").evaluate((element) => [element.selectionStart, element.selectionEnd]), [0, codeBlocks[1].length]);
  });

  test(`${mode} rejects failed, non-JSON and malformed preparations and retries without copying`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    const invalidResponses = [
      { status: 503, body: "Unavailable" },
      { contentType: "text/html", body: '<img src="https://author.invalid/not-json">' },
      { body: "{" },
      { json: null },
      { json: [] },
      { json: { schemaVersion: 2, status: "ready", text: "wrong version", codeBlocks: [] } },
      { json: { schemaVersion: 1, status: "ready", text: 4, codeBlocks: [] } },
      { json: { schemaVersion: 1, status: "ready", text: "wrong block", codeBlocks: [4] } },
      { json: { schemaVersion: 1, status: "unavailable", reason: "unexpected" } },
    ];
    let attempt = 0;
    await page.route("**/copy.json", async (route) => {
      const response = invalidResponses[attempt++];
      await route.fulfill(response ? {
        status: response.status ?? 200,
        contentType: response.contentType ?? "application/json; charset=utf-8",
        body: "json" in response ? JSON.stringify(response.json) : response.body,
      } : { json: { schemaVersion: 1, status: "ready", text: "Recovered\n", codeBlocks: ["\tcode  \n"] } });
    });
    await openCopy(page, false);

    for (let index = 0; index < invalidResponses.length; index += 1) {
      await assertStatus(page, "Could not prepare content.");
      assert.equal(await page.locator("[data-copy-content]").isVisible(), false);
      assert.equal(await page.locator("[data-copy-preview]").inputValue(), "");
      assert.equal(await page.locator("[data-copy-all]").isDisabled(), true);
      assert.deepEqual(await writes(page), []);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    }

    await page.locator("[data-copy-content]:visible").waitFor();
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), "Recovered\n");
    assert.equal(attempt, invalidResponses.length + 1);
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), ["Recovered\n"]);
  });

  test(`${mode} aborts preparation and ignores stale close, reopen and retry results`, { timeout: 30_000 }, async (t) => {
    const { page, copyUrl } = await createCopyFixture(t, mode);
    await deferredFetch(page);
    await openCopy(page, false);
    await assertStatus(page, "Preparing content...");
    assert.equal(await page.locator("[data-copy-all]").isDisabled(), true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await page.evaluate(() => window.copyRequests[0].signal.aborted), true);
    await openCopy(page, false);
    await resolveFetch(page, 0, "stale content");
    await assertStatus(page, "Preparing content...");
    assert.equal(await page.locator("[data-copy-content]").isVisible(), false);
    await page.evaluate(() => window.copyRequests[1].reject(new TypeError("Network failed")));
    await assertStatus(page, "Could not prepare content.");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await assertStatus(page, "Preparing content...");
    await page.evaluate(() => document.querySelector("[data-copy-retry]").dispatchEvent(new MouseEvent("click")));
    assert.equal(await page.evaluate(() => window.copyRequests[2].signal.aborted), true);
    await resolveFetch(page, 3, "fresh content");
    await page.locator("[data-copy-content]:visible").waitFor();
    await resolveFetch(page, 2, "stale retry");
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), "fresh content");
    assert.deepEqual(await writes(page), []);
    assert.deepEqual(await page.evaluate(() => window.copyRequests.map((request) => request.url)), Array(4).fill(new URL(copyUrl).pathname));
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), ["fresh content"]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openCopy(page, false);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => window.copyRequests[4].reject(new TypeError("Late failure")));
    assert.equal(await page.locator("[data-copy-status]").textContent(), "");
  });

  test(`${mode} guards pending clipboard writes across repeated input and dialog generations`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    await openCopy(page);
    await page.evaluate(() => { window.copyWriteBehavior = "pending"; });

    for (const outcome of ["resolve", "reject"]) {
      const before = (await writes(page)).length;
      const button = page.getByRole("button", { name: "Copy all", exact: true });
      await button.click();
      await assertStatus(page, "Copying...");
      assert.equal(await button.getAttribute("aria-disabled"), "true");
      assert.equal(await button.evaluate((element) => element.disabled), false);
      assert.equal(await button.evaluate((element) => element === document.activeElement), true);
      await button.click({ force: true });
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      assert.equal((await writes(page)).length, before + 1);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await openCopy(page);
      await button.click({ force: true });
      assert.equal((await writes(page)).length, before + 1, "Old pending writes keep the guard after reopen");
      await page.evaluate((outcome) => window.pendingWrites.shift()[outcome](), outcome);
      await page.locator('[data-copy-all][aria-disabled="false"]').waitFor();
      assert.equal(await page.locator("[data-copy-status]").textContent(), "Content ready. Choose what to copy.");
    }

    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Copying...");
    await page.evaluate(() => window.pendingWrites.shift().resolve());
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), Array(3).fill(documentText));
  });

  test(`${mode} explains unavailable and empty content and preserves whitespace-only blocks`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    let response;
    await page.route("**/copy.json", (route) => route.fulfill({ json: response }));

    for (const reason of ["too-large", "invalid-encoding"]) {
      response = { schemaVersion: 1, status: "unavailable", reason };
      await openCopy(page, false);
      await assertStatus(page, reason === "too-large" ? "too large" : "invalid text encoding");
      assert.match(await page.locator("[data-copy-status]").textContent(), /Use native Copy in the preview/);
      assert.equal(await page.locator("[data-copy-content]").isVisible(), false);
      await page.getByRole("button", { name: "Close", exact: true }).click();
    }

    response = { schemaVersion: 1, status: "ready", text: "", codeBlocks: [] };
    await openCopy(page);
    assert.equal(await page.locator("[data-copy-empty]").textContent(), "No document text found in the saved HTML.");
    assert.equal(await page.locator("[data-copy-all]").isDisabled(), true);
    assert.equal(await page.locator("[data-copy-select-all]").isDisabled(), true);
    await page.getByLabel("Format", { exact: true }).selectOption("code");
    assert.equal(await page.locator("[data-copy-empty]").textContent(), "No code blocks found in the saved HTML.");
    assert.equal(await page.locator("[data-copy-code-controls]").isVisible(), false);
    assert.equal(await page.locator("[data-copy-code]").isDisabled(), true);
    await page.getByRole("button", { name: "Close", exact: true }).click();

    response = { schemaVersion: 1, status: "ready", text: "", codeBlocks: ["", " \t\n"] };
    await openCopy(page);
    await page.getByLabel("Format", { exact: true }).selectOption("code");
    assert.equal(await page.locator("[data-copy-empty]").textContent(), "Code block 1 is empty.");
    assert.equal(await page.locator("[data-copy-code]").isDisabled(), true);
    await page.getByLabel("Code block", { exact: true }).selectOption("1");
    await page.getByRole("button", { name: "Copy code block 2", exact: true }).click();
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), [" \t\n"]);
  });

  test(`${mode} contains modal focus, restores Escape focus and keeps frame state at narrow widths`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    const documentFrame = page.locator("[data-document-frame]");
    const frame = page.frameLocator("[data-document-frame]");
    const originalFrame = await documentFrame.elementHandle();
    const originalSrc = await documentFrame.getAttribute("src");
    await frame.getByRole("button", { name: "Increment runtime" }).click();
    await frame.locator("body").evaluate(() => scrollTo(0, 350));
    const originalScroll = await frame.locator("body").evaluate(() => scrollY);

    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Viewer options", { exact: true }).click();
      await page.getByText(theme === "light" ? "Light" : "Dark", { exact: true }).click();
      await page.getByLabel("Viewer options", { exact: true }).click();
      await page.setViewportSize({ width: 320, height: 568 });
      await openCopy(page);
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await page.locator("[data-copy-status]").getAttribute("role"), "status");
      assert.equal(await page.locator("[data-copy-status]").getAttribute("aria-live"), "polite");
      await page.keyboard.press("Shift+Tab");
      // Native modal navigation can visit browser chrome, but must skip background controls.
      assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector("dialog").contains(document.activeElement)), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("[data-copy-close]").evaluate((element) => element === document.activeElement), true);

      for (const fontSize of ["100%", "200%"]) {
        await page.evaluate((fontSize) => { document.documentElement.style.fontSize = fontSize; }, fontSize);
        const layout = await page.locator("dialog[open]").evaluate((dialog) => {
          const bounds = dialog.getBoundingClientRect();

          return {
            left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
            width: innerWidth, height: innerHeight, outerWidth: document.documentElement.scrollWidth,
            outerHeight: document.documentElement.scrollHeight, internalWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
            controls: [...dialog.querySelectorAll("button, select")].filter((element) => element.checkVisibility()).map((element) => {
              const rect = element.getBoundingClientRect();

              return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
            }),
          };
        });
        assert(layout.left >= 0 && layout.right <= layout.width, JSON.stringify(layout));
        assert(layout.top >= 0 && layout.bottom <= layout.height, JSON.stringify(layout));
        assert(layout.outerWidth <= layout.width && layout.outerHeight <= layout.height, JSON.stringify(layout));
        assert(layout.internalWidth <= layout.clientWidth, JSON.stringify(layout));
        assert(layout.controls.every((control) => control.width >= 44 && control.height >= 44 && control.left >= 0 && control.right <= layout.width), JSON.stringify(layout));
      }

      await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
      await page.locator("[data-copy-preview]").focus();
      await page.keyboard.press("Escape");
      await page.locator("[data-copy-dialog]:not([open])").waitFor({ state: "attached" });
      assert.equal(await page.getByLabel("Viewer options", { exact: true }).evaluate((element) => element === document.activeElement), true);
      assert.equal(await documentFrame.evaluate((element, original) => element === original, originalFrame), true);
      assert.equal(await documentFrame.getAttribute("src"), originalSrc);
      assert.equal(await documentFrame.getAttribute("sandbox"), "allow-scripts");
      assert.equal(await frame.locator("#counter").textContent(), "1");
      assert.equal(await frame.locator("body").evaluate(() => scrollY), originalScroll);
      await frame.locator(`html[data-bridge-theme="${theme}"]`).waitFor();
    }

    await page.getByRole("button", { name: "Hide frame", exact: true }).click();
    await page.getByRole("button", { name: "Show frame", exact: true }).click();
    assert.equal(await documentFrame.evaluate((element, original) => element === original, originalFrame), true);
    assert.equal(await frame.locator("#counter").textContent(), "1");
    assert.equal(await frame.locator("body").evaluate(() => scrollY), originalScroll);
    await frame.locator("body").evaluate(() => {
      window.nativeCopyEvents = 0;
      document.addEventListener("copy", () => { window.nativeCopyEvents += 1; });
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("pre"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.body.focus();
    });
    await documentFrame.focus();
    await page.keyboard.press("ControlOrMeta+c");
    assert.equal(await frame.locator("body").evaluate(() => window.nativeCopyEvents), 1);
    assert.deepEqual(await writes(page), []);
  });
}

for (const mode of ["local", "static"]) {
  test(`${mode} clears copy feedback when the displayed content changes`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    await openCopy(page);
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await assertStatus(page, "Copied.");
    await page.getByLabel("Format", { exact: true }).selectOption("code");
    assert.equal(await page.locator("[data-copy-status]").textContent(), "Content ready. Choose what to copy.");
    await page.evaluate(() => { window.copyWriteBehavior = "pending"; });
    await page.getByRole("button", { name: "Copy code block 1", exact: true }).click();
    await assertStatus(page, "Copying...");
    await page.getByLabel("Code block", { exact: true }).selectOption("1");
    await page.evaluate(() => window.pendingWrites.shift().resolve());
    await page.locator('[data-copy-code][aria-disabled="false"]').waitFor();
    assert.equal(await page.locator("[data-copy-status]").textContent(), "Content ready. Choose what to copy.");
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), codeBlocks[1]);
    assert.deepEqual(await writes(page), [documentText, codeBlocks[0]]);
    await page.evaluate(() => { window.copyWriteBehavior = "resolve"; });
    await page.getByRole("button", { name: "Copy code block 2", exact: true }).click();
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), [documentText, ...codeBlocks]);
  });

  test(`${mode} rejects redirects instead of copying another resource`, { timeout: 30_000 }, async (t) => {
    const { page } = await createCopyFixture(t, mode);
    let redirectedRequests = 0;
    await page.route("**/redirected-copy.json", (route) => {
      redirectedRequests += 1;

      return route.fulfill({ json: { schemaVersion: 1, status: "ready", text: "Wrong document", codeBlocks: [] } });
    });
    await page.route("**/copy.json", (route) => route.fulfill({ status: 302, headers: { Location: "/redirected-copy.json" } }));
    await openCopy(page, false);
    await assertStatus(page, "Could not prepare content.");
    assert.equal(await page.locator("[data-copy-content]").isVisible(), false);
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), "");
    assert.equal(redirectedRequests, 0);
    assert.deepEqual(await writes(page), []);
  });
}

test("copy preparation bounds streamed UTF-8 bytes before parsing and cancels oversized responses", { timeout: 30_000 }, async (t) => {
  const { page } = await createCopyFixture(t, "local");
  await page.evaluate((limit) => {
    window.streamWasCancelled = false;
    window.copyResponseMode = "stream";
    window.streamChunks = 0;
    window.fetch = async () => {
      if (window.copyResponseMode === "length") {
        return new Response(new ReadableStream({ cancel() { window.streamWasCancelled = true; } }), {
          headers: { "Content-Type": "application/json", "Content-Length": String(limit + 1) },
        });
      }

      if (window.copyResponseMode === "encoding") {
        return new Response(new Uint8Array([123, 0xff, 125]), { headers: { "Content-Type": "application/json" } });
      }

      const encoder = new TextEncoder();
      const chunk = encoder.encode("é".repeat(256 * 1024));
      let bytesSent = 0;

      return new Response(new ReadableStream({
        pull(controller) {
          window.streamChunks += 1;

          if (bytesSent === 0) {
            const prefix = encoder.encode('{"schemaVersion":1,"status":"ready","codeBlocks":[],"text":"');
            controller.enqueue(prefix);
            bytesSent += prefix.byteLength;

            return;
          }

          controller.enqueue(chunk);
          bytesSent += chunk.byteLength;
        },
        cancel() { window.streamWasCancelled = true; },
      }), { headers: { "Content-Type": "application/json" } });
    };
  }, MAX_DOCUMENT_COPY_JSON_BYTES);
  await openCopy(page, false);
  await assertStatus(page, "too large");
  assert.equal(await page.evaluate(() => window.streamWasCancelled), true);
  assert((await page.evaluate(() => window.streamChunks)) <= 23, "The endless stream must stop near the byte limit");
  assert.equal(await page.locator("[data-copy-content]").isVisible(), false);
  assert.deepEqual(await writes(page), []);

  await page.evaluate(() => { window.copyResponseMode = "length"; window.streamWasCancelled = false; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await assertStatus(page, "too large");
  assert.equal(await page.evaluate(() => window.streamWasCancelled), true);
  await page.evaluate(() => { window.copyResponseMode = "encoding"; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await assertStatus(page, "Could not prepare content.");
  assert.deepEqual(await writes(page), []);
});

for (const mode of ["local", "static"]) {
  test(`${mode} treats adversarial saved content and forged messages as text without resource loads or clipboard writes`, { timeout: 30_000 }, async (t) => {
    const adversarialText = '</textarea><script>parent.document.body.dataset.compromised="yes"</script><img src="https://author.invalid/image" srcset="https://author.invalid/large 2x" onerror="alert(1)"><svg onload="alert(1)"></svg><iframe srcdoc="<script>alert(1)</script>"></iframe><form action="https://author.invalid/post"><input></form><style>body{background:url(https://author.invalid/css)}</style>';
    const encodedText = adversarialText.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const fixture = await createCopyFixture(t, mode, async (backend) => [await publishBrowserDocument(backend, "Adversarial copy", "adversarial.html", `<!doctype html><html><body><pre><code>${encodedText}</code></pre><script>
      parent.postMessage({ type: 'html-inbox:copy', text: 'forged', url: '/copy-forged.json' }, '*');
      parent.postMessage({ schemaVersion: 1, status: 'ready', text: 'forged', codeBlocks: [] }, '*');
    </script></body></html>`)]);
    const { page } = fixture;
    await page.waitForLoadState("load");

    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await openCopy(page);
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), adversarialText);
    assert.equal(await page.locator("body").getAttribute("data-compromised"), null);
    assert.equal(await page.locator("[data-copy-dialog]").locator("script, img, svg, iframe, form, style").count(), 0);
    assert.equal(await page.locator("iframe").count(), 1);
    assert.deepEqual(await writes(page), []);
    assert.deepEqual(requests, [fixture.copyUrl]);
    await page.frameLocator("iframe").locator("body").evaluate(() => {
      parent.postMessage({ type: "html-inbox:copy", text: "forged again", requestId: 1 }, "*");
    });
    await page.getByLabel("Format", { exact: true }).selectOption("code");
    assert.equal(await page.locator("[data-copy-preview]").inputValue(), adversarialText);
    assert.deepEqual(await writes(page), []);
    await page.getByRole("button", { name: "Copy code block 1", exact: true }).click();
    await assertStatus(page, "Copied.");
    assert.deepEqual(await writes(page), [adversarialText]);
    assert.deepEqual(requests, [fixture.copyUrl]);
  });
}
