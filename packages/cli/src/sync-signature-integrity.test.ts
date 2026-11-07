import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs, { chmod, cp, lstat, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { type TestContext } from "node:test";
import { type SyncLedger } from "./sync-ledger";
import { canonicalKey, metadataEncoding, sha256, signOriginState } from "./sync-model";
import { ManagedSyncStore, toOriginState } from "./sync-store";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const originalBytes = Buffer.from("<!doctype html><html><body>synthetic warm signature fixture π</body></html>");
const input = { originalBytes, title: "Warm signature fixture", type: "report", sourceFileName: "fixture.html" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "html-inbox-warm-signature-"));
  const home = path.join(root, "inbox");
  const store = new ManagedSyncStore(home);
  t.after(async () => {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: "ENOENT" });
  });

  await store.enroll();
  await store.publish(input, "requested");
  await store.publish(input, "unrelated");
  const ledgerPath = path.join(home, "sync", "ledger.json");
  const stableTime = new Date("2026-11-07T00:00:00.000Z");
  await utimes(ledgerPath, stableTime, stableTime);
  const ledger = await store.snapshot();
  assert.equal((await store.listDocuments()).length, 2);
  assert.deepEqual((await store.getDocument("requested"))?.originalBytes, originalBytes);

  return { root, home, store, ledger, ledgerPath };
}

async function assertAllReadsReject(store: ManagedSyncStore, error: RegExp) {
  await assert.rejects(store.snapshot(), error);
  await assert.rejects(store.listDocuments(), error);
  await assert.rejects(store.getDocument("requested"), error);
}

async function replaceWithoutGenerationChange(ledgerPath: string, ledger: SyncLedger) {
  const before = await stat(ledgerPath);
  const replacement = `${ledgerPath}.replacement`;
  await writeFile(replacement, JSON.stringify(ledger), { mode: 0o600 });
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, ledgerPath);
}

for (const change of ["signature", "signed-body-hash", "signed-metadata", "public-key"] as const) {
  test(`warm global reads reject a changed ${change} in an unrelated record at the same generation and mtime`, async (t) => {
    const { store, ledger, ledgerPath } = await fixture(t);
    const record = ledger.records[canonicalKey(ledger.inboxId, "unrelated")];
    const generation = ledger.generation;
    const mtimeMs = (await stat(ledgerPath)).mtimeMs;
    if (change === "signature") {
      record.signature = Buffer.alloc(64).toString("base64url");
    } else if (change === "signed-body-hash") {
      record.sha256 = record.sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    } else if (change === "signed-metadata") {
      record.metadata.title = "Changed signed title";
      record.metadataSha256 = sha256(metadataEncoding(record.metadata));
    } else {
      const replacementKey = generateKeyPairSync("ed25519").publicKey;
      ledger.originKeys[0].publicKey = replacementKey.export({ type: "spki", format: "pem" }).toString();
    }

    await replaceWithoutGenerationChange(ledgerPath, ledger);
    assert.equal(ledger.generation, generation);
    assert.equal((await stat(ledgerPath)).mtimeMs, mtimeMs);
    await assertAllReadsReject(store, /signature verification failed/);
    await assertAllReadsReject(new ManagedSyncStore(path.dirname(path.dirname(ledgerPath))), /signature verification failed/);
  });
}

test("warm signature reuse still parses the current ledger schema", async (t) => {
  const { store, ledger, ledgerPath } = await fixture(t);
  await writeFile(ledgerPath, JSON.stringify({ ...ledger, unsupportedField: true }));
  await assertAllReadsReject(store, /Unsupported or missing schema fields/);
});

for (const change of ["ledger-permissions", "directory-permissions", "anchor", "reader-identity", "barrier"] as const) {
  test(`warm signature reuse retains the ${change} check on every read`, async (t) => {
    const { home, store, ledger, ledgerPath } = await fixture(t);
    let error = /private/;
    if (change === "ledger-permissions") {
      await chmod(ledgerPath, 0o644);
    } else if (change === "directory-permissions") {
      await chmod(path.join(home, "sync"), 0o755);
    } else if (change === "anchor") {
      ledger.ownerAnchor.ino += 1;
      await replaceWithoutGenerationChange(ledgerPath, ledger);
      error = /Copied or moved/;
    } else if (change === "reader-identity") {
      await writeFile(path.join(home, "instance-id"), `${randomUUID()}\n`);
      error = /Reader identity differs/;
    } else {
      await writeFile(path.join(home, "documents"), "changed barrier\n");
      error = /barrier/;
    }

    await assertAllReadsReject(store, error);
  });
}

test("warm readers accept valid key rotation and restored exact inputs but reject cross-key signatures", async (t) => {
  const { store, ledger, ledgerPath } = await fixture(t);
  const savedBytes = await readFile(ledgerPath);
  const replacement = generateKeyPairSync("ed25519");
  const publicKey = replacement.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = replacement.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  ledger.originKeys[0].publicKey = publicKey;
  for (const record of Object.values(ledger.records)) {
    Object.assign(record, signOriginState(toOriginState(record), privateKey));
  }

  await replaceWithoutGenerationChange(ledgerPath, ledger);
  assert.equal((await store.snapshot()).originKeys[0].publicKey, publicKey);
  assert.deepEqual((await store.getDocument("requested"))?.originalBytes, originalBytes);

  await writeFile(ledgerPath, savedBytes);
  assert.notEqual((await store.snapshot()).originKeys[0].publicKey, publicKey);
  assert.deepEqual((await store.getDocument("requested"))?.originalBytes, originalBytes);

  const restored = await store.snapshot();
  restored.records[canonicalKey(restored.inboxId, "unrelated")].signature = ledger.records[canonicalKey(ledger.inboxId, "unrelated")].signature;
  await replaceWithoutGenerationChange(ledgerPath, restored);
  await assertAllReadsReject(store, /signature verification failed/);
});

test("warm shared signatures do not bypass copied-store quarantine or fresh-fork ownership", async (t) => {
  const { root, home, store, ledger } = await fixture(t);
  const copiedHome = path.join(root, "restored");
  await cp(home, copiedHome, { recursive: true });
  const copied = new ManagedSyncStore(copiedHome);
  await assertAllReadsReject(copied, /Copied or moved/);

  await copied.quarantineRestore();
  const quarantined = await copied.snapshot();
  assert.equal(quarantined.worker.ownerQuarantined, true);
  assert.notEqual(quarantined.storageIncarnation, ledger.storageIncarnation);
  await assert.rejects(copied.publish(input, "blocked"), /quarantine/);

  const fork = await copied.fork();
  await copied.publish(input, "future");
  const inherited = await copied.getDocumentMetadata("requested");
  assert.equal(inherited?.origin?.inboxId, ledger.inboxId);
  assert.equal(inherited?.origin?.detached, true);
  assert.equal((await copied.snapshot()).records[canonicalKey(fork.inboxId, "future")].originInboxId, fork.inboxId);
  assert.equal((await store.snapshot()).inboxId, ledger.inboxId);

  const changed = await copied.snapshot();
  changed.records[canonicalKey(ledger.inboxId, "unrelated")].signature = Buffer.alloc(64).toString("base64url");
  await replaceWithoutGenerationChange(path.join(copiedHome, "sync", "ledger.json"), changed);
  await assertAllReadsReject(copied, /signature verification failed/);
});

for (const isValid of [true, false]) {
  test(`a warm reader retries a concurrent atomic replacement and ${isValid ? "returns its current state" : "rejects its corrupted signature"}`, async (t) => {
    const { store, ledger, ledgerPath } = await fixture(t);
    ledger.worker.lastRunAt = 123;
    if (!isValid) {
      ledger.records[canonicalKey(ledger.inboxId, "unrelated")].signature = Buffer.alloc(64).toString("base64url");
    }

    const replacement = `${ledgerPath}.replacement`;
    await writeFile(replacement, JSON.stringify(ledger), { mode: 0o600 });
    const originalOpen = fs.open;
    let didReplace = false;
    let ledgerOpens = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args);
      if (args[0] !== ledgerPath) {
        return file;
      }

      ledgerOpens += 1;
      if (didReplace) {
        return file;
      }

      const originalStat = file.stat.bind(file);
      let observations = 0;
      t.mock.method(file, "stat", async (options?: { bigint?: boolean }) => {
        observations += 1;
        if (observations === 2 && !didReplace) {
          didReplace = true;
          await rename(replacement, ledgerPath);
        }

        return originalStat(options);
      });

      return file;
    });

    if (isValid) {
      assert.equal((await store.snapshot()).worker.lastRunAt, 123);
    } else {
      await assert.rejects(store.snapshot(), /signature verification failed/);
    }

    assert.equal(didReplace, true);
    assert.equal(ledgerOpens, 2, "the unlinked warmed inode cannot supply the final snapshot");
  });
}
