import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withTailscaleServeLock } from "./tailscale-records";
import { recordingTailscaleAccount } from "./tailscale-test-fixtures";

test("native account node locking creates private state and serializes without a Tailscale executable", async (t) => {
  const account = await recordingTailscaleAccount(t);
  const nodeId = randomUUID();
  const nodeHash = createHash("sha256")
    .update(nodeId)
    .digest("hex")
    .slice(0, 24);
  const stateDirectory = path.join(account.home, ".html-inbox-tailscale");
  const lockPath = path.join(stateDirectory, `${nodeHash}.lock`);
  assert.equal(os.userInfo().homedir, account.home);
  assert.equal(
    os.userInfo({ encoding: "buffer" }).homedir.toString(),
    account.home,
  );

  await withTailscaleServeLock(nodeId, async () => {
    const state = await stat(stateDirectory);
    const lock = await stat(lockPath);
    const owner = await stat(path.join(lockPath, "owner.json"));
    assert(state.isDirectory());
    assert(lock.isDirectory());
    assert(owner.isFile());
    if (process.platform !== "win32") {
      assert.equal(state.uid, os.userInfo().uid);
      assert.equal(state.mode & 0o777, 0o700);
      assert.equal(lock.mode & 0o777, 0o700);
      assert.equal(owner.mode & 0o777, 0o600);
    }

    const recorded: unknown = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
    );
    assert.deepEqual(recorded, { pid: process.pid, nodeId });
    await assert.rejects(
      withTailscaleServeLock(nodeId, async () => {}),
      /Another HTML Inbox operation owns this Tailscale node lock/,
    );
  });

  await assert.rejects(stat(lockPath), /ENOENT/);
  await assert.rejects(
    withTailscaleServeLock(nodeId, async () => {
      throw new Error("failed operation");
    }),
    /failed operation/,
  );
  await assert.rejects(stat(lockPath), /ENOENT/);
  assert((await stat(stateDirectory)).isDirectory());
});
