import { AsyncLocalStorage } from "node:async_hooks";
import { constants, lstatSync, realpathSync, writeSync, type BigIntStats, type Stats } from "node:fs";
import filesystem, { type FileHandle } from "node:fs/promises";
import Module from "node:module";
import path from "node:path";

export const VIEWER_READ_OBSERVATION_PREFIX = "html-inbox-viewer-read-observation-v1 ";

type ObservationStatus = "ok" | "cap-hit" | "observation-error";
type StopPhase = "initial-status" | "record-recheck" | "record-cleanup" | "record-removal-read" | "unknown";
type FailureCategory = "viewer-record-retry-exhausted" | "private-file-guard" | "native-io-error" | "record-read-error";
interface Metadata {
  isFile: boolean; isSymbolicLink: boolean;
  uid: number; currentUid: number; mode: number; dev: number; ino: number; nlink: number; size: number;
}
interface Callsite {
  module: "viewer-server" | "viewer-status" | "viewer-records";
  operation: "stopViewer" | "getViewerStatus" | "waitForViewerRecordCleanup" | "removeViewerRecord";
  line: number; column: number;
}
export interface ViewerReadObservation {
  logicalReadId: number;
  recordKind: "viewer.json" | "viewer-config.json";
  stopPhase: StopPhase;
  callsite?: Callsite;
  failureCategory?: FailureCategory;
  attempts: {
    attempt: number; openId?: number; nativeOpenFlags?: number;
    openOutcome: "not-opened" | "pending" | "opened" | "absent" | "error";
    nativeStat?: Metadata; checkedLstat?: Metadata | "absent"; currentLstat?: Metadata | "absent";
    errorCode?: string;
    closeOutcome: "not-opened" | "pending" | "closed" | "close-error";
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadata(value: unknown): Metadata | undefined {
  if (!isRecord(value) || typeof value.isFile !== "boolean" || typeof value.isSymbolicLink !== "boolean" ||
      typeof value.uid !== "number" || typeof value.currentUid !== "number" || typeof value.mode !== "number" ||
      typeof value.dev !== "number" || typeof value.ino !== "number" || typeof value.nlink !== "number" || typeof value.size !== "number" ||
      ![value.uid, value.currentUid, value.mode, value.dev, value.ino, value.nlink, value.size].every(Number.isFinite)) {
    return undefined;
  }

  return { isFile: value.isFile, isSymbolicLink: value.isSymbolicLink, uid: value.uid, currentUid: value.currentUid,
    mode: value.mode, dev: value.dev, ino: value.ino, nlink: value.nlink, size: value.size };
}

function nativeMetadata(info: Stats | BigIntStats) {
  return metadata({ isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink(), uid: info.uid,
    currentUid: process.getuid?.(), mode: info.mode, dev: info.dev, ino: info.ino, nlink: info.nlink, size: info.size });
}

function errorCode(error: unknown) {
  const code = isRecord(error) ? error.code : undefined;
  return ["ENOENT", "ELOOP", "EACCES", "EPERM", "EBADF", "EIO", "EINVAL", "ENOSPC", "EMFILE", "ENFILE", "EBUSY"].find((known) => known === code) ?? "OTHER";
}

export function recordViewerReadClose(read: ViewerReadObservation, openId: number, outcome: "closed" | "close-error") {
  const sample = read.attempts.find((attempt) => attempt.openId === openId);
  if (!sample) return false;

  sample.closeOutcome = outcome;
  return true;
}

export function serializeViewerReadFailure(authorPid: number, exitCode: number, value: unknown, status: ObservationStatus = "ok") {
  if (exitCode === 0) return "";

  const read = isRecord(value) ? value : undefined;
  const candidates: unknown[] = read && Array.isArray(read.attempts) ? read.attempts : [];
  if (candidates.length > 4) status = "cap-hit";
  const attempts = candidates.slice(0, 4).map((entry: unknown) => {
    const sample = isRecord(entry) ? entry : {};
    const stat = metadata(sample.nativeStat);
    const checked = sample.checkedLstat === "absent" ? "absent" : metadata(sample.checkedLstat);
    const current = sample.currentLstat === "absent" ? "absent" : metadata(sample.currentLstat);
    const openOutcome = ["not-opened", "pending", "opened", "absent", "error"].find((known) => known === sample.openOutcome);
    const closeOutcome = ["not-opened", "pending", "closed", "close-error"].find((known) => known === sample.closeOutcome);
    if (typeof sample.attempt !== "number" || !Number.isSafeInteger(sample.attempt) || !openOutcome || !closeOutcome ||
        sample.openId !== undefined && (typeof sample.openId !== "number" || !Number.isSafeInteger(sample.openId) || sample.openId < 1) ||
        sample.nativeOpenFlags !== undefined && (typeof sample.nativeOpenFlags !== "number" || !Number.isFinite(sample.nativeOpenFlags)) ||
        sample.nativeStat !== undefined && !stat || sample.checkedLstat !== undefined && !checked || sample.currentLstat !== undefined && !current) {
      status = "observation-error";
    }

    return { attempt: typeof sample.attempt === "number" ? sample.attempt : undefined,
      openId: typeof sample.openId === "number" ? sample.openId : undefined,
      nativeOpenFlags: typeof sample.nativeOpenFlags === "number" ? sample.nativeOpenFlags : undefined,
      openOutcome, nativeStat: stat, checkedLstat: checked, currentLstat: current,
      errorCode: sample.errorCode === undefined ? undefined : errorCode({ code: sample.errorCode }), closeOutcome };
  });
  const phase = ["initial-status", "record-recheck", "record-cleanup", "record-removal-read", "unknown"].find((known) => known === read?.stopPhase) ?? "unknown";
  const category = ["viewer-record-retry-exhausted", "private-file-guard", "native-io-error", "record-read-error"].find((known) => known === read?.failureCategory)
    ?? (status === "ok" ? "non-read-cli-failure" : "observer-error");
  const site = isRecord(read?.callsite) ? read.callsite : undefined;
  const siteModule = ["viewer-server", "viewer-status", "viewer-records"].find((known) => known === site?.module);
  const operation = ["stopViewer", "getViewerStatus", "waitForViewerRecordCleanup", "removeViewerRecord"].find((known) => known === site?.operation);
  const callsite = siteModule && operation && typeof site?.line === "number" && Number.isSafeInteger(site.line) && site.line > 0 &&
    typeof site.column === "number" && Number.isSafeInteger(site.column) && site.column > 0
    ? { module: siteModule, operation, line: site.line, column: site.column } : undefined;
  const complete = status === "ok" && attempts.length > 0 && attempts.every((sample, index) => sample.attempt === index + 1 &&
    sample.openOutcome !== "pending" && sample.closeOutcome !== "pending" &&
    (sample.openOutcome === "not-opened" || sample.openId !== undefined && sample.nativeOpenFlags !== undefined) &&
    (sample.openOutcome !== "opened" || sample.nativeStat !== undefined || sample.errorCode !== undefined));
  const envelope = { schemaVersion: 1, kind: "viewer-stop-read-failure", authorPid, exitCode, failureCategory: category,
    recordKind: read?.recordKind === "viewer.json" || read?.recordKind === "viewer-config.json" ? read.recordKind : null,
    logicalReadId: typeof read?.logicalReadId === "number" ? read.logicalReadId : null, stopPhase: phase, callsite,
    nativeConstants: { O_NOFOLLOW: constants.O_NOFOLLOW, O_NONBLOCK: constants.O_NONBLOCK }, observerStatus: status, complete, attempts };
  const line = `${VIEWER_READ_OBSERVATION_PREFIX}${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line) <= 8192) return line;

  return `${VIEWER_READ_OBSERVATION_PREFIX}${JSON.stringify({ schemaVersion: 1, kind: "viewer-stop-read-failure",
    authorPid, exitCode, failureCategory: "observer-error", observerStatus: "cap-hit", complete: false, attempts: [] })}\n`;
}

function observationHome() {
  const args = process.argv.slice(2);
  const name = args[3];
  const root = process.env.HOME;
  if (process.argv[1] !== path.join(__dirname, "index.js") || args.length !== 5 || args[0] !== "viewer" || args[1] !== "stop" ||
      args[2] !== "--inbox" || args[4] !== "--json" || !name || !/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !root ||
      !path.isAbsolute(root) || !/^html-inbox-worker-fault-[A-Za-z0-9]+$/.test(path.basename(root)) || process.cwd() !== root ||
      process.env.HTML_INBOX_CATALOG_HOME !== path.join(root, "catalog") || realpathSync(root) !== root) return undefined;

  const home = path.join(root, name);
  for (const directory of [root, home]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync(directory) !== directory) return undefined;
  }

  return home;
}

function readerCallsite(): Callsite | undefined {
  const stack = new Error().stack?.split("\n").slice(1, 12) ?? [];
  for (const operation of ["waitForViewerRecordCleanup", "getViewerStatus", "removeViewerRecord", "stopViewer"]) {
    for (const frame of stack) {
      for (const module of ["viewer-server", "viewer-status", "viewer-records"]) {
        const marker = `${path.join(__dirname, module)}.js:`;
        if (!frame.includes(` ${operation} (`) && !frame.includes(` async ${operation} (`)) continue;
        const location = frame.split(marker)[1]?.match(/^(\d+):(\d+)\)/);
        if (!location) continue;
        if (operation === "waitForViewerRecordCleanup" && module === "viewer-server") return { module, operation, line: Number(location[1]), column: Number(location[2]) };
        if (operation === "getViewerStatus" && module === "viewer-status") return { module, operation, line: Number(location[1]), column: Number(location[2]) };
        if (operation === "removeViewerRecord" && module === "viewer-records") return { module, operation, line: Number(location[1]), column: Number(location[2]) };
        if (operation === "stopViewer" && module === "viewer-server") return { module, operation, line: Number(location[1]), column: Number(location[2]) };
      }
    }
  }

  return undefined;
}

function installObservation() {
  const authorPid = process.pid;
  let status: ObservationStatus = "ok";
  let failed: ViewerReadObservation | undefined;
  let failedError: unknown;
  const safely = (action: () => void) => { try { action(); } catch { status = "observation-error"; } };
  const observe = <T>(promise: Promise<T>, fulfilled: (value: T) => void, rejected: (error: unknown) => void) => {
    void promise.then((value) => safely(() => fulfilled(value)), (error: unknown) => safely(() => rejected(error)));
    return promise;
  };
  process.once("exit", (code) => {
    if (code === 0) return;

    try { writeSync(2, serializeViewerReadFailure(authorPid, code, failed, status)); } catch { /* Preserve the original CLI exit even if stderr is unavailable. */ }
  });

  safely(() => {
    const home = observationHome();
    if (!home) { status = "observation-error"; return; }

    const scopes = new AsyncLocalStorage<{ inStop: boolean; inStatus: boolean; read?: ViewerReadObservation }>();
    const active = new Set<ViewerReadObservation>();
    const handles = new WeakMap<FileHandle, { read: ViewerReadObservation; openId: number }>();
    let nextReadId = 0;
    let nextOpenId = 0;
    const append = (read: ViewerReadObservation) => {
      if (read.attempts.length >= 4) { status = "cap-hit"; return undefined; }

      const sample: ViewerReadObservation["attempts"][number] = { attempt: read.attempts.length + 1,
        openOutcome: "not-opened", closeOutcome: "not-opened" };
      read.attempts.push(sample);
      return sample;
    };
    const currentRead = (file: unknown) => {
      const read = scopes.getStore()?.read;
      return read && file === path.join(home, read.recordKind) ? read : undefined;
    };
    const nativeOpen = filesystem.open;
    filesystem.open = (...args) => {
      const read = currentRead(args[0]);
      const result = nativeOpen(...args);
      if (!read) return result;

      let sample = read.attempts.at(-1);
      if (!sample || sample.openId !== undefined) sample = append(read);
      const attempt = sample;
      if (!attempt) return result;

      attempt.openId = ++nextOpenId;
      attempt.nativeOpenFlags = typeof args[1] === "number" ? args[1] : undefined;
      attempt.openOutcome = "pending";
      return observe(result, (file) => {
        attempt.openOutcome = "opened";
        attempt.closeOutcome = "pending";
        if (handles.has(file) || attempt.openId === undefined) { status = "observation-error"; return; }

        handles.set(file, { read, openId: attempt.openId });
        const stat = file.stat;
        // Forward Node's overloaded stat options and its original promise without choosing a new overload.
        Object.defineProperty(file, "stat", { configurable: true, writable: true, value: (...statArgs: Parameters<FileHandle["stat"]>) => {
          const pending: ReturnType<FileHandle["stat"]> = Reflect.apply(stat, file, statArgs);
          return observe(pending, (info) => { attempt.nativeStat = nativeMetadata(info); if (!attempt.nativeStat) status = "observation-error"; },
            (error) => { attempt.errorCode = errorCode(error); });
        } });
        const close = file.close;
        file.close = () => observe(close.call(file), () => {
          const held = handles.get(file);
          if (!held || !recordViewerReadClose(held.read, held.openId, "closed")) status = "observation-error";
        }, (error) => {
          const held = handles.get(file);
          if (!held || !recordViewerReadClose(held.read, held.openId, "close-error")) status = "observation-error";
          attempt.errorCode = errorCode(error);
        });
      }, (error) => { attempt.openOutcome = errorCode(error) === "ENOENT" ? "absent" : "error"; attempt.errorCode = errorCode(error); });
    };
    const nativeLstat = filesystem.lstat;
    Object.defineProperty(filesystem, "lstat", { configurable: true, writable: true, value: (...args: Parameters<typeof nativeLstat>) => {
      const read = currentRead(args[0]);
      const result: ReturnType<typeof nativeLstat> = Reflect.apply(nativeLstat, filesystem, args);
      if (!read) return result;

      const last = read.attempts.at(-1);
      const isCurrent = last?.openId !== undefined && last.nativeStat !== undefined && last.nativeStat.nlink > 0 && last.currentLstat === undefined;
      const sample = isCurrent ? last : append(read);
      if (!sample) return result;

      return observe(result, (info) => {
        const value = nativeMetadata(info);
        if (!value) status = "observation-error";
        if (isCurrent) sample.currentLstat = value; else sample.checkedLstat = value;
      }, (error) => {
        sample.errorCode = errorCode(error);
        if (errorCode(error) === "ENOENT") {
          if (isCurrent) sample.currentLstat = "absent"; else sample.checkedLstat = "absent";
        }
      });
    } });

    // Node's CommonJS loader is an untyped external boundary; narrow its callable member and treat exports/results as unknown.
    const loader: unknown = Module;
    if ((typeof loader !== "function" && typeof loader !== "object") || loader === null || !("_load" in loader) || typeof loader._load !== "function") {
      status = "observation-error";
      return;
    }

    const load = loader._load;
    const wrapped = new WeakSet<Function>();
    loader._load = function (this: unknown, request: string, parent: NodeModule | undefined, isMain?: boolean): unknown {
      const exports: unknown = Reflect.apply(load, this, [request, parent, isMain]);
      if (!parent || typeof parent.filename !== "string" || path.dirname(parent.filename) !== __dirname || !isRecord(exports)) return exports;

      const names = request === "./viewer-server" ? ["stopViewer"] : request === "./viewer-status" ? ["getViewerStatus"]
        : request === "./viewer-records" ? ["readViewerRecord", "readSavedViewerConfiguration", "removeViewerRecord"] : [];
      safely(() => {
        for (const name of names) {
          const original = exports[name];
          if (typeof original !== "function" || wrapped.has(original) || !Object.getOwnPropertyDescriptor(exports, name)?.writable) continue;

          const replacement = function (this: unknown, ...args: unknown[]): unknown {
            if (args[0] !== home) return Reflect.apply(original, this, args);

            const parentScope = scopes.getStore();
            const scope = { inStop: name === "stopViewer" || parentScope?.inStop === true,
              inStatus: name === "getViewerStatus" || parentScope?.inStatus === true, read: parentScope?.read };
            let read: ViewerReadObservation | undefined;
            safely(() => {
              if (name === "stopViewer" || name === "getViewerStatus") return;
              scope.read = undefined;
              if (active.size >= 4) { status = "cap-hit"; return; }

              const callsite = readerCallsite();
              const stopPhase: StopPhase = name === "removeViewerRecord" ? "record-removal-read"
                : callsite?.operation === "waitForViewerRecordCleanup" ? "record-cleanup"
                : scope.inStop && scope.inStatus ? "initial-status" : callsite?.operation === "stopViewer" ? "record-recheck" : "unknown";
              read = { logicalReadId: ++nextReadId, recordKind: name === "readSavedViewerConfiguration" ? "viewer-config.json" : "viewer.json",
                stopPhase, callsite, attempts: [] };
              scope.read = read;
              active.add(read);
            });
            const result: unknown = scopes.run(scope, () => Reflect.apply(original, this, args));
            if (!(result instanceof Promise)) { status = "observation-error"; return result; }

            return observe(result, () => {
              if (read) { active.delete(read); read.attempts.length = 0; }
              if (name === "stopViewer") { failed = undefined; failedError = undefined; }
            }, (error) => {
              if (read) {
                active.delete(read);
                if (failed && failed !== read) failed.attempts.length = 0;
                read.failureCategory = error instanceof Error && error.message.includes("Viewer record changed repeatedly during read") ? "viewer-record-retry-exhausted"
                  : error instanceof Error && /regular private file|not a regular file/.test(error.message) ? "private-file-guard"
                  : errorCode(error) !== "OTHER" ? "native-io-error" : "record-read-error";
                failed = read;
                failedError = error;
              }
              if (name === "stopViewer" && failedError !== error) { failed = undefined; failedError = undefined; }
            });
          };
          wrapped.add(replacement);
          exports[name] = replacement;
        }
      });
      return exports;
    };
  });
}

// Ordinary test imports expose only the pure helpers; Node creates this parent specifically for --require.
if (module.parent?.id === "internal/preload") installObservation();
