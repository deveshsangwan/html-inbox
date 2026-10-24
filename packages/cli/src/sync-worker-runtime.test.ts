import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { test as platformTest } from "node:test";
import { promisify } from "node:util";
import { temporaryHome } from "./test-fixtures";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const runNode = promisify(execFile);

test("owned runtime catch-up and cancellation work without AbortSignal.any and release their exact control port", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const [directory, home] = process.argv.slice(1);
    AbortSignal.any = undefined;
    (async () => {
      const store = new (require(path.join(directory, "sync-store.js")).ManagedSyncStore)(home);
      await store.enroll();
      await store.setWorkerEnabled(true);
      let wall = 0;
      let monotonic = 0;
      const events = [];
      const worker = await require(path.join(directory, "sync-worker.js")).startOwnedSyncWorker(home, { testHooks: {
        wallNow: () => wall, monotonicNow: () => monotonic, onEvent: event => events.push(event.type),
      } });
      const wait = async predicate => {
        const deadline = Date.now() + 2000;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error("Owned runtime event deadline exceeded");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      try {
        await wait(() => events.includes("pass") && worker.status().processState === "idle");
        wall += 5000;
        await worker.tick();
        await wait(() => events.filter(event => event === "pass").length >= 2);
        assert.equal(events.filter(event => event === "gap").length, 1);
        const id = require("node:crypto").randomUUID();
        worker.requestRun({ ticketId: id, deadlineAt: Date.now() + 2000, requestMs: 100 });
        worker.cancel(id);
        assert.equal(worker.status().tickets.find(ticket => ticket.ticketId === id).state, "cancelled");
      } finally {
        await worker.close();
      }
      assert.equal(await require(path.join(directory, "sync-worker-records.js")).readWorkerRecordOffline(home), null);
      assert.equal(events.filter(event => event === "closed").length, 1);
      assert.equal((await store.snapshot()).worker.retryPaused, false);
      process.stdout.write(JSON.stringify({ port: Number(new URL(worker.record.controlOrigin).port), gaps: 1, closed: true, anyUnavailable: true }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runNode(process.execPath, ["-e", script, __dirname, home], { timeout: 5000 });
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.gaps, 1);
  assert.equal(proof.closed, true);
  assert.equal(proof.anyUnavailable, true);
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(proof.port, "127.0.0.1", resolve); });
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
});
