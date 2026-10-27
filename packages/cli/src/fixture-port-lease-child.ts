import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createFixturePortScope } from "./fixture-port-leases";

async function main() {
  const directory = process.argv[2];
  const ports: unknown = JSON.parse(process.argv[3]);
  assert.equal(typeof directory, "string");
  assert.ok(Array.isArray(ports) && ports.every((port: unknown) => typeof port === "number"));
  const scope = await createFixturePortScope({ directory, ports });
  const port = await scope.allocatePort();
  let listener: ReturnType<typeof createServer> | undefined;
  let commands = Promise.resolve();

  async function stopListener() {
    if (!listener) return;

    const current = listener;
    listener = undefined;
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  }

  process.on("message", (command: unknown) => {
    commands = commands.then(async () => {
      if (command === "listen") {
        assert.equal(listener, undefined);
        listener = createServer();
        await new Promise<void>((resolve, reject) => {
          listener?.once("error", reject);
          listener?.listen(port, "127.0.0.1", resolve);
        });
      } else if (command === "stop-listener") {
        await stopListener();
      } else {
        assert.ok(command === "release" || command === "abandon");
        await stopListener();
        if (command === "release") await scope.release();
        else await scope.abandon();
        process.disconnect();
        return;
      }

      process.send?.({ command, port });
    }).catch(async (error: unknown) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
      try { await stopListener(); } finally { await scope.abandon(); process.disconnect?.(); }
    });
  });
  process.send?.({ command: "allocated", port });
}

void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
  process.disconnect?.();
});
