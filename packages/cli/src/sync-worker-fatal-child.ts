import fs from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { ManagedSyncStore } from "./sync-store";
import * as workerRecords from "./sync-worker-records";

// Preload only in a directly retained synthetic CLI child. Observe the real guard
// without changing its syscall results or passing faults into production options.
if (process.env.HTML_INBOX_FATAL_FIXTURE === "observe-ledger") {
  const home = process.argv[process.argv.indexOf("--home") + 1];
  const ledger = path.join(home, "sync", "ledger.json");
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  let unsafeObserved = false;

  mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const info = await originalLstat(...args);
    if (args[0] === ledger && info.isSymbolicLink()) {
      unsafeObserved = true;
      process.send?.({ type: "unsafe-observed" });
    }

    return info;
  });

  fs.open = async (...args: Parameters<typeof fs.open>) => {
    if (unsafeObserved && args[0] === ledger) {
      process.send?.({ type: "unsafe-open" });
    }

    return originalOpen(...args);
  };
}

if (process.env.HTML_INBOX_FATAL_FIXTURE === "temp-persistence") {
  mock.method(ManagedSyncStore.prototype, "recordWorkerRun", async () => {
    throw new Error("synthetic private path /credential-sentinel must not escape");
  });
}

if (process.env.HTML_INBOX_FATAL_FIXTURE === "temp-cleanup") {
  mock.method(workerRecords, "readWorkerRecordOffline", async () => {
    throw new Error("synthetic private path /credential-sentinel must not escape");
  });
}

if (process.env.HTML_INBOX_FATAL_FIXTURE === "early-startup-cleanup") {
  const home = process.argv[process.argv.indexOf("--home") + 1];
  const paths = workerRecords.workerPaths(home);
  const open = fs.open;
  const unlink = fs.unlink;
  let startupUnlinked = false;
  let syncFailed = false;
  mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (path.basename(String(args[0])).startsWith(".lifetime.lock.owner-")) {
      mock.method(file, "writeFile", async () => {
        process.send?.({ type: "candidate-write-fault" });
        throw Object.assign(new Error("private acquisition /credential-sentinel EIO"), { code: "EIO" });
      });
    }

    if (args[0] === paths.directory) {
      const sync = file.sync.bind(file);
      mock.method(file, "sync", async () => {
        if (startupUnlinked && !syncFailed) {
          syncFailed = true;
          process.send?.({ type: "startup-sync-fault" });
          throw Object.assign(new Error("private cleanup /credential-sentinel EIO"), { code: "EIO" });
        }

        await sync();
      });
    }

    return file;
  });
  mock.method(fs, "unlink", async (name: Parameters<typeof fs.unlink>[0]) => {
    await unlink(name);
    if (name === paths.startup) startupUnlinked = true;
  });
}
