import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { mkdtemp, lstat, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import platformTest, { type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { createDocumentDeleter, DocumentIdentityError } from "./document-deletion";
import { startHub } from "./hub";
import { registerInbox } from "./inbox-catalog";
import * as syncFiles from "./sync-files";
import { outboxKey } from "./sync-ledger";
import { canonicalKey, inventoryDigest, MANIFEST_DOMAIN, sha256, verifyOriginState, type RouteAuthorization, type SyncRoute } from "./sync-model";
import { ManagedDeletionIdentityError, ManagedSyncStore, toOriginState, type ManagedDeletionIdentity } from "./sync-store";
import { LIVE_SHELL_CSP } from "./viewer-assets";
import { getInboxInstanceId, readViewerRecord } from "./viewer-records";
import { startViewer } from "./viewer-server";

const originalBytes = Buffer.from("\ufeff<!doctype html>\r\n<html><body>managed deletion π</body></html>\r\n");
const test = process.platform === "win32" ? platformTest.skip : platformTest;

async function fixture(t: TestContext) {
  const root = await fs.realpath(await mkdtemp(path.join(tmpdir(), "html-inbox-managed-deletion-")));
  const resources: (() => Promise<void>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of resources.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, "Owned managed-deletion resources did not close");
    }

    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: "ENOENT" });
    t.diagnostic("owned listeners closed and rebound; synthetic home removed");
  });

  return { root, resources };
}

async function assertPortReleased(port: number) {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

async function startOwnedViewer(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, home: string) {
  const signalListeners = { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") };
  f.resources.push(async () => {
    assert.equal(process.listenerCount("SIGINT"), signalListeners.interrupt);
    assert.equal(process.listenerCount("SIGTERM"), signalListeners.terminate);
    assert.equal(await readViewerRecord(home), null);
  });

  const server = await startViewer(new LocalDocumentBackend(home), home, { port: 0, host: "127.0.0.1", exposure: "loopback" });
  const address = server.address();
  assert(address && typeof address !== "string");
  const record = await readViewerRecord(home);
  assert(record);
  const controlPort = Number(new URL(record.controlUrl).port);
  f.resources.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const deadline = Date.now() + 5000;
    while (await readViewerRecord(home)) {
      assert(Date.now() < deadline, "viewer cleanup removes its own record");
      await delay(10);
    }

    await assertPortReleased(address.port);
    await assertPortReleased(controlPort);
    assert.equal(process.listenerCount("SIGINT"), signalListeners.interrupt);
    assert.equal(process.listenerCount("SIGTERM"), signalListeners.terminate);
    t.diagnostic(`actual viewer reader/control ports ${address.port}/${controlPort} rebound`);
  });

  return `http://127.0.0.1:${address.port}`;
}

async function deleteThroughReader(origin: string, target: string) {
  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200);
  const token = /data-delete-token="([A-Za-z0-9_-]{43})"/.exec(await index.text())?.[1];
  assert(token, "live reader supplies a process-scoped deletion token");

  const response = await fetch(`${origin}${target}`, {
    method: "DELETE", headers: { Origin: origin, "X-HTML-Inbox-CSRF": token },
  });
  await response.text();
  return response;
}

function deleteThroughRawHttp(origin: string, target: string, headers: http.OutgoingHttpHeaders) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request(new URL(target, origin), { method: "DELETE", headers, agent: false }, (response) => {
      response.once("error", reject);
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.resume();
    });
    request.once("error", reject);
    request.end();
  });
}

async function library(f: Awaited<ReturnType<typeof fixture>>, name: string, managed = true) {
  const home = path.join(f.root, name);
  const backend = new LocalDocumentBackend(home, () => {}, () => "original");
  const metadata = await backend.publish({ originalBytes, title: name, type: "report", sourceFileName: `${name}.html` });
  const instanceId = await getInboxInstanceId(home);
  const store = new ManagedSyncStore(home);
  if (managed) {
    await store.enroll();
  }

  return { home, backend, store, instanceId, metadata };
}

async function startOwnedHub(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, sources: { name: string; home: string; instanceId: string }[]) {
  const hub = await startHub({ schemaVersion: 1, name: "Managed reports", sources: sources.map(({ name, home, instanceId }) => ({ name, home, instanceId })) },
    { port: 0, host: "127.0.0.1", exposure: "loopback" });
  const address = hub.server.address();
  assert(address && typeof address !== "string");
  f.resources.push(async () => {
    hub.server.closeAllConnections();
    await hub.close();
    await assertPortReleased(address.port);
    t.diagnostic(`actual hub reader port ${address.port} rebound`);
  });

  return `http://127.0.0.1:${address.port}`;
}

async function connectStores(source: ManagedSyncStore, destination: ManagedSyncStore) {
  const a = await source.snapshot();
  const b = await destination.snapshot();
  const owner = a.originKeys.find((grant) => grant.inboxId === a.inboxId);
  assert(owner);
  const route: SyncRoute = {
    id: randomUUID(), revision: 1, direction: "outbound", peerId: b.inboxId, peerUrl: "https://127.0.0.1:1/",
    sourceInboxId: a.inboxId, destinationInboxId: b.inboxId, localInboxName: "synthetic", readerAudience: "synthetic local reader",
    allowedOrigins: [owner], credentialRef: "synthetic_deletion_token", tlsTrustRef: "synthetic_deletion_ca", state: "active", lastError: null,
  };
  await source.configureRoute(route);
  await destination.configureRoute({ ...route, direction: "inbound", peerId: a.inboxId });
  const auth: RouteAuthorization = { routeId: route.id, revision: route.revision, peerId: a.inboxId, sourceInboxId: a.inboxId, destinationInboxId: b.inboxId };
  const states = Object.values(a.records).map(toOriginState);
  const nonce = randomUUID();
  await destination.completeInventory(auth, {
    protocolVersion: 1, domain: MANIFEST_DOMAIN, peerId: a.inboxId, routeId: route.id, revision: route.revision,
    scope: [{ inboxId: a.inboxId, historyEpoch: a.historyEpoch }], generation: a.generation, count: states.length, descriptorDigest: inventoryDigest(states), nonce,
  }, states, nonce);

  for (const state of states) {
    const document = await source.getDocument(state.originDocumentId);
    assert(document);
    assert.equal((await destination.apply(auth, state, document.originalBytes)).status, "committed");
  }

  return { route, auth };
}

async function captureTree(root: string) {
  const entries: { name: string; mode: number; ino: number; mtime: number | null; ctime: number | null; digest: string | null }[] = [];
  async function visit(name: string) {
    const filename = path.join(root, name);
    const info = await fs.lstat(filename);
    entries.push({ name, mode: info.mode, ino: info.ino, mtime: info.isFile() ? info.mtimeMs : null,
      ctime: info.isFile() ? info.ctimeMs : null, digest: info.isFile() ? sha256(await readFile(filename)) : null });
    if (info.isDirectory()) {
      for (const child of (await fs.readdir(filename)).sort()) {
        if (!/^\.?mutation\.lock(?:\.|$)/.test(child)) {
          await visit(path.join(name, child));
        }
      }
    }
  }

  await visit("");
  return entries;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitForCut(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Required managed deletion interleaving was not reached")), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function capturedIdentity(home: string, inboxId: string): Promise<ManagedDeletionIdentity> {
  const root = await fs.lstat(home);
  return { home, dev: root.dev, ino: root.ino, inboxId };
}

test("enrolled live viewer starts and deletes through its captured managed writer", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, "source");
  const backend = new LocalDocumentBackend(home, () => {}, () => "original");
  await backend.publish({ originalBytes, title: "Original", type: "report", sourceFileName: "original.html" });
  const store = new ManagedSyncStore(home);
  await store.enroll();
  const before = await store.snapshot();
  const key = canonicalKey(before.inboxId, "original");
  const live = before.records[key];
  assert(live?.bodyFile);
  const receiver = await library(f, "receiver");
  const { route, auth } = await connectStores(store, receiver.store);
  const barrier = await lstat(path.join(home, "documents"));
  assert.equal(barrier.isFile(), true);
  const origin = await startOwnedViewer(t, f, home);
  const response = await fetch(`${origin}/documents/original/content`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalBytes);
  assert.equal((await readFile(path.join(home, "documents"))).length > 0, true);

  assert.equal((await deleteThroughReader(origin, "/api/documents/original")).status, 204);
  const after = await store.snapshot();
  const deleted = after.records[key];
  assert(deleted);
  assert.equal(deleted.state, "deleted");
  assert(deleted.version > live.version);
  verifyOriginState(deleted, after.originKeys[0].publicKey);
  assert.equal(await backend.getDocument("original"), null);
  assert.equal(deleted.bodyFile, live.bodyFile);
  assert.deepEqual(await readFile(path.join(home, "sync", "bodies", live.bodyFile)), originalBytes);
  assert.equal(after.outbox[outboxKey(route.id, route.revision, key)].disposition, "pending");
  assert.equal((await receiver.store.apply(auth, toOriginState(deleted))).status, "deleted");
  const applied = (await receiver.store.snapshot()).records[key];
  assert.equal(applied.state, "deleted");
  assert.equal(applied.signature, deleted.signature);
  assert.equal(await receiver.store.getDocument(applied.localId), null);
  const grant = after.originKeys.find((entry) => entry.inboxId === after.inboxId);
  assert(grant);
  verifyOriginState(applied, grant.publicKey);
});

test("received-copy deletion only suppresses locally and keeps origin signatures, other copies and saved bytes", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source");
  const destination = await library(f, "destination");
  const other = await library(f, "other");
  await connectStores(source.store, destination.store);
  await connectStores(source.store, other.store);
  const before = await destination.store.snapshot();
  const key = canonicalKey(source.instanceId, "original");
  const imported = before.records[key];
  assert(imported?.bodyFile);
  const sourceBefore = await source.store.snapshot();
  const otherBefore = await other.store.snapshot();
  const deleter = await createDocumentDeleter(destination);
  const result = await deleter(imported.localId);

  assert.equal(result?.reclaimedBytes, 0);
  const after = await destination.store.snapshot();
  const suppressed = after.records[key];
  assert.equal(suppressed.suppressed, true);
  assert.deepEqual(toOriginState(suppressed), toOriginState(imported));
  assert.equal(suppressed.state, "live");
  assert.equal(await destination.store.getDocument(imported.localId), null);
  assert.deepEqual(await readFile(path.join(destination.home, "sync", "bodies", imported.bodyFile)), originalBytes);
  assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(after.outbox, before.outbox);
  assert.deepEqual(await source.store.snapshot(), sourceBefore);
  assert.deepEqual(await other.store.snapshot(), otherBefore);
  assert.deepEqual((await other.store.getDocument(otherBefore.records[key].localId))?.originalBytes, originalBytes);
  verifyOriginState(suppressed, sourceBefore.originKeys[0].publicKey);
});

test("a live viewer, mounted hub and captured writer survive completed enrollment of the same inbox", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source", false);
  for (const id of ["hub-document", "writer-document"]) {
    await new LocalDocumentBackend(source.home, () => {}, () => id).publish({ originalBytes, title: id, type: "report", sourceFileName: `${id}.html` });
  }

  const writer = await createDocumentDeleter(source);
  const viewer = await startOwnedViewer(t, f, source.home);
  const hub = await startOwnedHub(t, f, [{ name: "source", ...source }]);
  const identity = await capturedIdentity(source.home, source.instanceId);
  await source.store.enroll();
  assert.deepEqual(await capturedIdentity(source.home, source.instanceId), identity);
  for (const url of [`${viewer}/documents/original/content`, `${hub}/sources/source/documents/hub-document/content`]) {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalBytes);
  }

  assert.equal((await deleteThroughReader(viewer, "/api/documents/original")).status, 204);
  assert.equal((await deleteThroughReader(hub, "/api/sources/source/documents/hub-document")).status, 204);
  assert.equal((await writer("writer-document"))?.reclaimedBytes, 0);
  const ledger = await source.store.snapshot();
  assert.equal(Object.values(ledger.records).filter((record) => record.state === "deleted").length, 3);
});

test("mounted managed sources keep colliding IDs separate and reject invalid HTTP authority before mutation", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const work = await library(f, "work");
  const personal = await library(f, "personal");
  const hub = await startOwnedHub(t, f, [{ name: "work", ...work }, { name: "personal", ...personal }]);
  const index = await fetch(`${hub}/`);
  assert.equal(index.headers.get("content-security-policy"), LIVE_SHELL_CSP);
  const token = /data-delete-token="([A-Za-z0-9_-]{43})"/.exec(await index.text())?.[1];
  assert(token);
  const before = await captureTree(f.root);
  const deniedHeaders: http.OutgoingHttpHeaders[] = [{}, { Origin: "null", "X-HTML-Inbox-CSRF": token },
    { Origin: hub, "X-HTML-Inbox-CSRF": "wrong" }, { Origin: "https://untrusted.invalid", "X-HTML-Inbox-CSRF": token },
    { Host: "untrusted.invalid", Origin: hub, "X-HTML-Inbox-CSRF": token }];
  for (const [index, headers] of deniedHeaders.entries()) {
    const status = await deleteThroughRawHttp(hub, "/api/sources/work/documents/original", headers);
    assert([403, 421].includes(status), `Denied request ${index + 1} returned HTTP ${status}`);
  }

  assert.deepEqual(await captureTree(f.root), before);
  assert.equal((await deleteThroughReader(hub, "/api/sources/work/documents/original")).status, 204);
  const response = await fetch(`${hub}/sources/personal/documents/original/content`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalBytes);
  assert.equal((await work.store.snapshot()).records[canonicalKey(work.instanceId, "original")].state, "deleted");
  assert.equal((await personal.store.snapshot()).records[canonicalKey(personal.instanceId, "original")].state, "live");
});

test("factory creation is read-only and captured targets ignore later location or catalog alias changes", async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source");
  const other = await library(f, "other");
  const catalogHome = path.join(f.root, "catalog");
  await registerInbox("selected", source.home, catalogHome);
  const before = await captureTree(source.home);
  const nativeOpen = fs.open;
  const inspection = t.mock.method(fs, "open", (...args: Parameters<typeof nativeOpen>) => {
    const flags = args[1];
    assert(typeof flags === "number" ? (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC)) === 0 : flags === "r");
    assert.equal(typeof args[0] === "string" && /owner-[^/]+\.pem$/.test(args[0]), false, "factory never opens a private signing key");
    return nativeOpen(...args);
  });
  const location = { home: source.home, instanceId: source.instanceId };
  const writer = await createDocumentDeleter(location);
  inspection.mock.restore();
  assert.deepEqual(await captureTree(source.home), before);
  location.home = other.home;
  location.instanceId = other.instanceId;
  await fs.writeFile(path.join(catalogHome, "inboxes", "selected.json"), JSON.stringify({ schemaVersion: 1, name: "selected", home: other.home, instanceId: other.instanceId }));
  assert.equal((await writer("original"))?.reclaimedBytes, 0);
  assert.equal(await source.backend.getDocument("original"), null);
  assert.deepEqual((await other.backend.getDocument("original"))?.originalBytes, originalBytes);
});

for (const substitution of ["root", "uuid", "missing-uuid", "barrier", "ledger", "incomplete", "signature", "downgrade"] as const) {
  test(`captured managed writer refuses ${substitution} substitution before its first deletion without recovery writes`, async (t) => {
    const f = await fixture(t);
    const source = await library(f, "source");
    const writer = await createDocumentDeleter(source);
    const ledgerPath = path.join(source.home, "sync", "ledger.json");
    if (substitution === "root") {
      const replacement = path.join(f.root, "replacement");
      await fs.cp(source.home, replacement, { recursive: true });
      await fs.rename(source.home, path.join(f.root, "displaced"));
      await fs.rename(replacement, source.home);
    } else if (substitution === "uuid") {
      await fs.writeFile(path.join(source.home, "instance-id"), `${randomUUID()}\n`);
    } else if (substitution === "missing-uuid") {
      await rm(path.join(source.home, "instance-id"));
    } else if (substitution === "barrier") {
      await fs.writeFile(path.join(source.home, "documents"), "invalid barrier\n");
    } else if (substitution === "ledger") {
      await fs.writeFile(ledgerPath, "{ invalid");
    } else if (substitution === "downgrade") {
      await rm(path.join(source.home, "sync"), { recursive: true });
      await rm(path.join(source.home, "documents"));
      await source.backend.publish({ originalBytes, title: "Replacement legacy document", type: "report", sourceFileName: "replacement.html" });
    } else {
      const ledger = await source.store.snapshot();
      if (substitution === "incomplete") {
        ledger.migration.phase = "barrier";
      } else {
        ledger.records[canonicalKey(source.instanceId, "original")].signature = Buffer.alloc(64).toString("base64url");
      }

      await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    }

    const before = await captureTree(source.home);
    await assert.rejects(writer("original"));
    assert.deepEqual(await captureTree(source.home), before);
  });
}

for (const substitution of ["root", "uuid", "barrier", "ledger"] as const) {
  test(`queued managed deletion rechecks ${substitution} under actual ownership before writable recovery`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    const source = await library(f, "source");
    const writer = await createDocumentDeleter(source);
    const directory = path.join(source.home, "sync");
    const replacement = path.join(f.root, "replacement");
    if (substitution === "root") {
      await fs.cp(source.home, replacement, { recursive: true });
    }

    const entered = deferred();
    const release = deferred();
    const queued = deferred();
    let isArmed = false;
    let capturedParent = false;
    let substitutionHits = 0;
    let ownedChecks = 0;
    let before: Awaited<ReturnType<typeof captureTree>> | undefined;
    const nativeOpen = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof nativeOpen>) => {
      const file = await nativeOpen(...args);
      if (args[0] === directory && !capturedParent) {
        capturedParent = true;
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          if (!isArmed) {
            return;
          }

          isArmed = false;
          if (substitution === "root") {
            await fs.rename(source.home, path.join(f.root, "displaced"));
            await fs.rename(replacement, source.home);
          } else if (substitution === "uuid") {
            await fs.writeFile(path.join(source.home, "instance-id"), `${randomUUID()}\n`);
          } else if (substitution === "barrier") {
            await fs.writeFile(path.join(source.home, "documents"), "invalid barrier\n");
          } else {
            await fs.writeFile(path.join(directory, "ledger.json"), "{ invalid");
          }

          await fs.chmod(path.join(directory, "bodies"), 0o755);
          before = await captureTree(source.home);
          substitutionHits += 1;
        };
      }

      return file;
    });
    const withStoreLock = syncFiles.withStoreLock;
    const holder = withStoreLock(directory, 5000, async () => {
      entered.resolve();
      await release.promise;
    });
    const holderOutcome = Promise.allSettled([holder]);
    f.resources.push(async () => {
      isArmed = false;
      release.resolve();
      const [outcome] = await holderOutcome;
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    });
    await waitForCut(entered.promise);
    t.mock.method(syncFiles, "withStoreLock", function<T>(target: string, deadline: number, operation: () => Promise<T>, signal?: AbortSignal) {
      const pending = withStoreLock(target, deadline, async () => {
        const owner = await syncFiles.readSyncOwnership(path.join(target, "mutation.lock"));
        assert(owner);
        assert.equal(owner.pid, process.pid);
        ownedChecks += 1;
        return operation();
      }, signal);
      queued.resolve();
      return pending;
    });
    const deletion = Promise.allSettled([writer("original")]);
    f.resources.push(async () => {
      isArmed = false;
      release.resolve();
      await deletion;
    });
    await waitForCut(queued.promise);
    isArmed = true;
    release.resolve();
    await holder;
    const [outcome] = await deletion;

    assert.equal(substitutionHits, 1);
    assert.equal(ownedChecks, 1);
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert(outcome.reason instanceof Error);
      assert.equal(outcome.reason instanceof DocumentIdentityError, substitution === "root" || substitution === "uuid");
    }

    assert(before);
    assert.deepEqual(await captureTree(source.home), before);
    assert.equal((await fs.stat(path.join(directory, "bodies"))).mode & 0o777, 0o755, "no recovery hardening precedes identity validation");
    await assert.rejects(lstat(path.join(directory, "mutation.lock")), { code: "ENOENT" });
    t.diagnostic(`one ${substitution} substitution after prior ownership disposal, one queued operation under a real successor lock, protected bytes/modes unchanged`);
  });
}

test("managed deletion validates and copies identity data once while concurrent writers make one logical deletion", async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source");
  const identity = await capturedIdentity(source.home, source.instanceId);
  const before = await source.store.snapshot();
  const key = canonicalKey(source.instanceId, "original");
  const body = before.records[key].bodyFile;
  assert(body);
  const writers = await Promise.all(Array.from({ length: 3 }, () => createDocumentDeleter(source)));
  const direct = source.store.deleteDocument("original", identity);
  identity.inboxId = randomUUID();
  identity.home = path.join(f.root, "unrelated");
  const results = await Promise.all([direct, ...writers.map((writer) => writer("original"))]);

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.find((result) => result !== null)?.reclaimedBytes, 0);
  const after = await source.store.snapshot();
  assert.equal(after.nextOriginVersion, before.nextOriginVersion + 1);
  assert.equal(after.records[key].state, "deleted");
  assert.deepEqual(await readFile(path.join(source.home, "sync", "bodies", body)), originalBytes);
  const unchanged = await captureTree(source.home);
  await assert.rejects(source.store.deleteDocument("original", { ...await capturedIdentity(source.home, source.instanceId), inboxId: "invalid" }));
  await assert.rejects(source.store.deleteDocument("original", { ...await capturedIdentity(source.home, source.instanceId), ino: -1 }));
  assert.deepEqual(await captureTree(source.home), unchanged);
});

test("captured managed deletion rejects a foreign ledger before directory hardening or owner-key retirement", async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source");
  const identity = await capturedIdentity(source.home, source.instanceId);
  const ledger = await source.store.snapshot();
  ledger.inboxId = randomUUID();
  await fs.writeFile(path.join(source.home, "sync", "ledger.json"), JSON.stringify(ledger));
  await fs.chmod(path.join(source.home, "sync", "bodies"), 0o755);
  const before = await captureTree(source.home);

  await assert.rejects(new ManagedSyncStore(source.home).deleteDocument("original", identity), ManagedDeletionIdentityError);
  assert.deepEqual(await captureTree(source.home), before);
  assert.equal((await fs.stat(path.join(source.home, "sync", "bodies"))).mode & 0o777, 0o755);
  assert((await readFile(path.join(source.home, "sync", `owner-${source.instanceId}.pem`))).length > 0);
  await assert.rejects(lstat(path.join(source.home, "sync", "mutation.lock")), { code: "ENOENT" });
});

test("unsafe factory inputs and genuine storage errors remain refusals without owner-key reads or error reclassification", async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source");
  const alias = path.join(f.root, "alias");
  await fs.symlink(source.home, alias);
  await assert.rejects(createDocumentDeleter({ home: alias, instanceId: source.instanceId }), DocumentIdentityError);
  await assert.rejects(createDocumentDeleter({ home: source.home, instanceId: randomUUID() }), DocumentIdentityError);
  const writer = await createDocumentDeleter(source);
  const before = await captureTree(source.home);
  const nativeOpen = fs.open;
  const storageFailure = Object.assign(new Error("Controlled ledger read EIO"), { code: "EIO" });
  let hits = 0;
  const injection = t.mock.method(fs, "open", (...args: Parameters<typeof nativeOpen>) => {
    if (args[0] === path.join(source.home, "sync", "ledger.json")) {
      hits += 1;
      return Promise.reject(storageFailure);
    }

    return nativeOpen(...args);
  });
  await assert.rejects(writer("original"), (error: unknown) => error === storageFailure);
  injection.mock.restore();
  assert.equal(hits, 1);
  assert.deepEqual(await captureTree(source.home), before);
});

platformTest("legacy deletion keeps its real worker, physical purge and original directory identity guards", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const source = await library(f, "source", false);
  const writer = await createDocumentDeleter(source);
  const children: ChildProcess[] = [];
  const closed = new Set<ChildProcess>();
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof fork>) => {
    const child = fork(...args);
    children.push(child);
    child.once("close", () => closed.add(child));
    return child;
  });
  const result = await writer("original");
  assert(result);
  assert(result.reclaimedBytes > originalBytes.length);
  await assert.rejects(lstat(path.join(source.home, "documents", "original")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(source.home, "documents", ".trash")), []);
  assert.equal(children.length, 1);
  assert.equal(closed.has(children[0]), true);
  assert.equal(children[0].exitCode, 0);
  assert.equal(children[0].connected, false);

  const guarded = await library(f, "guarded", false);
  const guardedWriter = await createDocumentDeleter(guarded);
  await fs.rename(path.join(guarded.home, "documents"), path.join(guarded.home, "old-documents"));
  await fs.cp(path.join(guarded.home, "old-documents"), path.join(guarded.home, "documents"), { recursive: true });
  const before = await captureTree(guarded.home);
  await assert.rejects(guardedWriter("original"), DocumentIdentityError);
  assert.deepEqual(await captureTree(guarded.home), before);
  assert.equal(children.length, 1, "directory replacement is rejected before another worker is spawned");
  t.diagnostic(`actual legacy worker ${children[0].pid} exit0, close observed and IPC disconnected`);
});

platformTest("an identity-only legacy inbox can gain document storage after its writer was captured", async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, "identity-only");
  await fs.mkdir(home, { mode: 0o700 });
  const instanceId = await getInboxInstanceId(home);
  const writer = await createDocumentDeleter({ home, instanceId });
  const backend = new LocalDocumentBackend(home, () => {}, () => "later");
  await backend.publish({ originalBytes, title: "Later", type: "report", sourceFileName: "later.html" });
  assert((await writer("later"))?.reclaimedBytes);
  await assert.rejects(lstat(path.join(home, "documents", "later")), { code: "ENOENT" });
});
