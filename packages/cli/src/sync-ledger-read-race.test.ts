import assert from "node:assert/strict";
import fs, { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { SYNC_LIMITS } from "./sync-model";
import { ManagedSyncStore } from "./sync-store";
import { startOwnedSyncWorker } from "./sync-worker";

const test = process.platform === "win32" ? platformTest.skip : platformTest;

function attributes(info: Awaited<ReturnType<typeof lstat>>) {
  return { isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink(), dev: String(info.dev), ino: String(info.ino),
    nlink: Number(info.nlink), uid: Number(info.uid), currentUid: process.getuid?.(), mode: Number(info.mode), size: Number(info.size) };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-ledger-race-"));
  const home = path.join(root, "inbox");
  const store = new ManagedSyncStore(home);
  const cleanup: Array<() => Promise<void>> = [];
  await store.enroll();
  t.after(async () => {
    t.mock.restoreAll();
    for (const close of cleanup.reverse()) {
      await close();
    }

    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: "ENOENT" });
    t.diagnostic("synthetic root removed");
  });

  return { home, store, cleanup, ledgerPath: path.join(home, "sync", "ledger.json") };
}

async function holdReplacement(t: TestContext, ledgerPath: string, replace: () => Promise<void>, phase: "lstat-result" | "opened-handle", limit = 1, validReplacement = true) {
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  let hits = 0;
  let replacing = false;
  let freshCheck = false;

  async function replaceAndObserve(file: Awaited<ReturnType<typeof open>>, bigint = false) {
    hits += 1;
    const before = await file.stat({ bigint });
    replacing = true;
    try {
      await replace();
    } finally {
      replacing = false;
    }

    const checked = await file.stat({ bigint });
    const current = await originalLstat(ledgerPath, { bigint });
    t.diagnostic(JSON.stringify({ phase, filename: "ledger.json", before: attributes(before), checked: attributes(checked), current: attributes(current) }));
    assert.equal(Number(before.nlink), 1);
    assert.equal(Number(checked.nlink), 0);
    if (validReplacement) {
      assert.equal(Number(current.nlink), 1);
    }

    assert.notEqual(checked.ino, current.ino);
    freshCheck = true;

    return checked;
  }

  if (phase === "lstat-result") {
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] !== ledgerPath || replacing || hits >= limit) {
        return originalLstat(...args);
      }

      if (freshCheck) {
        freshCheck = false;
        return originalLstat(...args);
      }

      const retained = await originalOpen(ledgerPath, "r");
      try {
        // Use the old inode's real post-rename fstat to model a path lookup racing rename.
        // This controls the syscall result delivery; it does not prove native lstat returned nlink 0.
        return await replaceAndObserve(retained, args[1]?.bigint);
      } finally {
        await retained.close();
      }
    });
  } else {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args);
      if (args[0] === ledgerPath && !hits) {
        const originalStat = file.stat.bind(file);
        t.mock.method(file, "stat", async (options?: { bigint?: boolean }) => {
          if (hits) {
            return originalStat(options);
          }

          // Restore before observation so both stats are actual syscalls on this retained handle.
          file.stat = originalStat;
          return replaceAndObserve(file, options?.bigint);
        });
      }

      return file;
    });
  }

  return { hits: () => hits };
}

test("ledger snapshot accepts a new valid commit after the checked inode was replaced", async (t) => {
  const { store, ledgerPath } = await fixture(t);
  const initial = await store.snapshot();
  const race = await holdReplacement(t, ledgerPath, () => store.setWorkerEnabled(true), "lstat-result");
  const current = await store.snapshot();
  assert.equal(race.hits(), 1);
  assert.equal(current.worker.enabled, true);
  assert.ok(current.generation > initial.generation);
});

test("ledger snapshot retries a real opened inode unlinked by a production commit", async (t) => {
  const { store, ledgerPath } = await fixture(t);
  const initial = await store.snapshot();
  const race = await holdReplacement(t, ledgerPath, () => store.setWorkerEnabled(true), "opened-handle");
  const current = await store.snapshot();
  assert.equal(race.hits(), 1);
  assert.equal(current.worker.enabled, true);
  assert.ok(current.generation > initial.generation);
});

test("ledger snapshot checks a new valid inode installed between lstat and open", async (t) => {
  const { store, ledgerPath } = await fixture(t);
  const originalOpen = fs.open;
  let replacements = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === ledgerPath && !replacements) {
      replacements += 1;
      await store.setWorkerEnabled(true);
    }

    return originalOpen(...args);
  });

  assert.equal((await store.snapshot()).worker.enabled, true);
  assert.equal(replacements, 1);
});

test("ledger snapshot discards bytes when a production commit unlinks its handle during read", async (t) => {
  const { store, ledgerPath } = await fixture(t);
  const originalOpen = fs.open;
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  let replacements = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (args[0] === ledgerPath) {
      handles.push(file);
      const originalRead = file.read.bind(file);
      t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
        const result = await originalRead(...readArgs);
        if (!replacements) {
          replacements += 1;
          const before = await file.stat();
          await store.setWorkerEnabled(true);
          const checked = await file.stat();
          const current = await lstat(ledgerPath);
          t.diagnostic(JSON.stringify({ phase: "after-read", before: attributes(before), checked: attributes(checked), current: attributes(current) }));
          assert.equal(checked.nlink, 0);
          assert.notEqual(checked.ino, current.ino);
        }

        return result;
      });
    }

    return file;
  });

  assert.equal((await store.snapshot()).worker.enabled, true, "discard the earlier disabled snapshot bytes");
  assert.equal(replacements, 1);
  for (const file of handles) {
    await assert.rejects(file.stat(), { code: "EBADF" });
  }
});

for (const condition of ["mode", "size", "hardlink"] as const) {
  test(`in-place ${condition} change during read fails closed and closes its handle`, async (t) => {
    const { store, ledgerPath } = await fixture(t);
    const originalOpen = fs.open;
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    let changes = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args);
      if (args[0] === ledgerPath) {
        handles.push(file);
        const originalRead = file.read.bind(file);
        t.mock.method(file, "read", async (...readArgs: Parameters<typeof file.read>) => {
          const result = await originalRead(...readArgs);
          if (!changes) {
            changes += 1;
            if (condition === "mode") {
              await chmod(ledgerPath, 0o644);
            } else if (condition === "size") {
              await truncate(ledgerPath, 0);
            } else {
              await link(ledgerPath, `${ledgerPath}.second-link`);
            }
          }

          return result;
        });
      }

      return file;
    });

    await assert.rejects(store.snapshot(), /during read/);
    assert.equal(changes, 1);
    assert.equal(handles.length, 1, "in-place changes cannot consume a replacement retry");
    await assert.rejects(handles[0].stat(), { code: "EBADF" });
  });
}

test("an enabled owned worker keeps its process identity through a benign ledger replacement", async (t) => {
  const { home, store, cleanup, ledgerPath } = await fixture(t);
  await store.setWorkerEnabled(true);
  const events: string[] = [];
  const worker = await startOwnedSyncWorker(home, { testHooks: { onEvent: (event) => events.push(event.type) } });
  cleanup.push(async () => {
    await worker.close();
    await assertLoopbackClosed(worker.record.controlOrigin);
    t.diagnostic("owned worker closed; exact control port rebound");
  });

  const deadline = Date.now() + 3000;
  while ((await store.snapshot()).worker.lastRunAt === null && Date.now() < deadline) {
    await delay(10);
  }

  const race = await holdReplacement(t, ledgerPath, () => store.recordWorkerRun(Date.now(), null), "lstat-result");
  await assert.doesNotReject(worker.tick());
  assert.equal(race.hits(), 1);
  await delay(300);
  assert.equal(worker.status().processId, worker.record.processId);
  assert.equal(events.includes("closed"), false);
  assert.notEqual(worker.status().processState, "stopping");
});

for (const condition of ["directory", "symlink", "hardlink", "wrong-uid", "public-mode", "oversize", "missing"] as const) {
  test(`stable ${condition} ledger fails closed before any ledger or symlink-target open`, async (t) => {
    const { store, home, ledgerPath } = await fixture(t);
    const originalLstat = fs.lstat;
    const originalOpen = fs.open;
    const sentinel = path.join(home, "synthetic-sentinel");
    await writeFile(sentinel, "synthetic inaccessible payload", { mode: 0o600 });

    if (condition === "directory" || condition === "symlink") {
      await rm(ledgerPath);
      if (condition === "directory") {
        await mkdir(ledgerPath);
      } else {
        await symlink(sentinel, ledgerPath);
      }
    } else if (condition === "hardlink") {
      await link(ledgerPath, `${ledgerPath}.second-link`);
    } else if (condition === "oversize") {
      await truncate(ledgerPath, SYNC_LIMITS.ledgerBytes + 1);
    } else if (condition === "public-mode") {
      await chmod(ledgerPath, 0o644);
    } else if (condition === "missing") {
      await rm(ledgerPath);
    }

    let checks = 0;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === ledgerPath) {
        checks += 1;
      }

      const info = await originalLstat(...args);
      if (args[0] === ledgerPath) {
        if (condition === "wrong-uid") {
          // A stat-only owner simulation avoids privileged chown or changing the test account.
          return Object.assign(Object.create(info), { uid: Number(info.uid) + 1 });
        }
      }

      return info;
    });

    const opened: unknown[] = [];
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      opened.push(args[0]);
      return originalOpen(...args);
    });

    await assert.rejects(store.snapshot());
    assert.equal(checks, 1, "stable unsafe samples are never retried");
    assert.equal(opened.includes(ledgerPath), false);
    assert.equal(opened.includes(sentinel), false);
    assert.equal(await readFile(sentinel, "utf8"), "synthetic inaccessible payload");
  });
}

for (const condition of ["malformed-json", "signature", "anchor", "reader-identity", "barrier"] as const) {
  test(`a fresh ${condition} ledger fails validation without another ledger read`, async (t) => {
    const { store, home, ledgerPath } = await fixture(t);
    await store.publish({ originalBytes: Buffer.from("<!doctype html><html><body>synthetic ledger signature</body></html>"),
      title: "Ledger fixture", type: "report", sourceFileName: "fixture.html" }, "signed");
    const ledger = await store.snapshot();
    if (condition === "signature") {
      const record = Object.values(ledger.records)[0];
      record.signature = Buffer.alloc(64).toString("base64url");
    } else if (condition === "anchor") {
      ledger.ownerAnchor.ino += 1;
    }

    await writeFile(ledgerPath, condition === "malformed-json" ? "{" : JSON.stringify(ledger), { mode: 0o600 });
    if (condition === "reader-identity") {
      await writeFile(path.join(home, "instance-id"), "00000000-0000-4000-8000-000000000001\n");
    } else if (condition === "barrier") {
      await writeFile(path.join(home, "documents"), "invalid barrier\n");
    }

    const originalOpen = fs.open;
    let reads = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === ledgerPath) {
        reads += 1;
      }

      return originalOpen(...args);
    });

    const error = condition === "signature" ? /signature/ : condition === "anchor" ? /Copied or moved/ :
      condition === "reader-identity" ? /Reader identity differs/ : condition === "barrier" ? /barrier/ : SyntaxError;
    await assert.rejects(store.snapshot(), error);
    assert.equal(reads, 1);
  });
}

test("continuous proven replacement exhausts the existing four-read bound", async (t) => {
  const { store, ledgerPath } = await fixture(t);
  const race = await holdReplacement(t, ledgerPath, () => store.recordWorkerRun(Date.now(), null), "lstat-result", 4);
  await assert.rejects(store.snapshot());
  assert.equal(race.hits(), 4);
});

for (const condition of ["symlink", "hardlink", "public-mode"] as const) {
  test(`an unlinked old inode cannot authorize a ${condition} replacement`, async (t) => {
    const { home, store, ledgerPath } = await fixture(t);
    const sentinel = path.join(home, "synthetic-sentinel");
    await writeFile(sentinel, "synthetic inaccessible payload", { mode: 0o600 });
    let unsafeInstalled = false;
    const race = await holdReplacement(t, ledgerPath, async () => {
      await store.recordWorkerRun(Date.now(), null);
      if (condition === "symlink") {
        await rm(ledgerPath);
        await symlink(sentinel, ledgerPath);
      } else if (condition === "hardlink") {
        await link(ledgerPath, `${ledgerPath}.second-link`);
      } else {
        await chmod(ledgerPath, 0o644);
      }

      unsafeInstalled = true;
    }, "lstat-result", 1, false);
    const originalOpen = fs.open;
    const readPaths: unknown[] = [];
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      // Production commits use exclusive creation, which is unrelated to read acceptance.
      if (unsafeInstalled && args[1] !== "wx") {
        readPaths.push(args[0]);
      }

      return originalOpen(...args);
    });

    await assert.rejects(store.snapshot());
    assert.equal(race.hits(), 1);
    assert.equal(readPaths.includes(ledgerPath), false);
    assert.equal(readPaths.includes(sentinel), false);
  });
}
