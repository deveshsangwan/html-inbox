import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const [lockPath, stage = "created", action = "cut", errorCode = "EIO"] = process.argv.slice(2);
const original = { open: fs.open, link: fs.link, unlink: fs.unlink };
const abort = new AbortController();
const trace: string[] = [];
let hits = 0;
let callback = false;
let candidate: string | undefined;
let candidateOpens = 0;
let directorySyncs = 0;
let readonlySyncs = 0;

async function evidence() {
  const names = [];
  for (const name of await fs.readdir(path.dirname(lockPath))) {
    const location = path.join(path.dirname(lockPath), name);
    const info = await fs.lstat(location);
    names.push({ name, dev: info.dev, ino: info.ino, nlink: info.nlink, bytes: info.size,
      content: info.isFile() ? (await fs.readFile(location)).toString("utf8") : null });
  }

  return names;
}

async function event(current: string, name?: string, file?: FileHandle) {
  trace.push(current);
  if (current !== stage || hits > 0) return;
  hits += 1;
  const info = await file?.stat();
  const receipt = { type: "cut", stage, hits, name, pid: process.pid, candidateOpens,
    dev: info?.dev, ino: info?.ino, nlink: info?.nlink, bytes: info?.size, names: await evidence(), trace: [...trace] };

  if (action === "cut") {
    process.send?.(receipt);
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  if (action === "abort") { abort.abort(new Error("fixture cancellation")); return; }
  if (action === "deadline") { await new Promise((resolve) => setTimeout(resolve, 600)); return; }
  throw Object.assign(new Error(`Injected ${errorCode} at ${current}`), { code: errorCode });
}

fs.open = async (name, flags, mode) => {
  const file = await original.open(name, flags, mode);
  const nameString = String(name);
  const exclusive = flags === "wx" || typeof flags === "number" && (flags & constants.O_EXCL) !== 0;
  const isCandidate = path.dirname(nameString) === path.dirname(lockPath) && !nameString.endsWith(".reap") && exclusive;
  const isDirectory = nameString === path.dirname(lockPath);
  const isReadonly = (candidate === nameString || nameString === lockPath) && !exclusive;

  if (nameString === `${lockPath}.reap` && exclusive) await event("guard-created", nameString, file);
  if (isCandidate) {
    candidate = nameString;
    candidateOpens += 1;
    await event("created", nameString, file);
    const write = file.writeFile.bind(file);
    file.writeFile = async (data, options) => {
      await event("write-before", nameString, file);
      if (!Buffer.isBuffer(data) && typeof data !== "string") throw new Error("Unexpected fixture write");
      const bytes = Buffer.from(data);
      const split = Math.floor(bytes.length / 2);
      await write(bytes.subarray(0, split), options);
      await event("partial", nameString, file);
      await write(bytes.subarray(split), options);
      await event("written", nameString, file);
    };
  }

  if (isCandidate || isDirectory || isReadonly) {
    const sync = file.sync.bind(file);
    file.sync = async () => {
      const label = isDirectory ? `directory-${++directorySyncs}` : isCandidate ? "writable" : `readonly-${++readonlySyncs}`;
      await event(`${label}-sync-before`, nameString, file);
      await sync();
      await event(`${label}-sync-after`, nameString, file);
    };
  }

  if (isCandidate) {
    const close = file.close.bind(file);
    file.close = async () => {
      await event("close-before", nameString, file);
      await close();
      await event("close-after", nameString);
    };
  }

  if (isReadonly) await event("read-open", nameString, file);
  return file;
};

fs.link = async (source, destination) => {
  await event("link-before", String(source));
  await original.link(source, destination);
  await event("linked", String(source));
};

fs.unlink = async (name) => {
  const label = String(name) === lockPath ? "public" : String(name).endsWith(".reap") ? "guard" : "candidate";
  await event(`${label}-unlink-before`, String(name));
  await original.unlink(name);
  await event(`${label}-unlinked`, String(name));
};

async function main() {
  const { acquireSyncOwnership } = await import("./sync-files.js");
  try {
    const ownership = await acquireSyncOwnership(lockPath, Date.now() + 500, abort.signal);
    callback = true;
    await event("held", lockPath);
    await ownership.release();
    process.send?.({ type: "result", acquired: true, callback, hits, candidateOpens, trace, names: await evidence() });
  } catch (error) {
    process.send?.({ type: "result", acquired: false, callback, hits, candidateOpens, error: String(error), trace, names: await evidence() });
  }
  process.disconnect?.();
}

void main().catch((error: unknown) => {
  process.send?.({ type: "error", error: String(error), hits });
  process.exitCode = 1;
  process.disconnect?.();
});
