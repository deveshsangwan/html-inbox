import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { TestContext } from "node:test";
import { temporaryHome } from "./test-fixtures";
import { parseServeConfig } from "./tailscale-config";
import { isRecord } from "./validation";

export const TAILSCALE_TEST_HOSTNAME = "reader.example-tailnet.ts.net";
export const TAILSCALE_RECORDING_SKIP_REASON =
  process.platform === "win32"
    ? "The recording Tailscale CLI uses a POSIX shebang; Windows execFile cannot execute it."
    : false;

// JSON and route mutations follow Tailscale source 9128778b6515f32e13d92e7380044fe025f9b08e.
// Every command runs this temporary recording executable, never the installed client.
const RECORDING_EXECUTABLE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const directory = path.dirname(process.argv[1]);
const scenarioPath = path.join(directory, "scenario.json");
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(directory, "commands.jsonl"), JSON.stringify(args) + "\n");
const operation = args[0] === "status" ? "status"
  : args[1] === "status" ? "config" : args.at(-1) === "off" ? "off" : "serve";
function save() { fs.writeFileSync(scenarioPath, JSON.stringify(scenario)); }
function finish() {
  if (scenario.failOn === operation && !scenario.failAfterWrite) {
    process.stderr.write(scenario.failure || "permission denied");
    process.exit(1);
  }

  if (operation === "status" || operation === "config") {
    const output = scenario[operation + "Output"];
    process.stdout.write(output === undefined
      ? JSON.stringify(scenario[operation === "config" ? "config" : "status"]) : output);
    return;
  }

  const hostPort = scenario.status.Self.DNSName.replace(/\.$/, "").toLowerCase() + ":443";
  const config = scenario.config || {};
  if (operation === "serve") {
    config.TCP ||= {};
    config.TCP["443"] = { HTTPS: true };
    config.Web ||= {};
    config.Web[hostPort] ||= { Handlers: {} };
    config.Web[hostPort].Handlers["/"] = { Proxy: args.at(-1) };
    scenario.config = scenario.afterServeConfig === undefined ? config : scenario.afterServeConfig;
    if (scenario.afterServeStatus !== undefined) scenario.status = scenario.afterServeStatus;
    if (scenario.afterServeConfigOutput !== undefined) scenario.configOutput = scenario.afterServeConfigOutput;
    process.stdout.write("https://untrusted-output.invalid/\n");
  } else {
    if (scenario.ignoreOff !== true) {
      delete config.Web?.[hostPort]?.Handlers["/"];
      if (config.Web?.[hostPort] && Object.keys(config.Web[hostPort].Handlers).length === 0) {
        delete config.Web[hostPort];
        delete config.TCP?.["443"];
      }
      for (const key of ["TCP", "Web", "AllowFunnel"]) {
        if (config[key] && Object.keys(config[key]).length === 0) delete config[key];
      }
    }
    scenario.config = scenario.afterOffConfig === undefined ? config : scenario.afterOffConfig;
  }
  save();

  if (scenario.failOn === operation && scenario.failAfterWrite) {
    process.stderr.write(scenario.failure || "permission denied after configuration update");
    process.exit(1);
  }
}
setTimeout(finish, scenario.delayOperation === operation ? scenario.delayMs : 0);
`;

function connectedStatus() {
  return {
    BackendState: "Running",
    Self: {
      ID: randomUUID(),
      DNSName: `${TAILSCALE_TEST_HOSTNAME}.`,
      Online: true,
      Expired: false,
      CapMap: { https: [] },
    },
    CurrentTailnet: {
      MagicDNSSuffix: "example-tailnet.ts.net",
      MagicDNSEnabled: true,
    },
    CertDomains: [TAILSCALE_TEST_HOSTNAME],
  };
}

export async function recordingTailscale(
  t: TestContext,
  config: unknown = {},
  health: unknown = { ok: true },
) {
  if (TAILSCALE_RECORDING_SKIP_REASON) {
    throw new Error(TAILSCALE_RECORDING_SKIP_REASON);
  }

  const home = await temporaryHome(t);
  const executable = path.join(home, "recording ; tailscale.cjs");
  const scenarioPath = path.join(home, "scenario.json");
  await writeFile(executable, `#!${process.execPath}\n${RECORDING_EXECUTABLE}`);
  await chmod(executable, 0o700);
  const status = connectedStatus();
  await writeFile(scenarioPath, JSON.stringify({ status, config }));

  const reader = http.createServer((request, response) => {
    const body: unknown =
      typeof health === "function" ? health(request) : health;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    reader.once("error", reject);
    reader.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => reader.close(() => resolve())));
  const address = reader.address();
  assert(address && typeof address !== "string");

  const options = {
    home,
    backendPort: address.port,
    instanceId: randomUUID(),
    processId: randomUUID(),
  };
  const command = { executable };
  const update = async (changes: Record<string, unknown>) => {
    const scenario: unknown = JSON.parse(await readFile(scenarioPath, "utf8"));
    assert(isRecord(scenario));
    await writeFile(scenarioPath, JSON.stringify({ ...scenario, ...changes }));
  };
  const liveConfig = async () => {
    const scenario: unknown = JSON.parse(await readFile(scenarioPath, "utf8"));
    assert(isRecord(scenario));
    return parseServeConfig(JSON.stringify(scenario.config));
  };
  const commands = async () => {
    const lines = (
      await readFile(path.join(home, "commands.jsonl"), "utf8").catch(() => "")
    ).trim();
    const result: string[][] = [];
    for (const line of lines ? lines.split("\n") : []) {
      const value: unknown = JSON.parse(line);
      assert(Array.isArray(value));
      const args: string[] = [];
      for (const argument of value) {
        assert.equal(typeof argument, "string");
        assert(typeof argument === "string");
        args.push(argument);
      }
      result.push(args);
    }
    return result;
  };
  const journal = async () => {
    const value: unknown = JSON.parse(
      await readFile(path.join(home, "tailscale-serve.json"), "utf8"),
    );
    assert(isRecord(value));
    return value;
  };

  return {
    home,
    executable,
    status,
    options,
    command,
    update,
    liveConfig,
    commands,
    journal,
    reader,
  };
}
