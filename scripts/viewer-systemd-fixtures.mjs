import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function withViewerSystemdFixture(supervised, exercise, {
  createHome = () => mkdtemp(path.join(tmpdir(), "html-inbox-scope-")),
  findPort = availablePort,
  stopUnit = stopTestUnit,
  removeHome = (home) => rm(home, { recursive: true, force: true }),
  ownerExitTimeoutMs = 10_000,
} = {}) {
  const home = await createHome();
  let scope;
  let service;
  let ownerExit;
  let hasFailed = false;
  let primaryFailure;

  try {
    scope = `html-inbox-test-${randomUUID()}.scope`;
    service = `html-inbox-test-${randomUUID()}.service`;
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("HTML_INBOX_")) delete environment[key];
    }

    environment.HTML_INBOX_HOME = home;
    environment.HTML_INBOX_PORT = String(await findPort());
    const watchOwner = (owner) => {
      ownerExit = once(owner, "exit");
      // Observe spawn errors immediately, even while readiness is being polled.
      void ownerExit.catch(() => {});

      return ownerExit;
    };

    await exercise({ home, scope, service, environment, watchOwner });
  } catch (error) {
    hasFailed = true;
    primaryFailure = error;
  }

  // Only a launched owner can have created these uniquely named test units.
  const units = ownerExit ? [scope, ...(supervised ? [service] : [])] : [];
  const cleanup = await Promise.allSettled(units.map(async (unit) => stopUnit(unit)));
  const cleanupErrors = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);

  try {
    if (ownerExit) await waitForOwnerExit(ownerExit, ownerExitTimeoutMs);
  } catch (error) {
    cleanupErrors.push(error);
  }

  try {
    await removeHome(home);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length) {
    throw new AggregateError(
      hasFailed ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
      "Synthetic systemd probe cleanup failed",
      hasFailed ? { cause: primaryFailure } : undefined,
    );
  }

  if (hasFailed) {
    throw primaryFailure;
  }
}

async function waitForOwnerExit(ownerExit, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      ownerExit,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Synthetic scope owner exit timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopTestUnit(unit) {
  try {
    await run("systemctl", ["--user", "stop", unit], { timeout: 10_000, maxBuffer: 128 * 1024 });
  } catch (error) {
    if (!/not loaded|not found|does not exist/i.test(error.stderr ?? "")) throw error;
  }
}

async function availablePort() {
  const server = http.createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    return server.address().port;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
