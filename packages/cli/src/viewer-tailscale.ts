import http from "node:http";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./validation";
import {
  resolveTailscaleExecutable,
  runTailscale,
  type TailscaleCommandOptions,
} from "./tailscale-command";
import {
  assertSafeListener,
  getRoute,
  parseServeConfig,
  parseTailscaleNode,
  routeMatches,
  unrelatedConfig,
  type ServeConfig,
  type TailscaleNode,
} from "./tailscale-config";
import {
  assertPreparedTailscale,
  assertViewerOptions,
  readTailscaleOwnership,
  removeTailscaleOwnership,
  withTailscaleServeLock,
  writeTailscaleOwnership,
  type TailscaleOwnership,
} from "./tailscale-records";

export type { TailscaleCommandOptions } from "./tailscale-command";

export interface TailscaleViewerOptions {
  home: string;
  backendPort: number;
  instanceId: string;
  processId: string;
}

export interface PreparedTailscale extends TailscaleViewerOptions {
  nodeId: string;
  hostname: string;
  url: string;
  executable: string;
}

export interface TailscaleOwner {
  instanceId: string;
  processId: string;
}

export interface TailscaleStatus {
  state: "running" | "stopped" | "drift" | "unavailable";
  url?: string;
  hostname?: string;
  backendPort?: number;
  instanceId?: string;
  processId?: string;
  reason?: string;
}

export async function prepareTailscale(
  options: TailscaleViewerOptions,
  command: TailscaleCommandOptions = {},
): Promise<PreparedTailscale> {
  assertViewerOptions(options);
  const executable = await resolveTailscaleExecutable(command.executable);
  const node = await readNode(executable, command.timeoutMs);
  const config = await readConfig(executable, command.timeoutMs);
  const ownership = await readTailscaleOwnership(options.home);
  assertAvailableRoute(config, node, options, ownership);

  const prepared = {
    ...options,
    ...node,
    url: `https://${node.hostname}`,
    executable,
  };
  assertPreparedTailscale(prepared);

  return prepared;
}

export async function startTailscale(
  prepared: PreparedTailscale,
  command: TailscaleCommandOptions = {},
): Promise<PreparedTailscale> {
  assertPreparedTailscale(prepared);
  if (prepared.backendPort === 0) {
    throw new Error(
      "Tailscale Serve requires the reader's actual bound port; replace backendPort:0 after starting the loopback reader",
    );
  }

  const executable = await resolveTailscaleExecutable(
    command.executable ?? prepared.executable,
  );
  const actual = { ...prepared, executable };
  return withTailscaleServeLock(actual.nodeId, async () => {
    const node = await readNode(executable, command.timeoutMs);
    assertSameNode(node, actual);

    const before = await readConfig(executable, command.timeoutMs);
    const previous = await readTailscaleOwnership(actual.home);
    assertAvailableRoute(before, node, actual, previous);
    await assertAnonymousReader(actual.backendPort, actual.hostname);

    const ownership: TailscaleOwnership = {
      ...actual,
      version: 1,
      phase: "pending",
      httpsPort: 443,
      mount: "/",
      proxy: `http://127.0.0.1:${actual.backendPort}`,
    };
    await writeTailscaleOwnership(ownership);

    try {
      if (!routeMatches(before, actual.hostname, ownership.proxy)) {
        await runTailscale(
          executable,
          [
            "serve",
            "--bg",
            "--yes",
            "--https=443",
            "--set-path=/",
            ownership.proxy,
          ],
          command.timeoutMs,
        );
      }

      assertSameNode(await readNode(executable, command.timeoutMs), actual);
      const after = await readConfig(executable, command.timeoutMs);
      assertOwnedRoute(after, ownership);
      if (
        !isDeepStrictEqual(
          unrelatedConfig(before, actual.hostname),
          unrelatedConfig(after, actual.hostname),
        )
      ) {
        throw new Error(
          "Unrelated Tailscale Serve/Funnel configuration changed during startup; refusing to report a usable URL",
        );
      }

      await writeTailscaleOwnership({ ...ownership, phase: "active" });
      return actual;
    } catch (error) {
      try {
        await cleanupOwnedRoute(actual.home, ownership, command);
      } catch (cleanupError) {
        throw new Error(
          `Tailscale startup failed: ${describeError(error)}. Scoped cleanup also failed: ${describeError(cleanupError)}. Ownership journal retained; inspect tailscale serve status --json and retry viewer stop.`,
          { cause: error },
        );
      }

      throw new Error(
        `Tailscale startup failed: ${describeError(error)}. The owned route was cleaned up.`,
        { cause: error },
      );
    }
  });
}

export async function getTailscaleStatus(
  home: string,
  command: TailscaleCommandOptions = {},
): Promise<TailscaleStatus> {
  let ownership: TailscaleOwnership | undefined;
  try {
    ownership = await readTailscaleOwnership(home);
  } catch (error) {
    return { state: "drift", reason: describeError(error) };
  }

  if (!ownership) {
    return { state: "stopped" };
  }

  try {
    const executable = await resolveTailscaleExecutable(
      command.executable ?? ownership.executable,
    );
    const node = await readNode(executable, command.timeoutMs);
    if (
      node.nodeId !== ownership.nodeId ||
      node.hostname !== ownership.hostname
    ) {
      return {
        state: "drift",
        reason:
          "Connected Tailscale node identity differs from the owned route; no configuration was changed",
      };
    }

    const config = await readConfig(executable, command.timeoutMs);
    try {
      assertOwnedRoute(config, ownership);
    } catch (error) {
      return { state: "drift", reason: describeError(error) };
    }

    if (ownership.phase !== "active") {
      return {
        state: "drift",
        reason:
          "Tailscale startup is pending; retry viewer stop to recover the recorded route",
      };
    }

    return {
      state: "running",
      url: ownership.url,
      hostname: ownership.hostname,
      backendPort: ownership.backendPort,
      instanceId: ownership.instanceId,
      processId: ownership.processId,
    };
  } catch (error) {
    return { state: "unavailable", reason: describeError(error) };
  }
}

export async function cleanupTailscale(
  home: string,
  expectedOwner?: TailscaleOwner,
  command: TailscaleCommandOptions = {},
): Promise<TailscaleStatus> {
  const ownership = await readTailscaleOwnership(home);
  if (!ownership) {
    return { state: "stopped" };
  }

  return withTailscaleServeLock(ownership.nodeId, () =>
    cleanupOwnedRoute(home, expectedOwner, command),
  );
}

async function cleanupOwnedRoute(
  home: string,
  expectedOwner: TailscaleOwner | undefined,
  command: TailscaleCommandOptions,
): Promise<TailscaleStatus> {
  const ownership = await readTailscaleOwnership(home);
  if (!ownership) {
    return { state: "stopped" };
  }

  if (
    expectedOwner &&
    (ownership.instanceId !== expectedOwner.instanceId ||
      ownership.processId !== expectedOwner.processId)
  ) {
    throw new Error(
      "Tailscale ownership belongs to another viewer process; its route and journal were preserved",
    );
  }

  const executable = await resolveTailscaleExecutable(
    command.executable ?? ownership.executable,
  );
  assertSameNode(
    await readNode(executable, command.timeoutMs, false),
    ownership,
  );
  const before = await readConfig(executable, command.timeoutMs);
  if (getRoute(before, ownership.hostname) === undefined) {
    await removeTailscaleOwnership(home);
    return { state: "stopped" };
  }

  assertOwnedRoute(before, ownership);
  await runTailscale(
    executable,
    ["serve", "--bg", "--yes", "--https=443", "--set-path=/", "off"],
    command.timeoutMs,
  );

  assertSameNode(
    await readNode(executable, command.timeoutMs, false),
    ownership,
  );
  const after = await readConfig(executable, command.timeoutMs);
  if (
    getRoute(after, ownership.hostname) !== undefined ||
    !isDeepStrictEqual(
      unrelatedConfig(before, ownership.hostname),
      unrelatedConfig(after, ownership.hostname),
    )
  ) {
    throw new Error(
      "Tailscale scoped cleanup could not be verified; ownership journal retained and unrelated configuration will not be reset",
    );
  }

  await removeTailscaleOwnership(home);
  return { state: "stopped" };
}

function assertSameNode(node: TailscaleNode, expected: TailscaleNode): void {
  if (node.nodeId !== expected.nodeId || node.hostname !== expected.hostname) {
    throw new Error(
      "Connected Tailscale node identity changed; the recorded route and unrelated configuration were preserved",
    );
  }
}

function assertAvailableRoute(
  config: ServeConfig,
  node: TailscaleNode,
  options: TailscaleViewerOptions,
  ownership: TailscaleOwnership | undefined,
): void {
  assertSafeListener(config, node.hostname);
  if (ownership) {
    assertSameNode(node, ownership);
    if (ownership.instanceId !== options.instanceId) {
      throw new Error(
        "Tailscale ownership belongs to another inbox identity; inspect the private record before recovery",
      );
    }
  }

  if (getRoute(config, node.hostname) === undefined) {
    return;
  }

  if (
    !ownership ||
    !routeMatches(config, node.hostname, ownership.proxy) ||
    (options.backendPort !== 0 && ownership.backendPort !== options.backendPort)
  ) {
    throw new Error(
      "Tailscale HTTPS root route already exists or has drifted; HTML Inbox will not replace it. Inspect tailscale serve status --json and stop the recorded owner first.",
    );
  }
}

function assertOwnedRoute(
  config: ServeConfig,
  ownership: TailscaleOwnership,
): void {
  assertSafeListener(config, ownership.hostname);
  if (
    !isDeepStrictEqual(config.TCP?.["443"], { HTTPS: true }) ||
    !routeMatches(config, ownership.hostname, ownership.proxy)
  ) {
    throw new Error(
      "Tailscale owned HTTPS root route is missing or has drifted; its journal and unrelated configuration were preserved",
    );
  }
}

async function readNode(
  executable: string,
  timeoutMs?: number,
  requireServe = true,
) {
  return parseTailscaleNode(
    await runTailscale(executable, ["status", "--json"], timeoutMs),
    requireServe,
  );
}

async function readConfig(executable: string, timeoutMs?: number) {
  return parseServeConfig(
    await runTailscale(executable, ["serve", "status", "--json"], timeoutMs),
  );
}

async function assertAnonymousReader(
  port: number,
  hostname: string,
): Promise<void> {
  for (const host of [`127.0.0.1:${port}`, hostname]) {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/health",
          headers: { Host: host },
          timeout: 2000,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
            if (Buffer.byteLength(body) > 1024) {
              response.destroy(
                new Error(
                  "Reader health response exceeded its anonymous response limit",
                ),
              );
            }
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const health: unknown = JSON.parse(body);
              if (
                response.statusCode !== 200 ||
                !isDeepStrictEqual(health, { ok: true })
              ) {
                throw new Error(
                  "Reader /health must return only {ok:true}; move process/inbox identity to a separate private loopback control endpoint before enabling Tailscale",
                );
              }

              resolve();
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once("timeout", () =>
        request.destroy(
          new Error("Loopback reader health timed out; Serve was not enabled"),
        ),
      );
      request.once("error", reject);
    });
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
