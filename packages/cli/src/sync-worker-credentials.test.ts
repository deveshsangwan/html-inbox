import assert from "node:assert/strict";
import childProcesses from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import platformTest from "node:test";
import { assertReceiverCommitted, createOwnedPullPair, exists, syntheticBytes, waitUntil, writePrivateJson } from "./sync-worker-fault-fixtures";
import { canonicalKey } from "./sync-model";
import { setTimeout as delay } from "node:timers/promises";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

test("explicit retry resolves a rotated route after an unrelated reconciliation already entered the pass", { timeout: 45_000 }, async (t) => {
  const spawn = childProcesses.spawn;
  t.mock.method(childProcesses, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
    const env = options.env;
    return spawn(command, args, env?.HTML_INBOX_CATALOG_HOME
      ? { ...options, env: { ...env, NODE_OPTIONS: `--require=${path.join(__dirname, "sync-worker-credentials-child.js")}` } }
      : options);
  });
  const f = await createOwnedPullPair(t);
  const rotatedFile = path.join(f.root, "rotated-token");
  const nextFile = path.join(f.root, "next-token");
  await writeFile(rotatedFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
  await writeFile(nextFile, randomBytes(48).toString("base64url"), { mode: 0o600 });
  const credentials = { ...f.sourceConfig.credentials, rotated: rotatedFile, next: nextFile };
  await f.configure(f.source, { ...f.sourceConfig, credentials });
  await f.configure(f.destination, { ...f.destinationConfig, credentials });
  await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
  await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
  await waitUntil("initial unrelated live route", () => f.source.store.snapshot(), (ledger) => ledger.routes[f.route.id].state === "active");
  await f.source.store.publish({ originalBytes: syntheticBytes, title: "Credential freshness", type: "report", sourceFileName: "fixture.html" }, "credential-freshness");
  await waitUntil("unrelated route custody", () => f.source.store.deliveryStatus(f.route.id, f.sourceId, "credential-freshness"), (value) => value.isCommitted);
  const target = { ...f.route, id: randomUUID(), credentialRef: "rotated" };
  const inbound = { ...target, direction: "inbound", peerId: f.sourceId, peerUrl: f.sourceUrl, localInboxName: f.destination.name };
  async function mapping(fields: typeof target, revision: number) {
    return writePrivateJson(path.join(f.root, `${randomUUID()}.mapping.json`), { schemaVersion: 1, expectedRevision: revision, route: fields });
  }

  await f.json(["sync", "mapping", "add", "--inbox", f.destination.name, "--config", await mapping(inbound, 0)]);
  await f.json(["sync", "mapping", "add", "--inbox", f.source.name, "--config", await mapping(target, 0)]);
  await f.json(["sync", "run", "--route", target.id, "--inbox", f.source.name]);
  await waitUntil("first target revision custody", () => f.source.store.deliveryStatus(target.id, f.sourceId, "credential-freshness"), (value) => value.isCommitted);
  await f.json(["sync", "mapping", "reconnect", target.id, "--revision", "1", "--config", await mapping({ ...inbound, credentialRef: "next" }, 1), "--inbox", f.destination.name]);
  await f.json(["sync", "mapping", "reconnect", target.id, "--revision", "1", "--config", await mapping(target, 1), "--inbox", f.source.name]);
  await f.json(["sync", "run", "--route", target.id, "--inbox", f.source.name]);
  const blocked = await waitUntil("former credential rejected", () => f.source.store.snapshot(), (ledger) => ledger.routeRetries[target.id]?.blocked === true);
  assert.equal(blocked.routeRetries[target.id].lastError, "unauthorized");
  assert.equal((await f.source.store.deliveryStatus(target.id, f.sourceId, "credential-freshness")).isCommitted, false);
  const source = await f.rememberWorker(f.source);
  const receiver = await f.rememberWorker(f.destination);

  await writePrivateJson(path.join(f.root, "credential-hold.json"), { firstRouteId: f.route.id, targetRouteId: target.id, sourceId: f.sourceId });
  try {
    await waitUntil("exact unrelated reconciliation entry hold", () => exists(path.join(f.root, "credential-held.json")), Boolean);
    const held = JSON.parse(await readFile(path.join(f.root, "credential-held.json"), "utf8"));
    assert.equal(held.pid, source.pid);
    assert.equal(held.routeId, f.route.id);
    await writeFile(rotatedFile, await readFile(nextFile));
    await f.json(["sync", "retry", "--route", target.id, "--inbox", f.source.name]);
    assert.equal((await f.source.store.snapshot()).routeRetries[target.id], undefined, "real explicit retry committed while the unrelated call was held");
    await writeFile(path.join(f.root, "credential-release"), "release", { mode: 0o600 });
    await waitUntil("fresh credential confirms actual revision 2 custody", () => f.source.store.deliveryStatus(target.id, f.sourceId, "credential-freshness"), (value) => value.isCommitted);
    const received = await assertReceiverCommitted(f.destination, f.sourceId, "credential-freshness");
    assert.ok(received.receipts.some((receipt) => receipt.routeId === target.id && receipt.revision === 2 && receipt.disposition === "committed"));
    assert.equal(Object.values(received.ledger.records).filter((record) => record.originInboxId === f.sourceId && record.originDocumentId === "credential-freshness").length, 1);
    assert.deepEqual((await f.destination.store.getDocument(received.ledger.records[canonicalKey(f.sourceId, "credential-freshness")].localId))?.originalBytes, syntheticBytes);
    assert.equal((await f.source.store.deliveryStatus(f.route.id, f.sourceId, "credential-freshness")).isCommitted, true);
    assert.equal((await f.rememberWorker(f.source)).processId, source.processId);
    assert.equal((await f.rememberWorker(f.destination)).processId, receiver.processId);
    assert.equal((await readFile(path.join(f.root, "credential-holds.jsonl"), "utf8")).trim().split("\n").length, 1);
    t.diagnostic("exactly one unrelated-route hold; same workers; real explicit retry; revision 2 receipt, exact bytes and unrelated custody retained");
  } catch (error) {
    const ledger = await f.source.store.snapshot();
    const delivery = await f.source.store.deliveryStatus(target.id, f.sourceId, "credential-freshness");
    t.diagnostic(JSON.stringify({ targetRetry: ledger.routeRetries[target.id], currentCommitted: delivery.isCommitted,
      currentRevisionReceipts: Object.values((await f.destination.store.snapshot()).receipts).filter((receipt) => receipt.routeId === target.id && receipt.revision === 2).length,
      result: await readFile(path.join(f.root, "credential-results.jsonl"), "utf8").catch(() => "no reconciliation result") }));
    throw error;
  } finally {
    await writeFile(path.join(f.root, "credential-release"), "cleanup-release", { mode: 0o600 });
  }
});

for (const fault of ["wrong-token", "malformed-token", "missing-file", "missing-reference"] as const) {
  test(`${fault} remains a permanent route block without stopping either worker`, { timeout: 25_000 }, async (t) => {
    const f = await createOwnedPullPair(t);
    const token = await readFile(f.sourceConfig.credentials.token);
    const tokenPath = path.join(f.root, "source-only-token");
    if (fault !== "missing-file") {
      await writeFile(tokenPath, fault === "malformed-token" ? "invalid-token" : randomBytes(48).toString("base64url"), { mode: 0o600 });
    }

    await f.configure(f.source, { ...f.sourceConfig, credentials: fault === "missing-reference" ? {} : { token: tokenPath } });
    await f.json(["sync", "worker", "enable", "--inbox", f.destination.name]);
    await f.json(["sync", "worker", "enable", "--inbox", f.source.name]);
    const blocked = await waitUntil("permanent credential route failure", () => f.source.store.snapshot(), (ledger) => ledger.routeRetries[f.route.id]?.blocked === true);
    const retry = blocked.routeRetries[f.route.id];
    assert.equal(retry.lastError, fault === "wrong-token" ? "unauthorized" : "runtime-credential-unavailable");
    assert.equal(retry.attempts, 1);
    const source = await f.rememberWorker(f.source);
    const receiver = await f.rememberWorker(f.destination);
    await writeFile(tokenPath, token, { mode: 0o600 });
    await delay(1200);
    assert.deepEqual((await f.source.store.snapshot()).routeRetries[f.route.id], retry, "file replacement and periodic passes cannot clear a permanent block");
    assert.equal((await f.rememberWorker(f.source)).processId, source.processId);
    assert.equal((await f.rememberWorker(f.destination)).processId, receiver.processId);
  });
}
