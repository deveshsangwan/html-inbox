import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { formatDocumentTable } from "./cli-display";
import { CloudflarePagesAdapter } from "./cloudflare-pages";
import { type CommandInvocation } from "./command-runner";
import { parseDocumentMetadata, type DocumentSource } from "./documents";
import { LocalDocumentSource } from "./local-document-source";
import { exportStaticSnapshot, type StaticSnapshotResult } from "./static-export";
import { createSyncIngestionServer } from "./sync-http-server";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { canonicalKey, inventoryDigest, MANIFEST_DOMAIN, sha256, verifyOriginState, type RouteAuthorization, type SyncRoute } from "./sync-model";
import { ManagedSyncStore, toOriginState } from "./sync-store";
import { DOCUMENT_CSP, SHELL_CSP } from "./viewer-assets";
import { startViewerHttpServer } from "./viewer-http-server";

// Managed enrollment requires POSIX file/directory fsync; portable rejection is tested separately.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const originalBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>destination-original Ω 漢字 🧪</body></html>\r\n");
const importedBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>attached-private-body π café 🦉</body></html>\r\n");
const detachedBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>detached-private-body λ 日本語 🐈</body></html>\r\n");
const hostileTitle = '</title><script>globalThis.readerInjected=1</script><img src=x onerror="globalThis.readerInjected=2">';
const hostileType = '<svg onload="globalThis.readerInjected=3">';
const hostileFile = 'report"><img src=x onerror="globalThis.readerInjected=4">.html';
const expectedDocumentCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4 https://cdn.jsdelivr.net/npm/mermaid@11/dist/; script-src-attr 'none'; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

async function createLibrary(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "html-inbox-managed-reader-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await assert.rejects(fs.lstat(root), { code: "ENOENT" });
    t.diagnostic("Owned synthetic library tree removed");
  });

  const home = path.join(root, "destination");
  const backend = new LocalDocumentBackend(home, () => {}, () => "Shared_ID");
  const original = await backend.publish({ originalBytes, title: "Existing original", type: "report", sourceFileName: "original.html" });
  const store = new ManagedSyncStore(home);
  await store.enroll();

  const sourceHome = path.join(root, "source");
  const sourceBackend = new LocalDocumentBackend(sourceHome, () => {}, () => "Shared_ID");
  const sourceMetadata = await sourceBackend.publish({ originalBytes: importedBytes, title: hostileTitle, type: hostileType, sourceFileName: hostileFile });
  const exactMetadata = { ...sourceMetadata, createdAt: "2020-02-03T04:05:06.789+05:30" };
  await fs.writeFile(path.join(sourceHome, "documents", "Shared_ID", "metadata.json"), JSON.stringify(exactMetadata));
  const origin = new ManagedSyncStore(sourceHome);
  await origin.enroll();
  const attached = await importOrigin(origin, store);

  const detachedOrigin = new ManagedSyncStore(path.join(root, "detached-source"));
  await detachedOrigin.enroll();
  await detachedOrigin.publish({ originalBytes: detachedBytes, title: "Retained detached copy", type: "note", sourceFileName: "detached.html" }, "Shared_ID");
  const detached = await importOrigin(detachedOrigin, store);
  await store.revokeRoute(detached.route.id, detached.route.revision);

  const suppressed = await origin.publish({ originalBytes: Buffer.from("<!doctype html><html><body>suppressed-private-body</body></html>"), title: "Suppressed secret", type: "private", sourceFileName: "suppressed.html" }, "suppressed-private-id");
  const deleted = await origin.publish({ originalBytes: Buffer.from("<!doctype html><html><body>deleted-private-body</body></html>"), title: "Tombstone secret", type: "private", sourceFileName: "tombstone.html" }, "tombstone-private-id");
  for (const metadata of [suppressed, deleted]) {
    const state = (await origin.snapshot()).records[canonicalKey(attached.route.sourceInboxId, metadata.id)];
    assert.ok(state);
    const document = await origin.getDocument(metadata.id);
    assert.ok(document);
    assert.equal((await store.apply(attached.auth, toOriginState(state), document.originalBytes)).status, "committed");
  }

  const suppressedRow = (await store.listDocuments()).find((metadata) => metadata.origin?.documentId === suppressed.id);
  assert.ok(suppressedRow);
  await store.setSuppressed(suppressedRow.id, true);
  await origin.deleteDocument(deleted.id);
  const terminal = (await origin.snapshot()).records[canonicalKey(attached.route.sourceInboxId, deleted.id)];
  assert.ok(terminal);
  assert.equal((await store.apply(attached.auth, toOriginState(terminal))).status, "deleted");

  const ledger = await store.snapshot();
  const source = new LocalDocumentSource({ home, instanceId: ledger.inboxId });
  const documents = await source.listDocuments();
  const attachedRow = documents.find((metadata) => metadata.origin?.inboxId === attached.route.sourceInboxId);
  const detachedRow = documents.find((metadata) => metadata.origin?.inboxId === detached.route.sourceInboxId);
  assert.ok(attachedRow?.origin);
  assert.ok(detachedRow?.origin);

  return { root, home, backend, source, store, ledger, original, exactMetadata, attached, detached, attachedRow, detachedRow };
}

async function importOrigin(origin: ManagedSyncStore, destination: ManagedSyncStore) {
  const a = await origin.snapshot();
  const b = await destination.snapshot();
  const owner = a.originKeys.find((grant) => grant.inboxId === a.inboxId);
  assert.ok(owner);
  const route: SyncRoute = {
    id: randomUUID(), revision: 1, direction: "inbound", peerId: randomUUID(), peerUrl: "https://127.0.0.1:1/",
    sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: "destination", readerAudience: "synthetic local reader",
    allowedOrigins: [owner], credentialRef: "synthetic-reader-token", tlsTrustRef: "synthetic-reader-ca", state: "active", lastError: null,
  };
  await destination.configureRoute(route);
  const auth: RouteAuthorization = { routeId: route.id, revision: route.revision, peerId: route.peerId, sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId };
  const states = Object.values(a.records).map(toOriginState);
  const nonce = randomUUID();
  await destination.completeInventory(auth, {
    protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: route.peerId, routeId: route.id, revision: route.revision,
    scope: [{ inboxId: a.inboxId, historyEpoch: a.historyEpoch }], generation: a.generation, count: states.length, descriptorDigest: inventoryDigest(states), nonce,
  }, states, nonce);

  for (const state of states) {
    verifyOriginState(state, owner.publicKey);
    const document = await origin.getDocument(state.originDocumentId);
    assert.ok(document);
    assert.equal((await destination.apply(auth, state, document.originalBytes)).status, "committed");
  }

  return { route, auth };
}

test("managed backend and read-only source preserve originals, canonical collisions and complete origin metadata", async (t) => {
  const fixture = await createLibrary(t);
  const documents = await fixture.backend.listDocuments();
  assert.deepEqual(await fixture.source.listDocuments(), documents);
  assert.equal(documents.length, 3);
  assert.equal(new Set(documents.map((metadata) => metadata.id)).size, 3);
  assert.equal(documents.find((metadata) => !metadata.origin)?.id, "Shared_ID");
  assert.notEqual(fixture.attachedRow.id, "Shared_ID");
  assert.notEqual(fixture.detachedRow.id, "Shared_ID");
  assert.deepEqual(fixture.attachedRow.origin?.originalMetadata, fixture.exactMetadata);
  assert.equal(fixture.attachedRow.origin?.detached, false);
  assert.equal(fixture.detachedRow.origin?.detached, true);
  assert.match(formatDocumentTable(documents), /\[origin /);
  assert.match(formatDocumentTable(documents), /detached/);

  for (const [metadata, bytes] of [[fixture.original, originalBytes], [fixture.attachedRow, importedBytes], [fixture.detachedRow, detachedBytes]] as const) {
    assert.deepEqual(parseDocumentMetadata(metadata), metadata);
    for (const source of [fixture.backend, fixture.source]) {
      assert.deepEqual(await source.getDocumentMetadata(metadata.id), metadata);
      assert.deepEqual(await source.getDocument(metadata.id), { metadata, originalBytes: bytes });
    }

    if (metadata.origin) {
      const record = fixture.ledger.records[canonicalKey(metadata.origin.inboxId, metadata.origin.documentId)];
      assert.ok(record);
      assert.equal(record.signature, metadata.origin.signature);
      assert.equal(metadata.origin.sha256, sha256(bytes));
      assert.equal(metadata.origin.byteLength, bytes.length);
    }
  }

  for (const id of ["missing", "shared_id"]) {
    assert.equal(await fixture.source.getDocument(id), null);
  }
});

test("ordinary metadata parsing rejects hostile provenance instead of turning it into a display badge", async (t) => {
  const fixture = await createLibrary(t);
  const origin = fixture.attachedRow.origin;
  assert.ok(origin);
  const invalidOrigins = [
    { ...origin, inboxId: '"><script>globalThis.readerInjected=1</script>' },
    { ...origin, documentId: '<img src=x onerror="globalThis.readerInjected=1">' },
    { ...origin, detached: '<svg onload="globalThis.readerInjected=1">' },
    { ...origin, originalMetadata: { ...origin.originalMetadata, unvalidatedProvenance: hostileTitle } },
  ];
  for (const invalidOrigin of invalidOrigins) {
    assert.throws(() => parseDocumentMetadata({ ...fixture.attachedRow, origin: invalidOrigin }), /origin|unsupported/i);
  }

  assert.deepEqual(parseDocumentMetadata(fixture.attachedRow), fixture.attachedRow);
});

for (const kind of ["backend", "source"] as const) {
  test(`managed ${kind} HTTP routes resolve colliding IDs, search provenance and reject sync ingestion`, async (t) => {
    const fixture = await createLibrary(t);
    const reader = await startOwnedReader(t, fixture[kind]);
    const before = await captureTree(fixture.home);
    assert.equal(DOCUMENT_CSP, expectedDocumentCsp);

    for (const [metadata, bytes] of [[fixture.original, originalBytes], [fixture.attachedRow, importedBytes], [fixture.detachedRow, detachedBytes]] as const) {
      const shell = await fetch(`${reader.origin}/documents/${metadata.id}`);
      assert.equal(shell.status, 200);
      assert.equal(shell.headers.get("content-security-policy"), SHELL_CSP);
      const html = await shell.text();
      assert.match(html, /sandbox="allow-scripts"/);
      assert.equal(html.includes("allow-same-origin"), false);
      assert.equal(html.includes(`<script>globalThis.readerInjected`), false);
      const response = await fetch(`${reader.origin}/documents/${metadata.id}/content`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-security-policy"), expectedDocumentCsp);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }

    const searches = [
      { query: fixture.attached.route.sourceInboxId, expectedIds: [fixture.attachedRow.id] },
      { query: "Shared_ID", expectedIds: [fixture.attachedRow.id, fixture.detachedRow.id] },
      { query: "detached", expectedIds: [fixture.detachedRow.id] },
      { query: "original.html", expectedIds: [fixture.original.id] },
      { query: "retained", expectedIds: [fixture.detachedRow.id] },
      { query: "note", expectedIds: [fixture.detachedRow.id] },
      { query: "missing-query", expectedIds: [] },
    ];
    for (const { query, expectedIds } of searches) {
      const response = await fetch(`${reader.origin}/?q=${encodeURIComponent(query)}`);
      const html = await response.text();
      assert.equal(response.status, 200);
      const actualIds = Array.from(html.matchAll(/class="doc__title" href="\/documents\/([A-Za-z0-9_-]+)"/g), (match) => match[1]);
      assert.deepEqual(actualIds.sort(), expectedIds.sort());
    }

    for (const origin of [reader.origin, reader.controlOrigin]) {
      for (const endpoint of ["identity", "manifest", "holdings", "offer", "body"]) {
        const response = await fetch(`${origin}/sync/v1/${endpoint}`, { method: endpoint === "body" ? "PUT" : "POST", body: JSON.stringify({ descriptor: fixture.attachedRow.origin }) });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("allow"), "GET, HEAD");
        await response.text();
      }
    }

    assert.deepEqual(await captureTree(fixture.home), before);
  });
}

test("managed LocalDocumentSource never writes, locks, chmods, migrates or fsyncs during successful reads", async (t) => {
  const fixture = await createLibrary(t);
  const before = await captureTree(fixture.home);
  const file = await fs.open(path.join(fixture.home, "sync", "ledger.json"), "r");
  const prototype = Object.getPrototypeOf(file);
  await file.close();
  const realOpen = fs.open;
  const forbidden = () => { throw new Error("Read-only source attempted a storage mutation"); };
  const mutations = ["chmod", "chown", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "unlink", "writeFile", "appendFile", "truncate", "link", "symlink", "copyFile", "cp", "utimes"] as const;
  for (const operation of mutations) {
    t.mock.method(fs, operation, forbidden);
  }
  t.mock.method(prototype, "sync", forbidden);
  t.mock.method(prototype, "datasync", forbidden);
  t.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => {
    const [filename, flags, mode] = args;
    if (typeof flags === "number") {
      assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0);
    } else {
      assert.equal(flags, "r");
    }

    return realOpen(filename, flags, mode);
  });

  try {
    const fresh = new LocalDocumentSource({ home: fixture.home, instanceId: fixture.ledger.inboxId });
    const documents = await fresh.listDocuments();
    assert.equal(documents.length, 3);
    for (const metadata of documents) {
      assert.deepEqual(await fresh.getDocumentMetadata(metadata.id), metadata);
      assert.ok(await fresh.getDocument(metadata.id));
    }
  } finally {
    t.mock.restoreAll();
  }

  assert.deepEqual(await captureTree(fixture.home), before);
});

test("read-only managed source rejects unsafe permissions and incomplete migration without repairing either", async (t) => {
  const fixture = await createLibrary(t);
  const syncDirectory = path.join(fixture.home, "sync");
  await fs.chmod(syncDirectory, 0o755);
  let before = await captureTree(fixture.home);
  for (const read of [() => fixture.source.listDocuments(), () => fixture.source.getDocumentMetadata("Shared_ID"), () => fixture.source.getDocument("Shared_ID")]) {
    await assert.rejects(read(), /private/);
  }
  assert.deepEqual(await captureTree(fixture.home), before);

  await fs.chmod(syncDirectory, 0o700);
  const ledgerPath = path.join(syncDirectory, "ledger.json");
  const ledger = await fixture.store.snapshot();
  ledger.migration.phase = "barrier";
  await fs.writeFile(ledgerPath, JSON.stringify(ledger));
  before = await captureTree(fixture.home);
  await assert.rejects(fixture.source.listDocuments(), /incomplete|migration/i);
  await assert.rejects(fixture.source.getDocument("Shared_ID"), /incomplete|migration/i);
  assert.deepEqual(await captureTree(fixture.home), before);
});

test("read-only source reports a lost imported body unavailable without recovery or invented deletion", async (t) => {
  const fixture = await createLibrary(t);
  const key = canonicalKey(fixture.attached.route.sourceInboxId, "Shared_ID");
  const record = fixture.ledger.records[key];
  assert.ok(record.bodyFile);
  await fs.rm(path.join(fixture.home, "sync", "bodies", record.bodyFile));
  const before = await captureTree(fixture.home);
  const source = new LocalDocumentSource({ home: fixture.home, instanceId: fixture.ledger.inboxId });
  assert.deepEqual(new Set((await source.listDocuments()).map((metadata) => metadata.id)), new Set([fixture.original.id, fixture.detachedRow.id]));
  assert.equal(await source.getDocumentMetadata(fixture.attachedRow.id), null);
  assert.equal(await source.getDocument(fixture.attachedRow.id), null);
  assert.deepEqual((await fixture.store.snapshot()).records[key], record);
  assert.equal(record.state, "live");
  assert.deepEqual(await captureTree(fixture.home), before);
});

test("unknown legacy metadata extras block enrollment and retain their exact original representation", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "html-inbox-reader-extras-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const backend = new LocalDocumentBackend(home, () => {}, () => "Legacy_Case");
  const metadata = await backend.publish({ originalBytes, title: "Legacy fields", type: "report", sourceFileName: "legacy.html" });
  const raw = JSON.stringify({ ...metadata, arbitraryExtra: { unicode: "原稿", nested: [1, "preserve me"] } }, null, 2) + "\r\n";
  await fs.writeFile(path.join(home, "documents", metadata.id, "metadata.json"), raw);
  await assert.rejects(new ManagedSyncStore(home).enroll(), /unsupported fields|explicit.*projection/i);
  const retained = path.join(home, "sync", "legacy-documents", metadata.id);
  assert.equal(await fs.readFile(path.join(retained, "metadata.json"), "utf8"), raw);
  assert.deepEqual(await fs.readFile(path.join(retained, "index.html")), originalBytes);

  const before = await captureTree(home);
  const instanceId = (await fs.readFile(path.join(home, "instance-id"), "utf8")).trim();
  await assert.rejects(new LocalDocumentSource({ home, instanceId }).listDocuments(), /incomplete|unsupported/i);
  assert.deepEqual(await captureTree(home), before);
});

for (const kind of ["backend", "source"] as const) {
  test(`static and cloud upload artifacts from managed ${kind} include only originals`, async (t) => {
    const fixture = await createLibrary(t);
    const fetchedIds: string[] = [];
    const source = fixture[kind];
    const snapshot = await exportStaticSnapshot({
      listDocuments: () => source.listDocuments(),
      getDocument(id) {
        fetchedIds.push(id);
        return source.getDocument(id);
      },
    }, { outputDir: path.join(fixture.root, "public-snapshot") });
    assert.equal(snapshot.manifest.documentCount, 1);
    assert.deepEqual(fetchedIds, [fixture.original.id]);
    await assertPublicTree(snapshot.outputDir, snapshot, fixture, fixture.original.id, originalBytes);

    const invocations: CommandInvocation[] = [];
    const adapter = new CloudflarePagesAdapter({
      async run(invocation) {
        invocations.push(invocation);
        assert(invocation.args.includes("deploy"));
        await assertPublicTree(invocation.cwd, snapshot, fixture, fixture.original.id, originalBytes);
        assert.match(await fs.readFile(path.join(invocation.cwd, "_headers"), "utf8"), /sandbox allow-scripts;/);
        return { code: 0, signal: null, stdout: "Deployment complete! https://abc123.reader-test.pages.dev", stderr: "" };
      },
    }, 1000, async () => { throw new Error("Cloud export test attempted a network request"); });
    const receipt = await adapter.deploySnapshot(snapshot, { accountId: "a".repeat(32), projectName: "reader-test" });
    assert.equal(invocations.length, 1);
    assert.equal(receipt.deploymentUrl, "https://abc123.reader-test.pages.dev");
    await assert.rejects(fs.lstat(invocations[0].cwd), { code: "ENOENT" });
    assert.equal((await fs.readdir(fixture.root)).some((name) => name.includes(".cloudflare-")), false);
  });
}

test("fork-inherited originals remain excluded from public exports alongside detached imports", async (t) => {
  const fixture = await createLibrary(t);
  await fixture.store.quarantineRestore();
  await fixture.store.fork();
  const bytes = Buffer.from("<!doctype html><html><body>fresh-fork-original</body></html>");
  const fresh = await fixture.store.publish({ originalBytes: bytes, title: "Fresh fork", type: "report", sourceFileName: "fresh.html" }, "fresh-original");
  const documents = await fixture.backend.listDocuments();
  assert.equal(documents.length, 4);
  assert.equal(documents.filter((metadata) => metadata.origin?.detached).length, 3);
  const snapshot = await exportStaticSnapshot(fixture.backend, { outputDir: path.join(fixture.root, "fork-snapshot") });
  assert.equal(snapshot.manifest.documentCount, 1);
  await assertPublicTree(snapshot.outputDir, snapshot, fixture, fresh.id, bytes);
  const files = await readTreeFiles(snapshot.outputDir);
  assert.equal([...files.values()].some((contents) => contents.includes(originalBytes)), false);
});

test("export rechecks fetched managed origin and preserves the previous snapshot on a reader race", async (t) => {
  const fixture = await createLibrary(t);
  const outputDir = path.join(fixture.root, "racing-snapshot");
  await exportStaticSnapshot(fixture.source, { outputDir });
  const before = await captureTree(outputDir);
  const imported = await fixture.source.getDocument(fixture.attachedRow.id);
  assert.ok(imported);
  const getDocument = t.mock.method(fixture.source, "getDocument", async () => imported);
  await assert.rejects(exportStaticSnapshot(fixture.source, { outputDir }), /changed while exporting/);
  assert.equal(getDocument.mock.callCount(), 1);
  assert.deepEqual(await captureTree(outputDir), before);
  assert.equal((await fs.readdir(fixture.root)).some((name) => name.includes(".staging-")), false);
});

test("dedicated HTTPS ingestion has no reader, control or process administration endpoints", async (t) => {
  const fixture = await createLibrary(t);
  const credentials = await createSyncHttpsCredentials(t);
  const server = createSyncIngestionServer({
    store: fixture.store, peerId: randomUUID(), host: "127.0.0.1", port: 0,
    key: await fs.readFile(credentials.trusted.keyPath), cert: await fs.readFile(credentials.trusted.certPath),
    credentials: () => ({ token: Buffer.alloc(32, 7).toString("base64url") }),
  });
  const { url } = await server.start();
  const port = Number(new URL(url).port);
  t.after(async () => {
    await server.close();
    assert.equal(server.status().listening, false);
    await assertReleasedPort(port);
    t.diagnostic(`Owned HTTPS ingress port ${port} released`);
  });
  const before = await captureTree(fixture.home);
  const ca = await fs.readFile(credentials.caPath);
  for (const endpoint of ["/", "/health", "/documents/Shared_ID", "/control/stop", "/viewer/stop", "/sync/enable", "/sync/v1/stop"]) {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = https.request(new URL(endpoint, url), { ca, method: "POST", agent: false, timeout: 2000 }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { body += chunk; });
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
      });
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("Owned ingress request timed out")));
      request.end();
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.includes("Existing original"), false);
    assert.equal(response.body.includes(fixture.ledger.inboxId), false);
  }

  assert.equal(server.status().listening, true);
  assert.deepEqual(await captureTree(fixture.home), before);
});

async function startOwnedReader(t: TestContext, source: DocumentSource) {
  const reader = await startViewerHttpServer(source, { host: "127.0.0.1", port: 0, exposure: "loopback" }, {
    instanceId: randomUUID(), processId: randomUUID(), protocolVersion: 1, pid: process.pid,
  });
  const address = reader.server.address();
  const controlAddress = reader.controlServer.address();
  assert.ok(address && typeof address !== "string");
  assert.ok(controlAddress && typeof controlAddress !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(controlAddress.address, "127.0.0.1");
  t.after(async () => {
    reader.server.closeAllConnections();
    reader.controlServer.closeAllConnections();
    await reader.close();
    await assertReleasedPort(address.port);
    await assertReleasedPort(controlAddress.port);
    t.diagnostic(`Owned reader/control ports ${address.port}/${controlAddress.port} released`);
  });

  return { origin: `http://127.0.0.1:${address.port}`, controlOrigin: `http://127.0.0.1:${controlAddress.port}` };
}

async function assertReleasedPort(port: number) {
  const probe = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
}

async function captureTree(root: string) {
  const entries: { relativePath: string; mode: number; ino: number; size: number; mtime: number; ctime: number; digest: string | null }[] = [];
  async function visit(relativePath: string) {
    const absolutePath = path.join(root, relativePath);
    const info = await fs.lstat(absolutePath);
    entries.push({ relativePath, mode: info.mode, ino: info.ino, size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, digest: info.isFile() ? sha256(await fs.readFile(absolutePath)) : null });
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(absolutePath)).sort()) {
        await visit(path.join(relativePath, name));
      }
    }
  }

  await visit("");
  return entries;
}

async function readTreeFiles(root: string) {
  const files = new Map<string, Buffer>();
  async function visit(relativePath: string) {
    for (const entry of await fs.readdir(path.join(root, relativePath), { withFileTypes: true })) {
      const filename = path.join(relativePath, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) {
        await visit(filename);
      } else {
        assert.equal(entry.isFile(), true);
        files.set(filename, await fs.readFile(path.join(root, filename)));
      }
    }
  }

  await visit("");
  return files;
}

async function assertPublicTree(directory: string, snapshot: StaticSnapshotResult, fixture: Awaited<ReturnType<typeof createLibrary>>, originalId: string, bytes: Buffer) {
  const files = await readTreeFiles(directory);
  const contentPath = `${snapshot.inboxPath.slice(1)}/documents/${originalId}/content/index.html`;
  assert.deepEqual(files.get(contentPath), bytes);
  assert.deepEqual([...files.keys()].filter((filename) => filename.endsWith("/content/index.html")), [contentPath]);
  const prohibited = [
    importedBytes.toString("utf8"), detachedBytes.toString("utf8"), hostileTitle, "suppressed-private-body", "deleted-private-body",
    "suppressed-private-id", "tombstone-private-id", fixture.attached.route.sourceInboxId, fixture.detached.route.sourceInboxId,
    fixture.attached.route.id, fixture.detached.route.id, "PRIVATE KEY", "synthetic-reader-token", "ledger.json", "ownerAnchor",
    ...Object.values(fixture.ledger.records).filter((record) => record.originInboxId !== fixture.ledger.inboxId).map((record) => record.signature),
    ...fixture.ledger.originKeys.map((grant) => grant.publicKey),
  ];
  for (const [filename, contents] of files) {
    assert.equal(/(?:^|\/)(?:sync|staging|legacy-documents|bodies)(?:\/|$)/.test(filename), false, filename);
    for (const secret of prohibited) {
      assert.equal(contents.includes(Buffer.from(secret)), false, `Public artifact ${filename} contains managed-only data`);
    }
  }
}
