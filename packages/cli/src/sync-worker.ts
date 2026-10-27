import { isRouteDue } from "./sync-ledger-policy";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createStorageCounters, DurableFiles, acquireSyncOwnership, readSyncOwnership, processStart } from "./sync-files";
import { assertManagedLifecycle } from "./sync-lifecycle";
import { createSyncIngestionServer } from "./sync-http-server";
import { reconcileSyncRoutes, routeAuthorization, type RouteReconciliation } from "./sync-reconciliation";
import { assertExactKeys, parseArray, parseInteger, parseObject, parseUuid } from "./sync-model";
import { defaultRuntimeConfig, readRuntimeFile, resolveRuntimeCredentials } from "./sync-runtime-config";
import { ManagedSyncStore } from "./sync-store";
import { acquireWorkerExclusion, inspectWorkerOwner, matchesWorkerToken, readWorkerRecordOffline, workerPaths, type WorkerRecord } from "./sync-worker-records";

export interface WorkerRunRequest {
  ticketId: string;
  routeIds?: string[];
  deadlineAt: number;
  requestMs: number;
}

interface RunTicket extends WorkerRunRequest {
  controller: AbortController;
  state: "queued" | "running" | "complete" | "cancelled";
  routes: RouteReconciliation[];
  error: string | null;
}

export interface WorkerTestHooks {
  wallNow?: () => number;
  monotonicNow?: () => number;
  onEvent?: (event: { type: "ready" | "pass" | "gap" | "closed"; processId: string }) => void;
}

export function parseWorkerRun(value: unknown): WorkerRunRequest {
  const run = parseObject(value, "worker run request");
  assertExactKeys(run, Object.hasOwn(run, "routeIds") ? ["ticketId", "routeIds", "deadlineAt", "requestMs"] : ["ticketId", "deadlineAt", "requestMs"]);
  const routeIds = run.routeIds === undefined ? undefined : parseArray(run.routeIds, parseUuid, 128);
  if (routeIds && (!routeIds.length || new Set(routeIds).size !== routeIds.length)) {
    throw new Error("Worker run requires distinct explicit route IDs");
  }

  return { ticketId: parseUuid(run.ticketId), ...(routeIds ? { routeIds } : {}), deadlineAt: parseInteger(run.deadlineAt, 1), requestMs: parseInteger(run.requestMs, 100, 30_000) };
}

/** The lifetime lock owns every locally initiated sync request, including explicit one-shot runs. */
export async function startOwnedSyncWorker(home: string, options: { temporary?: boolean; testHooks?: WorkerTestHooks; onFatalStop?: () => void } = {}) {
  let fatalStopped = false;
  function notifyFatalStop() {
    if (fatalStopped) {
      return;
    }

    fatalStopped = true;
    try {
      void Promise.resolve(options.onFatalStop?.()).catch(() => {});
    } catch {
      // The observer cannot prevent startup cleanup or runtime shutdown.
    }
  }

  const initial = await assertManagedLifecycle(home);
  if (!initial || !options.temporary && !initial.worker.enabled) {
    throw new Error("Worker start requires an enrolled, explicitly enabled inbox");
  }

  const paths = workerPaths(home);
  const files = new DurableFiles(createStorageCounters(), {}, home);
  await files.directory(paths.directory);
  let startupExclusion: Awaited<ReturnType<typeof acquireWorkerExclusion>> | undefined;
  const inheritedToken = process.env.HTML_INBOX_SYNC_START_LOCK;
  delete process.env.HTML_INBOX_SYNC_START_LOCK;
  if (inheritedToken) {
    const owner = await readSyncOwnership(paths.startup);
    if (!process.send || !owner || owner.token !== inheritedToken || owner.pid !== process.ppid || owner.start !== await processStart(process.ppid)) {
      throw new Error("Worker inherited startup ownership is invalid");
    }
  } else {
    startupExclusion = await acquireWorkerExclusion(home);
  }

  let ownership: Awaited<ReturnType<typeof acquireSyncOwnership>>;
  try {
    const previous = await inspectWorkerOwner(home);

    if (previous.state === "owned") {
      throw new Error("An owned worker is already running");
    }

    ownership = await acquireSyncOwnership(paths.lifetime, Date.now() + 1000);
  } catch (error) {
    try {
      await releaseStartupExclusion();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Worker acquisition and startup cleanup failed");
    }

    throw error;
  }
  const store = new ManagedSyncStore(home);
  const tickets = new Map<string, RunTicket>();
  const stopController = new AbortController();
  let record: WorkerRecord | undefined;
  let ingestion: ReturnType<typeof createSyncIngestionServer> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: { routeId: string; controller: AbortController; done: Promise<void> } | undefined;
  let draining: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let backgroundRequested = !options.temporary;
  let lastPassAt = 0;
  let controlOrigin = "";
  const wallNow = options.testHooks?.wallNow ?? Date.now;
  const monotonicNow = options.testHooks?.monotonicNow ?? (() => performance.now());
  let lastWall = wallNow();
  let lastMonotonic = monotonicNow();
  const controlToken = randomBytes(32).toString("base64url");
  const control = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1 }, (request, response) => {
    void handleControl(request, response);
  });
  control.maxConnections = 16;
  control.on("clientError", (_error, socket) => socket.destroy());
  const onSignal = () => { requestClose(); };

  try {
    await store.recover();
    const ledger = await store.snapshot();
    const config = ledger.runtime?.config ?? defaultRuntimeConfig();
    const credentials = await resolveRuntimeCredentials(config, Object.values(ledger.routes));
    if (config.listener) {
      const tls = config.tls[config.listener.tlsRef];
      if (!tls) {
        throw new Error("Missing configured listener TLS files");
      }

      const key = await readRuntimeFile(tls.key, 128 * 1024, true);
      const cert = await readRuntimeFile(tls.cert, 128 * 1024, false);
      ingestion = createSyncIngestionServer({ store, peerId: ledger.inboxId, credentials, key, cert,
        host: config.listener.host, port: config.listener.port, requestMs: config.timings.requestMs, runtimeRevision: ledger.runtime?.revision ?? 0 });
      await ingestion.start();
    }

    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(0, "127.0.0.1", () => { control.off("error", reject); resolve(); });
    });
    const address = control.address();
    if (!address || typeof address === "string") {
      throw new Error("Worker control listener has no address");
    }

    controlOrigin = `http://127.0.0.1:${address.port}`;
    record = { schemaVersion: 1, inboxId: ledger.inboxId, storageIncarnation: ledger.storageIncarnation, ownerAnchor: ledger.ownerAnchor,
      processId: ownership.owner.token, pid: process.pid, start: ownership.owner.start, controlOrigin, controlToken,
      startedAt: Date.now(), configRevision: ledger.runtime?.revision ?? 0 };
    await files.replaceLedger(paths.record, record);
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    timer = setInterval(() => { void tick().catch(fatalStop); }, 250);
    options.testHooks?.onEvent?.({ type: "ready", processId: record.processId });
    kick();
    await releaseStartupExclusion();
    startupExclusion = undefined;

    return { record, requestRun, cancel, requestWake, quiesce, status, close, tick };
  } catch (error) {
    const cleanup = await Promise.allSettled([close(), releaseStartupExclusion()]);
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) {
      throw new AggregateError([error, ...failures], "Worker startup and cleanup failed");
    }

    throw error;
  }

  async function releaseStartupExclusion() {
    const failures: unknown[] = [];
    try { await startupExclusion?.release(); } catch (error) { failures.push(error); notifyFatalStop(); }
    try { await startupExclusion?.closeHandles(); } catch (error) {
      if (!failures.includes(error)) failures.push(error);
      notifyFatalStop();
    }

    if (failures.length > 1) throw new AggregateError(failures, "Worker startup ownership cleanup failed");
    if (failures.length === 1) throw failures[0];
  }

  function requestClose() {
    void close().catch(fatalStop);
  }

  function fatalStop() {
    if (fatalStopped) {
      return;
    }

    requestClose();
    notifyFatalStop();
  }

  function status() {
    return { processId: record?.processId, inboxId: record?.inboxId, storageIncarnation: record?.storageIncarnation, pid: process.pid,
      configRevision: record?.configRevision, processState: closing ? "stopping" : current ? "running-pass" : "idle",
      ingestion: ingestion ? { state: "listening", ...ingestion.status() } : { state: "disabled" },
      tickets: [...tickets.values()].map((ticket) => ({ ticketId: ticket.ticketId, state: ticket.state, routes: ticket.routes, error: ticket.error })) };
  }

  function requestRun(value: WorkerRunRequest) {
    const run = parseWorkerRun(value);
    if (closing || run.deadlineAt <= Date.now() || run.deadlineAt > Date.now() + 300_000 || tickets.size >= 32) {
      throw new Error("Worker is stopping, ticket deadline expired, or ticket capacity reached");
    }

    const previous = tickets.get(run.ticketId);
    if (previous) {
      return { ticketId: previous.ticketId, state: previous.state };
    }

    tickets.set(run.ticketId, { ...run, controller: new AbortController(), state: "queued", routes: [], error: null });
    kick();
    return { ticketId: run.ticketId, state: "queued" };
  }

  function cancel(ticketId: string) {
    const ticket = tickets.get(parseUuid(ticketId));
    if (ticket && (ticket.state === "queued" || ticket.state === "running")) {
      ticket.state = "cancelled";
      ticket.controller.abort(new Error("Foreground ticket cancelled; durable retries remain enabled"));
    }

    return { ticketId, cancelled: ticket?.state === "cancelled" };
  }

  function requestWake() {
    backgroundRequested = true;
    kick();
    return { coalesced: true };
  }

  function kick() {
    if (!draining && !closing) {
      draining = drain().catch(async () => {
        lastPassAt = Date.now();
        backgroundRequested = false;
        for (const ticket of tickets.values()) {
          if (ticket.state === "running" || ticket.state === "queued") {
            ticket.state = "complete";
            ticket.error = "worker-pass-failed";
          }
        }

        try {
          await store.recordWorkerRun(lastPassAt, "worker-pass-failed");
        } catch {
          // Shutdown awaits this drain; initiating it here must not await it.
          fatalStop();
        }
      }).finally(() => {
        draining = undefined;
        if (!closing && ([...tickets.values()].some((entry) => entry.state === "queued") || backgroundRequested)) {
          kick();
        }
      });
    }
  }

  async function drain() {
    while (!closing) {
      const ticket = [...tickets.values()].find((entry) => entry.state === "queued");
      if (!ticket && !backgroundRequested) {
        return;
      }

      const ledger = await assertManagedLifecycle(home);
      if (!ledger || ledger.storageIncarnation !== record?.storageIncarnation || (ledger.runtime?.revision ?? 0) !== record?.configRevision) {
        requestClose();
        return;
      }

      const config = ledger.runtime?.config ?? defaultRuntimeConfig();
      if (!ticket) {
        backgroundRequested = false;
      }

      if (ledger.worker.retryPaused || !ticket && !ledger.worker.enabled) {
        if (ticket) {
          ticket.state = "complete";
          ticket.error = ledger.worker.retryPaused ? "retries-paused" : "worker-disabled";
        }

        continue;
      }

      if (ticket) {
        ticket.state = "running";
      }

      const deadlineAt = Math.min(ticket?.deadlineAt ?? Date.now() + config.timings.passMs, Date.now() + config.timings.passMs);
      const routeIds = ticket?.routeIds ?? Object.values(ledger.routes).filter((route) => route.state === "active" || route.state === "reconnecting").map((route) => route.id);
      options.testHooks?.onEvent?.({ type: "pass", processId: ownership.owner.token });
      for (const routeId of routeIds) {
        if (closing || ticket?.controller.signal.aborted || Date.now() >= deadlineAt) {
          break;
        }

        const latest = await store.snapshot();
        const route = latest.routes[routeId];
        if (!route || latest.worker.retryPaused || route.state !== "active" && route.state !== "reconnecting") {
          continue;
        }

        if (!isRouteDue(latest, route, Date.now())) {
          continue;
        }

        const credentials = await resolveRuntimeCredentials(latest.runtime?.config ?? defaultRuntimeConfig(), [route]);
        if (credentials.unavailableRouteIds.includes(routeId)) {
          await store.recordRouteRun(routeAuthorization(route), "runtime-credential-unavailable", true);
          if (ticket) {
            ticket.error = "runtime-credential-unavailable";
          }

          continue;
        }

        const controller = new AbortController();
        const abortRoute = () => controller.abort(new Error("Worker route attempt cancelled"));
        stopController.signal.addEventListener("abort", abortRoute, { once: true });
        ticket?.controller.signal.addEventListener("abort", abortRoute, { once: true });
        if (stopController.signal.aborted || ticket?.controller.signal.aborted) {
          abortRoute();
        }

        const signal = controller.signal;
        const done = reconcileSyncRoutes({ store, peerId: latest.inboxId, credentials, routeIds: [routeId], signal, deadlineAt,
          deadlineMs: config.timings.passMs, requestMs: Math.min(ticket?.requestMs ?? config.timings.requestMs, Math.max(1, deadlineAt - Date.now())),
          retryMinMs: 1000, retryMaxMs: 300_000, maxAttempts: 20 }).then(async (result) => {
          ticket?.routes.push(...result.routes);
          const routeResult = result.routes[0];
          if (routeResult && routeResult.status !== "aborted" && !signal.aborted) {
            await store.recordRouteRun(routeAuthorization(route), routeResult.lastError, routeResult.status === "blocked");
          }
        });
        current = { routeId, controller, done };
        try {
          await done;
        } catch {
          if (ticket) {
            ticket.error = signal.aborted ? "cancelled" : "worker-pass-failed";
          }
        } finally {
          stopController.signal.removeEventListener("abort", abortRoute);
          ticket?.controller.signal.removeEventListener("abort", abortRoute);
          current = undefined;
        }
      }

      lastPassAt = Date.now();
      await store.recordWorkerRun(lastPassAt, ticket?.error ?? null);
      if (ticket && ticket.state === "running") {
        ticket.state = "complete";
      }

      for (const [id, completed] of tickets) {
        if ((completed.state === "complete" || completed.state === "cancelled") && completed.deadlineAt + 60_000 < Date.now()) {
          tickets.delete(id);
        }
      }
    }
  }

  async function tick() {
    if (closing) {
      return;
    }

    const wall = wallNow();
    const monotonic = monotonicNow();
    const gap = wall - lastWall > 2000 || monotonic - lastMonotonic > 2000 || Math.abs(wall - lastWall - (monotonic - lastMonotonic)) > 1000;
    lastWall = wall;
    lastMonotonic = monotonic;
    const ledger = await store.snapshot();
    const now = Date.now();
    const retryDue = Object.values(ledger.routes).some((route) => {
      if (route.state !== "active" && route.state !== "reconnecting") {
        return false;
      }

      return isRouteDue(ledger, route, now) && (!!ledger.routeRetries[route.id]?.nextAttemptAt ||
        Object.values(ledger.outbox).some((entry) => entry.routeId === route.id && entry.revision === route.revision && entry.disposition === "pending" && entry.nextAttemptAt <= now));
    });
    if (!options.temporary && ledger.worker.enabled && !ledger.worker.retryPaused &&
        (gap || retryDue || now - lastPassAt >= (ledger.runtime?.config.timings.reconcileMs ?? 30_000))) {
      if (gap) {
        options.testHooks?.onEvent?.({ type: "gap", processId: ownership.owner.token });
      }

      requestWake();
    }
  }

  async function quiesce(routeId?: string) {
    const active = current;
    if (active && (routeId === undefined || active.routeId === routeId)) {
      active.controller.abort(new Error("Local route admission was fenced"));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([active.done.catch(() => {}), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Route did not quiesce within request bound")), 6000);
        })]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    if (routeId) {
      await store.quiesceRoute(routeId);
      ingestion?.invalidateRoute(routeId);
    }

    return { quiesced: true };
  }

  function close(): Promise<void> {
    return closing ??= (async () => {
      if (timer) {
        clearInterval(timer);
      }

      stopController.abort(new Error("Worker stopping"));
      for (const ticket of tickets.values()) {
        cancel(ticket.ticketId);
      }

      const failures: unknown[] = [];
      const listeners = await Promise.allSettled([
        (async () => { await ingestion?.close(); })().catch((error: unknown) => { fatalStop(); throw error; }),
        (async () => { control.closeAllConnections(); })().catch((error: unknown) => { fatalStop(); throw error; }),
        (async () => {
          if (control.listening) {
            await new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
          }
        })().catch((error: unknown) => { fatalStop(); throw error; }),
      ]);
      for (const result of listeners) {
        if (result.status === "rejected") failures.push(result.reason);
      }

      try {
        await draining;
      } catch (error) {
        failures.push(error);
        fatalStop();
      }

      // Failed listener/drain cleanup cannot prove that replication has stopped.
      // Retain ownership evidence rather than allowing another worker to act.
      let releaseAttempted = false;
      if (!failures.length) {
        try {
          if (record && (await readWorkerRecordOffline(home))?.processId === record.processId) {
            await rm(paths.record);
          }

          releaseAttempted = true;
          await ownership.release();
        } catch (error) {
          failures.push(error);
          fatalStop();
        }
      }

      if (!releaseAttempted) {
        try {
          await ownership.closeHandles();
        } catch (error) {
          failures.push(error);
          fatalStop();
        }
      }

      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      try {
        options.testHooks?.onEvent?.({ type: "closed", processId: ownership.owner.token });
      } catch (error) {
        failures.push(error);
        fatalStop();
      }

      if (failures.length === 1) {
        throw failures[0];
      }

      if (failures.length) {
        throw new AggregateError(failures, "Worker cleanup failed");
      }
    })();
  }

  async function handleControl(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      if (request.method !== "POST" || request.url !== "/control" || request.headers.host !== new URL(controlOrigin).host || request.headers.origin ||
          !matchesWorkerToken(typeof request.headers["x-html-inbox-worker"] === "string" ? request.headers["x-html-inbox-worker"] : undefined, controlToken) ||
          request.headers["transfer-encoding"] || request.headers["content-encoding"] || Number(request.headers["content-length"]) > 8192) {
        response.writeHead(403).end();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 8192) {
          throw new Error("Control body exceeds limit");
        }

        chunks.push(bytes);
      }

      const command = parseObject(JSON.parse(Buffer.concat(chunks).toString("utf8")), "worker control command");
      assertExactKeys(command, ["processId", "inboxId", "storageIncarnation", "operation", "argument"]);
      if (!record || command.processId !== record.processId || command.inboxId !== record.inboxId || command.storageIncarnation !== record.storageIncarnation) {
        response.writeHead(409).end();
        return;
      }

      await assertManagedLifecycle(home);
      let result: unknown;
      switch (command.operation) {
        case "status": result = status(); break;
        case "run": result = requestRun(parseWorkerRun(command.argument)); break;
        case "wake": result = requestWake(); break;
        case "cancel": result = cancel(parseUuid(command.argument)); break;
        case "quiesce": result = await quiesce(command.argument === null ? undefined : parseUuid(command.argument)); break;
        case "stop": result = { stopping: true }; break;
        default: throw new Error("Unsupported worker control operation");
      }

      if (command.operation === "stop") {
        response.once("finish", requestClose);
      }

      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
    } catch {
      response.writeHead(409).end(JSON.stringify({ error: "worker-control-rejected" }));
    }
  }
}
