import http from "node:http";
import { strict as assert } from "node:assert";
import { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function temporaryHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

export async function availablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
