import assert from "node:assert/strict";
import path from "node:path";
const files: typeof import("./sync-files") = require("./sync-files");
import { maintainSyncIdentity } from "./sync-maintenance";
import { ManagedSyncStore } from "./sync-store";

const [home, inboxId, action, cut] = process.argv.slice(2);
assert.ok(home && inboxId && (action === "quarantine" || action === "fork"));
const acquire = files.acquireSyncOwnership;
let paused = false;

async function pause() {
  assert.ok(process.send);
  paused = true;
  await new Promise<void>((resolve, reject) => process.send?.({ cut, pid: process.pid }, (error) => error ? reject(error) : resolve()));
  await new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Parent did not terminate owned crash fixture")), 15000));
}

files.acquireSyncOwnership = async (...args: Parameters<typeof acquire>) => {
  const lock = await acquire(...args);
  if (args[0] === path.join(home, "sync", "worker", "lifetime.lock")) {
    if (cut === "lifetime") await pause();
  }

  return lock;
};

if (cut === "candidate" || cut === "linked") {
  const fs: typeof import("node:fs/promises") = require("node:fs/promises");
  if (cut === "candidate") {
    const open = fs.open;
    fs.open = async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(path.join(home, "sync", "worker", ".lifetime.lock.owner-"))) {
        const sync = file.sync.bind(file);
        file.sync = async () => { await sync(); await pause(); };
      }
      return file;
    };
  } else {
    const link = fs.link;
    fs.link = async (...args: Parameters<typeof link>) => {
      await link(...args);
      if (args[1] === path.join(home, "sync", "worker", "lifetime.lock")) await pause();
    };
  }
}

if (cut === "cleanup") {
  const fs: typeof import("node:fs/promises") = require("node:fs/promises");
  const remove = fs.rm;
  fs.rm = async (...args: Parameters<typeof remove>) => {
    await remove(...args);
    if (args[0] === path.join(home, "sync", "worker", "runtime.json")) await pause();
  };
}

if (cut === "quarantine") {
  const quarantine = ManagedSyncStore.prototype.quarantineRestore;
  ManagedSyncStore.prototype.quarantineRestore = async function (...args) {
    await quarantine.apply(this, args);
    await pause();
  };
}
if (cut === "fork") {
  const fork = ManagedSyncStore.prototype.fork;
  ManagedSyncStore.prototype.fork = async function (...args) {
    const result = await fork.apply(this, args);
    await pause();
    return result;
  };
}

void maintainSyncIdentity(home, inboxId, action).then(() => {
  assert.equal(paused, true, "The requested crash cut must be reached");
}).catch((error: unknown) => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
