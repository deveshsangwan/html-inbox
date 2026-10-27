import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { main } from "./index";
import { parseLedger } from "./sync-ledger";
import { startOwnedSyncWorker } from "./sync-worker";
import { isRecord } from "./validation";

export type IdentityCrashCut = "intent" | "fork-ledger" | "reader-identity" | "catalog-entry";

async function sendProof(value: object) {
  assert.ok(process.send, "Identity fault child requires an owned IPC channel");
  await new Promise<void>((resolve, reject) => process.send?.(value, (error) => error ? reject(error) : resolve()));
}

async function runCrash(home: string, oldInboxId: string, cut: string) {
  assert.ok(cut === "intent" || cut === "fork-ledger" || cut === "reader-identity" || cut === "catalog-entry");
  const catalog = process.env.HTML_INBOX_CATALOG_HOME;
  assert.ok(catalog);
  const journal = path.join(catalog, "identity-transition.json");
  const ledger = path.join(home, "sync", "ledger.json");
  const identity = path.join(home, "instance-id");
  const entry = path.join(catalog, "inboxes", "subject.json");
  const originalRename = fs.rename;
  const originalOpen = fs.open;
  const synced = new Set<string>();
  const renamed = new Map<string, boolean>();
  let hits = 0;

  fs.rename = async (source, destination) => {
    await originalRename(source, destination);
    renamed.set(String(destination), synced.has(String(source)));
  };
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    const originalSync = file.sync.bind(file);
    const opened = String(args[0]);
    file.sync = async () => {
      await originalSync();
      synced.add(opened);
      const destination = cut === "intent" ? journal : cut === "fork-ledger" ? ledger : cut === "reader-identity" ? identity : entry;
      if (hits || opened !== path.dirname(destination) || !renamed.has(destination)) {
        return;
      }

      if (cut === "fork-ledger" && parseLedger(JSON.parse(await fs.readFile(ledger, "utf8"))).migration.phase !== "forking") {
        return;
      }

      hits += 1;
      await sendProof({ type: "cut", cut, hits, renamed: destination, fileSyncedBeforeRename: renamed.get(destination), flushed: opened });
      // Keep this fsync callback pending until the parent kills only this ChildProcess.
      await new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Parent did not kill paused child at ${cut}`)), 20_000);
      });
    };
    return file;
  };

  await main(["sync", "fork", "--home", home, "--expect-inbox", oldInboxId, "--yes", "--json"]);
  throw new Error(`Identity cut was not reached: ${cut}, hits=${hits}`);
}

async function runWorker(home: string) {
  let controlAttempts = 0;
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      controlAttempts += 1;
    }

    return Reflect.apply(originalEmit, this, [event, ...args]) === true;
  };

  const worker = await startOwnedSyncWorker(home, { temporary: true });
  process.on("message", (message: unknown) => {
    if (!isRecord(message)) {
      return;
    }

    if (message.type === "probe") {
      void sendProof({ type: "probe", controlAttempts, processId: worker.record.processId });
    }

    if (message.type === "close") {
      void worker.close().then(() => sendProof({ type: "closed", controlAttempts })).then(() => process.disconnect?.());
    }
  });
  await sendProof({ type: "ready", port: Number(new URL(worker.record.controlOrigin).port), processId: worker.record.processId });
}

const deadline = setTimeout(() => {
  console.error("Identity fault child exceeded its 25-second lifetime");
  process.exit(1);
}, 25_000);
deadline.unref();

const [mode, home, oldInboxId, cut] = process.argv.slice(2);
assert.ok(home);
void (mode === "worker" ? runWorker(home) : runCrash(home, oldInboxId, cut)).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
