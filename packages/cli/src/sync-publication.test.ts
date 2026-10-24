import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as platformTest, type TestContext } from "node:test";
import { createInbox } from "./inbox-catalog";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { temporaryHome, availablePort } from "./test-fixtures";
import { parseObject } from "./sync-model";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

async function publicationFixture(t: TestContext) {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  const entry = await createInbox("source", path.join(root, "source"), catalogHome);
  const store = new ManagedSyncStore(entry.home);
  await store.enroll();
  const peerId = randomUUID();
  await store.configureRuntime({ ...defaultRuntimeConfig(), intendedTarget: { peerId, destinationInboxId: peerId } });
  const ledger = await store.snapshot();
  await store.configureRoute({ id: randomUUID(), revision: 1, direction: "outbound", peerId, peerUrl: `https://127.0.0.1:${await availablePort()}`,
    sourceInboxId: entry.instanceId, destinationInboxId: peerId, localInboxName: entry.name, readerAudience: "unknown", allowedOrigins: ledger.originKeys,
    credentialRef: "missing", tlsTrustRef: "missing", state: "reconnecting", lastError: null });
  const filePath = path.join(root, "report.html");
  await writeFile(filePath, "<!doctype html><html><body>durable synthetic report</body></html>");
  const env = { PATH: process.env.PATH, HOME: root, HTML_INBOX_CATALOG_HOME: catalogHome, HTML_INBOX_HOME: entry.home };
  return { root, entry, store, filePath, env };
}

test("first post-commit receipt lookup deadline still prints saved/pending JSON and exits 2", async (t) => {
  const value = await publicationFixture(t);
  const script = `
    const [directory, filePath] = process.argv.slice(1);
    const path = require("node:path");
    const store = require(path.join(directory, "sync-store.js")).ManagedSyncStore;
    const original = store.prototype.deliveryStatus;
    let hits = 0;
    store.prototype.deliveryStatus = function (...args) {
      if (!hits) { hits += 1; return Promise.reject(new Error("Delivery status deadline exceeded")); }
      return original.apply(this, args);
    };
    require(path.join(directory, "viewer-server.js")).ensureViewer = async () => { throw new Error("Synthetic viewer unavailable"); };
    require(path.join(directory, "index.js")).main(["publish", filePath, "--title", "Saved", "--type", "report", "--inbox", "source", "--wait-ms", "100", "--json"])
      .then(() => process.stderr.write(JSON.stringify({ firstLookupFaultHits: hits })))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runScript(script, [__dirname, value.filePath], value.env);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /"firstLookupFaultHits":1/);
  const output = parseObject(JSON.parse(result.stdout), "publication");
  assert.equal(parseObject(output.local, "local").durable, true);
  assert.equal(parseObject(output.local, "local").queued, true);
  assert.equal(parseObject(output.delivery, "delivery").state, "pending");
  const ledger = await value.store.snapshot();
  assert.equal(Object.keys(ledger.records).length, 1);
  assert.equal(Object.values(ledger.outbox).filter((entry) => entry.disposition !== "retired").length, 1);
});

test("SIGINT after durable save cancels a long viewer startup and preserves queued retries without transient failures", async (t) => {
  const value = await publicationFixture(t);
  const script = `
    const [directory, filePath] = process.argv.slice(1);
    const path = require("node:path");
    require(path.join(directory, "viewer-server.js")).ensureViewer = (_home, _port, _name, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("Viewer startup cancelled")), { once: true });
      if (options.signal.aborted) reject(new Error("Viewer startup cancelled"));
      process.send({ type: "viewer-waiting-after-durable-save" });
    });
    require(path.join(directory, "index.js")).main(["publish", filePath, "--title", "Interrupted", "--type", "report", "--inbox", "source", "--wait-ms", "30000", "--json"])
      .then(() => process.disconnect())
      .catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
  `;
  const result = await runScript(script, [__dirname, value.filePath], value.env, true);
  assert.equal(result.code, 130, result.stderr);
  assert(result.afterInterruptMs < 1500, `Cancellation waited ${result.afterInterruptMs} ms for viewer startup`);
  const output = parseObject(JSON.parse(result.stdout), "publication");
  assert.equal(parseObject(output.local, "local").durable, true);
  const delivery = parseObject(output.delivery, "delivery");
  assert.equal(delivery.cancelled, true);
  assert.equal(delivery.state, "pending");
  const ledger = await value.store.snapshot();
  assert.equal(ledger.worker.retryPaused, false);
  assert.equal(Object.values(ledger.outbox)[0]?.attempts, 0);
  assert.notEqual(Object.values(ledger.outbox)[0]?.disposition, "retired");
});

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, interrupt = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; afterInterruptMs: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, ...args], { env, stdio: interrupt ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let interruptedAt = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
    assert(child.stdout && child.stderr);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (message: unknown) => {
      if (interrupt && parseObject(message, "fixture event").type === "viewer-waiting-after-durable-save") {
        interruptedAt = Date.now();
        child.kill("SIGINT");
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Publication subprocess exceeded bound: ${stderr} ${stdout}`));
      else resolve({ code, stdout, stderr, afterInterruptMs: interruptedAt ? Date.now() - interruptedAt : 0 });
    });

  });
}

test("a route to the intended peer without the publication origin scope is blocked and never claims queued delivery", async (t) => {
  const value = await publicationFixture(t);
  const ledger = await value.store.snapshot();
  const previous = Object.values(ledger.routes)[0];
  assert(previous);
  await value.store.configureRoute({ ...previous, revision: 2, allowedOrigins: [] });
  const script = `
    const [directory, filePath] = process.argv.slice(1);
    const path = require("node:path");
    require(path.join(directory, "viewer-server.js")).ensureViewer = async () => { throw new Error("Synthetic viewer unavailable"); };
    require(path.join(directory, "index.js")).main(["publish", filePath, "--title", "Excluded origin", "--type", "report", "--inbox", "source", "--json"])
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runScript(script, [__dirname, value.filePath], value.env);
  assert.equal(result.code, 3, result.stderr);
  const output = parseObject(JSON.parse(result.stdout), "publication");
  assert.equal(parseObject(output.local, "local").durable, true);
  assert.equal(parseObject(output.local, "local").queued, false);
  assert.equal(parseObject(output.delivery, "delivery").state, "blocked");
  assert.equal(parseObject(output.delivery, "delivery").reason, "no-authorized-route-to-intended-target");
  assert.equal(Object.keys((await value.store.snapshot()).outbox).length, 0);
});
