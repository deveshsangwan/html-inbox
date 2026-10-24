import { constants } from "node:fs";
import path from "node:path";
import { parseObject } from "./sync-model";

const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const [home, stage = "created"] = process.argv.slice(2);
const lockPath = path.join(home, "sync", "mutation.lock");
let armed = false;
let hits = 0;
let candidateOpens = 0;

process.on("message", (value: unknown) => {
  if (parseObject(value, "fixture message").type === "arm") {
    armed = true;
    process.send?.({ type: "armed" });
  }
});

// The base has the separately tracked QA002 lease bug. This fixture-only lease is
// deliberately shorter on the same loopback clock; it is not a production correction.
const server: typeof import("./sync-http-server") = require("./sync-http-server");
const createServer = server.createSyncIngestionServer;
server.createSyncIngestionServer = (options) => createServer({ ...options, leaseMs: 30_000 });

async function cut(candidate: string) {
  if (!armed || hits > 0) return;
  hits += 1;
  const info = await fs.lstat(candidate);
  const canonical = await fs.lstat(lockPath).then(async (stat) => ({ dev: stat.dev, ino: stat.ino, nlink: stat.nlink,
    bytes: stat.size, content: await fs.readFile(lockPath, "utf8") }), () => null);
  process.send?.({ type: "mutation-cut", stage, hits, candidateOpens, pid: process.pid, candidate, canonical,
    dev: info.dev, ino: info.ino, nlink: info.nlink, bytes: info.size });
  await new Promise(() => { setInterval(() => {}, 1000); });
}

const open = fs.open;
fs.open = async (name, flags, mode) => {
  const file = await open(name, flags, mode);
  const candidate = String(name);
  const exclusive = flags === "wx" || typeof flags === "number" && (flags & constants.O_EXCL) !== 0;
  if (armed && exclusive && path.dirname(candidate) === path.dirname(lockPath) && path.basename(candidate).startsWith(".mutation.lock.owner-")) {
    candidateOpens += 1;
    if (stage === "created") await cut(candidate);
  }
  return file;
};

const link = fs.link;
fs.link = async (source, destination) => {
  await link(source, destination);
  if (String(destination) === lockPath && stage === "linked") await cut(String(source));
};

process.argv = [process.execPath, path.join(__dirname, "index.js"), "sync", "worker", "start", "--foreground", "--home", home, "--json"];
void import("./index.js").then(({ main }) => main()).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
  process.disconnect?.();
});
