import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { test as platformTest, type TestContext } from "node:test";
import { availablePort, temporaryHome } from "./test-fixtures";
import { parseObject, parseString, parseOriginGrant } from "./sync-model";
import { defaultRuntimeConfig } from "./sync-runtime-config";
import { createSyncHttpsCredentials } from "./sync-https-fixtures";
import { readWorkerRecordOffline } from "./sync-worker-records";
import { ManagedSyncStore } from "./sync-store";
import { readViewerRecord, hasErrorCode } from "./viewer-records";

// Managed durability requires POSIX directory fsync; Windows opt-in rejection has its own active regression.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

const cliPath = path.join(__dirname, "index.js");
const runNode = promisify(execFile);

async function fixture(t: TestContext, name: string) {
  const root = await realpath(await temporaryHome(t));
  const home = path.join(root, name);
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, HTML_INBOX_CATALOG_HOME: path.join(root, "catalog"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_DATA_HOME: root };
  const run = (args: string[], expected = 0, extra: NodeJS.ProcessEnv = {}) => runCli([...args, "--json"], { ...env, ...extra }, expected);
  await run(["inbox", "create", name, "--home", home]);
  return { root, home, env, run, name, diagnostic: (message: string) => t.diagnostic(message) };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv, expected = 0) {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI fixture timed out: ${args[0]}`)); }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, expected, `${result.stderr}\n${result.stdout}`);
  return parseObject(JSON.parse(result.stdout), "CLI fixture JSON");
}

async function stopFixture(value: Awaited<ReturnType<typeof fixture>>) {
  const worker = await readWorkerRecordOffline(value.home);
  const viewer = await readViewerRecord(value.home, { readOnly: true });
  const ports = new Set<number>();
  if (worker) ports.add(Number(new URL(worker.controlOrigin).port));
  if (viewer) ports.add(viewer.config.port);
  if (await ManagedSyncStore.isEnrolled(value.home)) {
    const ledger = await new ManagedSyncStore(value.home).snapshot();
    if (ledger.runtime?.config.listener) ports.add(ledger.runtime.config.listener.port);
    await value.run(["sync", "worker", "disable", "--home", value.home]);
  }

  if (viewer) await value.run(["viewer", "stop", "--home", value.home]);
  assert.equal(await readWorkerRecordOffline(value.home), null);
  assert.equal(await readViewerRecord(value.home, { readOnly: true }), null);
  for (const pid of [worker?.pid, viewer?.pid]) {
    if (pid === undefined) continue;
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (hasErrorCode(error, "ESRCH")) break;
        throw error;
      }

      if (Date.now() >= deadline) throw new Error("Owned fixture process was not reaped after verified shutdown");
      await delay(20);
    }
  }

  for (const port of ports) {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  value.diagnostic(`Verified cleanup for ${value.name}: ${Number(Boolean(worker)) + Number(Boolean(viewer))} processes reaped, ${ports.size} exact loopback ports rebound`);
}

test("actual CLI headless enrollment, worker lifecycle and durable local-only publication", async (t) => {
  const a = await fixture(t, "headless");
  const port = await availablePort();
  try {
    const enrolled = await a.run(["sync", "enroll", "--inbox", a.name, "--yes"]);
    assert.equal(enrolled.enrolled, true);
    assert.equal(enrolled.peerId, parseObject(enrolled.inbox, "inbox").id);
    await assert.rejects(readFile(path.join(a.home, "viewer.json")), { code: "ENOENT" });
    assert.equal((await a.run(["sync", "worker", "startup", "--inbox", a.name])).skipped, true);
    const invalidConfig = path.join(a.root, "invalid-listener.json");
    await writeFile(invalidConfig, JSON.stringify({ ...defaultRuntimeConfig(), listener: { host: "127.0.0.1", port: await availablePort(), tlsRef: "missing" },
      tls: { missing: { key: path.join(a.root, "missing.key"), cert: path.join(a.root, "missing.pem") } } }), { mode: 0o600 });
    await a.run(["sync", "configure", "--inbox", a.name, "--config", invalidConfig]);
    const failed = await a.run(["sync", "worker", "enable", "--inbox", a.name], 1);
    const failedWorker = parseObject(failed.worker, "worker");
    assert.equal(failedWorker.enabled, true);
    assert.equal(failedWorker.running, false);
    assert.equal(parseObject(failedWorker.ingestion, "ingestion").state, "failed");
    const defaultConfig = path.join(a.root, "default-runtime.json");
    await writeFile(defaultConfig, JSON.stringify(defaultRuntimeConfig()), { mode: 0o600 });
    await a.run(["sync", "configure", "--inbox", a.name, "--config", defaultConfig]);
    const enabled = await a.run(["sync", "worker", "enable", "--inbox", a.name]);
    assert.equal(parseObject(enabled.worker, "worker").running, true);
    const first = await readWorkerRecordOffline(a.home);
    assert(first);
    await a.run(["sync", "pause", "--inbox", a.name]);
    assert.equal(parseObject((await a.run(["sync", "status", "--inbox", a.name])).worker, "worker").retryPaused, true);
    await a.run(["sync", "resume", "--inbox", a.name]);
    const source = path.join(a.root, "report.html");
    await writeFile(source, "<!doctype html><html><body>synthetic local save</body></html>");
    const published = await a.run(["publish", source, "--title", "Synthetic", "--type", "report", "--inbox", a.name], 0, { HTML_INBOX_PORT: String(port) });
    assert.equal(parseObject(published.local, "local").durable, true);
    assert.equal(parseObject(published.delivery, "delivery").state, "local-only");
    assert.equal(parseObject(published.onward, "onward").awaited, false);
    await a.run(["viewer", "stop", "--inbox", a.name]);
    assert.equal(parseObject((await a.run(["sync", "worker", "status", "--inbox", a.name])).worker, "worker").running, true);
    const stoppedAt = Date.now();
    await a.run(["sync", "worker", "stop", "--inbox", a.name]);
    assert(Date.now() - stoppedAt < 3000, "worker stop left a referenced quiescence timer");
    assert.equal(await readWorkerRecordOffline(a.home), null);
    assert.equal(parseObject((await a.run(["sync", "status", "--inbox", a.name])).worker, "worker").enabled, true);
    await a.run(["sync", "worker", "start", "--inbox", a.name]);
    assert.notEqual((await readWorkerRecordOffline(a.home))?.processId, first.processId);
  } finally {
    await stopFixture(a);
  }
});

for (const startup of ["normal", "recoverable history gate", "recoverable history deadline"] as const) {
  test(`actual CLI mapping/configuration confirms intended-server custody through the secured application worker: ${startup}`, async (t) => {
    const a = await fixture(t, "source");
    const b = await fixture(t, "destination");
    const tls = await createSyncHttpsCredentials(t);
    const aPort = await availablePort();
    const bPort = await availablePort();
    const viewerPort = await availablePort();
    const routeId = randomUUID();
    const tokenFile = path.join(a.root, "token");
    await writeFile(tokenFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
    try {
      const aStatus = await a.run(["sync", "enroll", "--inbox", a.name, "--yes"]);
      const bStatus = await b.run(["sync", "enroll", "--inbox", b.name, "--yes"]);
      const aId = parseString(aStatus.peerId);
      const bId = parseString(bStatus.peerId);
      const grant = parseOriginGrant(aStatus.origin);
      for (const [value, port, target] of [[a, aPort, { peerId: bId, destinationInboxId: bId }], [b, bPort, null]] as const) {
        const config = { ...defaultRuntimeConfig(), intendedTarget: target, listener: { host: "127.0.0.1", port, tlsRef: "server" },
          credentials: { paired: tokenFile }, trust: { ca: tls.caPath }, tls: { server: { key: tls.trusted.keyPath, cert: tls.trusted.certPath } } };
        const configPath = path.join(value.root, "runtime.json");
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        await value.run(["sync", "configure", "--inbox", value.name, "--config", configPath]);
        const mappingPath = path.join(value.root, "mapping.json");
        const outbound = value === a;
        await writeFile(mappingPath, JSON.stringify({ schemaVersion: 1, expectedRevision: 0, route: { id: routeId, direction: outbound ? "outbound" : "inbound",
          peerId: outbound ? bId : aId, peerUrl: `https://127.0.0.1:${outbound ? bPort : aPort}`, sourceInboxId: aId, destinationInboxId: bId,
          localInboxName: value.name, readerAudience: "unknown", allowedOrigins: [grant], credentialRef: "paired", tlsTrustRef: "ca" } }), { mode: 0o600 });
        const mapping = await value.run(["sync", "mapping", "add", "--inbox", value.name, "--config", mappingPath]);
        assert.equal(parseObject(mapping.route, "route").state, "reconnecting");
        if (outbound || startup === "normal") {
          await value.run(["sync", "worker", "enable", "--inbox", value.name]);
        }
      }

      if (startup !== "normal") {
        const deadlineAt = Date.now() + 5000;
        while (true) {
          const ledger = await new ManagedSyncStore(a.home).snapshot();
          const retry = ledger.routeRetries[routeId];
          if (retry?.lastError === "verified-transport-failed") {
            assert.equal(retry.blocked, false);
            assert.equal(ledger.routes[routeId]?.lastError, "verified-transport-failed");
            break;
          }

          assert(Date.now() < deadlineAt, "Source worker did not record the unavailable receiver");
          await delay(20);
        }
      }

      const source = path.join(a.root, "report.html");
      const bytes = "<!doctype html><html><body>actual secured worker payload</body></html>";
      await writeFile(source, bytes);

      if (startup !== "normal") {
        // Keep fixture CLI startup outside the publication's real foreground deadline.
        assert.equal(parseObject((await a.run(["sync", "worker", "status", "--inbox", a.name])).worker, "worker").running, true);
        assert.equal((await new ManagedSyncStore(b.home).listDocuments()).length, 0);
      }

      const startedAt = Date.now();
      const publishArgs = ["publish", source, "--title", "Confirmed", "--type", "report", "--inbox", a.name, "--wait-ms", startup === "recoverable history deadline" ? "1000" : "5000"];
      const published = startup === "normal" ? await a.run(publishArgs, 0, { HTML_INBOX_PORT: String(viewerPort) }) :
        await observeFirstDelivery(publishArgs, { ...a.env, HTML_INBOX_PORT: String(viewerPort) }, async (status) => {
          assert.equal(status.status, "blocked");
          assert.equal(status.lastError, "Trusted terminal history is required");
          assert.equal(status.isCommitted, false);
          assert.equal((await new ManagedSyncStore(b.home).listDocuments()).length, 0);

          if (startup === "recoverable history gate") {
            await b.run(["sync", "worker", "enable", "--inbox", b.name]);
          }

          t.diagnostic("Observed actual history-blocked item and empty destination before receiver startup; source worker verified before publication");
        }, startup === "recoverable history deadline" ? 2 : 0);
      const delivery = parseObject(published.delivery, "delivery");
      if (startup === "recoverable history deadline") {
        assert(Date.now() - startedAt < 3000, "History waiting extended the foreground deadline");
        assert.deepEqual(published.local, { durable: true, queued: true });
        assert.equal(delivery.state, "pending");
        assert.equal(delivery.reason, "foreground-deadline");
        assert.equal(delivery.receipt, null);
        const ledger = await new ManagedSyncStore(a.home).snapshot();
        assert.equal(ledger.routes[routeId]?.state, "reconnecting");
        assert.equal(ledger.worker.enabled, true);
        assert.equal(ledger.worker.retryPaused, false);
        assert.equal(Object.values(ledger.outbox)[0]?.disposition, "blocked");
        assert.equal(Object.values(ledger.outbox)[0]?.attempts, 0);
        assert.equal((await new ManagedSyncStore(b.home).listDocuments()).length, 0);
        assert.equal(Object.keys((await new ManagedSyncStore(b.home).snapshot()).historyCheckpoints).length, 0);
        return;
      }

      assert.equal(delivery.state, "confirmed");
      const receipt = parseObject(delivery.receipt, "receipt");
      assert.equal(receipt.receiverInboxId, bId);
      assert.equal(receipt.disposition, "committed");
      assert.equal(receipt.storageIncarnation, (await new ManagedSyncStore(b.home).snapshot()).storageIncarnation);
      const documents = await new ManagedSyncStore(b.home).listDocuments();
      assert.equal(documents.length, 1);
      assert.equal((await new ManagedSyncStore(b.home).getDocument(documents[0]?.id ?? "missing"))?.originalBytes.toString(), bytes);
      const doc = parseObject(published.document, "document");
      assert.equal(receipt.fingerprint, doc.fingerprint);
      assert.equal(doc.originInboxId, aId);
      assert.equal(parseObject((await a.run(["sync", "status", "--inbox", a.name, "--document", parseString(doc.localId)])).document, "document").target && true, true);
      const script = `
        const [cliPath, ...argv] = process.argv.slice(1);
        const path = require("node:path");
        const Store = require(path.join(path.dirname(cliPath), "sync-store.js")).ManagedSyncStore;
        const perform = Store.prototype.deliveryStatus;
        let faults = 0;
        let staleObservationHits = 0;
        let confirmationObservations = 0;
        let redundantLookupAttempts = 0;
        Store.prototype.deliveryStatus = function (...args) {
          if (confirmationObservations) {
            redundantLookupAttempts += 1;
            return Promise.reject(new Error("Controlled post-confirmation lookup deadline exceeded"));
          }
          if (faults < 2) {
            faults += 1;
            return Promise.reject(new Error("Managed ownership deadline exceeded"));
          }
          return perform.apply(this, args).then(status => {
            if (!staleObservationHits) {
              staleObservationHits += 1;
              return { ...status, status: "pending", isCommitted: false, receipt: null };
            }
            if (status.isCommitted) confirmationObservations += 1;
            return status;
          });
        };
        process.argv[1] = cliPath;
        require(cliPath).main(argv).then(() => process.stderr.write(JSON.stringify({ lookupTimeoutFaultHits: faults, staleObservationHits, confirmationObservations, redundantLookupAttempts })))
          .catch(error => { console.error(error); process.exitCode = 1; });
      `;
      const recovered = await runNode(process.execPath, ["-e", script, cliPath, "publish", source, "--title", "Poll contention", "--type", "report", "--inbox", a.name, "--wait-ms", "5000", "--json"], {
        env: { ...a.env, HTML_INBOX_PORT: String(viewerPort) }, timeout: 10_000,
      });
      assert.match(recovered.stderr, /"lookupTimeoutFaultHits":2,"staleObservationHits":1,"confirmationObservations":1,"redundantLookupAttempts":0/);
      assert.equal(parseObject(JSON.parse(recovered.stdout).delivery, "delivery").state, "confirmed");
      assert.equal((await new ManagedSyncStore(b.home).listDocuments()).length, 2);

      await a.run(["viewer", "stop", "--inbox", a.name]);
      assert.equal(parseObject((await a.run(["sync", "status", "--inbox", a.name])).worker, "worker").running, true);
    } finally {
      await stopFixture(a);
      await stopFixture(b);
    }
  });
}

async function observeFirstDelivery(args: string[], env: NodeJS.ProcessEnv, observe: (status: Record<string, unknown>) => Promise<void>, expected = 0) {
  const script = `
    const [cliPath, ...argv] = process.argv.slice(1);
    const path = require("node:path");
    const Store = require(path.join(path.dirname(cliPath), "sync-store.js")).ManagedSyncStore;
    const deliveryStatus = Store.prototype.deliveryStatus;
    let observed = false;
    Store.prototype.deliveryStatus = async function (...args) {
      const status = await deliveryStatus.apply(this, args);
      if (!observed) {
        observed = true;
        await new Promise(resolve => {
          process.once("message", resolve);
          process.send({ type: "delivery-observed", status });
        });
      }
      return status;
    };
    process.argv[1] = cliPath;
    require(cliPath).main(argv).then(() => process.disconnect())
      .catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
  `;
  const child = spawn(process.execPath, ["-e", script, cliPath, ...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "";
  let stderr = "";
  let observation: Promise<void> | undefined;
  let observationError: unknown;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
  assert(child.stdout && child.stderr);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message: unknown) => {
    observation = Promise.resolve().then(async () => {
      const event = parseObject(message, "delivery event");
      assert.equal(event.type, "delivery-observed");
      await observe(parseObject(event.status, "delivery status"));
    }).catch((error: unknown) => { observationError = error; }).finally(() => {
      if (child.connected) child.send({ type: "continue" });
    });
  });

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await observation;
    if (observationError) throw observationError;

    assert.equal(timedOut, false, `Observed publication exceeded its fixture bound: ${stderr}`);
    assert(observation, "Publication never inspected actual delivery status");
    assert.equal(code, expected, `${stderr}\n${stdout}`);
    return parseObject(JSON.parse(stdout), "observed publication");
  } finally {
    clearTimeout(timer);
  }
}
