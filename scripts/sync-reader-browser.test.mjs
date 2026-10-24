import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest from "node:test";
import { chromium } from "playwright";
import { LocalDocumentBackend } from "../packages/cli/dist/backend.js";
import { LocalDocumentSource } from "../packages/cli/dist/local-document-source.js";
import { canonicalKey, inventoryDigest, MANIFEST_DOMAIN, verifyOriginState } from "../packages/cli/dist/sync-model.js";
import { ManagedSyncStore, toOriginState } from "../packages/cli/dist/sync-store.js";
import { DOCUMENT_CSP, SHELL_CSP } from "../packages/cli/dist/viewer-assets.js";
import { startViewerHttpServer } from "../packages/cli/dist/viewer-http-server.js";
import { installCdnFixtures } from "./browser-fixtures.mjs";

// Managed enrollment requires POSIX file/directory fsync; portable rejection is tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const hostileTitle = '</title><script>globalThis.readerInjected=1</script><img src=x onerror="globalThis.readerInjected=2">';
const hostileType = '<svg onload="globalThis.readerInjected=3">';
const hostileFile = 'hostile"><img src=x onerror="globalThis.readerInjected=4">.html';
const hostileInbox = 'Inbox "><svg onload="globalThis.readerInjected=5">';
const isolationBytes = Buffer.from(`\ufeff<!doctype html>
<html><head><script src="https://cdn.tailwindcss.com"></script></head><body>
<h1>Imported isolation proof Ω 日本語 🦉</h1>
<p id="isolation">loading</p><p id="storage">loading</p><p id="network">loading</p>
<script>
  let parentBlocked = false;
  let storageBlocked = false;
  try { parent.document.documentElement.dataset.compromised = 'yes'; } catch { parentBlocked = true; }
  try { localStorage.setItem('managed-document', 'escaped'); } catch { storageBlocked = true; }
  document.querySelector('#isolation').textContent = parentBlocked ? 'isolated' : 'parent allowed';
  document.querySelector('#storage').textContent = storageBlocked ? 'storage isolated' : 'storage allowed';
  parent.postMessage({ type: 'managed-isolation-proof', parentBlocked, storageBlocked }, '*');
  fetch('/health').then(() => document.querySelector('#network').textContent = 'network allowed')
    .catch(() => document.querySelector('#network').textContent = 'network blocked');
</script></body></html>
`.replaceAll("\n", "\r\n"));

for (const kind of ["backend", "source"]) {
  test(`managed ${kind} browser keeps collision routes, search, themes and iframe origin isolation`, { timeout: 45_000 }, async (t) => {
    const fixture = await createManagedBrowserFixture(t, kind);
    const { page, context, origin, original, imported, otherImport, store, route } = fixture;
    const cdn = await installCdnFixtures(context);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await context.addInitScript(() => {
      globalThis.managedFrameMessages = [];
      addEventListener("message", (event) => {
        if (event.data?.type === "managed-isolation-proof") {
          globalThis.managedFrameMessages.push({ origin: event.origin, ...event.data });
        }
      });
    });

    const response = await page.goto(`${origin}/`);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-security-policy"], SHELL_CSP);
    assert.equal(await page.locator("[data-search-text]").count(), 3);
    assert.equal(await page.locator("h1").textContent(), hostileInbox);
    await assertRendererEscaped(page);
    const attachedLink = page.locator(`a.doc__title[href="/documents/${imported.id}"]`);
    assert.equal(await attachedLink.textContent(), `${hostileTitle} ${route.sourceInboxId} · imported`);
    assert.equal(await attachedLink.locator(".inbox-badge").getAttribute("title"), `Origin ${route.sourceInboxId} / Shared_ID`);
    assert.equal(await page.locator(`a[href="/documents/${otherImport.id}"] .inbox-badge`).textContent(), `${otherImport.origin.inboxId} · imported`);
    assert.equal(await page.locator(`a[href="/documents/${original.id}"] .inbox-badge`).count(), 0);

    await page.locator('html[data-theme="dark"]').waitFor();
    await chooseAppearance(page, "Light");
    await page.reload();
    await page.locator('html[data-theme="light"]').waitFor();
    await chooseAppearance(page, "System");
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator('html[data-theme="light"]').waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator('html[data-theme="dark"]').waitFor();
    await chooseAppearance(page, "Light");

    for (const [query, id] of [[route.sourceInboxId, imported.id], ["hostile", imported.id], ["note", otherImport.id], ["other-origin.html", otherImport.id], ["original.html", original.id]]) {
      await page.getByRole("searchbox", { name: "Search documents" }).fill(query);
      await Promise.all([
        page.waitForURL((url) => url.searchParams.get("q") === query),
        page.getByRole("button", { name: "Search", exact: true }).click(),
      ]);
      assert.equal(await page.locator("[data-search-text]").count(), 1);
      assert.equal(await page.locator(`a.doc__title[href="/documents/${id}"]`).count(), 1);
      await assertRendererEscaped(page);
    }

    await page.goto(`${origin}/`);
    await page.locator(`a.doc__title[href="/documents/${original.id}"]`).click();
    await page.frameLocator("iframe").getByRole("heading", { name: "Existing destination original", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/documents/Shared_ID");
    await page.getByRole("link", { name: "Back to inbox" }).click();
    await page.locator(`a.doc__title[href="/documents/${otherImport.id}"]`).click();
    await page.frameLocator("iframe").getByRole("heading", { name: "Second origin with same bare ID", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/documents/${otherImport.id}`);
    await page.getByRole("link", { name: "Back to inbox" }).click();

    const contentResponse = page.waitForResponse(`${origin}/documents/${imported.id}/content`);
    await page.locator(`a.doc__title[href="/documents/${imported.id}"]`).click();
    const content = await contentResponse;
    assert.equal(content.status(), 200);
    assert.equal(content.headers()["content-security-policy"], DOCUMENT_CSP);
    // DevTools decodes HTML response bodies and strips the BOM. APIRequest retains the HTTP octets.
    const rawContent = await context.request.get(content.url());
    assert.equal(rawContent.status(), 200);
    assert.deepEqual(await rawContent.body(), isolationBytes);
    assert.equal(DOCUMENT_CSP.startsWith("sandbox allow-scripts;"), true);
    assert.equal(DOCUMENT_CSP.includes("allow-same-origin"), false);
    const frameElement = page.locator("iframe");
    assert.equal(await frameElement.getAttribute("sandbox"), "allow-scripts");
    assert.equal(await frameElement.getAttribute("src"), `/documents/${imported.id}/content`);
    assert.equal(await frameElement.getAttribute("title"), hostileTitle);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("heading", { name: "Imported isolation proof Ω 日本語 🦉", exact: true }).waitFor();
    await frame.locator("#isolation").getByText("isolated", { exact: true }).waitFor();
    await frame.locator("#storage").getByText("storage isolated", { exact: true }).waitFor();
    await frame.locator("#network").getByText("network blocked", { exact: true }).waitFor();
    await page.waitForFunction(() => globalThis.managedFrameMessages.length > 0);
    assert.deepEqual(await page.evaluate(() => globalThis.managedFrameMessages), [{ origin: "null", type: "managed-isolation-proof", parentBlocked: true, storageBlocked: true }]);
    assert.equal(await frameElement.evaluate((element) => element.contentDocument === null), true);
    assert.equal(await page.locator("html").getAttribute("data-compromised"), null);
    assert.equal(await page.evaluate(() => localStorage.getItem("managed-document")), null);
    await page.locator('html[data-theme="light"]').waitFor();
    await assertRendererEscaped(page);

    await store.revokeRoute(route.id, route.revision);
    await page.reload();
    assert.equal(await page.locator("h1 .inbox-badge").textContent(), `${route.sourceInboxId} · detached`);
    await frame.locator("#isolation").getByText("isolated", { exact: true }).waitFor();
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    await assertRendererEscaped(page);
    await page.getByRole("link", { name: "Back to inbox" }).click();
    assert.equal(await page.locator("[data-search-text]").count(), 3);
    assert.equal(await page.locator(`a[href="/documents/${imported.id}"] .inbox-badge`).textContent(), `${route.sourceInboxId} · detached`);
    await page.getByRole("searchbox", { name: "Search documents" }).fill("detached");
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("q") === "detached"),
      page.getByRole("button", { name: "Search", exact: true }).click(),
    ]);
    assert.equal(await page.locator("[data-search-text]").count(), 1);
    assert.equal(await page.locator(`a.doc__title[href="/documents/${imported.id}"]`).count(), 1);
    await page.reload();
    assert.equal(await page.locator(`a.doc__title[href="/documents/${imported.id}"] .inbox-badge`).textContent(), `${route.sourceInboxId} · detached`);

    assert.deepEqual(pageErrors, []);
    assert(cdn.requestedUrls.includes("https://cdn.tailwindcss.com/"));
    assert.deepEqual(cdn.unexpectedUrls, []);
    assert.deepEqual(fixture.blockedExternalUrls, []);
    assert.equal(fixture.localRequests.some((url) => new URL(url).pathname === "/health"), false);
    t.diagnostic("CDN fulfilled locally; opaque iframe origin and current detached badges verified");
  });
}

async function createManagedBrowserFixture(t, kind) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-sync-browser-"));
  let reader;
  let browser;
  let context;
  let ports = [];
  t.after(async () => {
    try {
      await context?.close();
      assert.equal(browser?.contexts().length ?? 0, 0);
    } finally {
      try {
        await browser?.close();
        assert.equal(browser?.isConnected() ?? false, false);
      } finally {
        try {
          if (reader) {
            reader.server.closeAllConnections();
            reader.controlServer.closeAllConnections();
            await reader.close();
          }
          for (const port of ports) {
            await assertReleasedPort(port);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
          await assert.rejects(lstat(root), { code: "ENOENT" });
        }
      }
    }
    t.diagnostic(`Browser/context closed, synthetic homes removed, reader/control ports ${ports.join("/")} released`);
  });

  const home = path.join(root, "destination");
  const backend = new LocalDocumentBackend(home, () => {}, () => "Shared_ID");
  const original = await backend.publish({ originalBytes: Buffer.from("\ufeff<!doctype html>\r\n<html><body><h1>Existing destination original</h1></body></html>\r\n"), title: "Existing original", type: "report", sourceFileName: "original.html" });
  const store = new ManagedSyncStore(home);
  await store.enroll();
  const importedOrigin = new ManagedSyncStore(path.join(root, "source"));
  await importedOrigin.enroll();
  await importedOrigin.publish({ originalBytes: isolationBytes, title: hostileTitle, type: hostileType, sourceFileName: hostileFile }, "Shared_ID");
  const route = await importOrigin(importedOrigin, store);
  const otherOrigin = new ManagedSyncStore(path.join(root, "other-source"));
  await otherOrigin.enroll();
  await otherOrigin.publish({ originalBytes: Buffer.from("<!doctype html><html><body><h1>Second origin with same bare ID</h1></body></html>"), title: "Second origin", type: "note", sourceFileName: "other-origin.html" }, "Shared_ID");
  const otherRoute = await importOrigin(otherOrigin, store);
  const ledger = await store.snapshot();
  const source = kind === "backend" ? backend : new LocalDocumentSource({ home, instanceId: ledger.inboxId });
  const documents = await source.listDocuments();
  const imported = documents.find((metadata) => metadata.origin?.inboxId === route.sourceInboxId);
  const otherImport = documents.find((metadata) => metadata.origin?.inboxId === otherRoute.sourceInboxId);
  assert.ok(imported?.origin);
  assert.ok(otherImport?.origin);
  assert.equal(new Set(documents.map((metadata) => metadata.id)).size, 3);
  assert.deepEqual((await source.getDocument(imported.id)).originalBytes, isolationBytes);

  reader = await startViewerHttpServer(source, { host: "127.0.0.1", port: 0, exposure: "loopback" }, {
    instanceId: ledger.inboxId, processId: randomUUID(), protocolVersion: 1, pid: process.pid,
  }, undefined, { inboxName: hostileInbox });
  const address = reader.server.address();
  const controlAddress = reader.controlServer.address();
  assert(address && typeof address !== "string");
  assert(controlAddress && typeof controlAddress !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(controlAddress.address, "127.0.0.1");
  ports = [address.port, controlAddress.port];
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    ...(process.env.HTML_INBOX_BROWSER_EXECUTABLE ? { executablePath: process.env.HTML_INBOX_BROWSER_EXECUTABLE } : {}),
    args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  context = await browser.newContext({ colorScheme: "dark" });
  const blockedExternalUrls = [];
  const localRequests = [];
  await context.route("**/*", async (requestRoute) => {
    const url = new URL(requestRoute.request().url());
    if (url.origin === origin) {
      localRequests.push(url.href);
      await requestRoute.continue();
      return;
    }

    blockedExternalUrls.push(url.href);
    await requestRoute.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);

  return { root, page, context, origin, original, imported, otherImport, store, route, blockedExternalUrls, localRequests };
}

async function importOrigin(origin, destination) {
  const a = await origin.snapshot();
  const b = await destination.snapshot();
  const owner = a.originKeys.find((grant) => grant.inboxId === a.inboxId);
  assert.ok(owner);
  const route = {
    id: randomUUID(), revision: 1, direction: "inbound", peerId: randomUUID(), peerUrl: "https://127.0.0.1:1/",
    sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: "destination", readerAudience: "synthetic local reader",
    allowedOrigins: [owner], credentialRef: "synthetic-browser-token", tlsTrustRef: "synthetic-browser-ca", state: "active", lastError: null,
  };
  await destination.configureRoute(route);
  const auth = { routeId: route.id, revision: route.revision, peerId: route.peerId, sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId };
  const states = Object.values(a.records).map(toOriginState);
  const nonce = randomUUID();
  await destination.completeInventory(auth, {
    protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: route.peerId, routeId: route.id, revision: route.revision,
    scope: [{ inboxId: a.inboxId, historyEpoch: a.historyEpoch }], generation: a.generation, count: states.length, descriptorDigest: inventoryDigest(states), nonce,
  }, states, nonce);
  const record = a.records[canonicalKey(a.inboxId, "Shared_ID")];
  assert.ok(record);
  verifyOriginState(toOriginState(record), owner.publicKey);
  const document = await origin.getDocument("Shared_ID");
  assert.ok(document);
  assert.equal((await destination.apply(auth, toOriginState(record), document.originalBytes)).status, "committed");

  return route;
}

async function assertRendererEscaped(page) {
  assert.equal(await page.locator("img, svg[onload], script:not([src])").count(), 0);
  assert.deepEqual(await page.locator("script").evaluateAll((elements) => elements.map((element) => element.getAttribute("src"))), ["/assets/viewer.js"]);
  assert.equal(await page.evaluate(() => typeof globalThis.readerInjected), "undefined");
  assert.equal(await page.locator("[onerror], [onload]").count(), 0);
}

async function chooseAppearance(page, appearance) {
  const menu = page.locator("details[data-viewer-menu]");
  await menu.locator("summary").click();
  await page.getByRole("radio", { name: appearance, exact: true }).check();
  await menu.locator("summary").click();
}

async function assertReleasedPort(port) {
  const probe = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
}
