import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import { assertExactKeys, parseInteger, parseObject, parseString, parseUuid } from "./sync-model";
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

const reconciliation: typeof import("./sync-reconciliation") = require("./sync-reconciliation");
const failure: typeof import("./sync-failure") = require("./sync-failure");
const reconcileRoutes = reconciliation.reconcileSyncRoutes;
type FailurePass = {
  routeIds: string[];
  signal?: AbortSignal;
  authorization?: unknown;
  error?: unknown;
  emitted: boolean;
  fingerprint?: ReturnType<typeof fingerprintFailure>;
  classifiedAborted?: boolean;
  classifiedReason?: boolean;
  result?: Awaited<ReturnType<typeof reconcileRoutes>>;
};
const failureScope = new AsyncLocalStorage<FailurePass>();
const failurePasses = new WeakMap<ManagedSyncStore, FailurePass>();
let failureEvents = 0;
let observationFaults = 0;

function observationFault() {
  observationFaults = Math.min(255, observationFaults + 1);
}

function fingerprintFailure(error: unknown) {
  const frames = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 13).flatMap((line) => {
    const frame = line.split(`${__dirname}${path.sep}`)[1]?.match(/^([a-z0-9-]+\.js):(\d{1,7}):(\d{1,7})/);
    return frame ? [{ module: frame[1].slice(0, 80), line: Number(frame[2]), column: Number(frame[3]) }] : [];
  }).slice(0, 4) : [];

  return {
    name: error instanceof Error && ["Error", "TypeError", "RangeError", "AggregateError", "AbortError"].includes(error.name) ? error.name : "other",
    code: error instanceof Error && "code" in error && typeof error.code === "string" && ["EIO", "ENOSPC", "ENOENT", "EACCES", "EPERM", "ABORT_ERR"].includes(error.code) ? error.code : null,
    messageSHA256: error instanceof Error ? createHash("sha256").update(error.message).digest("hex") : null,
    frames,
  };
}

reconciliation.reconcileSyncRoutes = (options) => {
  const pass: FailurePass = { routeIds: options.routeIds, signal: options.signal, emitted: false };
  failurePasses.set(options.store, pass);
  const pending = failureScope.run(pass, () => reconcileRoutes(options));
  void pending.then((result) => { pass.result = result; }, () => {}).catch(observationFault);

  return pending;
};

const classify = failure.classifySyncFailure;
failure.classifySyncFailure = (error) => {
  const result = classify(error);
  const pass = failureScope.getStore();
  if (pass && result.code === "local-validation-or-storage-failed") {
    try {
      Object.assign(pass, { error, fingerprint: undefined });
      pass.fingerprint = fingerprintFailure(error);
      pass.classifiedAborted = pass.signal?.aborted;
      pass.classifiedReason = pass.signal ? error === pass.signal.reason : undefined;
    } catch {
      observationFault();
    }
  }

  return result;
};

const openAttempt = ManagedSyncStore.prototype.openRouteAttempt;
ManagedSyncStore.prototype.openRouteAttempt = function (...args: Parameters<typeof openAttempt>) {
  const pass = failureScope.getStore();
  const pending = openAttempt.apply(this, args);
  void pending.then(() => { if (pass) pass.authorization = args[0]; }, () => {}).catch(observationFault);

  return pending;
};

function observePermanentWrite(call: "setRouteError" | "recordRouteRun", authorization: unknown, code: string | null, pass?: FailurePass) {
  if (code !== "local-validation-or-storage-failed" || failureEvents >= 4 || pass?.emitted) {
    return;
  }

  let routeId: string | null = null;
  let revision: number | null = null;
  let isMatched = false;
  try {
    const auth = parseObject(authorization, "failure authorization");
    const observed = pass?.authorization === undefined ? null : parseObject(pass.authorization, "observed authorization");
    routeId = parseUuid(auth.routeId);
    revision = parseInteger(auth.revision, 1);
    isMatched = !!pass?.fingerprint && pass.routeIds.includes(routeId) && observed?.routeId === routeId && observed.revision === revision &&
      (call === "setRouteError" || !!pass.result?.routes.some((route) => route.routeId === routeId && route.lastError === code));
  } catch {
    observationFault();
  }

  const event = {
    type: "permanent-route-failure", pid: process.pid,
    stage: stage === "created" || stage === "linked" ? stage : "unknown",
    operationId: operationId ?? null, cutHits: hits, call, routeId, revision,
    attribution: isMatched ? "same-reconciliation-error" : "unmatched", error: isMatched ? pass?.fingerprint : null,
    parentPassAbortedAtClassification: isMatched ? pass?.classifiedAborted ?? null : null,
    errorWasParentPassReason: isMatched ? pass?.classifiedReason ?? null : null,
    parentPassAbortedAtPersistence: pass?.signal?.aborted ?? null,
    errorIsParentPassReason: isMatched && pass?.signal ? pass.error === pass.signal.reason : null,
    observationFaults,
  };
  try {
    if (Buffer.byteLength(JSON.stringify(event)) > 4096) {
      observationFault();
      return;
    }

    failureEvents += 1;
    if (pass) {
      pass.emitted = true;
    }

    process.send?.(event, (error) => { if (error) observationFault(); });
  } catch {
    observationFault();
  }
}

const setRouteError = ManagedSyncStore.prototype.setRouteError;
ManagedSyncStore.prototype.setRouteError = function (...args: Parameters<typeof setRouteError>) {
  const pass = failureScope.getStore();
  const pending = setRouteError.apply(this, args);
  void pending.then(() => observePermanentWrite("setRouteError", args[0], args[1], pass), () => {}).catch(observationFault);

  return pending;
};

const recordRouteRun = ManagedSyncStore.prototype.recordRouteRun;
ManagedSyncStore.prototype.recordRouteRun = function (...args: Parameters<typeof recordRouteRun>) {
  const pass = failurePasses.get(this);
  const pending = recordRouteRun.apply(this, args);
  void pending.then(() => observePermanentWrite("recordRouteRun", args[0], args[1], pass), () => {}).catch(observationFault);

  return pending;
};

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
