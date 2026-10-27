import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ManagedSyncStore } from "./sync-store";
import * as workerClient from "./sync-worker-client";
import * as viewerServer from "./viewer-server";
import { main } from "./index";
import { mock } from "node:test";
import { access, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseObject, parseString } from "./sync-model";

const [boundary, action, ...args] = process.argv.slice(2);
process.argv[1] = path.join(__dirname, "index.js");
assert.ok(boundary === "viewer" || boundary === "status" || boundary === "early" || boundary === "no-ticket" || boundary === "ack");
assert.ok(action === "signal" || action === "continue" || action === "signal-cancel-fails");
const shouldSignal = action !== "continue";
const stats = { lookupFaults: 0, staleObservations: 0, confirmations: 0, redundantLookups: 0, holds: 0, signals: 0, finalStatus: 0 };
const cancellation: { submitted: string[]; requests: { ticketId: string; budgetMs: number }[]; failures: number } = { submitted: [], requests: [], failures: 0 };
const attemptedTickets: string[] = [];
let releaseViewer = () => {};
const viewerGate = new Promise<void>((resolve) => { releaseViewer = resolve; });
let viewerHeld = false;

async function holdFinalization() {
  stats.holds += 1;
  const marker = path.join(process.cwd(), "finalization-marker.json");
  await writeFile(`${marker}.tmp`, JSON.stringify({ boundary, stats }), { mode: 0o600 });
  await rename(`${marker}.tmp`, marker);
  while (true) {
    const released = await access(path.join(process.cwd(), "finalization-release")).then(() => true, () => false);
    if (released && (!shouldSignal || stats.signals === 1)) break;
    await delay(5);
  }
  if (shouldSignal) {
    // Parent sends SIGINT to this retained child while this await is held.
    assert.equal(stats.signals, 1);
  }
}

process.on("SIGINT", () => { stats.signals += 1; });
const contact = workerClient.contactWorker;
mock.method(workerClient, "contactWorker", async (...parameters: Parameters<typeof contact>) => {
  if (parameters[1] === "run") {
    attemptedTickets.push(parseString(parseObject(parameters[2], "attempted run").ticketId));
  }

  if (parameters[1] === "cancel") {
    cancellation.requests.push({ ticketId: parseString(parameters[2]), budgetMs: (parameters[3] ?? 0) - Date.now() });
    if (action === "signal-cancel-fails") {
      cancellation.failures += 1;
      throw new Error("Controlled best-effort cancellation unavailable");
    }
  }
  const result = await contact(...parameters);
  if (parameters[1] === "run") {
    cancellation.submitted.push(parseString(parseObject(parameters[2], "submitted run").ticketId));
    if (boundary === "early") await holdFinalization();
  }
  return result;
});
const ensureViewer = viewerServer.ensureViewer;
mock.method(viewerServer, "ensureViewer", async (...parameters: Parameters<typeof ensureViewer>) => {
  const ready = await ensureViewer(...parameters);
  if (boundary === "viewer") {
    viewerHeld = true;
    await viewerGate;
  }
  return ready;
});

const deliveryStatus = ManagedSyncStore.prototype.deliveryStatus;
ManagedSyncStore.prototype.deliveryStatus = async function (...parameters: Parameters<typeof deliveryStatus>) {
  if (stats.confirmations) {
    stats.redundantLookups += 1;
    throw new Error("Controlled redundant final lookup deadline");
  }
  if (stats.lookupFaults < 2) {
    stats.lookupFaults += 1;
    throw new Error("Managed ownership deadline exceeded");
  }

  const result = await deliveryStatus.apply(this, parameters);
  if (!stats.staleObservations) {
    stats.staleObservations += 1;
    return { ...result, status: "pending", isCommitted: false, receipt: null };
  }
  if (result.isCommitted) {
    stats.confirmations += 1;
    if (boundary === "viewer") {
      // Run only after inspectDelivery has returned and publication awaits viewer.
      setImmediate(() => {
        void (async () => {
          while (!viewerHeld) await delay(5);
          await holdFinalization();
          releaseViewer();
        })().catch((error: unknown) => { console.error(error); process.exitCode = 1; releaseViewer(); });
      });
    }
  }
  return result;
};

const getStatus = workerClient.getOwnedWorkerStatus;
mock.method(workerClient, "getOwnedWorkerStatus", async (...parameters: Parameters<typeof getStatus>) => {
  const result = await getStatus(...parameters);
  stats.finalStatus += 1;
  if (boundary === "viewer" || boundary === "status") assert.equal(stats.confirmations, 1);
  if (boundary === "status" || boundary === "no-ticket") await holdFinalization();
  return result;
});

void main(args).then(async () => {
  await writeFile(path.join(process.cwd(), "finalization-complete.json"), JSON.stringify(stats), { mode: 0o600 });
  await writeFile(path.join(process.cwd(), "finalization-cancellation.json"), JSON.stringify(cancellation), { mode: 0o600 });
  await writeFile(path.join(process.cwd(), "finalization-attempts.json"), JSON.stringify(attemptedTickets), { mode: 0o600 });
}, (error: unknown) => { console.error(error); process.exitCode = 1; });
