import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";
import { readViewerRecord } from "./viewer-records";
import { getViewerStatus, startViewer, stopViewer } from "./viewer-server";

test("wildcard LAN status returns current interface URLs without changing its private process record", async (t) => {
  const home = await temporaryHome(t);
  let interfaces = lanInterface("192.0.2.10");
  t.mock.method(os, "networkInterfaces", () => interfaces);
  const server = await startViewer(new LocalDocumentBackend(home), home, {
    port: 0,
    exposure: "lan",
  });

  try {
    const record = await readViewerRecord(home);
    assert(record);
    assert.deepEqual(record.urls, [`http://192.0.2.10:${record.config.port}`]);
    interfaces = lanInterface("192.0.2.20");

    const status = await getViewerStatus(home);
    assert.equal(status.state, "running");
    assert.equal(status.url, `http://192.0.2.20:${record.config.port}`);
    assert.deepEqual(status.urls, [status.url]);
    assert.deepEqual(await readViewerRecord(home), record);
    interfaces = {};
    await assert.rejects(
      getViewerStatus(home),
      /No usable network interface addresses.*--host/,
    );
    if (process.platform !== "win32") {
      assert.equal((await stopViewer(home)).state, "stopped");
      assert.equal(await readViewerRecord(home), null);
      const reset = await startViewer(new LocalDocumentBackend(home), home, {
        port: 0,
        exposure: "loopback",
      });
      assert.equal((await getViewerStatus(home)).exposure, "loopback");
      await new Promise<void>((resolve, reject) =>
        reset.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

test("explicit LAN binds keep their selected URL when interface discovery changes", async (t) => {
  const home = await temporaryHome(t);
  t.mock.method(os, "networkInterfaces", () => ({}));
  const server = await startViewer(new LocalDocumentBackend(home), home, {
    port: 0,
    exposure: "lan",
    host: "127.0.0.1",
  });

  try {
    const record = await readViewerRecord(home);
    assert(record);
    assert.equal((await getViewerStatus(home)).url, record.urls[0]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function lanInterface(
  address: string,
): ReturnType<typeof os.networkInterfaces> {
  return {
    ethernet: [
      {
        address,
        family: "IPv4",
        netmask: "255.255.255.0",
        mac: "00:00:00:00:00:00",
        cidr: `${address}/24`,
        internal: false,
      },
    ],
  };
}
