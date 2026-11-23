import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { getInboxInstanceId } from "../packages/cli/dist/viewer-records.js";
import { startHub } from "../packages/cli/dist/hub.js";
import { writeHubConfig } from "../packages/cli/dist/hub-config.js";
import { availablePort } from "../packages/cli/dist/test-fixtures.js";
import { isolationHtml } from "./browser-fixtures.mjs";

// Installed hub children that never closed. They stay registered after their handles are released,
// so a late close is still recorded and the suite still fails while any remain.
const unjoinedHubChildren = new Map();
after(() => {
  if (unjoinedHubChildren.size > 0) {
    throw new Error(`Installed hub children remain unjoined: ${JSON.stringify([...unjoinedHubChildren.values()])}`);
  }
});

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
  // Typeahead uses real keys without opening a macOS native popup that CDP cannot drive.
  await waitForReload(page, () => inbox.press("h"));
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
  assert.match(description, /Changing the inbox reloads the page automatically/);
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
  t.after(() => closeHubFixture(t, browser, hub, root));

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

  hub = await startFixtureHub(root, { schemaVersion: 1, name: "Filter test", sources }, (started) => { hub = started; });
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
  t.after(() => closeHubFixture(t, browser, hub, root));

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
  hub = await startFixtureHub(root, { schemaVersion: 1, name: hubName, sources }, (started) => { hub = started; });
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

async function startFixtureHub(root, configuration, onStarted) {
  if (!process.env.HTML_INBOX_HUB_TEST_CLI) {
    return startHub(configuration, 0);
  }

  // Teardown asserts a graceful SIGTERM exit, which Windows cannot deliver.
  if (process.platform === "win32") {
    throw new Error("HTML_INBOX_HUB_TEST_CLI requires POSIX signals; unset it to use the in-process hub on Windows");
  }

  const executable = await resolveInstalledExecutable(process.env.HTML_INBOX_HUB_TEST_CLI);
  const config = path.join(root, "hub.json");
  await writeHubConfig(config, configuration);

  const origin = `http://127.0.0.1:${await availablePort()}`;
  const child = spawn(process.execPath, [executable, "hub", "--config", config,
    "--loopback", "--host", "127.0.0.1", "--port", new URL(origin).port], {
    cwd: root,
    env: isolatedChildEnvironment(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childErrors = [];
  let readinessPublished = false;
  let teardownRequested = false;
  let nativeExit;
  let closeOutcome;
  child.on("error", (error) => { childErrors.push(error); });
  child.once("exit", (code, signal) => {
    nativeExit = { code, signal, beforeTeardown: !teardownRequested };
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => {
    resolve({ code, signal, beforeTeardown: !teardownRequested });
  }));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16 * 1024); });
  let closing;
  const close = () => closing ??= (async () => {
    const hadExited = nativeExit !== undefined || child.exitCode !== null || child.signalCode !== null;
    if (!hadExited) {
      teardownRequested = true;
      signalChild(child, "SIGTERM", childErrors, "Installed hub did not accept its teardown signal");
    }

    let forced = false;
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        forced = true;
        signalChild(child, "SIGKILL", childErrors, "Installed hub did not accept forced cleanup");
      }
    }, 3000);
    let deadlineTimer;
    const deadline = new Promise((resolve) => { deadlineTimer = setTimeout(resolve, 6000); });
    let result;
    try {
      result = await Promise.race([closed, deadline]);
    } finally {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
    }

    if (!result) {
      // Release the parent's references so an unkillable child cannot keep the test process alive.
      unjoinedHubChildren.set(child.pid, { pid: child.pid, root });
      closed.then((late) => {
        unjoinedHubChildren.delete(child.pid);
        console.error(`Installed hub child ${child.pid} closed late: ${JSON.stringify(late)}; fixture retained at ${root}`);
      });
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }

    closeOutcome = { pid: child.pid, readinessPublished, teardownRequested, hadExited,
      nativeExit, nativeClose: result ?? "unjoined", forced, stderr,
      errors: childErrors.map((error) => error instanceof Error
        ? { ...error, name: error.name, message: error.message, stack: error.stack }
        : { thrown: String(error) }) };
    const failures = [...childErrors];
    if (!result) {
      failures.push(new Error(`Installed hub child ${child.pid} is unjoined: no close within 6 s, including forced cleanup`));
    }
    if (hadExited || result?.beforeTeardown || nativeExit?.beforeTeardown) {
      failures.push(new Error("Installed hub terminated before intentional fixture teardown"));
    }
    if (result && (result.code !== 0 || result.signal !== null)) {
      failures.push(new Error(`Installed hub shutdown was not code0/signalnull: ${result.code}/${result.signal}`));
    }
    if (readinessPublished && (!nativeExit || nativeExit.code !== 0 || nativeExit.signal !== null)) {
      failures.push(new Error("Ready installed hub did not emit a normal code0/signalnull exit"));
    }
    if (forced) {
      failures.push(new Error("Installed hub required forced shutdown"));
    }

    if (failures.length) {
      const error = new AggregateError(failures, `Installed hub shutdown failed.\n${stderr}`);
      error.outcome = closeOutcome;

      throw error;
    }
  })();
  // Publish the close handle before readiness, so the fixture also owns a failed initializer.
  const handle = { urls: [origin], close, get nativeOutcome() { return closeOutcome; } };
  onStarted(handle);

  let timer;
  try {
    await new Promise((resolve, reject) => {
      let stdout = "";
      let readinessSettled = false;
      const failReadiness = (error) => {
        if (readinessSettled) return;

        readinessSettled = true;
        reject(error);
      };
      child.once("error", failReadiness);
      child.once("close", (code, signal) => failReadiness(new Error(`Installed hub exited before readiness (${signal ?? code}).\n${stderr}`)));
      child.stdout.on("data", (chunk) => {
        if (readinessSettled) return;

        stdout = (stdout + chunk.toString()).slice(0, 8193);
        if (stdout.length > 8192) {
          failReadiness(new Error("Installed hub readiness output exceeded its fixture bound"));
        } else if (stdout.includes("\n")) {
          if (stdout.trim() === origin) {
            readinessSettled = true;
            readinessPublished = true;
            resolve();
          } else {
            failReadiness(new Error(`Unexpected installed hub readiness URL: ${stdout.trim()}`));
          }
        }
      });
      timer = setTimeout(() => failReadiness(new Error(`Installed hub did not announce readiness.\n${stderr}`)), 5000);
    });
    return handle;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Installed hub startup/cleanup failed; fixture retained at ${root}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveInstalledExecutable(configuredPath) {
  assert.equal(path.isAbsolute(configuredPath), true);
  const executable = await realpath(configuredPath);
  const installedRoot = path.dirname(path.dirname(executable));
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  const sourcePackage = JSON.parse(await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"));

  assert.equal(path.basename(installedRoot), "html-inbox");
  assert.equal(path.basename(path.dirname(installedRoot)), "node_modules");
  assert.equal(installedPackage.name, "html-inbox");
  assert.equal(installedPackage.bin["html-inbox"], "bundle/index.js");
  assert.equal(executable, path.join(installedRoot, "bundle", "index.js"));
  assert.equal(installedPackage.version, sourcePackage.version);

  return executable;
}

// Developer-shell library, limit and Node runtime settings must not reach the fixture child.
function isolatedChildEnvironment(root) {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("HTML_INBOX_") && !key.startsWith("NODE_")));

  return { ...inherited, HOME: root, USERPROFILE: root,
    HTML_INBOX_HOME: path.join(root, "unused-home"), HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
    TMPDIR: root, TMP: root, TEMP: root };
}

function signalChild(child, signal, errors, refusal) {
  try {
    if (!child.kill(signal)) {
      errors.push(new Error(refusal));
    }
  } catch (error) {
    errors.push(error);
  }
}

async function closeHubFixture(t, browser, hub, root) {
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => browser?.close()),
    Promise.resolve().then(() => hub?.close()),
  ]);
  const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
  if (hub?.nativeOutcome) {
    try { t.diagnostic(JSON.stringify(hub.nativeOutcome)); } catch (error) { failures.push(error); }
  }

  if (failures.length) {
    throw new AggregateError(failures, `Hub fixture shutdown failed; evidence retained at ${root}`);
  }

  await rm(root, { recursive: true, force: true });
}

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
