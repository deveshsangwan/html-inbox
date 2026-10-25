import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import path from "node:path";
import { assertExactKeys, parseObject, parseString } from "./sync-model";
import { ManagedSyncStore } from "./sync-store";

const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const [home, stage = "created"] = process.argv.slice(2);
const lockPath = path.join(home, "sync", "mutation.lock");
let armed = false;
let hits = 0;
let candidateOpens = 0;
let requested = false;
let operationId: string | undefined;
let selectedCandidate: string | undefined;
let operationCount = 0;
const mutationScope = new AsyncLocalStorage<string>();

type FixtureCommand = { type: "arm" } | { type: "cut-paused-mutation"; operationId: string };

function parseCommand(value: unknown): FixtureCommand {
  const message = parseObject(value, "fixture message");
  if (message.type === "arm") {
    assertExactKeys(message, ["type"]);
    return { type: "arm" };
  }

  assertExactKeys(message, ["type", "operationId"]);
  if (message.type !== "cut-paused-mutation") throw new Error("Unsupported fixture command");
  const id = parseString(message.operationId, "fixture operation ID", 64);
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid fixture operation ID");

  return { type: "cut-paused-mutation", operationId: id };
}

async function acceptCommand(value: unknown) {
  const command = parseCommand(value);
  if (requested) throw new Error("Duplicate fixture cut request");
  requested = true;
  if (command.type === "arm") {
    armed = true;
    process.send?.({ type: "armed" });
    return;
  }

  operationId = command.operationId;
  await mutationScope.run(command.operationId, async () => {
    const store = new ManagedSyncStore(home);
    if (!(await store.snapshot()).worker.retryPaused) throw new Error("Scoped cut requires an already-paused source");

    armed = true;
    operationCount += 1;
    process.send?.({ type: "mutation-producer", operationId, operationCount, method: "setRetryPaused", paused: true,
      alreadyPaused: true, pid: process.pid, stack: new Error("Test-only idempotent paused mutation").stack });
    await store.setRetryPaused(true);
    throw new Error(`Scoped mutation completed without its ${stage} cut`);
  });
}

process.on("message", (value: unknown) => {
  void acceptCommand(value).catch((error: unknown) => {
    process.send?.({ type: "mutation-cut-failed", operationId, error: String(error) });
  });
});

// The base has the separately tracked QA002 lease bug. This fixture-only lease is
// deliberately shorter on the same loopback clock; it is not a production correction.
const server: typeof import("./sync-http-server") = require("./sync-http-server");
const createServer = server.createSyncIngestionServer;
server.createSyncIngestionServer = (options) => createServer({ ...options, leaseMs: 30_000 });

function isSelectedMutation() {
  const current = mutationScope.getStore();
  if (current !== undefined && current !== operationId) throw new Error("Fixture mutation scope mismatch");

  return armed && (operationId === undefined || current === operationId);
}

async function cut(candidate: string) {
  if (!isSelectedMutation()) throw new Error("Cut outside selected mutation scope");
  if (hits !== 0 || candidateOpens !== 1 || candidate !== selectedCandidate) throw new Error("Unexpected fixture candidate or extra cut");

  hits += 1;
  const info = await fs.lstat(candidate);
  const canonical = await fs.lstat(lockPath).then(async (stat) => ({ dev: stat.dev, ino: stat.ino, nlink: stat.nlink,
    bytes: stat.size, mode: stat.mode, uid: stat.uid, content: await fs.readFile(lockPath, "utf8") }), () => null);
  process.send?.({ type: "mutation-cut", stage, hits, candidateOpens, pid: process.pid, candidate, canonical,
    dev: info.dev, ino: info.ino, nlink: info.nlink, bytes: info.size, mode: info.mode, uid: info.uid,
    operationId, scopeId: mutationScope.getStore(), operationCount });
  await new Promise(() => { setInterval(() => {}, 1000); });
}

const open = fs.open;
fs.open = async (name, flags, mode) => {
  const file = await open(name, flags, mode);
  const candidate = String(name);
  const exclusive = flags === "wx" || typeof flags === "number" && (flags & constants.O_EXCL) !== 0;
  if (isSelectedMutation() && exclusive && path.dirname(candidate) === path.dirname(lockPath) && path.basename(candidate).startsWith(".mutation.lock.owner-")) {
    candidateOpens += 1;
    if (candidateOpens !== 1) throw new Error("Extra candidate open in selected mutation");
    selectedCandidate = candidate;
    if (stage === "created") await cut(candidate);
  }
  return file;
};

const link = fs.link;
fs.link = async (source, destination) => {
  await link(source, destination);
  if (String(destination) === lockPath && stage === "linked" && isSelectedMutation()) await cut(String(source));
};

process.argv = [process.execPath, path.join(__dirname, "index.js"), "sync", "worker", "start", "--foreground", "--home", home, "--json"];
void import("./index.js").then(({ main }) => main()).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
  process.disconnect?.();
});
