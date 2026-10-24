import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";
import { parseViewerLocalOwner, verifyViewerLocalOwner } from "./viewer-ownership";
import { readViewerRecord } from "./viewer-records";
import { getViewerStatus, startViewer } from "./viewer-server";

const runNode = promisify(execFile);

test("ordinary viewer startup retains a readable record and verified private status", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const info = await stat(home);
  t.diagnostic(JSON.stringify({ platform: process.platform, dev: info.dev, ino: info.ino,
    safeDev: Number.isSafeInteger(info.dev), safeIno: Number.isSafeInteger(info.ino) }));

  const backend = new LocalDocumentBackend(home);
  const bytes = Buffer.from("<!doctype html><html><body>ordinary viewer</body></html>");
  const document = await backend.publish({ originalBytes: bytes, title: "Ordinary", type: "report", sourceFileName: "ordinary.html" });
  const server = await startViewer(backend, home, 0);
  let hasVerifiedRecord = false;
  const ports: number[] = [];

  try {
    const record = await readViewerRecord(home);
    assert(record, "startup must write a process record the lifecycle can read");
    ports.push(record.config.port, Number(new URL(record.controlUrl).port));
    const status = await getViewerStatus(home);
    assert.equal(status.state, "running");
    assert.equal(status.pid, process.pid);
    assert.deepEqual(await (await fetch(`${status.url}/health`)).json(), { ok: true });
    assert.deepEqual(Buffer.from(await (await fetch(`${status.url}/documents/${document.id}/content`)).arrayBuffer()), bytes);

    if (process.platform === "win32") {
      assert.equal(record.localOwner, undefined);
      await assert.rejects(verifyViewerLocalOwner(home, record), /ownership.*ambiguous/);
      await assert.rejects(verifyViewerLocalOwner(home, { ...record, localOwner: { home, dev: 0, ino: 0, start: null } }), /ownership.*ambiguous/);
    } else {
      assert(record.localOwner);
      assert.equal(await verifyViewerLocalOwner(home, record), "live");
    }

    hasVerifiedRecord = true;
  } finally {
    // A malformed record must not prevent teardown of this deliberately failing fixture.
    if (!hasVerifiedRecord) {
      await rm(path.join(home, "viewer.json"), { force: true });
    }

    await closeViewerFixture(server, home);
  }

  for (const port of ports) {
    await assertPortReleased(port);
  }
});

test("Windows viewer lifecycle tolerates filesystem identifiers outside the managed integer range", async (t) => {
  const home = await realpath(await temporaryHome(t));
  const preload = path.join(home, "windows-stat.cjs");
  await writeFile(preload, `
    const fs = require("node:fs/promises");
    const stat = fs.stat;
    fs.stat = async (...args) => {
      const info = await stat(...args);
      if (info.isDirectory()) {
        info.dev = Number.MAX_SAFE_INTEGER + 1;
        info.ino = Number.MAX_SAFE_INTEGER + 1;
      }
      return info;
    };
    Object.defineProperty(process, "platform", { value: "win32" });
  `);

  const env = { ...process.env };
  // This subprocess owns its test runner rather than joining the parent's test transport.
  delete env.NODE_TEST_CONTEXT;

  const result = await runNode(process.execPath, ["--require", preload, "--test", "--test-reporter=tap",
    "--test-name-pattern=^ordinary viewer startup", __filename], {
    timeout: 5000,
    env: { ...env, TMPDIR: home, TMP: home, TEMP: home },
  }).catch((error: unknown) => {
    if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
      t.diagnostic(error.stdout);
    }

    throw error;
  });

  assert.match(result.stdout, /# pass 1/);
  assert.match(result.stdout, /"safeIno":false/);
  t.diagnostic("Windows platform and large filesystem identifiers simulated in an isolated subprocess; this is not native Windows evidence");
});

test("POSIX viewer ownership rejects copied homes, changed UUIDs and missing or altered anchors", {
  skip: process.platform === "win32" ? "Managed ownership requires POSIX filesystem identity" : false,
}, async (t) => {
  const home = await realpath(await temporaryHome(t));
  const copiedHome = await realpath(await temporaryHome(t));
  const server = await startViewer(new LocalDocumentBackend(home), home, 0);

  try {
    const record = await readViewerRecord(home);
    assert(record?.localOwner);
    const owner = record.localOwner;
    await writeFile(path.join(copiedHome, "instance-id"), record.instanceId);
    await writeFile(path.join(copiedHome, "viewer.json"), await readFile(path.join(home, "viewer.json")));
    const copied = await readViewerRecord(copiedHome);
    assert(copied);
    await assert.rejects(verifyViewerLocalOwner(copiedHome, copied), /copied/);
    await assert.rejects(verifyViewerLocalOwner(home, { ...record, instanceId: randomUUID() }), /copied/);
    await assert.rejects(verifyViewerLocalOwner(home, { ...record, localOwner: undefined }), /ambiguous/);
    await assert.rejects(verifyViewerLocalOwner(home, { ...record, localOwner: { ...owner, home: copiedHome } }), /copied/);
    await assert.rejects(verifyViewerLocalOwner(home, { ...record, localOwner: { ...owner, ino: owner.ino === 0 ? 1 : 0 } }), /copied/);
    await assert.rejects(verifyViewerLocalOwner(home, { ...record, localOwner: { ...owner, dev: owner.dev === 0 ? 1 : 0 } }), /copied/);
    assert.throws(() => parseViewerLocalOwner({ ...owner, ino: Number.MAX_SAFE_INTEGER + 1 }), /bounded integer/);
    assert.throws(() => parseViewerLocalOwner({ ...owner, dev: -1 }), /bounded integer/);

    if (owner.start !== null) {
      assert.equal(await verifyViewerLocalOwner(home, { ...record, localOwner: { ...owner, start: `${owner.start}-reused` } }), "dead");
    }

    assert.equal(await verifyViewerLocalOwner(home, record), "live");
    assert.equal((await getViewerStatus(home)).pid, process.pid);
  } finally {
    await closeViewerFixture(server, home);
  }
});

async function closeViewerFixture(server: Server, home: string) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const deadline = Date.now() + 1000;
  while (await readViewerRecord(home) && Date.now() < deadline) {
    await delay(10);
  }

  assert.equal(await readViewerRecord(home), null);
}

async function assertPortReleased(port: number) {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}
