import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const firstPort = 20_000;
const poolSize = 4096;
const maximumLeases = 64;
const recordSize = 65;

type PortRange = readonly [number, number];
type TestContext = { directory: string; ports: readonly number[] };
type Claim = { file: string; handle: FileHandle; identity: Stats; record: string };

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function combined(errors: unknown[], message: string) {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

async function closeRetainedHandle(handle: FileHandle) {
  try {
    await handle.close();
  } catch (error) {
    if (handle.fd === -1) throw error;

    // A rejected close can leave the same handle open; disposal must still report that failure.
    try {
      await handle.close();
    } catch (disposalError) {
      throw combined([error, disposalError], "Fixture port handle close and disposal failed");
    }

    throw error;
  }
}

export function parseFixtureAutomaticRanges(platform: string, output: string): PortRange[] {
  const count = platform === "linux" ? 2 : platform === "darwin" ? 6 : 0;
  if (!count) throw new Error(`Unsupported fixture port platform: ${platform}`);

  const fields = output.trim().split(/\s+/);
  if (fields.length !== count || fields.some((value) => !/^[0-9]{1,5}$/.test(value))) {
    throw new Error("Invalid automatic IPv4 port range output");
  }

  const numbers = fields.map(Number);
  if (numbers.some((value) => value < 1 || value > 65535)) throw new Error("Automatic IPv4 port endpoint out of range");
  if (platform === "linux" && numbers[0] > numbers[1]) throw new Error("Reversed Linux automatic IPv4 port range");

  const ranges: PortRange[] = [];
  for (let index = 0; index < count; index += 2) {
    ranges.push([Math.min(numbers[index], numbers[index + 1]), Math.max(numbers[index], numbers[index + 1])]);
  }

  return ranges;
}

export function validateFixturePortPool(ports: readonly number[], ranges: readonly PortRange[]) {
  if (!ports.length || ports.length > poolSize || new Set(ports).size !== ports.length ||
      ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error("Invalid fixture port pool");
  }

  if (!ranges.length || ranges.some(([start, end]) => !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end)) {
    throw new Error("Invalid automatic IPv4 port ranges");
  }

  if (ports.some((port) => ranges.some(([start, end]) => port >= start && port <= end))) {
    throw new Error("Fixture port pool overlaps automatic IPv4 allocation");
  }
}

async function discoverAutomaticRanges() {
  if (process.platform === "linux") {
    return parseFixtureAutomaticRanges("linux", await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8"));
  }

  if (process.platform === "darwin") {
    const { stdout } = await runFile("/usr/sbin/sysctl", ["-n",
      "net.inet.ip.portrange.first", "net.inet.ip.portrange.last",
      "net.inet.ip.portrange.hifirst", "net.inet.ip.portrange.hilast",
      "net.inet.ip.portrange.lowfirst", "net.inet.ip.portrange.lowlast"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 });
    return parseFixtureAutomaticRanges("darwin", stdout);
  }

  throw new Error(`Unsupported fixture port platform: ${process.platform}`);
}

function sameInode(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateDirectory(info: Stats, uid: number) {
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) {
    throw new Error("Unsafe fixture port directory");
  }
}

function validateClaim(info: Stats, uid: number) {
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size > recordSize) {
    throw new Error("Unsafe fixture port claim");
  }
}

async function probePort(port: number) {
  const server = createServer();
  let listenError: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    listenError = error;
  }

  try {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } catch (error) {
    if (!listenError || !hasCode(error, "ERR_SERVER_NOT_RUNNING")) {
      throw combined(listenError ? [listenError, error] : [error], "Fixture port probe and close failed");
    }
  }

  if (listenError) {
    if (hasCode(listenError, "EADDRINUSE")) return false;

    throw listenError;
  }

  return true;
}

// A claim owns cooperating number selection, including the gap with no kernel listener.
export async function createFixturePortScope(testContext?: TestContext) {
  if (typeof process.getuid !== "function") throw new Error("Fixture port claims require a POSIX account");

  const uid = process.getuid();
  const ranges = await discoverAutomaticRanges();
  const ports = testContext ? [...testContext.ports] : Array.from({ length: poolSize }, (_, index) => firstPort + index);
  validateFixturePortPool(ports, ranges);

  const directory = testContext?.directory ?? path.join(await realpath("/var/tmp"), `html-inbox-fixture-ports-${uid}`);
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new Error("Fixture port directory must be canonical");
  if (!testContext) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }

  const identity = await lstat(directory);
  validateDirectory(identity, uid);
  if (await realpath(directory) !== directory) throw new Error("Noncanonical fixture port directory");

  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const claims = new Set<Claim>();
  let admitted = true;
  let abandonRequested = false;
  let queue = Promise.resolve();
  let closing: Promise<void> | undefined;

  async function checkDirectory() {
    const held = await directoryHandle.stat();
    const current = await lstat(directory);
    validateDirectory(held, uid);
    validateDirectory(current, uid);
    if (!sameInode(identity, held) || !sameInode(held, current) || await realpath(directory) !== directory) {
      throw new Error("Fixture port directory identity changed");
    }
  }

  try {
    await checkDirectory();
  } catch (error) {
    try { await closeRetainedHandle(directoryHandle); } catch (closeError) { throw combined([error, closeError], "Fixture port directory setup and close failed"); }
    throw error;
  }

  async function checkClaim(claim: Claim, partial = false) {
    await checkDirectory();
    const held = await claim.handle.stat();
    const current = await lstat(claim.file);
    validateClaim(held, uid);
    validateClaim(current, uid);
    if (!sameInode(claim.identity, held) || !sameInode(held, current)) throw new Error("Fixture port claim identity changed");

    const bytes = Buffer.alloc(recordSize + 1);
    const { bytesRead } = await claim.handle.read(bytes, 0, bytes.length, 0);
    const actual = bytes.subarray(0, bytesRead).toString("utf8");
    if (partial ? !claim.record.startsWith(actual) : actual !== claim.record) throw new Error("Fixture port claim nonce changed");
  }

  async function removeClaim(claim: Claim, partial = false, releasing = false) {
    await checkClaim(claim, partial);
    if (releasing && abandonRequested) return;

    await unlink(claim.file);
  }

  async function closeClaim(claim: Claim) {
    try { await closeRetainedHandle(claim.handle); } finally {
      if (claim.handle.fd === -1) claims.delete(claim);
    }
  }

  async function existingClaim(file: string) {
    await checkDirectory();
    try {
      validateClaim(await lstat(file), uid);
    } catch (error) {
      // A cooperating owner may release after EEXIST. This pass still skips its candidate.
      if (!hasCode(error, "ENOENT")) throw error;
    }

    await checkDirectory();
  }

  async function allocate() {
    if (claims.size >= maximumLeases) throw new Error("Fixture port scope live lease limit reached");

    for (const port of ports) {
      await checkDirectory();
      const file = path.join(directory, String(port));
      let handle: FileHandle;
      try {
        handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;

        await existingClaim(file);
        continue;
      }

      let claim: Claim | undefined;
      try {
        claim = { file, handle, identity: await handle.stat(), record: `${randomBytes(32).toString("hex")}\n` };
        claims.add(claim);
        await handle.writeFile(claim.record, "utf8");
        await checkClaim(claim);
        if (await probePort(port)) return port;

        await removeClaim(claim);
      } catch (error) {
        const errors = [error];
        if (claim) {
          try { await removeClaim(claim, true); } catch (cleanupError) { errors.push(cleanupError); }
        }
        try { await closeRetainedHandle(handle); } catch (closeError) { errors.push(closeError); }
        if (claim && handle.fd === -1) claims.delete(claim);
        throw combined(errors, "Fixture port allocation and cleanup failed");
      }

      // Collision cleanup must also report a failed close instead of choosing another port.
      if (claim) await closeClaim(claim);
    }

    throw new Error("Fixture port pool exhausted");
  }

  function allocatePort(): Promise<number> {
    if (!admitted) return Promise.reject(new Error("Fixture port scope is closed"));

    const allocation = queue.then(allocate);
    queue = allocation.then(() => {}, () => {});
    return allocation;
  }

  function finish(abandon: boolean) {
    admitted = false;
    abandonRequested ||= abandon;
    if (closing) return closing;

    closing = (async () => {
      await queue;
      const errors: unknown[] = [];
      for (const claim of claims) {
        if (!abandonRequested) {
          try {
            const port = Number(path.basename(claim.file));
            if (!await probePort(port)) throw new Error(`Fixture port ${port} still has a consumer`);
            if (!abandonRequested) await removeClaim(claim, false, true);
          } catch (error) { errors.push(error); }
        }
        try { await closeClaim(claim); } catch (error) { errors.push(error); }
      }

      try { await checkDirectory(); } catch (error) { errors.push(error); }
      try { await closeRetainedHandle(directoryHandle); } catch (error) { errors.push(error); }
      if (errors.length) throw combined(errors, "Fixture port scope cleanup failed");
    })();
    return closing;
  }

  return { allocatePort, release: () => finish(false), abandon: () => finish(true) };
}
