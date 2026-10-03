import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function createPackageTailscaleFixture(directory) {
  await mkdir(directory, { mode: 0o700 });

  const hostname = "packaged.example-tailnet.ts.net";
  const configPath = path.join(directory, "serve.json");
  const commandsPath = path.join(directory, "commands.jsonl");
  const executable = path.join(directory, "recording tailscale.cjs");
  const originalConfig = {
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      [`${hostname}:443`]: { Handlers: { "/metrics": { Text: "existing metrics" } } },
      [`${hostname}:8443`]: { Handlers: { "/": { Text: "existing service" } } },
    },
  };
  const status = {
    BackendState: "Running",
    Self: { ID: randomUUID(), DNSName: `${hostname}.`, Online: true, Expired: false, CapMap: { https: [] } },
    CurrentTailnet: { MagicDNSSuffix: "example-tailnet.ts.net", MagicDNSEnabled: true },
    CertDomains: [hostname],
  };
  await writeFile(configPath, JSON.stringify(originalConfig), { mode: 0o600 });

  const source = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const directory = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(directory, "commands.jsonl"), JSON.stringify(args) + "\n");
const status = STATUS_PLACEHOLDER;
if (JSON.stringify(args) === JSON.stringify(["status", "--json"])) {
  process.stdout.write(JSON.stringify(status));
  process.exit(0);
}

const configPath = path.join(directory, "serve.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (JSON.stringify(args) === JSON.stringify(["serve", "status", "--json"])) {
  process.stdout.write(JSON.stringify(config));
  process.exit(0);
}

const expectedFlags = ["serve", "--bg", "--yes", "--https=443", "--set-path=/"];
if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify(expectedFlags) || args.length !== 6) {
  throw new Error("Unexpected Tailscale mutation: " + JSON.stringify(args));
}

const handlers = config.Web[status.Self.DNSName.slice(0, -1) + ":443"].Handlers;
if (args[5] === "off") {
  delete handlers["/"];
} else {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(args[5])) {
    throw new Error("Unexpected proxy target");
  }
  handlers["/"] = { Proxy: args[5] };
}
fs.writeFileSync(configPath, JSON.stringify(config));
process.stdout.write("https://untrusted-command-output.invalid/\n");
`;
  await writeFile(executable, `#!${process.execPath}\n${source.replace("STATUS_PLACEHOLDER", JSON.stringify(status))}`, { mode: 0o700 });

  return { hostname, executable, configPath, commandsPath, originalConfig };
}
