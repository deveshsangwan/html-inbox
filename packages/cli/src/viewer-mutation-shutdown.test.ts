import assert from "node:assert/strict";
import childProcesses from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { link, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { createDocumentDeleter } from "./document-deletion";
import { startHub } from "./hub";
import { ManagedStorageError } from "./private-storage";
import { withStoreLock } from "./sync-files";
import { canonicalKey } from "./sync-model";
import { ManagedSyncStore } from "./sync-store";
import { temporaryHome } from "./test-fixtures";
import { startViewerHttpServer } from "./viewer-http-server";
import * as viewerProcess from "./viewer-process";
import * as viewerRecords from "./viewer-records";
import { getInboxInstanceId, readViewerRecord, ViewerRecordFormatError, writeViewerRecord } from "./viewer-records";
import { ensureViewer, getViewerStatus, startViewer, stopViewer } from "./viewer-server";

const bytes = Buffer.from("<!doctype html><html><body>Reader shutdown custody</body></html>");

for (const entry of ["startViewer", "ensureViewer"] as const) {
  test(`${entry} preserves a draining viewer's record until its disconnected managed deletion settles`, {
    skip: process.platform === "win32" ? "Managed enrollment requires POSIX storage" : false,
    timeout: 15_000,
  }, async (t) => {
    const home = await realpath(await temporaryHome(t));
    const backend = new LocalDocumentBackend(home, () => {}, () => "replacement-original");
    const document = await backend.publish({ originalBytes: bytes, title: "Replacement", type: "report", sourceFileName: "fixture.html" });
    const store = new ManagedSyncStore(home);
    await store.enroll();
    const key = canonicalKey((await store.snapshot()).inboxId, document.id);
    const admitted = gate();
    const held = gate();
    const release = gate();
    const stopped = gate();
    let mutation: ReturnType<ManagedSyncStore["deleteDocument"]> | undefined;
    const deleteDocument = ManagedSyncStore.prototype.deleteDocument;
    t.mock.method(ManagedSyncStore.prototype, "deleteDocument", function (this: ManagedSyncStore, ...args: Parameters<typeof deleteDocument>) {
      mutation = deleteDocument.apply(this, args);
      admitted.release();
      return mutation;
    });
    t.mock.method(console, "error", (message: unknown) => {
      if (typeof message === "string" && /Viewer \d+ stopped \(reader-close\)$/.test(message)) stopped.release();
    });
    const spawn = t.mock.method(viewerProcess, "spawnDetachedViewer", async () => {
      throw new Error("A draining viewer must be rejected before spawning a successor");
    });
    const original = await startViewer(backend, home, 0);
    const record = await readViewerRecord(home);
    assert(record);
    const recordChecksum = await viewerRecordChecksum(home);
    let holding: Promise<void> | undefined;
    let request: http.ClientRequest | undefined;
    let successor: http.Server | undefined;

    try {
      const origin = record.urls[0];
      const token = await deletionToken(origin);
      holding = withStoreLock(path.join(home, "sync"), 5000, async () => {
        held.release();
        await release.promise;
      });
      await bounded(Promise.race([held.promise, holding]), "replacement fixture ownership");
      request = deleteRequest(origin, `/api/documents/${document.id}`, token);
      await bounded(admitted.promise, "actual managed deletion admission");
      await disconnect(request);
      const nativeClosed = once(original, "close");
      original.close();
      original.closeAllConnections();
      await bounded(nativeClosed, "original native reader close");
      assert.equal((await getViewerStatus(home)).state, "stopped");
      await rebind(record.config.port);
      await rebind(Number(new URL(record.controlUrl).port));
      assert.equal((await store.snapshot()).records[key].state, "live");

      await assert.rejects(entry === "startViewer"
        ? startViewer(backend, home, 0).then((server) => { successor = server; return server; })
        : ensureViewer(home, 0), /Existing viewer process record is unverified/);
      assert.equal(spawn.mock.callCount(), 0, "ensure must refuse before spawning or deleting the old record");
      assert.equal(await viewerRecordChecksum(home), recordChecksum);
      assert.equal((await store.snapshot()).records[key].state, "live");

      release.release();
      await bounded(Promise.all([holding, mutation, stopped.promise]), "original mutation and lifecycle settlement");
      assert.equal(await readViewerRecord(home), null);
      const terminal = (await store.snapshot()).records[key];
      assert.equal(terminal.state, "deleted");
      assert.equal(typeof terminal.signature, "string");
      assert.equal(await backend.getDocument(document.id), null);

      successor = await startViewer(backend, home, 0);
      const replacement = await readViewerRecord(home);
      assert(replacement);
      assert.notEqual(replacement.processId, record.processId);
      assert.equal((await ensureViewer(home, replacement.config.port)).state, "running");
      assert.equal((await stopViewer(home)).state, "stopped");
      assert.equal(await readViewerRecord(home), null);
      await rebind(replacement.config.port);
      await rebind(Number(new URL(replacement.controlUrl).port));
    } finally {
      release.release();
      request?.destroy();
      await Promise.allSettled([holding, mutation]);
      await bounded(stopped.promise, "original lifecycle cleanup");
      await closeViewerLifecycle(successor ?? original, home);
    }
  });
}

test("ordinary viewer replacement retains a live optional-owner record and inconclusive process evidence", { timeout: 15_000 }, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const backend = new LocalDocumentBackend(home);
  const original = await startViewer(backend, home, 0);
  const record = await readViewerRecord(home);
  assert(record);
  const portableRecord = { ...record, localOwner: undefined };
  await writeViewerRecord(home, portableRecord);
  const recordChecksum = await viewerRecordChecksum(home);
  const removing = gate();
  const release = gate();
  const remove = viewerRecords.removeViewerRecord;
  t.mock.method(viewerRecords, "removeViewerRecord", async (...args: Parameters<typeof remove>) => {
    removing.release();
    await release.promise;
    return remove(...args);
  });
  const spawn = t.mock.method(viewerProcess, "spawnDetachedViewer", async () => {
    throw new Error("A live ordinary viewer must be rejected before spawning a successor");
  });
  let successor: http.Server | undefined;

  try {
    original.close();
    original.closeAllConnections();
    await bounded(removing.promise, "ordinary viewer record cleanup");
    assert.equal((await getViewerStatus(home)).state, "stopped");
    await assert.rejects(startViewer(backend, home, 0).then((server) => { successor = server; return server; }), /Existing viewer process record is unverified/);
    const kill = process.kill;
    t.mock.method(process, "kill", (...args: Parameters<typeof kill>) => {
      if (args[0] === record.pid && args[1] === 0) throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
      return kill(...args);
    });
    await assert.rejects(ensureViewer(home, 0), /Existing viewer process record is unverified/);
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(await viewerRecordChecksum(home), recordChecksum);
  } finally {
    release.release();
    await closeViewerLifecycle(successor ?? original, home);
  }
});

test("managed replacement accepts a conclusively dead old owner when the PID has a different start identity", {
  skip: process.platform !== "linux" ? "Validated process-start reuse evidence requires Linux" : false,
  timeout: 15_000,
}, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const backend = new LocalDocumentBackend(home);
  await new ManagedSyncStore(home).enroll();
  const original = await startViewer(backend, home, 0);
  const record = await readViewerRecord(home);
  assert(record?.localOwner?.start);
  await closeViewerLifecycle(original, home);
  await writeViewerRecord(home, { ...record, localOwner: { ...record.localOwner, start: `${record.localOwner.start}-previous` } });
  let successor: http.Server | undefined;

  try {
    assert.equal((await getViewerStatus(home)).state, "stopped");
    successor = await startViewer(backend, home, 0);
    assert.notEqual((await readViewerRecord(home))?.processId, record.processId);
    assert.equal((await getViewerStatus(home)).state, "running");
  } finally {
    await closeViewerLifecycle(successor ?? original, home);
  }
});

test("ordinary startup preserves recovery of malformed JSON and incomplete process records", { timeout: 15_000 }, async (t) => {
  for (const invalid of ["{broken", JSON.stringify({ pid: process.pid })]) {
    const home = await realpath(await temporaryHome(t));
    await writeFile(path.join(home, "viewer.json"), invalid, { mode: 0o600 });
    await assert.rejects(readViewerRecord(home), ViewerRecordFormatError);
    let server: http.Server | undefined;

    try {
      server = await startViewer(new LocalDocumentBackend(home), home, 0);
      assert.equal((await getViewerStatus(home)).state, "running");
    } finally {
      if (server) await closeViewerLifecycle(server, home);
    }
  }
});

test("viewer format recovery never treats bounded-read or unsafe hardlink failures as malformed content", { timeout: 15_000 }, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const recordPath = path.join(home, "viewer.json");
  await writeFile(recordPath, Buffer.alloc(64 * 1024 + 1, 0x20), { mode: 0o600 });
  await assert.rejects(startViewer(new LocalDocumentBackend(home), home, 0), (error: unknown) =>
    error instanceof Error && !(error instanceof ViewerRecordFormatError) && /too large/.test(error.message));
  assert.equal((await stat(recordPath)).size, 64 * 1024 + 1);

  await writeFile(recordPath, "{broken");
  const alias = path.join(home, "retained-record-link");
  await link(recordPath, alias);
  const before = await stat(recordPath);
  await assert.rejects(startViewer(new LocalDocumentBackend(home), home, 0), ManagedStorageError);
  await assert.rejects(ensureViewer(home, 0), ManagedStorageError);
  const after = await stat(recordPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 2);
  assert.equal(await readFile(alias, "utf8"), "{broken");
});

test("reader close joins an admitted disconnected managed deletion before reporting completion", {
  skip: process.platform === "win32" ? "Managed enrollment requires POSIX storage" : false,
  timeout: 15_000,
}, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const backend = new LocalDocumentBackend(home, () => {}, () => "managed-original");
  const document = await backend.publish({ originalBytes: bytes, title: "Managed", type: "report", sourceFileName: "fixture.html" });
  const store = new ManagedSyncStore(home);
  await store.enroll();
  const initial = await store.snapshot();
  const remove = await createDocumentDeleter({ home, instanceId: initial.inboxId });
  const admitted = gate();
  const held = gate();
  const release = gate();
  let mutation: ReturnType<typeof remove> | undefined;
  const reader = await startViewerHttpServer(backend, { host: "127.0.0.1", port: 0, exposure: "loopback" }, {
    instanceId: initial.inboxId, processId: randomUUID(), protocolVersion: 3, pid: process.pid,
  }, home, {}, (id) => {
    mutation = remove(id);
    admitted.release();
    return mutation;
  });
  const holding = withStoreLock(path.join(home, "sync"), 5000, async () => {
    held.release();
    await release.promise;
  });
  let request: http.ClientRequest | undefined;

  try {
    await bounded(Promise.race([held.promise, holding]), "managed store ownership");
    const origin = reader.urls[0];
    request = deleteRequest(origin, `/api/documents/${document.id}`, await deletionToken(origin));
    await bounded(admitted.promise, "managed deletion admission");
    await disconnect(request);
    const nativeClosed = Promise.all([once(reader.server, "close"), once(reader.controlServer, "close")]);
    let closeCompleted = false;
    const closing = reader.close().then(() => { closeCompleted = true; });
    const closingAgain = reader.close();
    await bounded(nativeClosed, "native reader and control close");
    await rebind(Number(new URL(origin).port));
    await rebind(Number(new URL(reader.controlUrl).port));

    assert.equal(closeCompleted, false, "listener closure cannot report a pending tombstone as settled");
    const key = canonicalKey(initial.inboxId, document.id);
    assert.equal((await store.snapshot()).records[key].state, "live");
    release.release();
    await bounded(Promise.all([holding, mutation, closing, closingAgain]), "managed deletion and close settlement");
    const terminal = (await store.snapshot()).records[key];
    assert.equal(closeCompleted, true);
    assert.equal(terminal.state, "deleted");
    assert.equal(typeof terminal.signature, "string");
    assert.equal(await backend.getDocument(document.id), null);
  } finally {
    release.release();
    request?.destroy();
    await Promise.allSettled([holding, mutation]);
    await reader.close();
  }
});

test("hub close joins a disconnected legacy deletion and its real helper child", { timeout: 15_000 }, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const backend = new LocalDocumentBackend(home, () => {}, () => "legacy-original");
  const document = await backend.publish({ originalBytes: bytes, title: "Legacy", type: "report", sourceFileName: "fixture.html" });
  const instanceId = await getInboxInstanceId(home);
  const lockPath = path.join(home, "documents", ".trash", `.delete-${createHash("sha256").update(document.id).digest("hex")}.lock`);
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600, flag: "wx" });
  const spawned = gate();
  const fork = childProcesses.fork;
  let helper: ReturnType<typeof fork> | undefined;
  let helperClosed: Promise<void> | undefined;
  t.mock.method(childProcesses, "fork", (...args: Parameters<typeof fork>) => {
    assert.equal(args[0], path.join(__dirname, "index.js"));
    const child = fork(...args);
    helper = child;
    helperClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.once("spawn", spawned.release);
    return child;
  });
  const reader = await startHub({ schemaVersion: 1, name: "Shutdown", sources: [{ name: "legacy", home, instanceId }] }, {
    host: "127.0.0.1", port: 0, exposure: "loopback",
  });
  let request: http.ClientRequest | undefined;
  let released = false;

  try {
    const origin = reader.urls[0];
    request = deleteRequest(origin, `/api/sources/legacy/documents/${document.id}`, await deletionToken(origin));
    await bounded(spawned.promise, "actual deletion helper spawn");
    assert(helper);
    assert.equal(helper.exitCode, null);
    await disconnect(request);
    const nativeClosed = once(reader.server, "close");
    let closeCompleted = false;
    const closing = reader.close().then(() => { closeCompleted = true; });
    await bounded(nativeClosed, "native hub close");
    await rebind(Number(new URL(origin).port));

    assert.equal(closeCompleted, false, "hub close must own the helper beyond client and listener close");
    assert.equal(helper.exitCode, null);
    assert.deepEqual(await readFile(path.join(home, "documents", document.id, "index.html")), bytes);
    await unlink(lockPath);
    released = true;
    await bounded(Promise.all([closing, helperClosed]), "legacy helper and hub close");
    assert.equal(closeCompleted, true);
    assert.equal(helper.exitCode, 0);
    assert.equal(await backend.getDocument(document.id), null);
  } finally {
    request?.destroy();
    if (!released) await unlink(lockPath);
    await bounded(Promise.all([reader.close(), helperClosed]), "legacy shutdown cleanup");
  }
});

test("closing reader rejects a newly pipelined deletion before invoking storage", { timeout: 15_000 }, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const backend = new LocalDocumentBackend(home, () => {}, () => "retained-original");
  const document = await backend.publish({ originalBytes: bytes, title: "Retained", type: "report", sourceFileName: "fixture.html" });
  const held = gate();
  const release = gate();
  const deletionSeen = gate();
  const remove = await createDocumentDeleter({ home, instanceId: await getInboxInstanceId(home) });
  let holdRead = false;
  let mutations = 0;
  let mutation: ReturnType<typeof remove> | undefined;
  const reader = await startViewerHttpServer({
    listDocuments: async () => {
      if (holdRead) {
        held.release();
        await release.promise;
      }
      return backend.listDocuments();
    },
    getDocument: (id) => backend.getDocument(id),
    getDocumentMetadata: (id) => backend.getDocumentMetadata(id),
  }, { host: "127.0.0.1", port: 0, exposure: "loopback" }, {
    instanceId: await getInboxInstanceId(home), processId: randomUUID(), protocolVersion: 3, pid: process.pid,
  }, home, {}, (id) => {
    mutations += 1;
    mutation = remove(id);
    return mutation;
  });
  const origin = reader.urls[0];
  const url = new URL(origin);
  let socket: net.Socket | undefined;
  let response = "";
  reader.server.on("request", (request) => {
    if (request.method === "DELETE") deletionSeen.release();
  });

  try {
    const token = await deletionToken(origin);
    socket = net.createConnection({ host: "127.0.0.1", port: Number(url.port) });
    const socketClosed = new Promise<void>((resolve) => socket?.once("close", () => resolve()));
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => { response += chunk.toString(); });
    await bounded(once(socket, "connect"), "existing reader connection");
    holdRead = true;
    socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`);
    await bounded(held.promise, "first pipelined read");
    const closing = reader.close();
    socket.write(`DELETE /api/documents/${document.id} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nX-HTML-Inbox-CSRF: ${token}\r\n\r\n`);
    await bounded(deletionSeen.promise, "request received after close admission fence");
    assert.equal(mutations, 0, "closing reader must not admit a new storage operation");
    release.release();
    await bounded(Promise.all([closing, socketClosed]), "pipelined connection shutdown");
    assert.equal(response.includes("HTTP/1.1 503"), true, "closing reader rejects the new request");
    assert(await backend.getDocument(document.id));
  } finally {
    release.release();
    socket?.destroy();
    await mutation?.catch(() => {});
    await reader.close();
    await rebind(Number(url.port));
    await rebind(Number(new URL(reader.controlUrl).port));
  }
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>, description: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function deletionToken(origin: string) {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  const token = /data-delete-token="([A-Za-z0-9_-]{43})"/.exec(await response.text())?.[1];
  assert(token);
  return token;
}

function deleteRequest(origin: string, target: string, token: string) {
  const request = http.request(new URL(target, origin), { method: "DELETE", agent: false,
    headers: { Origin: origin, "X-HTML-Inbox-CSRF": token } });
  request.on("error", () => {});
  request.end();
  return request;
}

async function disconnect(request: http.ClientRequest) {
  const closed = new Promise<void>((resolve) => request.once("close", () => resolve()));
  request.destroy();
  await bounded(closed, "client disconnect");
}

async function rebind(port: number) {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function closeViewerLifecycle(server: http.Server, home: string) {
  if (server.listening) server.close();
  server.closeAllConnections();
  await bounded((async () => {
    while (await readViewerRecord(home)) await delay(10);
  })(), "matching viewer lifecycle cleanup");
}

async function viewerRecordChecksum(home: string) {
  return createHash("sha256").update(await readFile(path.join(home, "viewer.json"))).digest("hex");
}
