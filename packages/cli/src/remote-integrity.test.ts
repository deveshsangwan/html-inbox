import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { CloudflarePagesAdapter } from "./cloudflare-pages";
import { parseRemoteOperation, parseRemoteState } from "./remote-workflow";
import { exportStaticSnapshot } from "./static-export";

const target = { accountId: "a".repeat(32), projectName: "inbox-test" };
const capability = "AAAAAAAAAAAAAAAAAAAAAA";
const timestamp = "2026-09-05T00:00:00.000Z";
const base = {
  schemaVersion: 1,
  ownerId: randomUUID(),
  target,
  branch: "main",
  capability,
  revoked: false,
  configuredAt: timestamp,
  updatedAt: timestamp,
};
const receipt = {
  target,
  branch: "main",
  deploymentUrl: "https://abcdef12.inbox-test.pages.dev",
  projectUrl: "https://inbox-test.pages.dev",
  deploymentInboxUrl: `https://abcdef12.inbox-test.pages.dev/i/${capability}/`,
  projectInboxUrl: `https://inbox-test.pages.dev/i/${capability}/`,
};

test("remote records reject incomplete and inconsistent persisted state", () => {
  const deployment = {
    operationId: randomUUID(),
    kind: "publish",
    snapshotHash: "a".repeat(64),
    completedAt: timestamp,
    receipt,
  };
  assert.equal(
    parseRemoteState({ ...base, lastDeployment: deployment }).lastDeployment
      ?.receipt.projectUrl,
    receipt.projectUrl,
  );
  for (const lastDeployment of [
    null,
    { operationId: randomUUID() },
    { ...deployment, receipt: {} },
    { ...deployment, receipt: { ...receipt, branch: "other" } },
    { ...deployment, snapshotHash: "bad" },
  ]) {
    assert.throws(() => parseRemoteState({ ...base, lastDeployment }));
  }
  assert.throws(() => parseRemoteState({ ...base, configuredAt: undefined }));
});

test("remote operation parsing enforces kind and phase requirements", () => {
  const operation = {
    ...base,
    id: randomUUID(),
    kind: "publish",
    phase: "prepared",
    snapshotHash: "b".repeat(64),
    attempts: 0,
    createdAt: timestamp,
  };
  assert.equal(parseRemoteOperation(operation).kind, "publish");
  assert.throws(() =>
    parseRemoteOperation({ ...operation, phase: "remote-succeeded" }),
  );
  assert.throws(() => parseRemoteOperation({ ...operation, kind: "revoke" }));
  assert.throws(() =>
    parseRemoteOperation({
      ...operation,
      kind: "revoke",
      previousCapability: capability,
    }),
  );
  assert.throws(() => parseRemoteOperation({ ...operation, receipt }));
  assert.equal(
    parseRemoteOperation({ ...operation, phase: "remote-succeeded", receipt })
      .phase,
    "remote-succeeded",
  );
});

for (const change of ["extra", "missing", "changed", "journal"] as const) {
  test(`deployment rejects ${change} snapshot data before invoking Wrangler`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "inbox-integrity-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const snapshot = await exportStaticSnapshot(
      {
        async listDocuments() {
          return [];
        },
        async getDocument() {
          return null;
        },
      },
      { outputDir: path.join(directory, "snapshot"), capability },
    );
    const indexPath = path.join(snapshot.outputDir, "index.html");
    if (change === "extra")
      await writeFile(path.join(snapshot.outputDir, "extra.html"), "unlisted");
    if (change === "missing") await rm(indexPath);
    if (change === "changed")
      await writeFile(indexPath, `${await readFile(indexPath, "utf8")}changed`);
    let invoked = false;
    const adapter = new CloudflarePagesAdapter({
      async run() {
        invoked = true;
        return { code: 0, signal: null, output: receipt.deploymentUrl };
      },
    });
    await assert.rejects(
      adapter.deploySnapshot(
        {
          ...snapshot,
          snapshotHash:
            change === "journal"
              ? "0".repeat(64)
              : snapshot.manifest.snapshotHash,
        },
        target,
      ),
      /snapshot/i,
    );
    assert.equal(invoked, false);
  });
}

test("deployment copies verified snapshot bytes and generates host headers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "inbox-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new LocalDocumentBackend(path.join(directory, "home"));
  const originalBytes = Buffer.from(
    `<!doctype html><html><body>${"x".repeat(128 * 1024)}</body></html>`,
  );
  const published = await backend.publish({
    originalBytes,
    title: "Large document",
    type: "report",
    sourceFileName: "large.html",
  });
  const snapshot = await exportStaticSnapshot(backend, {
    outputDir: path.join(directory, "snapshot"),
    capability,
  });
  let copied = false;
  const adapter = new CloudflarePagesAdapter({
    async run(invocation) {
      assert.equal(
        await readFile(path.join(invocation.cwd, "index.html"), "utf8"),
        await readFile(path.join(snapshot.outputDir, "index.html"), "utf8"),
      );
      assert.match(
        await readFile(path.join(invocation.cwd, "_headers"), "utf8"),
        /Content-Security-Policy/,
      );
      assert.deepEqual(
        await readFile(
          path.join(
            invocation.cwd,
            "i",
            capability,
            "documents",
            published.metadata.id,
            "content",
            "index.html",
          ),
        ),
        originalBytes,
      );
      copied = true;
      return { code: 0, signal: null, output: receipt.deploymentUrl };
    },
  });
  await adapter.deploySnapshot(
    { ...snapshot, snapshotHash: snapshot.manifest.snapshotHash },
    target,
  );
  assert.equal(copied, true);
});

test("remote receipts preserve Cloudflare assigned project hostname suffixes", () => {
  const assignedReceipt = {
    ...receipt,
    deploymentUrl: "https://abcdef12.inbox-test-7x.pages.dev",
    projectUrl: "https://inbox-test-7x.pages.dev",
    deploymentInboxUrl: `https://abcdef12.inbox-test-7x.pages.dev/i/${capability}/`,
    projectInboxUrl: `https://inbox-test-7x.pages.dev/i/${capability}/`,
  };
  const deployment = {
    operationId: randomUUID(),
    kind: "publish",
    snapshotHash: "a".repeat(64),
    completedAt: timestamp,
    receipt: assignedReceipt,
  };
  assert.deepEqual(
    parseRemoteState({ ...base, lastDeployment: deployment }).lastDeployment
      ?.receipt,
    assignedReceipt,
  );
  assert.throws(() =>
    parseRemoteState({
      ...base,
      lastDeployment: {
        ...deployment,
        receipt: { ...assignedReceipt, projectUrl: receipt.projectUrl },
      },
    }),
  );
});
