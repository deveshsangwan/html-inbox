import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// The coordinator builds archived refs, never edits the active checkout, and runs one worker at a time.
const [mode, ...args] = process.argv.slice(2);
const hash = (value) => createHash("sha256").update(value).digest("hex");

if (mode === "run") {
  const [output, baseline, candidate, ...nodes] = args;
  assert.ok(nodes.length > 0, "Provide absolute Node executable paths");
  mkdirSync(output, { recursive: true });
  const repo = process.cwd();
  const builds = {};

  for (const [label, ref] of Object.entries({ baseline, candidate })) {
    const directory = path.join(output, label);
    mkdirSync(directory, { recursive: true });
    const archive = path.join(output, `${label}.tar`);
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, ref]);
    execFileSync("tar", ["-xf", archive, "-C", directory]);
    symlinkSync(path.join(repo, "node_modules"), path.join(directory, "node_modules"));
    execFileSync(path.join(repo, "node_modules/.bin/tsc-rs"), ["-p", "packages/cli/tsconfig.json"], { cwd: directory, stdio: "inherit" });
    builds[label] = path.join(directory, "packages/cli/dist");
  }

  const script = path.resolve(process.argv[1]);
  const run = (node, workerArgs) => {
    const child = spawnSync(node, [script, ...workerArgs], {
      encoding: "utf8", env: { ...process.env, TZ: "America/New_York", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const rows = [];

  for (const size of [10, 1000]) {
    const home = path.join(output, `fixture-${size}`);
    run(nodes[0], ["fixture", builds.baseline, home, String(size)]);

    for (const node of nodes) {
      for (const route of ["viewer", "hub"]) {
        for (let pair = 0; pair < 5; pair += 1) {
          for (const label of pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
            const row = { label, ref: label === "baseline" ? baseline : candidate, size, route, pair,
              ...run(node, ["worker", builds[label], home, route]) };
            rows.push(row);
            writeFileSync(path.join(output, "requests.json"), JSON.stringify(rows, null, 2) + "\n");
            console.log(JSON.stringify(row));
          }
        }
      }
    }
  }

  for (const row of rows.filter((row) => row.label === "candidate")) {
    const before = rows.find((other) => other.label === "baseline" && other.node === row.node &&
      other.size === row.size && other.route === row.route && other.pair === row.pair);
    assert.deepEqual(row.responses, before.responses);
  }

  // Exact bytes, including shell markup, under changed locale and runtime timezone defaults.
  for (const node of nodes) {
    const nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();

    for (const locale of ["en_US.UTF-8", "fr_FR.UTF-8", "ar_EG.UTF-8"]) {
      const env = { ...process.env, LANG: locale, LC_ALL: locale };
      const outputs = Object.fromEntries(Object.entries(builds).map(([label, dist]) => {
        const result = spawnSync(node, [script, "equivalence", dist], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env });
        assert.equal(result.status, 0, result.stderr);
        return [label, result.stdout];
      }));
      assert.equal(outputs.candidate, outputs.baseline);
      writeFileSync(path.join(output, `equivalence-${nodeVersion}-${locale}.json`), outputs.candidate);
    }
  }
} else if (mode === "fixture") {
  const [dist, home, size] = args;
  const { LocalDocumentBackend } = createRequire(import.meta.url)(path.join(dist, "backend.js"));
  const backend = new LocalDocumentBackend(home);

  for (let index = 0; index < Number(size); index += 1) {
    await backend.publish({ originalBytes: Buffer.from("<!doctype html><h1>Fixture</h1>"),
      title: `Report ${index}`, type: "report", sourceFileName: "fixture.html" });
  }

  console.log(JSON.stringify({ size: Number(size) }));
} else if (mode === "worker") {
  const [dist, home, route] = args;
  const require = createRequire(import.meta.url);
  const { LocalDocumentBackend } = require(path.join(dist, "backend.js"));
  const { startViewerHttpServer, startHubHttpServer } = require(path.join(dist, "viewer-http-server.js"));
  const { resolveViewerNetworkConfig } = require(path.join(dist, "viewer-network.js"));
  const source = new LocalDocumentBackend(home);
  const config = resolveViewerNetworkConfig(0);
  const server = route === "hub"
    ? await startHubHttpServer([{ name: "reports", source }], config)
    : await startViewerHttpServer(source, config, {
      instanceId: "bench", processId: "bench", protocolVersion: 1, pid: process.pid,
    });
  let constructions = 0;
  const Original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = new Proxy(Original, {
    construct(target, args) {
      constructions += 1;
      return Reflect.construct(target, args);
    },
  });
  const samples = [];
  const responses = [];

  try {
    for (let index = 0; index < 11; index += 1) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      const count = constructions;
      const response = await fetch(server.urls[0]);
      const body = Buffer.from(await response.arrayBuffer());
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      assert.equal(response.status, 200);
      samples.push({ phase: index === 0 ? "cold-process" : "warm", elapsedMs,
        cpuMs: (used.user + used.system) / 1000, constructions: constructions - count,
        rssBytes: process.memoryUsage().rss });
      responses.push({ bytes: body.length, sha256: hash(body) });
    }
  } finally {
    Intl.DateTimeFormat = Original;
    await server.close();
  }

  console.log(JSON.stringify({ node: process.version, samples, responses, maxRssKiB: process.resourceUsage().maxRSS }));
} else if (mode === "equivalence") {
  const [dist] = args;
  const { renderIndex, renderHubIndex, renderDocumentShell } = createRequire(import.meta.url)(path.join(dist, "viewer-render.js"));
  const documents = ["2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z", "2026-11-01T05:59:00Z",
    "2026-11-01T06:01:00Z", "2026-01-01T00:15:00+05:30", "2026-11-07T12:34:00", "2026-11-07", "invalid<&\"'", ""].map((createdAt, index) => ({
    schemaVersion: 1, id: `doc-${index}`, title: `Report ${index}`, type: "report", createdAt, sourceFileName: "fixture.html",
  }));
  const results = [];

  for (const runtimeZone of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
    process.env.TZ = runtimeZone;

    for (const timeZone of [undefined, "UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
      results.push(renderIndex(documents, "", { timeZone }),
        renderIndex(documents, "", { timeZone, basePath: "/i/static", clientSearch: true }),
        renderHubIndex([{ name: "reports", available: true, documents }], "", "", { timeZone }),
        ...documents.map((document) => renderDocumentShell(document, { timeZone })));
    }
  }

  console.log(JSON.stringify(results));
} else {
  throw new Error("Use run OUTPUT BASELINE CANDIDATE NODE...; internal modes: fixture, worker, equivalence");
}
