import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { temporaryHome } from "./test-fixtures";
import { defaultRuntimeConfig, parseRuntimeConfig } from "./sync-runtime-config";

const runNode = promisify(execFile);

test("runtime credential replacement cannot substitute an unchecked inode after handle permission checks", { skip: process.platform === "win32" }, async (t) => {
  const root = await realpath(await temporaryHome(t));
  const target = path.join(root, "credential");
  await writeFile(target, "verified private bytes", { mode: 0o600 });
  const worker = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const [modulePath, target] = process.argv.slice(1);
    const perform = fs.open;
    let hits = 0;
    fs.open = async (...args) => {
      const file = await perform(...args);
      if (args[0] !== target) return file;
      const stat = file.stat.bind(file);
      let calls = 0;
      file.stat = async (...statArgs) => {
        const info = await stat(...statArgs);
        calls += 1;
        if (calls === 2) {
          hits += 1;
          await fs.writeFile(target + ".replacement", "unverified public replacement", { mode: 0o644 });
          await fs.rename(target + ".replacement", target);
        }
        return info;
      };
      return file;
    };
    (async () => {
      const bytes = await require(modulePath).readRuntimeFile(target, 256, true);
      assert.equal(bytes.toString(), "verified private bytes");
      assert.equal(hits, 1);
      assert.equal(await fs.readFile(target, "utf8"), "unverified public replacement");
      process.stdout.write(JSON.stringify({ hits, sameHandleRead: true }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;

  const result = await runNode(process.execPath, ["-e", worker, path.join(__dirname, "sync-runtime-config.js"), target], { timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { hits: 1, sameHandleRead: true });
});

test("runtime configuration validates deadlines, references, unknown fields and literal listener host", () => {
  assert.deepEqual(parseRuntimeConfig(defaultRuntimeConfig()), defaultRuntimeConfig());
  for (const foregroundMs of [0, 99, 300_001, Infinity, "30000"]) {
    const config = defaultRuntimeConfig();
    assert.throws(() => parseRuntimeConfig({ ...config, timings: { ...config.timings, foregroundMs } }));
  }

  assert.throws(() => parseRuntimeConfig({ ...defaultRuntimeConfig(), token: "not allowed" }), /fields/);
  assert.throws(() => parseRuntimeConfig({ ...defaultRuntimeConfig(), credentials: { route: "relative" } }), /absolute/);
  const key = path.resolve(tmpdir(), "html-inbox-test-key");
  const cert = path.resolve(tmpdir(), "html-inbox-test-cert");
  const listener = { host: "127.0.0.1", port: 4000, tlsRef: "server" };
  const config = { ...defaultRuntimeConfig(), listener, tls: { server: { key, cert } } };
  assert.deepEqual(parseRuntimeConfig(config).listener, listener);
  assert.throws(() => parseRuntimeConfig({ ...config, listener: { ...listener, host: "0.0.0.0" } }), /unicast/);
});

test("optional worker record removal between existence check and checked read is absent, while unsafe files remain errors", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const [modulePath, home, boundary] = process.argv.slice(1);
    const target = path.join(home, "sync", "worker", "runtime.json");
    let hits = 0;
    const operation = boundary === "fstat" ? "open" : boundary;
    const perform = fs[operation];
    fs[operation] = async (...args) => {
      if (boundary === "fstat" && args[0] === target && !hits) {
        const file = await perform(...args);
        hits += 1;
        await fs.rm(target);
        return file;
      }
      if (args[0] === target && !hits) {
        hits += 1;
        await fs.rm(target);
      }
      return perform(...args);
    };
    (async () => {
      const value = await require(modulePath).readWorkerRecordOffline(home);
      assert.equal(value, null);
      assert.equal(hits, 1);
      process.stdout.write(JSON.stringify({ hits, absent: true }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "sync", "worker"), { recursive: true, mode: 0o700 });
  for (const boundary of ["realpath", "open", "fstat"]) {
    await writeFile(path.join(root, "sync", "worker", "runtime.json"), "{}", { mode: 0o600 });
    const result = await runNode(process.execPath, ["-e", script, path.join(__dirname, "sync-worker-records.js"), root, boundary], { timeout: 5000 });
    assert.deepEqual(JSON.parse(result.stdout), { hits: 1, absent: true });
  }

  await writeFile(path.join(root, "sync", "worker", "runtime.json"), "{}", { mode: 0o600 });
  const { readWorkerRecordOffline } = await import("./sync-worker-records.js");
  await assert.rejects(readWorkerRecordOffline(root), /fields|private permissions/);
});
