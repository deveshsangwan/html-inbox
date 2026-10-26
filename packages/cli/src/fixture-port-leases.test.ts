import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs = require("node:fs/promises");
import net = require("node:net");
import { tmpdir } from "node:os";
import path from "node:path";
import platformTest, { after, before, mock, type TestContext } from "node:test";
import { createFixturePortScope, parseFixtureAutomaticRanges, validateFixturePortPool } from "./fixture-port-leases";

const test = process.platform === "win32" ? platformTest.skip : platformTest;
const ports: number[] = [];
const poolOwners: Awaited<ReturnType<typeof createFixturePortScope>>[] = [];

if (process.platform !== "win32") {
  before(async () => {
    // Isolated claim directories must still exclude this file's native probes from other fixtures.
    for (let index = 0; index < 2; index += 1) {
      const owner = await createFixturePortScope();
      poolOwners.push(owner);
      for (let count = 0; count < 40; count += 1) ports.push(await owner.allocatePort());
    }
  });

  after(async () => {
    const settled = await Promise.allSettled(poolOwners.map((owner) => owner.release()));
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Helper test port reservations failed to release");
  });
}

async function context(t: TestContext, selected = ports) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "fixture-port-leases-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, ports: selected };
}

async function scope(t: TestContext, selected = ports) {
  const ctx = await context(t, selected);
  const owner = await createFixturePortScope(ctx);
  t.after(() => owner.abandon());
  return { ...ctx, ...owner };
}

async function listen(port: number) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function close(server: net.Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function client(t: TestContext, ctx: Awaited<ReturnType<typeof context>>) {
  const child = spawn(process.execPath, [path.join(__dirname, "fixture-port-lease-child.js"), ctx.directory, JSON.stringify(ctx.ports)],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  assert.ok(child.stderr);
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const messages: { command: string; port: number }[] = [];
  const waiters: (() => void)[] = [];
  child.on("message", (value: unknown) => {
    assert.ok(value && typeof value === "object" && "command" in value && typeof value.command === "string" && "port" in value && typeof value.port === "number");
    messages.push({ command: value.command, port: value.port });
    for (const wake of waiters.splice(0)) wake();
  });
  let closed = false;
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      for (const wake of waiters.splice(0)) wake();
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`Port client failed ${code}/${signal}: ${stderr}`));
    });
  });
  // Keep the native close rejection observed even when readiness fails first.
  void completion.catch(() => {});
  async function message(command: string) {
    const deadline = Date.now() + 5000;
    while (!messages.some((value) => value.command === command)) {
      if (closed) { await completion; throw new Error("Client closed before reply"); }
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, `Missing client ${command}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: () => void = () => {};
      try {
        await new Promise<void>((resolve) => { wake = resolve; waiters.push(wake); timer = setTimeout(resolve, remaining); });
      } finally {
        clearTimeout(timer);
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
      }
    }

    const reply = messages.find((value) => value.command === command);
    assert.ok(reply);
    messages.splice(messages.indexOf(reply), 1);
    return reply;
  }
  async function stop(command = "release") {
    if (!closed && child.connected) child.send(command);
    await completion;
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
    assert.ok(child.pid);
    assert.throws(() => process.kill(child.pid ?? 0, 0), { code: "ESRCH" });
  }
  t.after(() => stop());
  const allocated = await message("allocated");
  return { port: allocated.port, stop, async send(command: string) { child.send(command); return message(command); } };
}

test("automatic range parsing validates Linux and all three Darwin endpoint pairs", () => {
  assert.deepEqual(parseFixtureAutomaticRanges("linux", "32768\t60999\n"), [[32768, 60999]]);
  assert.deepEqual(parseFixtureAutomaticRanges("darwin", "49152\n65535\n49152\n65535\n1023\n600\n"), [[49152, 65535], [49152, 65535], [600, 1023]]);
  for (const [platform, output] of [["linux", ""], ["linux", "60000 30000"], ["linux", "0 60000"], ["linux", "32768 65536"],
    ["linux", "32768 60999 junk"], ["linux", "+32768 60999"], ["darwin", "1 2 3 4"], ["darwin", "1 2 3 4 0 6"], ["unknown", "1 2"]]) {
    assert.throws(() => parseFixtureAutomaticRanges(platform, output));
  }
  for (const range of [[[20000, 20000]], [[19999, 21000]], [[24095, 65535]]]) {
    assert.throws(() => validateFixturePortPool([20000, 24095], range.map(([a, b]) => [a, b])), /overlaps/);
  }
  for (const pool of [[], [0], [1023], [65536], [20000.5], [20000, 20000], Array(4097).fill(20000)]) {
    assert.throws(() => validateFixturePortPool(pool, [[32768, 60999]]), /pool/);
  }
  assert.throws(() => validateFixturePortPool([20000], []), /ranges/);
});

test("separate processes exclude claims before consumers bind and retain one through listener restart", { timeout: 15_000 }, async (t) => {
  const ctx = await context(t);
  const first = await client(t, ctx);
  const second = await client(t, ctx);
  assert.notEqual(first.port, second.port);
  await first.send("listen");
  await first.send("stop-listener");
  const third = await client(t, ctx);
  assert.notEqual(first.port, third.port);
  await first.send("listen");
  await first.send("stop-listener");
  await first.stop();
  await second.stop();
  await third.stop();
  assert.deepEqual(await fs.readdir(ctx.directory), []);
  for (const port of [first.port, second.port, third.port]) await close(await listen(port));
  t.diagnostic("three retained children exited/closed/reaped; exact listeners rebound; claims empty across restart");
});

test("promise allocations are distinct, cap at 64, and release is stable", async (t) => {
  const owner = await scope(t);
  const allocated = await Promise.all(Array.from({ length: 64 }, () => owner.allocatePort()));
  assert.equal(new Set(allocated).size, 64);
  await assert.rejects(owner.allocatePort(), /limit/);
  const released = owner.release();
  assert.equal(owner.release(), released);
  await released;
  await assert.rejects(owner.allocatePort(), /closed/);
  assert.deepEqual(await fs.readdir(owner.directory), []);
});

test("native EADDRINUSE excludes only that candidate and leaves its real holder untouched", async (t) => {
  const holder = await listen(ports[0]);
  t.after(() => close(holder));
  const owner = await scope(t, [ports[0], ports[1]]);
  assert.equal(await owner.allocatePort(), ports[1]);
  assert.equal(holder.listening, true);
  assert.deepEqual(await fs.readdir(owner.directory), [String(ports[1])]);
  await owner.release();
  assert.equal(holder.listening, true);
});

test("finite exhaustion preserves safe empty and partial foreign claims", async (t) => {
  const owner = await scope(t, [ports[0], ports[1]]);
  await fs.writeFile(path.join(owner.directory, String(ports[0])), "", { mode: 0o600 });
  await fs.writeFile(path.join(owner.directory, String(ports[1])), "partial", { mode: 0o600 });
  await assert.rejects(owner.allocatePort(), /exhausted/);
  await owner.release();
  assert.equal(await fs.readFile(path.join(owner.directory, String(ports[1])), "utf8"), "partial");
});

test("a cooperating release after EEXIST skips the vanished candidate without acquiring it", async (t) => {
  const ctx = await context(t, ports.slice(0, 2));
  const owner = await createFixturePortScope(ctx);
  const first = await owner.allocatePort();
  const contender = await createFixturePortScope(ctx);
  t.after(() => contender.abandon());
  const original = fs.lstat;
  let hits = 0;
  const patch = mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === path.join(ctx.directory, String(first)) && hits === 0) {
      hits += 1;
      await owner.release();
    }

    return original(...args);
  });
  try {
    assert.equal(await contender.allocatePort(), ports[1]);
  } finally {
    patch.mock.restore();
    await owner.abandon();
  }

  assert.equal(hits, 1);
  await contender.release();
  assert.deepEqual(await fs.readdir(ctx.directory), []);
});

test("abandoned claims are never stolen and all abandoned handles close", async (t) => {
  const owner = await scope(t, [ports[0]]);
  await owner.allocatePort();
  const abandoned = owner.abandon();
  assert.equal(owner.abandon(), abandoned);
  await abandoned;
  const contender = await createFixturePortScope(owner);
  await assert.rejects(contender.allocatePort(), /exhausted/);
  await contender.release();
  assert.equal((await fs.readdir(owner.directory)).length, 1);
});

test("release refuses a live consumer and closes handles while retaining evidence", async (t) => {
  const ctx = await context(t, [ports[0]]);
  const owner = await createFixturePortScope(ctx);
  const port = await owner.allocatePort();
  const holder = await listen(port);
  await assert.rejects(owner.release(), /still has a consumer/);
  assert.equal(holder.listening, true);
  assert.deepEqual(await fs.readdir(ctx.directory), [String(port)]);
  await close(holder);
  await close(await listen(port));
});

for (const kind of ["symlink", "directory", "hardlink", "mode", "oversize"]) {
  test(`unsafe existing ${kind} claim fails without modifying it`, async (t) => {
    const owner = await scope(t, [ports[0]]);
    const file = path.join(owner.directory, String(ports[0]));
    const target = path.join(owner.directory, "target");
    await fs.writeFile(target, "owned test target", { mode: 0o600 });
    if (kind === "symlink") await fs.symlink(target, file);
    else if (kind === "directory") await fs.mkdir(file, { mode: 0o700 });
    else if (kind === "hardlink") await fs.link(target, file);
    else await fs.writeFile(file, kind === "oversize" ? "x".repeat(66) : "", { mode: kind === "mode" ? 0o644 : 0o600 });
    await assert.rejects(owner.allocatePort(), /Unsafe/);
    assert.equal(await fs.readFile(target, "utf8"), "owned test target");
    await owner.release();
  });
}

for (const kind of ["symlink", "mode", "noncanonical", "file"]) {
  test(`unsafe ${kind} root is rejected before claims`, async (t) => {
    const ctx = await context(t);
    let directory = ctx.directory;
    if (kind === "symlink") { directory = path.join(ctx.directory, "alias"); await fs.symlink(ctx.directory, directory); }
    else if (kind === "mode") await fs.chmod(directory, 0o755);
    else if (kind === "noncanonical") directory += "/../" + path.basename(directory);
    else { directory = path.join(ctx.directory, "file"); await fs.writeFile(directory, ""); }
    await assert.rejects(createFixturePortScope({ ...ctx, directory }), /Unsafe|canonical/);
  });
}

for (const kind of ["nonce", "replaced", "mode", "hardlink", "symlink"]) {
  test(`release detects ${kind} claim substitution and retains the uncertain name`, async (t) => {
    const ctx = await context(t, [ports[0]]);
    const owner = await createFixturePortScope(ctx);
    await owner.allocatePort();
    const file = path.join(ctx.directory, String(ports[0]));
    if (kind === "nonce") await fs.writeFile(file, "x".repeat(64) + "\n");
    else if (kind === "mode") await fs.chmod(file, 0o644);
    else if (kind === "hardlink") await fs.link(file, path.join(ctx.directory, "other"));
    else {
      await fs.rename(file, path.join(ctx.directory, "original"));
      if (kind === "symlink") await fs.symlink(path.join(ctx.directory, "original"), file);
      else await fs.writeFile(file, "replacement", { mode: 0o600 });
    }
    await assert.rejects(owner.release(), /nonce|identity|Unsafe/);
    assert.ok(await fs.lstat(file));
  });
}

test("directory replacement fails allocation and abandon still closes its held directory", async (t) => {
  const ctx = await context(t);
  const owner = await createFixturePortScope(ctx);
  const moved = ctx.directory + "-moved";
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  await fs.rename(ctx.directory, moved);
  await fs.mkdir(ctx.directory, { mode: 0o700 });
  await assert.rejects(owner.allocatePort(), /identity/);
  await assert.rejects(owner.abandon(), /identity/);
  assert.deepEqual(await fs.readdir(ctx.directory), []);
});

test("release joins admitted allocations and abandon wins a simultaneous close", async (t) => {
  const owner = await scope(t, [ports[0], ports[1]]);
  const allocation = owner.allocatePort();
  const released = owner.release();
  assert.equal(owner.abandon(), released);
  const port = await allocation;
  await released;
  await assert.rejects(owner.allocatePort(), /closed/);
  assert.deepEqual(await fs.readdir(owner.directory), [String(port)]);
});

for (const code of ["EACCES", "EPERM", "EIO", "ENOSPC"]) {
  test(`${code} during exclusive creation fails instead of advancing candidates`, async (t) => {
    const owner = await scope(t);
    const original = fs.open;
    let hits = 0;
    const injected = Object.assign(new Error(`injected ${code}`), { code });
    const patch = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (typeof args[0] === "string" && path.dirname(args[0]) === owner.directory && (Number(args[1]) & constants.O_CREAT)) {
        hits += 1;
        throw injected;
      }
      return original(...args);
    });
    try { await assert.rejects(owner.allocatePort(), (error: unknown) => error === injected); } finally { patch.mock.restore(); }
    assert.equal(hits, 1);
    assert.deepEqual(await fs.readdir(owner.directory), []);
    await owner.release();
  });
}

test("failed write and close preserve both causes, close actual descriptors, and remove only own partial claim", async (t) => {
  const owner = await scope(t, [ports[0]]);
  const original = fs.open;
  const writeFailure = new Error("injected write EIO");
  const closeFailure = new Error("injected close EIO");
  let closed = 0;
  const patch = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (typeof args[0] === "string" && path.dirname(args[0]) === owner.directory) {
      mock.method(handle, "writeFile", async () => { throw writeFailure; });
      const closeHandle = handle.close.bind(handle);
      mock.method(handle, "close", async () => { await closeHandle(); closed += 1; throw closeFailure; });
    }
    return handle;
  });
  try {
    await assert.rejects(owner.allocatePort(), (error: unknown) => error instanceof AggregateError && error.errors.includes(writeFailure) && error.errors.includes(closeFailure));
  } finally { patch.mock.restore(); }
  assert.equal(closed, 1);
  assert.deepEqual(await fs.readdir(owner.directory), []);
  await owner.release();
});

for (const boundary of ["release-claim", "release-directory", "abandon-claim", "abandon-directory", "allocation-write", "allocation-stat", "setup-directory"] as const) {
  test(`recoverable close failure at ${boundary} disposes the native handle and preserves the failure`, async (t) => {
    const ctx = await context(t, ports.slice(0, 2));
    const originalOpen = fs.open;
    const nativeCloses = new Map<fs.FileHandle, () => Promise<void>>();
    const closeFailure = new Error("first close rejected before native closure");
    const operationFailure = new Error("setup or allocation failed");
    let target: fs.FileHandle | undefined;
    let closeCalls = 0;
    let owner: Awaited<ReturnType<typeof createFixturePortScope>> | undefined;
    const patch = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const nativeClose = handle.close.bind(handle);
      nativeCloses.set(handle, nativeClose);
      const isDirectory = args[0] === ctx.directory;
      if (!target && isDirectory === boundary.endsWith("directory")) {
        target = handle;
        if (boundary === "allocation-write") mock.method(handle, "writeFile", async () => { throw operationFailure; });
        if (boundary === "allocation-stat" || boundary === "setup-directory") {
          const nativeStat = handle.stat.bind(handle);
          let calls = 0;
          mock.method(handle, "stat", (...statArgs: Parameters<typeof handle.stat>) => {
            if (++calls === 1) return Promise.reject(operationFailure);

            return nativeStat(...statArgs);
          });
        }

        mock.method(handle, "close", async () => {
          if (++closeCalls === 1) throw closeFailure;

          await nativeClose();
        });
      }

      return handle;
    });
    try {
      const compound = (error: unknown) => error instanceof AggregateError && error.errors.includes(operationFailure) && error.errors.includes(closeFailure);
      if (boundary === "setup-directory") {
        await assert.rejects(createFixturePortScope(ctx), compound);
      } else {
        owner = await createFixturePortScope(ctx);
        if (boundary.startsWith("allocation-")) {
          await assert.rejects(owner.allocatePort(), compound);
          await owner.release();
        } else {
          await owner.allocatePort();
          const completion = boundary.startsWith("abandon-") ? owner.abandon() : owner.release();
          await assert.rejects(completion, (error: unknown) => error === closeFailure);
          assert.equal(owner.abandon(), completion);
        }
      }

      assert.ok(target);
      assert.equal(closeCalls, 2, "one bounded disposal follows a pre-close rejection");
      assert.equal(target.fd, -1);
      await assert.rejects(target.stat(), { code: "EBADF" });
      assert.ok([...nativeCloses.keys()].every((handle) => handle.fd === -1));
    } finally {
      patch.mock.restore();
      await owner?.abandon().catch(() => {});
      for (const [handle, closeHandle] of nativeCloses) {
        if (handle.fd !== -1) await closeHandle();
      }
    }
  });
}

test("a second disposal rejection preserves both close failures and still disposes other handles", async (t) => {
  const ctx = await context(t, ports.slice(0, 2));
  const originalOpen = fs.open;
  const nativeCloses = new Map<fs.FileHandle, () => Promise<void>>();
  const firstFailure = new Error("first close failure");
  const secondFailure = new Error("second close failure after native disposal");
  let target: fs.FileHandle | undefined;
  let calls = 0;
  let owner: Awaited<ReturnType<typeof createFixturePortScope>> | undefined;
  const patch = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const nativeClose = handle.close.bind(handle);
    nativeCloses.set(handle, nativeClose);
    if (!target && args[0] !== ctx.directory) {
      target = handle;
      mock.method(handle, "close", async () => {
        if (++calls === 1) throw firstFailure;

        await nativeClose();
        throw secondFailure;
      });
    }

    return handle;
  });
  try {
    owner = await createFixturePortScope(ctx);
    await Promise.all([owner.allocatePort(), owner.allocatePort()]);
    const completion = owner.release();
    await assert.rejects(completion, (error: unknown) => error instanceof AggregateError && error.errors.includes(firstFailure) && error.errors.includes(secondFailure));
    assert.equal(owner.abandon(), completion);
    assert.equal(calls, 2);
    assert.ok(target);
    await assert.rejects(target.stat(), { code: "EBADF" });
    assert.ok([...nativeCloses.keys()].every((handle) => handle.fd === -1));
    assert.deepEqual(await fs.readdir(ctx.directory), []);
  } finally {
    patch.mock.restore();
    await owner?.abandon().catch(() => {});
    for (const [handle, closeHandle] of nativeCloses) {
      if (handle.fd !== -1) await closeHandle();
    }
  }
});

test("probe permission and close failures remain failures, with no candidate advance", async (t) => {
  const owner = await scope(t);
  const original = net.createServer;
  let probes = 0;
  const failure = Object.assign(new Error("injected probe EPERM"), { code: "EPERM" });
  const patch = mock.method(net, "createServer", () => {
    const server = original();
    probes += 1;
    mock.method(server, "listen", () => { queueMicrotask(() => server.emit("error", failure)); return server; });
    return server;
  });
  try { await assert.rejects(owner.allocatePort(), (error: unknown) => error === failure); } finally { patch.mock.restore(); }
  assert.equal(probes, 1);
  assert.deepEqual(await fs.readdir(owner.directory), []);
  const closeFailure = new Error("injected native close failure");
  const closePatch = mock.method(net, "createServer", () => {
    const server = original();
    const closeServer = server.close.bind(server);
    mock.method(server, "close", (callback?: (error?: Error) => void) => closeServer(() => callback?.(closeFailure)));
    return server;
  });
  try { await assert.rejects(owner.allocatePort(), (error: unknown) => error === closeFailure); } finally { closePatch.mock.restore(); }
  assert.deepEqual(await fs.readdir(owner.directory), []);
  await owner.release();
});

test("unknown host discovery output fails setup without a guessed range", async (t) => {
  const ctx = await context(t);
  if (process.platform !== "linux") return;

  const original = fs.readFile;
  const patch = mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === "/proc/sys/net/ipv4/ip_local_port_range") return Promise.resolve("unknown");
    return original(...args);
  });
  try { await assert.rejects(createFixturePortScope(ctx), /Invalid automatic/); } finally { patch.mock.restore(); }
  assert.deepEqual(await fs.readdir(ctx.directory), []);
});

test("repeated release and abandonment close every retained file and directory descriptor", async (t) => {
  const ctx = await context(t);
  const original = fs.open;
  const live = new Set<fs.FileHandle>();
  const patch = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    live.add(handle);
    const closeHandle = handle.close.bind(handle);
    mock.method(handle, "close", async () => { await closeHandle(); assert.equal(live.delete(handle), true); });
    return handle;
  });
  try {
    for (let index = 0; index < 12; index += 1) {
      const owner = await createFixturePortScope(ctx);
      await owner.allocatePort();
      if (index % 2) await owner.abandon();
      else await owner.release();
      assert.equal(live.size, 0);
    }
  } finally { patch.mock.restore(); }
  assert.equal((await fs.readdir(ctx.directory)).length, 6);
});

for (const kind of ["root", "claim"]) {
  test(`wrong-owner ${kind} metadata is rejected at its filesystem boundary`, async (t) => {
    const ctx = await context(t, [ports[0]]);
    const owner = kind === "claim" ? await createFixturePortScope(ctx) : undefined;
    const file = path.join(ctx.directory, String(ports[0]));
    if (owner) await fs.writeFile(file, "", { mode: 0o600 });
    const original = fs.lstat;
    const patch = mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const result = await original(...args);
      if (args[0] === (kind === "root" ? ctx.directory : file)) Object.defineProperty(result, "uid", { value: Number(result.uid) + 1 });
      return result;
    });
    try {
      if (owner) await assert.rejects(owner.allocatePort(), /Unsafe/);
      else await assert.rejects(createFixturePortScope(ctx), /Unsafe/);
    } finally { patch.mock.restore(); }
    await owner?.release();
  });
}

test("release attempts every claim and closes all handles after an unlink error", async (t) => {
  const ctx = await context(t, [ports[0], ports[1]]);
  const originalOpen = fs.open;
  const originalUnlink = fs.unlink;
  const live = new Set<fs.FileHandle>();
  const opens = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    live.add(handle);
    const closeHandle = handle.close.bind(handle);
    mock.method(handle, "close", async () => { await closeHandle(); assert.equal(live.delete(handle), true); });
    return handle;
  });
  const failure = Object.assign(new Error("injected unlink EIO"), { code: "EIO" });
  let removals = 0;
  const unlinks = mock.method(fs, "unlink", async (file: Parameters<typeof fs.unlink>[0]) => {
    removals += 1;
    if (file === path.join(ctx.directory, String(ports[0]))) throw failure;
    return originalUnlink(file);
  });
  try {
    const owner = await createFixturePortScope(ctx);
    await Promise.all([owner.allocatePort(), owner.allocatePort()]);
    await assert.rejects(owner.release(), (error: unknown) => error === failure);
    assert.equal(live.size, 0);
    assert.equal(removals, 2);
    assert.deepEqual(await fs.readdir(ctx.directory), [String(ports[0])]);
  } finally { opens.mock.restore(); unlinks.mock.restore(); }
});

test("actual host range overlap fails before opening a scope directory", async (t) => {
  const ctx = await context(t);
  if (process.platform !== "linux") return;

  const original = fs.readFile;
  const patch = mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === "/proc/sys/net/ipv4/ip_local_port_range") return Promise.resolve(`${Math.min(...ports)} ${Math.max(...ports)}\n`);
    return original(...args);
  });
  try { await assert.rejects(createFixturePortScope(ctx), /overlaps/); } finally { patch.mock.restore(); }
  assert.deepEqual(await fs.readdir(ctx.directory), []);
});
