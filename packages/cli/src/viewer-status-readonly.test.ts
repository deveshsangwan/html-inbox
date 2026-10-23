import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ManagedStorageError } from "./private-storage";
import { availablePort, temporaryHome } from "./test-fixtures";
import * as tailscaleCommand from "./tailscale-command";
import { readTailscaleOwnership, type TailscaleOwnership } from "./tailscale-records";
import { resolveViewerNetworkConfig } from "./viewer-network";
import type { ViewerRecord } from "./viewer-records";
import { getViewerStatus, VIEWER_PROTOCOL_VERSION } from "./viewer-status";

test("read-only status verifies the private viewer without changing source paths, modes or bytes", async (t) => {
  const viewer = await viewerFixture(t);
  await assertUnchanged(viewer.home, async () => {
    const status = await viewer.inspect();
    assert.equal(status.state, "running");
    assert.equal(status.pid, process.pid);
    assert.equal(status.url, viewer.record.urls[0]);
  });

  assert.deepEqual(viewer.requests, [viewer.controlPath]);
});

test("read-only status leaves a stopped library without configuration or process records unchanged", async (t) => {
  const home = await temporaryHome(t);
  const instanceId = randomUUID();
  const port = await availablePort();
  await writeFile(path.join(home, "instance-id"), instanceId, { mode: 0o640 });
  await mkdir(path.join(home, "documents"), { mode: 0o751 });
  await chmod(home, 0o751);
  readAsNormalUser(t);

  await assertUnchanged(home, async () => {
    assert.equal((await getViewerStatus(home, port, {
      readOnly: true,
      refreshLanUrls: false,
      instanceId,
    })).state, "stopped");
  });
});

test("read-only status cannot recreate a missing source home or identity", async (t) => {
  const root = await temporaryHome(t);
  const instanceId = randomUUID();
  const existingHome = path.join(root, "existing");
  await mkdir(existingHome, { mode: 0o751 });
  await mkdir(path.join(existingHome, "documents"), { mode: 0o751 });
  readAsNormalUser(t);

  await assertUnchanged(root, async () => {
    for (const home of [existingHome, path.join(root, "missing")]) {
      const status = await getViewerStatus(home, undefined, { readOnly: true, instanceId });
      assert.equal(status.state, "conflict");
      assert.match(status.reason ?? "", /identity is missing/);
    }
  });
});

test("read-only status fails closed when the captured or on-disk identity no longer agrees", async (t) => {
  const viewer = await viewerFixture(t);
  await assertUnchanged(viewer.home, async () => {
    const status = await viewer.inspect(randomUUID());
    assert.equal(status.state, "conflict");
    assert.match(status.reason ?? "", /identity changed since selection/);
    assert.equal(status.pid, undefined);
  });

  await rm(path.join(viewer.home, "instance-id"));
  await assertUnchanged(viewer.home, async () => {
    assert.equal((await viewer.inspect()).state, "conflict");
  });

  assert.deepEqual(viewer.requests, []);
});

test("read-only status rejects stale process records while normal status retains its existing semantics", async (t) => {
  const viewer = await viewerFixture(t);
  for (const change of [
    { processId: randomUUID() },
    { pid: viewer.record.pid === 1 ? 2 : 1 },
    { protocolVersion: VIEWER_PROTOCOL_VERSION - 1 },
  ]) {
    await writeJson(viewer.home, "viewer.json", { ...viewer.record, ...change });
    const legacy = await getViewerStatus(viewer.home);
    assert.equal(legacy.state, "running");
    assert.equal(legacy.pid, undefined);
    assert.match(legacy.reason ?? "", /missing or stale/);
    await chmod(path.join(viewer.home, "viewer.json"), 0o640);
    await chmod(path.join(viewer.home, "viewer-config.json"), 0o640);

    await assertUnchanged(viewer.home, async () => {
      const status = await viewer.inspect();
      assert.equal(status.state, "protocolVersion" in change ? "incompatible" : "conflict");
      assert.equal(status.pid, undefined);
      assert.match(status.reason ?? "", /incompatible protocol|missing or stale/);
    });
  }
});

test("read-only status reports malformed process records as incompatible", async (t) => {
  const viewer = await viewerFixture(t);
  for (const contents of ["{", "null", '{"pid":0}']) {
    await writeFile(path.join(viewer.home, "viewer.json"), contents);
    await assertUnchanged(viewer.home, async () => {
      const status = await viewer.inspect();
      assert.equal(status.state, "incompatible");
      assert.equal(status.pid, undefined);
      assert(status.reason);
    });
  }

  assert.deepEqual(viewer.requests, []);
});

test("read-only status retains private control health, protocol and inbox validation", async (t) => {
  const viewer = await viewerFixture(t);
  for (const health of [
    { ...viewer.health, processId: randomUUID() },
    { ...viewer.health, pid: 0 },
    { ...viewer.health, instanceId: randomUUID() },
    { ...viewer.health, processId: undefined },
    { ...viewer.health, protocolVersion: VIEWER_PROTOCOL_VERSION - 1 },
    { ok: true },
    null,
  ]) {
    viewer.setHealth(health);
    await assertUnchanged(viewer.home, async () => {
      const status = await viewer.inspect();
      const hasOlderProtocol = health && "protocolVersion" in health && health.protocolVersion === VIEWER_PROTOCOL_VERSION - 1;
      assert.equal(status.state, hasOlderProtocol ? "incompatible" : "conflict");
      assert.equal(status.pid, undefined);
    });
  }

  viewer.setHealth(viewer.health);
  await writeJson(viewer.home, "viewer.json", {
    ...viewer.record,
    controlUrl: `http://127.0.0.1:${viewer.record.config.port}/health`,
  });
  const requestsBefore = [...viewer.requests];
  await assertUnchanged(viewer.home, async () => {
    const status = await viewer.inspect();
    assert.equal(status.state, "incompatible");
    assert.match(status.reason ?? "", /private loopback URL/);
  });

  assert.deepEqual(viewer.requests, requestsBefore);
  assert(viewer.requests.every((request) => request === viewer.controlPath));
});

test("read-only wildcard LAN inspection uses saved URLs without network interface discovery", async (t) => {
  const viewer = await viewerFixture(t);
  const config = resolveViewerNetworkConfig({ port: viewer.record.config.port, exposure: "lan" });
  const urls = [`http://192.0.2.10:${config.port}`];
  await writeJson(viewer.home, "viewer-config.json", { version: 1, config, urls });
  await writeJson(viewer.home, "viewer.json", { ...viewer.record, config, urls });
  t.mock.method(os, "networkInterfaces", () => {
    throw new Error("Read-only catalog inspection must not rediscover LAN interfaces");
  });

  await assertUnchanged(viewer.home, async () => {
    const status = await viewer.inspect();
    assert.equal(status.state, "running");
    assert.deepEqual(status.urls, urls);
  });
});

for (const filename of ["viewer-config.json", "viewer.json", "instance-id"]) {
  for (const kind of ["symlink", "hardlink"]) {
    test(`read-only status rejects a ${kind} at ${filename} without changing the source or target`, {
      skip: kind === "symlink" && process.platform === "win32"
        ? "Creating symbolic links requires an elevated Windows account."
        : false,
    }, async (t) => {
      const viewer = await viewerFixture(t);
      const recordPath = path.join(viewer.home, filename);
      const targetPath = `${recordPath}.original`;
      await rename(recordPath, targetPath);
      if (kind === "symlink") {
        await symlink(targetPath, recordPath);
      } else {
        await link(targetPath, recordPath);
      }

      await assertUnchanged(viewer.home, async () => {
        await assert.rejects(viewer.inspect(), /regular (private )?file/);
      });

      assert.deepEqual(viewer.requests, []);
    });
  }
}

test("read-only Tailscale status verifies the active route without hardening its ownership journal", async (t) => {
  const viewer = await viewerFixture(t, true);
  const ownership = await tailscaleFixture(t, viewer.home, viewer.record);
  await assertUnchanged(viewer.home, async () => {
    const status = await viewer.inspect();
    assert.equal(status.state, "running");
    assert.equal(status.pid, process.pid);
    assert.equal(status.url, ownership.url);
  });
});

test("read-only Tailscale inspection preserves missing or unsafe ownership journals", async (t) => {
  const viewer = await viewerFixture(t, true);
  const command = t.mock.method(tailscaleCommand, "resolveTailscaleExecutable", async () => {
    throw new Error("Unsafe or absent journals cannot authorize Tailscale commands");
  });
  await assertUnchanged(viewer.home, async () => {
    const status = await viewer.inspect();
    assert.equal(status.state, "conflict");
    assert.match(status.reason ?? "", /Tailscale exposure stopped/);
  });

  const targetPath = path.join(viewer.home, "unrelated.json");
  const recordPath = path.join(viewer.home, "tailscale-serve.json");
  await writeFile(targetPath, "{}", { mode: 0o640 });
  for (const kind of process.platform === "win32" ? ["hardlink"] : ["symlink", "hardlink"]) {
    if (kind === "symlink") {
      await symlink(targetPath, recordPath);
    } else {
      await link(targetPath, recordPath);
    }

    await assertUnchanged(viewer.home, async () => {
      await assert.rejects(readTailscaleOwnership(viewer.home, { readOnly: true }), ManagedStorageError);
      const status = await viewer.inspect();
      assert.equal(status.state, "conflict");
      assert.match(status.reason ?? "", /regular private file/);
    });
    await rm(recordPath);
  }

  assert.equal(command.mock.callCount(), 0);
});

async function viewerFixture(t: TestContext, usesTailscale = false) {
  const home = await temporaryHome(t);
  const health = {
    ok: true,
    instanceId: randomUUID(),
    processId: randomUUID(),
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    pid: process.pid,
  };
  let responseHealth: unknown = health;
  const controlPath = `/control/${"A".repeat(43)}`;
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(request.url === controlPath ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(request.url === controlPath ? responseHealth : { ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert(address && typeof address !== "string");

  const config = resolveViewerNetworkConfig({
    port: address.port,
    exposure: usesTailscale ? "tailscale" : "loopback",
    ...(usesTailscale ? { tailscaleHostname: "reader.example-tailnet.ts.net" } : {}),
  });
  const record: ViewerRecord = {
    ...health,
    config,
    urls: [usesTailscale ? `https://${config.tailscaleHostname}` : `http://127.0.0.1:${address.port}`],
    controlUrl: `http://127.0.0.1:${address.port}${controlPath}`,
    startedAt: new Date().toISOString(),
  };
  await writeFile(path.join(home, "instance-id"), health.instanceId, { mode: 0o640 });
  await writeJson(home, "viewer.json", record);
  await writeJson(home, "viewer-config.json", { version: 1, config, urls: record.urls });
  await mkdir(path.join(home, "documents"), { mode: 0o751 });
  await writeFile(path.join(home, "documents", "unrelated.html"), "<p>Preserved source bytes</p>", { mode: 0o640 });
  await chmod(home, 0o751);
  readAsNormalUser(t);

  return {
    home,
    record,
    health,
    controlPath,
    requests,
    setHealth(value: unknown) { responseHealth = value; },
    inspect(instanceId = health.instanceId) {
      return getViewerStatus(home, undefined, { readOnly: true, refreshLanUrls: false, instanceId });
    },
  };
}

async function tailscaleFixture(t: TestContext, home: string, record: ViewerRecord) {
  const hostname = record.config.tailscaleHostname;
  assert(hostname);
  const ownership: TailscaleOwnership = {
    version: 1,
    phase: "active",
    home,
    backendPort: record.config.port,
    instanceId: record.instanceId,
    processId: record.processId,
    nodeId: randomUUID(),
    hostname,
    url: `https://${hostname}`,
    executable: process.execPath,
    httpsPort: 443,
    mount: "/",
    proxy: `http://127.0.0.1:${record.config.port}`,
  };
  await writeJson(home, "tailscale-serve.json", ownership);
  t.mock.method(tailscaleCommand, "resolveTailscaleExecutable", async () => process.execPath);
  t.mock.method(tailscaleCommand, "runTailscale", async (_executable: string, args: string[]) => {
    if (JSON.stringify(args) === JSON.stringify(["status", "--json"])) {
      return JSON.stringify({
        BackendState: "Running",
        Self: { ID: ownership.nodeId, DNSName: hostname, Online: true, CapMap: { https: [] } },
        CurrentTailnet: { MagicDNSEnabled: true, MagicDNSSuffix: "example-tailnet.ts.net" },
        CertDomains: [hostname],
      });
    }

    assert.deepEqual(args, ["serve", "status", "--json"]);
    return JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: { [`${hostname}:443`]: { Handlers: { "/": { Proxy: ownership.proxy } } } },
    });
  });

  return ownership;
}

function readAsNormalUser(t: TestContext) {
  const getUid = process.getuid;
  if (!getUid) {
    return;
  }

  process.getuid = () => 1000;
  t.after(() => { process.getuid = getUid; });
}

async function writeJson(home: string, filename: string, value: unknown) {
  await writeFile(path.join(home, filename), `${JSON.stringify(value)}\n`, { mode: 0o640 });
}

async function assertUnchanged(home: string, inspect: () => Promise<void>) {
  const before = await sourceSnapshot(home);
  try {
    await inspect();
  } finally {
    assert.deepEqual(await sourceSnapshot(home), before);
  }
}

async function sourceSnapshot(home: string) {
  const paths = ["", ...(await readdir(home, { recursive: true })).sort()];
  return Promise.all(paths.map(async (relativePath) => {
    const filePath = path.join(home, relativePath);
    const info = await lstat(filePath);
    return {
      path: relativePath,
      mode: info.mode,
      dev: info.dev,
      ino: info.ino,
      nlink: info.nlink,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      contents: info.isFile() ? (await readFile(filePath)).toString("base64") : undefined,
      target: info.isSymbolicLink() ? await readlink(filePath) : undefined,
    };
  }));
}
