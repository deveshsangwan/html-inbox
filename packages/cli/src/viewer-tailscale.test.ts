import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { temporaryHome } from "./test-fixtures";
import {
  cleanupTailscale,
  getTailscaleStatus,
  prepareTailscale,
  startTailscale,
} from "./viewer-tailscale";

import {
  recordingTailscale as fixture,
  TAILSCALE_RECORDING_SKIP_REASON,
  TAILSCALE_TEST_HOSTNAME as HOSTNAME,
} from "./tailscale-test-fixtures";

const recordingTestOptions = { skip: TAILSCALE_RECORDING_SKIP_REASON };

function mutations(commands: string[][]) {
  return commands.filter((args) => args[0] === "serve" && args[1] !== "status");
}

test("Serve verifies URL, owns a private route, repeats idempotently and preserves unrelated configuration", recordingTestOptions, async (t) => {
  const original = {
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      [`${HOSTNAME}:443`]: {
        Handlers: {
          "/metrics": { Proxy: "http://127.0.0.1:9000" },
          "/assets-other": { Text: "separate namespace" },
          "/documents-archive": { Text: "separate namespace" },
          "/healthcheck": { Text: "separate route" },
          "/health/details": { Text: "does not match /health" },
          "/%61ssets/viewer.js": { Text: "mount keys are not URL decoded" },
        },
      },
      [`${HOSTNAME}:8443`]: {
        Handlers: {
          "/": { Text: "public existing service" },
          "/assets/viewer.js": { Text: "another port" },
          "/documents/": { Text: "another port" },
          "/health": { Text: "another port" },
        },
      },
    },
    AllowFunnel: { [`${HOSTNAME}:8443`]: true },
    Foreground: {
      session: { TCP: { "9443": { TCPForward: "127.0.0.1:9001" } } },
    },
    Services: {
      "svc:other": {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "other.example-tailnet.ts.net:443": {
            Handlers: {
              "/": { Text: "service" },
              "/assets/viewer.js": { Text: "named service" },
              "/documents/": { Text: "named service" },
              "/health": { Text: "named service" },
            },
          },
        },
      },
    },
  };
  const f = await fixture(t, original);
  const prepared = await prepareTailscale(f.options, f.command);
  assert.equal(prepared.executable, f.executable);
  assert.equal(prepared.hostname, HOSTNAME);
  assert.equal(prepared.url, `https://${HOSTNAME}`);
  assert.equal(mutations(await f.commands()).length, 0);

  assert.deepEqual(await startTailscale(prepared), prepared);
  assert.deepEqual(await startTailscale(prepared), prepared);
  assert.equal((await f.journal()).phase, "active");
  assert.equal(
    (await stat(path.join(f.home, "tailscale-serve.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(f.home)).mode & 0o777, 0o700);
  assert.deepEqual(await getTailscaleStatus(f.home), {
    state: "running",
    url: prepared.url,
    hostname: HOSTNAME,
    backendPort: f.options.backendPort,
    instanceId: f.options.instanceId,
    processId: f.options.processId,
  });

  assert.deepEqual(await cleanupTailscale(f.home, f.options), {
    state: "stopped",
  });
  assert.deepEqual(await f.liveConfig(), original);
  assert.deepEqual(await getTailscaleStatus(f.home), { state: "stopped" });
  assert.deepEqual(mutations(await f.commands()), [
    [
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      "--set-path=/",
      `http://127.0.0.1:${f.options.backendPort}`,
    ],
    ["serve", "--bg", "--yes", "--https=443", "--set-path=/", "off"],
  ]);
  assert.equal(
    (await f.commands()).some((args) =>
      args.some((arg) =>
        ["reset", "funnel", "login", "up", "set-raw", "set-config"].includes(
          arg,
        ),
      ),
    ),
    false,
  );
});

test("missing CLI and read-only status never fall back to an installed Tailscale", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareTailscale(f.options, {
      executable: path.join(f.home, "missing-tailscale"),
    }),
    /missing or not executable/,
  );
  assert.deepEqual(await f.commands(), []);
  assert.deepEqual(await getTailscaleStatus(f.home), { state: "stopped" });
  assert.deepEqual(await cleanupTailscale(f.home), { state: "stopped" });
  assert.deepEqual(await f.commands(), []);
});

test("offline, login, expired, MagicDNS, HTTPS and identity failures are actionable and read-only", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const cases = [
    {
      status: { ...f.status, BackendState: "NeedsLogin" },
      error: /connect the existing/,
    },
    {
      status: { ...f.status, Self: { ...f.status.Self, Online: false } },
      error: /offline or expired/,
    },
    {
      status: { ...f.status, Self: { ...f.status.Self, Expired: true } },
      error: /offline or expired/,
    },
    {
      status: {
        ...f.status,
        CurrentTailnet: { ...f.status.CurrentTailnet, MagicDNSEnabled: false },
      },
      error: /MagicDNS/,
    },
    { status: { ...f.status, CertDomains: [] }, error: /HTTPS certificates/ },
    {
      status: {
        ...f.status,
        CertDomains: ["somebody-else.example-tailnet.ts.net"],
      },
      error: /HTTPS certificates/,
    },
    {
      status: { ...f.status, Self: { ...f.status.Self, CapMap: {} } },
      error: /consent flow/,
    },
    {
      status: {
        ...f.status,
        CurrentTailnet: {
          ...f.status.CurrentTailnet,
          MagicDNSSuffix: "other.ts.net",
        },
      },
      error: /does not match/,
    },
    {
      status: {
        ...f.status,
        Self: { ...f.status.Self, DNSName: "evil.invalid/;touch" },
      },
      error: /explicit device hostname/,
    },
    { status: { ...f.status, Self: null }, error: /node identity/ },
    { status: [], error: /BackendState/ },
  ];
  for (const scenario of cases) {
    await f.update({ status: scenario.status });
    await assert.rejects(
      prepareTailscale(f.options, f.command),
      scenario.error,
    );
  }

  await f.update({
    status: f.status,
    failOn: "status",
    failure: "Access denied: operator permission required",
  });
  await assert.rejects(
    prepareTailscale(f.options, f.command),
    /grant this normal user.*operator access/,
  );
  await f.update({ failOn: "", statusOutput: "not JSON" });
  await assert.rejects(
    prepareTailscale(f.options, f.command),
    /malformed JSON/,
  );
  assert.deepEqual(mutations(await f.commands()), []);
});

test("malformed or unsupported full configuration is refused before any mutation", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  for (const config of [
    [],
    { Foreground: [] },
    { Services: { "svc:broken": null } },
    { AllowFunnel: { [`${HOSTNAME}:443`]: "yes" } },
    { TCP: { "443": null } },
    { Web: { [`${HOSTNAME}:443`]: { Handlers: [] } } },
    { NewRoutingFeature: {} },
  ]) {
    await f.update({ config });
    await assert.rejects(
      prepareTailscale(f.options, f.command),
      /invalid|unsupported/,
    );
  }

  await f.update({ config: {}, configOutput: "truncated JSON {" });
  await assert.rejects(
    prepareTailscale(f.options, f.command),
    /malformed JSON/,
  );
  await f.update({ configOutput: "null" });
  await prepareTailscale(f.options, f.command);
  assert.deepEqual(mutations(await f.commands()), []);
});

test("existing root, Funnel, foreground, TCP, HTTP and shared-host listener conflicts are refused", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const proxy = `http://127.0.0.1:${f.options.backendPort}`;
  const configs = [
    {
      TCP: { "443": { HTTPS: true } },
      Web: { [`${HOSTNAME}:443`]: { Handlers: { "/": { Proxy: proxy } } } },
    },
    { TCP: { "443": { TCPForward: "127.0.0.1:9000" } } },
    { TCP: { "443": { HTTP: true } } },
    { TCP: { "443": { HTTPS: true } } },
    { AllowFunnel: { [`${HOSTNAME}:443`]: true } },
    { AllowFunnel: { [`${HOSTNAME}:443`]: false } },
    { Foreground: { session: { TCP: { "443": { HTTPS: true } } } } },
    { Foreground: { session: { AllowFunnel: { [`${HOSTNAME}:443`]: true } } } },
    {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "other.example-tailnet.ts.net:443": {
          Handlers: { "/": { Text: "existing" } },
        },
      },
    },
  ];
  for (const config of configs) {
    await f.update({ config });
    await assert.rejects(
      prepareTailscale(f.options, f.command),
      /already|conflict|Funnel|shared|existing listener/,
    );
    assert.deepEqual(await f.liveConfig(), config);
  }
  assert.deepEqual(mutations(await f.commands()), []);
});

test("start rechecks a route claimed after preparation and never overwrites it", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  const occupied = {
    TCP: { "443": { HTTPS: true } },
    Web: { [`${HOSTNAME}:443`]: { Handlers: { "/": { Text: "new owner" } } } },
  };
  await f.update({ config: occupied });
  await assert.rejects(startTailscale(prepared), /already exists/);
  assert.deepEqual(await f.liveConfig(), occupied);
  assert.deepEqual(mutations(await f.commands()), []);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("prepare refuses mounts shadowing reader namespaces, ancestors and canonical aliases", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const mounts = [
    "/assets",
    "/assets/",
    "/assets/viewer.js",
    "/assets/viewer.js/",
    "/assets/viewer.css",
    "/documents",
    "/documents/",
    "/documents/report/content",
    "/documents/report/content/",
    "/health",
    "/health/",
    "//",
    "/assets//viewer.js",
    "/other/../assets/viewer.js",
    "/documents/./report/content",
    "/other/../documents/report",
    "/other/../health",
    "/health/.",
  ];
  for (const mount of mounts) {
    const config = {
      TCP: { "443": { HTTPS: true } },
      Web: {
        [`${HOSTNAME}:443`]: {
          Handlers: { [mount]: { Proxy: "http://127.0.0.1:9000" } },
        },
      },
    };
    await f.update({ config });
    await assert.rejects(
      prepareTailscale(f.options, f.command),
      /conflicts with HTML Inbox's reserved reader routes/,
      mount,
    );
    assert.deepEqual(await f.liveConfig(), config);
  }

  assert.deepEqual(mutations(await f.commands()), []);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("start rechecks shadow mounts added after preparation before recording or mutation", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  for (const mount of ["/assets/viewer.js", "/documents/", "/health/", "//"]) {
    const config = {
      TCP: { "443": { HTTPS: true } },
      Web: {
        [`${HOSTNAME}:443`]: { Handlers: { [mount]: { Text: "new route" } } },
      },
    };
    await f.update({ config });
    await assert.rejects(
      startTailscale(prepared),
      /conflicts with HTML Inbox's reserved reader routes/,
      mount,
    );
    assert.deepEqual(await f.liveConfig(), config);
  }

  assert.deepEqual(mutations(await f.commands()), []);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("external reader shadows cause status drift while scoped cleanup preserves every shadow", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  await startTailscale(prepared);
  const root = { Proxy: `http://127.0.0.1:${f.options.backendPort}` };
  const mounts = ["/assets/viewer.js", "/documents/", "/health/", "//"];
  for (const mount of mounts) {
    await f.update({
      config: {
        TCP: { "443": { HTTPS: true } },
        Web: {
          [`${HOSTNAME}:443`]: {
            Handlers: { "/": root, [mount]: { Text: "external route" } },
          },
        },
      },
    });
    const status = await getTailscaleStatus(f.home);
    assert.equal(status.state, "drift", mount);
    assert.equal(status.url, undefined);
    assert.match(status.reason ?? "", /reserved reader routes/);
    await assert.rejects(prepareTailscale(f.options, f.command), /reserved reader routes/);
    await assert.rejects(startTailscale(prepared), /reserved reader routes/);
    assert.equal((await f.journal()).phase, "active");
  }

  const remaining = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      [`${HOSTNAME}:443`]: {
        Handlers: Object.fromEntries(
          [...mounts, "/metrics"].map((mount) => [mount, { Text: "external route" }]),
        ),
      },
    },
  };
  await f.update({
    config: {
      ...remaining,
      Web: {
        [`${HOSTNAME}:443`]: {
          Handlers: { "/": root, ...remaining.Web[`${HOSTNAME}:443`].Handlers },
        },
      },
    },
  });
  assert.deepEqual(await cleanupTailscale(f.home, f.options), { state: "stopped" });
  assert.deepEqual(await f.liveConfig(), remaining);
  await assert.rejects(f.journal(), /ENOENT/);
  assert.deepEqual(mutations(await f.commands()).map((args) => args.at(-1)), [
    root.Proxy,
    "off",
  ]);
});

test("postmutation reader shadows refuse readiness and roll back only the verified root", recordingTestOptions, async (t) => {
  for (const mount of ["/assets/viewer.js/", "/documents/", "/health/"]) {
    const f = await fixture(t);
    const prepared = await prepareTailscale(f.options, f.command);
    const remaining = {
      TCP: { "443": { HTTPS: true } },
      Web: {
        [`${HOSTNAME}:443`]: { Handlers: { [mount]: { Text: "external route" } } },
      },
    };
    await f.update({
      afterServeConfig: {
        ...remaining,
        Web: {
          [`${HOSTNAME}:443`]: {
            Handlers: {
              "/": { Proxy: `http://127.0.0.1:${f.options.backendPort}` },
              ...remaining.Web[`${HOSTNAME}:443`].Handlers,
            },
          },
        },
      },
    });
    await assert.rejects(
      startTailscale(prepared),
      /reserved reader routes.*owned route was cleaned up/,
      mount,
    );
    assert.deepEqual(await f.liveConfig(), remaining);
    assert.deepEqual(await getTailscaleStatus(f.home), { state: "stopped" });
    await assert.rejects(f.journal(), /ENOENT/);
    assert.equal(mutations(await f.commands()).length, 2);
    assert.deepEqual(mutations(await f.commands()).at(-1), [
      "serve", "--bg", "--yes", "--https=443", "--set-path=/", "off",
    ]);
  }
});

test("reader identity metadata cannot be proxied even with a spoofed loopback Host", recordingTestOptions, async (t) => {
  const f = await fixture(t, {}, (request: http.IncomingMessage) =>
    request.headers.host === HOSTNAME
      ? { ok: true }
      : { ok: true, instanceId: randomUUID(), pid: process.pid },
  );
  const prepared = await prepareTailscale(f.options, f.command);
  await assert.rejects(
    startTailscale(prepared),
    /move process\/inbox identity/,
  );
  assert.deepEqual(mutations(await f.commands()), []);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("drifted routes, listeners and Funnel never authorize cleanup", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  await startTailscale(prepared);
  const valid = await f.liveConfig();
  const configs = [
    {
      ...valid,
      Web: {
        [`${HOSTNAME}:443`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } },
        },
      },
    },
    {
      ...valid,
      Web: {
        [`${HOSTNAME}:443`]: {
          Handlers: {
            "/": {
              Proxy: `http://127.0.0.1:${f.options.backendPort}`,
              AcceptAppCaps: ["cap.example"],
            },
          },
        },
      },
    },
    { ...valid, TCP: { "443": { HTTP: true } } },
    { ...valid, AllowFunnel: { [`${HOSTNAME}:443`]: true } },
  ];
  for (const config of configs) {
    await f.update({ config });
    assert.equal((await getTailscaleStatus(f.home)).state, "drift");
    await assert.rejects(
      cleanupTailscale(f.home, f.options),
      /drift|conflict|Funnel/,
    );
    assert.deepEqual(await f.liveConfig(), config);
    assert.equal((await f.journal()).phase, "active");
  }

  assert.equal(mutations(await f.commands()).length, 1);
  await f.update({ config: valid });
  await cleanupTailscale(f.home, f.options);
});

test("pending journal can recover exact ownership but never reports a usable URL", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await startTailscale(await prepareTailscale(f.options, f.command));
  await writeFile(
    path.join(f.home, "tailscale-serve.json"),
    JSON.stringify({ ...(await f.journal()), phase: "pending" }),
  );
  const status = await getTailscaleStatus(f.home);
  assert.equal(status.state, "drift");
  assert.equal(status.url, undefined);
  assert.match(status.reason ?? "", /pending/);
  await cleanupTailscale(f.home, f.options);
  assert.deepEqual(await f.liveConfig(), {});
});

test("startup failures before and after mutation clean only the recorded route", recordingTestOptions, async (t) => {
  for (const failAfterWrite of [false, true]) {
    const f = await fixture(t);
    const prepared = await prepareTailscale(f.options, f.command);
    await f.update({ failOn: "serve", failAfterWrite });
    await assert.rejects(
      startTailscale(prepared),
      /startup failed.*owned route was cleaned up/,
    );
    assert.deepEqual(await f.liveConfig(), {});
    await assert.rejects(f.journal(), /ENOENT/);
    assert.equal(
      mutations(await f.commands()).filter((args) => args.at(-1) === "off")
        .length,
      failAfterWrite ? 1 : 0,
    );
  }
});

test("unverifiable partial startup retains pending ownership for later scoped recovery", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  await f.update({ afterServeConfigOutput: "malformed output after mutation" });
  await assert.rejects(
    startTailscale(prepared),
    /Scoped cleanup also failed.*journal retained/,
  );
  assert.equal((await f.journal()).phase, "pending");
  assert.equal(mutations(await f.commands()).length, 1);
  const status = await getTailscaleStatus(f.home);
  assert.equal(status.state, "unavailable");
  assert.equal(status.url, undefined);

  await f.update({ configOutput: undefined });
  await cleanupTailscale(f.home, f.options);
  assert.deepEqual(await f.liveConfig(), {});
});

test("postmutation unrelated changes are preserved while startup refuses success", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  const added = { TCP: { "9001": { TCPForward: "127.0.0.1:9002" } } };
  await f.update({
    afterServeConfig: {
      TCP: { ...added.TCP, "443": { HTTPS: true } },
      Web: {
        [`${HOSTNAME}:443`]: {
          Handlers: {
            "/": { Proxy: `http://127.0.0.1:${f.options.backendPort}` },
          },
        },
      },
    },
  });
  await assert.rejects(
    startTailscale(prepared),
    /Unrelated.*changed during startup/,
  );
  assert.deepEqual(await f.liveConfig(), added);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("changed node identity blocks both status URL and cleanup after partial startup", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  await f.update({
    afterServeStatus: {
      ...f.status,
      Self: { ...f.status.Self, ID: randomUUID() },
    },
  });
  await assert.rejects(
    startTailscale(prepared),
    /node identity changed.*Scoped cleanup also failed/,
  );
  assert.equal((await f.journal()).phase, "pending");
  assert.equal((await getTailscaleStatus(f.home)).state, "drift");
  await assert.rejects(
    cleanupTailscale(f.home, f.options),
    /node identity changed/,
  );
  assert.equal(mutations(await f.commands()).length, 1);

  await f.update({ status: f.status });
  await cleanupTailscale(f.home, f.options);
});

test("cleanup rejects stale process identity and verifies that off actually removed the route", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await startTailscale(await prepareTailscale(f.options, f.command));
  await assert.rejects(
    cleanupTailscale(f.home, { ...f.options, processId: randomUUID() }),
    /another viewer process/,
  );
  assert.equal(mutations(await f.commands()).length, 1);

  await f.update({ ignoreOff: true });
  await assert.rejects(
    cleanupTailscale(f.home, f.options),
    /cleanup could not be verified/,
  );
  assert.equal((await f.journal()).phase, "active");
  await f.update({ ignoreOff: false });
  await cleanupTailscale(f.home, f.options);
});

test("externally removed route clears ownership without a Tailscale mutation", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await startTailscale(await prepareTailscale(f.options, f.command));
  await f.update({ config: {} });
  assert.equal((await getTailscaleStatus(f.home)).state, "drift");
  await cleanupTailscale(f.home, f.options);
  assert.equal(mutations(await f.commands()).length, 1);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("offline and missing CLI preserve ownership, while disabled HTTPS still permits safe cleanup", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await startTailscale(await prepareTailscale(f.options, f.command));
  await f.update({
    status: { ...f.status, Self: { ...f.status.Self, Online: false } },
  });
  assert.equal((await getTailscaleStatus(f.home)).state, "unavailable");
  await assert.rejects(cleanupTailscale(f.home, f.options), /offline/);
  await assert.rejects(
    cleanupTailscale(f.home, f.options, {
      executable: path.join(f.home, "missing"),
    }),
    /missing/,
  );
  assert.equal((await f.journal()).phase, "active");

  await f.update({
    status: {
      ...f.status,
      CertDomains: [],
      CurrentTailnet: { ...f.status.CurrentTailnet, MagicDNSEnabled: false },
    },
  });
  await cleanupTailscale(f.home, f.options);
});

test("different inbox homes cannot race root claims or remove the winning owner's route", recordingTestOptions, async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const preparedFirst = await prepareTailscale(first.options, first.command);
  const preparedSecond = await prepareTailscale(second.options, first.command);
  await first.update({ delayOperation: "serve", delayMs: 250 });
  const outcomes = await Promise.allSettled([
    startTailscale(preparedFirst),
    startTailscale(preparedSecond),
  ]);
  const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  assert(winner?.status === "fulfilled");
  assert(loser?.status === "rejected");
  assert.match(String(loser.reason), /Another HTML Inbox operation/);
  assert.equal(mutations(await first.commands()).length, 1);

  const losingOptions =
    winner.value.home === first.home ? second.options : first.options;
  await assert.rejects(
    prepareTailscale(losingOptions, first.command),
    /already exists/,
  );
  await cleanupTailscale(winner.value.home, winner.value);
  assert.deepEqual(await first.liveConfig(), {});
});

test("ephemeral preflight and persisted executable work without boot PATH lookup", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const previousCommand = process.env.HTML_INBOX_TAILSCALE_COMMAND;
  t.after(() => {
    if (previousCommand === undefined) {
      delete process.env.HTML_INBOX_TAILSCALE_COMMAND;
      return;
    }

    process.env.HTML_INBOX_TAILSCALE_COMMAND = previousCommand;
  });
  process.env.HTML_INBOX_TAILSCALE_COMMAND = f.executable;
  const prepared = await prepareTailscale({ ...f.options, backendPort: 0 });
  await assert.rejects(startTailscale(prepared), /actual bound port/);
  await startTailscale({ ...prepared, backendPort: f.options.backendPort });
  assert.equal((await f.journal()).executable, f.executable);
  process.env.HTML_INBOX_TAILSCALE_COMMAND = path.join(f.home, "wrong-path");
  assert.equal((await getTailscaleStatus(f.home)).state, "running");
  await cleanupTailscale(f.home, f.options);
});

test("symlinked, malformed and oversized private journals never authorize a mutation", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const journalPath = path.join(f.home, "tailscale-serve.json");
  const target = path.join(f.home, "unrelated-file");
  await writeFile(target, "keep this file");
  await symlink(target, journalPath);
  await assert.rejects(
    prepareTailscale(f.options, f.command),
    /not a regular file/,
  );
  assert.equal(await readFile(target, "utf8"), "keep this file");
  await rm(journalPath);

  for (const contents of ["{}", "{", "x".repeat(17 * 1024)]) {
    await writeFile(journalPath, contents);
    await assert.rejects(
      cleanupTailscale(f.home, f.options),
      /invalid|cannot be read/,
    );
    assert.equal((await getTailscaleStatus(f.home)).state, "drift");
  }
  assert.deepEqual(mutations(await f.commands()), []);
});

test("recording command timeouts and output limits are bounded before ownership", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await f.update({ delayOperation: "status", delayMs: 1000 });
  await assert.rejects(
    prepareTailscale(f.options, { ...f.command, timeoutMs: 50 }),
    /failed/,
  );
  await f.update({
    delayOperation: "",
    statusOutput: "x".repeat(1024 * 1024 + 1),
  });
  await assert.rejects(
    prepareTailscale(f.options, f.command),
    /maxBuffer|stdout|output/,
  );
  assert.deepEqual(mutations(await f.commands()), []);
});

test("cleanup command errors retain active ownership even after the route was removed", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await startTailscale(await prepareTailscale(f.options, f.command));
  await f.update({ failOn: "off", failAfterWrite: true });
  await assert.rejects(
    cleanupTailscale(f.home, f.options),
    /permission denied after/,
  );
  assert.equal((await f.journal()).phase, "active");
  assert.deepEqual(await f.liveConfig(), {});

  await f.update({ failOn: "" });
  await cleanupTailscale(f.home, f.options);
  assert.equal(mutations(await f.commands()).length, 2);
  await assert.rejects(f.journal(), /ENOENT/);
});

test("startup retains a pending journal when the postmutation route belongs to another target", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTailscale(f.options, f.command);
  const drifted = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      [`${HOSTNAME}:443`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } },
      },
    },
  };
  await f.update({ afterServeConfig: drifted });
  await assert.rejects(startTailscale(prepared), /Scoped cleanup also failed/);
  assert.equal((await f.journal()).phase, "pending");
  assert.deepEqual(await f.liveConfig(), drifted);
  assert.equal(mutations(await f.commands()).length, 1);
  assert.equal((await getTailscaleStatus(f.home)).url, undefined);
});

test("symlinked home and corrupted ownership fields cannot authorize route removal", recordingTestOptions, async (t) => {
  const f = await fixture(t);
  await startTailscale(await prepareTailscale(f.options, f.command));
  const ownership = await f.journal();
  const journalPath = path.join(f.home, "tailscale-serve.json");
  for (const changes of [
    { proxy: "http://127.0.0.1:9000" },
    { httpsPort: 8443 },
    { mount: "/other" },
    { url: "https://different.example-tailnet.ts.net" },
    { home: path.join(f.home, "different") },
    { processId: "invalid-uuid" },
    { executable: "tailscale" },
  ]) {
    await writeFile(journalPath, JSON.stringify({ ...ownership, ...changes }));
    await assert.rejects(cleanupTailscale(f.home, f.options));
    assert.equal(mutations(await f.commands()).length, 1);
  }

  await writeFile(journalPath, JSON.stringify(ownership));
  const parent = await temporaryHome(t);
  const alias = path.join(parent, "linked-home");
  await symlink(f.home, alias, "dir");
  await assert.rejects(
    cleanupTailscale(alias, f.options),
    /not a regular directory/,
  );
  assert.equal(mutations(await f.commands()).length, 1);
  await cleanupTailscale(f.home, f.options);
});

test(
  "a killed lock owner retains pending ownership until documented manual lock recovery",
  { ...recordingTestOptions, timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    await startTailscale(await prepareTailscale(f.options, f.command));
    await writeFile(
      path.join(f.home, "tailscale-serve.json"),
      JSON.stringify({ ...(await f.journal()), phase: "pending" }),
    );
    const nodeHash = createHash("sha256")
      .update(f.status.Self.ID)
      .digest("hex")
      .slice(0, 24);
    const lockPath = path.join(
      tmpdir(),
      `html-inbox-tailscale-${process.getuid?.() ?? process.env.USERNAME ?? "user"}-${nodeHash}.lock`,
    );
    const owner = spawn(
      process.execPath,
      [
        "--eval",
        `
    const { withTailscaleServeLock } = require("./tailscale-records.js");
    withTailscaleServeLock(process.env.HTML_INBOX_TEST_NODE_ID, async () => {
      process.send("lock-held");
      await new Promise(() => setInterval(() => {}, 1000));
    }).catch((error) => { console.error(error); process.exit(1); });
  `,
      ],
      {
        cwd: __dirname,
        env: { ...process.env, HTML_INBOX_TEST_NODE_ID: f.status.Self.ID },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const ownerExit = once(owner, "exit");
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
      }

      await ownerExit;
      await rm(lockPath, { recursive: true, force: true });
    });
    const ready = await Promise.race([
      once(owner, "message"),
      ownerExit.then(() => {
        throw new Error(
          "Recording lock owner exited before acquiring its lock",
        );
      }),
    ]);
    assert.equal(ready[0], "lock-held");
    owner.kill("SIGKILL");
    await ownerExit;

    await assert.rejects(
      cleanupTailscale(f.home, f.options),
      /inspect owner.json.*stale lock directory/,
    );
    assert.equal((await f.journal()).phase, "pending");
    assert.equal(mutations(await f.commands()).length, 1);
    await rm(lockPath, { recursive: true });
    await cleanupTailscale(f.home, f.options);
    assert.deepEqual(await f.liveConfig(), {});
  },
);
