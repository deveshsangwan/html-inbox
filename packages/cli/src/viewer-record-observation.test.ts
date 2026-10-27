import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createWorkerFixture, isPidGone, waitUntil } from "./sync-worker-fault-fixtures";
import { assertLoopbackClosed } from "./sync-protocol-fixture";
import { isRecord } from "./validation";
import {
  recordViewerReadClose, serializeViewerReadFailure, VIEWER_READ_OBSERVATION_PREFIX,
  type ViewerReadObservation,
} from "./viewer-record-observation-child";

function object(value: unknown): Record<string, unknown> {
  assert(isRecord(value));
  return value;
}

function diagnostic(stderr: string) {
  const lines = stderr.split("\n").filter((line) => line.startsWith(VIEWER_READ_OBSERVATION_PREFIX));
  assert.equal(lines.length, 1, "one failure-only observation");
  const line = lines[0];
  assert(line);
  assert(Buffer.byteLength(`${line}\n`) <= 8192);
  const value: unknown = JSON.parse(line.slice(VIEWER_READ_OBSERVATION_PREFIX.length));
  return object(value);
}

function fabricatedLogRead(): ViewerReadObservation {
  // These are fabricated log rows for the serializer, never filesystem results supplied to an application.
  return { logicalReadId: 7, recordKind: "viewer.json", stopPhase: "record-cleanup",
    failureCategory: "viewer-record-retry-exhausted", attempts: [1, 2, 3, 4].map((attempt): ViewerReadObservation["attempts"][number] => ({
      attempt, openId: 100 + attempt, nativeOpenFlags: constants.O_NOFOLLOW | constants.O_NONBLOCK,
      openOutcome: "opened", closeOutcome: "pending", nativeStat: { isFile: true, isSymbolicLink: false,
        uid: 1001, currentUid: 1001, mode: 0o100600, dev: 37, ino: 900 + attempt, nlink: 0, size: 754 },
    })) };
}

test("failure serialization preserves four log attempts and unique handle closure without leaking arbitrary fields", () => {
  const read = fabricatedLogRead();
  const canary = "SECRET-CANARY-must-not-appear";
  const untrusted = { ...read, authorPid: 999999, controlUrl: canary, stack: canary, config: { token: canary },
    attempts: read.attempts.map((sample) => {
      assert(sample.nativeStat);
      return { ...sample, fd: 19, credential: canary, nativeStat: { ...sample.nativeStat, report: canary } };
    }) };
  for (const id of [104, 102, 101]) assert.equal(recordViewerReadClose(untrusted, id, "closed"), true);
  assert.equal(recordViewerReadClose(untrusted, 103, "close-error"), true);
  assert.equal(recordViewerReadClose(untrusted, 19, "closed"), false, "reused FD is not an open identity");

  const line = serializeViewerReadFailure(123, 1, untrusted);
  const observed = diagnostic(line);
  assert.equal(observed.authorPid, 123);
  assert.equal(observed.complete, true);
  assert.equal(line.includes(canary), false);
  assert.equal(line.includes('"fd"'), false);
  const attempts = observed.attempts;
  assert(Array.isArray(attempts));
  assert.deepEqual(attempts.map((entry: unknown) => object(entry).attempt), [1, 2, 3, 4]);
  assert.deepEqual(attempts.map((entry: unknown) => object(entry).openId), [101, 102, 103, 104]);
  assert.deepEqual(attempts.map((entry: unknown) => object(entry).closeOutcome), ["closed", "closed", "close-error", "closed"]);
  assert.deepEqual(attempts.map((entry: unknown) => object(object(entry).nativeStat).ino), [901, 902, 903, 904]);
  assert.equal(serializeViewerReadFailure(123, 0, untrusted), "");
});

test("serialization explicitly labels cap, missed closure, invalid metadata and unrelated CLI failures", () => {
  const read = fabricatedLogRead();
  const capped = diagnostic(serializeViewerReadFailure(123, 1, { ...read, attempts: [...read.attempts, ...read.attempts] }));
  assert.equal(capped.observerStatus, "cap-hit");
  assert.equal(capped.complete, false);
  assert(Array.isArray(capped.attempts));
  assert.equal(capped.attempts.length, 4);
  assert.equal(diagnostic(serializeViewerReadFailure(123, 1, read)).complete, false);

  const invalid = diagnostic(serializeViewerReadFailure(123, 1, { ...read,
    attempts: [{ ...read.attempts[0], nativeStat: { uid: "credential-canary" } }] }));
  assert.equal(invalid.observerStatus, "observation-error");
  assert.equal(invalid.complete, false);
  assert.equal(JSON.stringify(invalid).includes("credential-canary"), false);
  const unrelated = diagnostic(serializeViewerReadFailure(123, 1, undefined));
  assert.equal(unrelated.failureCategory, "non-read-cli-failure");
  assert.equal(unrelated.logicalReadId, null);
  assert.equal(diagnostic(serializeViewerReadFailure(123, 1, undefined, "observation-error")).failureCategory, "observer-error");
});

test("ordinary test import neither patches platform functions nor loads production modules", { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const Module = require('node:module');
    const open = fs.open, lstat = fs.lstat, load = Module._load;
    const helper = require(process.argv[1]);
    assert.equal(fs.open, open); assert.equal(fs.lstat, lstat); assert.equal(Module._load, load);
    assert.equal(require.cache[process.argv[2]], undefined);
    assert.equal(helper.serializeViewerReadFailure(process.pid, 0, undefined), '');
  `, path.join(__dirname, "viewer-record-observation-child.js"), path.join(__dirname, "viewer-records.js")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    if (child.pid) assert.equal(isPidGone(child.pid), true);
  });

  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.equal(child.exitCode, 0);
  assert.equal(stderr, "");
});

const posix = process.platform === "win32" ? "Native private-file hardlinks and graceful viewer signals require POSIX" : false;

test("fixture activation excludes custom CLI entries and unregistered inbox bindings", { skip: posix, timeout: 20_000 }, async (t) => {
  const f = await createWorkerFixture(t, { observeViewerStop: true });
  const inbox = await f.inbox("source", false);
  const helper = path.join(__dirname, "viewer-record-observation-child.js");
  const custom = f.launch(["viewer", "stop", "--inbox", inbox.name, "--json"], { entry: path.join(__dirname, "index.js") });
  assert.equal(custom.child.spawnargs.includes(helper), false);
  assert.equal((await custom.completion).code, 0);

  const unregistered = f.launch(["viewer", "stop", "--inbox", "unregistered", "--json"]);
  assert.equal(unregistered.child.spawnargs.includes(helper), false);
  const failed = await unregistered.completion;
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr.includes(VIEWER_READ_OBSERVATION_PREFIX), false);
  t.diagnostic("expected unregistered-inbox CLI exit1; custom entry and missing owned binding receive no preload");
});

test("instrumented ordinary viewer stop keeps native success silent and releases its actual child and both listeners", { skip: posix, timeout: 30_000 }, async (t) => {
  const f = await createWorkerFixture(t, { observeViewerStop: true });
  const inbox = await f.inbox("source", false);
  const viewer = f.launch(["viewer", "--foreground", "--inbox", inbox.name]);
  f.resources.push(() => viewer.stop());
  const status = await waitUntil("actual foreground viewer readiness", () => f.rememberViewer(inbox), (value) => value.state === "running");
  assert.equal(status.pid, viewer.child.pid);
  const record = object(JSON.parse(await readFile(path.join(inbox.home, "viewer.json"), "utf8")));
  assert.equal(typeof record.controlUrl, "string");
  if (typeof record.controlUrl !== "string") throw new Error("Missing owned control endpoint");
  const controlOrigin = new URL(record.controlUrl).origin;

  const stopped = f.launch(["viewer", "stop", "--inbox", inbox.name, "--json"]);
  assert(stopped.child.spawnargs.includes(path.join(__dirname, "viewer-record-observation-child.js")), "same fixture activation is attached");
  const result = await stopped.completion;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr.includes(VIEWER_READ_OBSERVATION_PREFIX), false);
  assert.equal(object(JSON.parse(result.stdout)).state, "stopped");
  assert.equal((await viewer.completion).code, 0);
  assert.equal(viewer.child.exitCode, 0);
  const viewerPid = viewer.child.pid;
  assert(viewerPid);
  await waitUntil("owned viewer reaped", async () => isPidGone(viewerPid), Boolean);
  await assertLoopbackClosed(String(status.url));
  await assertLoopbackClosed(controlOrigin);
  t.diagnostic("native viewer stop exit0; no observation bytes; actual child exit+close/reaped and reader/control ports rebound");
});

test("instrumented hardlink guard retains native failure and one real nlink2 sample without leaking control data", { skip: posix, timeout: 30_000 }, async (t) => {
  const f = await createWorkerFixture(t, { observeViewerStop: true });
  const inbox = await f.inbox("source", false);
  const viewer = f.launch(["viewer", "--foreground", "--inbox", inbox.name]);
  f.resources.push(() => viewer.stop());
  const status = await waitUntil("actual viewer readiness before hardlink", () => f.rememberViewer(inbox), (value) => value.state === "running");
  assert.equal(status.pid, viewer.child.pid);
  const file = path.join(inbox.home, "viewer.json");
  const before = await lstat(file);
  const bytes = await readFile(file);
  const record = object(JSON.parse(bytes.toString("utf8")));
  assert.equal(typeof record.controlUrl, "string");
  if (typeof record.controlUrl !== "string") throw new Error("Missing owned control endpoint");
  const control = new URL(record.controlUrl);
  const alias = path.join(inbox.home, "owned-viewer-record-alias");
  await link(file, alias);

  try {
    const linked = await lstat(file);
    assert.equal(linked.nlink, 2);
    assert.equal(linked.ino, before.ino);
    const result = await f.run(["viewer", "stop", "--inbox", inbox.name, "--json"], 1);
    assert.match(result.stderr, /regular private file/);
    const observation = diagnostic(result.stderr);
    assert.equal(observation.failureCategory, "private-file-guard");
    assert.equal(observation.observerStatus, "ok");
    assert.equal(observation.complete, true);
    assert.equal(observation.recordKind, "viewer.json");
    const attempts = observation.attempts;
    assert(Array.isArray(attempts));
    assert.equal(attempts.length, 1);
    const sample = object(attempts[0]);
    const info = object(sample.nativeStat);
    assert.equal(info.nlink, 2);
    assert.equal(info.dev, linked.dev);
    assert.equal(info.ino, linked.ino);
    assert.equal(info.mode, linked.mode);
    assert.equal(sample.closeOutcome, "closed");
    assert.equal(sample.nativeOpenFlags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    assert.equal(result.stderr.includes(control.pathname), false);
    assert.equal(result.stderr.includes(control.pathname.slice("/control/".length)), false);
    assert.equal(result.stderr.includes(record.controlUrl), false);
    assert.equal(viewer.child.exitCode, null, "unsafe record does not signal the actual viewer");
    assert.equal((await lstat(file)).mode, before.mode);
    assert.equal((await readFile(file)).equals(bytes), true, "observer and guard preserve the original bytes");
    assert.equal(typeof observation.authorPid, "number");
    if (typeof observation.authorPid !== "number") throw new Error("Missing observation author");
    t.diagnostic(`expected native viewer-stop exit1/private-file guard; original file unchanged; ${serializeViewerReadFailure(observation.authorPid, 1, observation).trim()}`);
  } finally {
    const ownedAlias = await lstat(alias);
    assert.equal(ownedAlias.dev, before.dev);
    assert.equal(ownedAlias.ino, before.ino);
    await unlink(alias);
  }

  const stopped = await f.run(["viewer", "stop", "--inbox", inbox.name, "--json"], 0);
  assert.equal(stopped.stderr.includes(VIEWER_READ_OBSERVATION_PREFIX), false);
  assert.equal((await viewer.completion).code, 0);
  assert.equal(viewer.child.exitCode, 0);
  const viewerPid = viewer.child.pid;
  assert(viewerPid);
  await waitUntil("actual viewer reaped after alias removal", async () => isPidGone(viewerPid), Boolean);
  await assertLoopbackClosed(String(status.url));
  await assertLoopbackClosed(control.origin);
});
