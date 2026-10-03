import { strict as assert } from "node:assert";
import { isIP } from "node:net";
import { NetworkInterfaceInfo } from "node:os";
import { test } from "node:test";
import {
  getViewerUrls,
  isAllowedViewerHost,
  parseViewerNetworkConfig,
  resolveViewerNetworkConfig,
} from "./viewer-network";

test("viewer networking defaults to loopback and makes LAN exposure explicit", () => {
  assert.deepEqual(resolveViewerNetworkConfig(3217), {
    port: 3217,
    exposure: "loopback",
    host: "127.0.0.1",
  });
  assert.deepEqual(resolveViewerNetworkConfig({ port: 3217, exposure: "lan" }), {
    port: 3217,
    exposure: "lan",
    host: "0.0.0.0",
  });
  assert.deepEqual(resolveViewerNetworkConfig({ port: 0, host: "::1" }), {
    port: 0,
    exposure: "loopback",
    host: "::1",
  });
  assert.equal(resolveViewerNetworkConfig({ port: 65535, host: "127.0.0.2" }).port, 65535);
});

test("viewer config validates untrusted values and forbids implicit exposure", () => {
  for (const input of [null, [], "3217", true, {}, { port: "3217" }]) {
    assert.throws(() => parseViewerNetworkConfig(input));
  }

  for (const port of [-1, 65536, 1.5, Infinity, NaN]) {
    assert.throws(() => parseViewerNetworkConfig({ port }), /port/);
  }

  for (const exposure of [null, false, "public", "LAN", ""]) {
    assert.throws(() => parseViewerNetworkConfig({ port: 3217, exposure }), /exposure/);
  }

  for (const host of [null, false, "", "localhost", "example.com", "[::1]", "fe80::1%eth0", "127.0.0.1:3217", "127.0.0.1\n", "127.1", "2130706433"]) {
    assert.throws(() => parseViewerNetworkConfig({ port: 3217, host }), /host/);
  }

  for (const host of ["0.0.0.0", "::", "192.168.1.2", "fd00::1", "::ffff:192.168.1.2"]) {
    assert.throws(() => resolveViewerNetworkConfig({ port: 3217, host }), /loopback/);
    assert.throws(() => resolveViewerNetworkConfig({ port: 3217, exposure: "tailscale", host }), /loopback/);
  }

  for (const host of ["::1", "127.0.0.2"]) {
    assert.throws(() => resolveViewerNetworkConfig({ port: 3217, exposure: "tailscale", host }), /must bind 127.0.0.1/);
  }
});

test("wildcard URLs enumerate only usable addresses from matching interfaces", () => {
  const interfaces = {
    lo: [interfaceAddress("127.0.0.1", true), interfaceAddress("::1", true)],
    eth0: [interfaceAddress("192.168.1.20"), interfaceAddress("fd00::20"), interfaceAddress("fe80::20")],
    wlan0: [interfaceAddress("10.0.0.7"), interfaceAddress("192.168.1.20"), interfaceAddress("2001:db8::7")],
    inactive: undefined,
    invalid: [interfaceAddress("0.0.0.0"), interfaceAddress("239.1.1.1"), interfaceAddress("::"), interfaceAddress("ff02::1"), interfaceAddress("::ffff:127.0.0.1"), interfaceAddress("fe80::1%eth0")],
  };

  const ipv4 = resolveViewerNetworkConfig({ port: 3217, exposure: "lan" });
  assert.deepEqual(getViewerUrls(ipv4, interfaces), ["http://192.168.1.20:3217", "http://10.0.0.7:3217"]);

  const dualStack = resolveViewerNetworkConfig({ port: 3217, exposure: "lan", host: "::" });
  assert.deepEqual(getViewerUrls(dualStack, interfaces), [
    "http://192.168.1.20:3217",
    "http://[fd00::20]:3217",
    "http://10.0.0.7:3217",
    "http://[2001:db8::7]:3217",
  ]);

  assert.throws(() => getViewerUrls(ipv4, {}), /No usable network interface/);
  assert.throws(() => getViewerUrls(dualStack, { lo: interfaces.lo }), /No usable network interface/);
});

test("explicit IPv4 and IPv6 bindings report the selected address and port", () => {
  const ipv4 = resolveViewerNetworkConfig({ port: 4321, exposure: "lan", host: "192.168.1.40" });
  assert.deepEqual(getViewerUrls(ipv4, {}), ["http://192.168.1.40:4321"]);

  const ipv6 = resolveViewerNetworkConfig({ port: 4321, exposure: "lan", host: "FD00:0:0:0:0:0:0:40" });
  assert.equal(ipv6.host, "fd00::40");
  assert.deepEqual(getViewerUrls(ipv6, {}), ["http://[fd00::40]:4321"]);
});

test("Host validation admits only configured and derived authorities", () => {
  const config = resolveViewerNetworkConfig({ port: 3217, exposure: "lan" });
  const urls = getViewerUrls(config, { eth0: [interfaceAddress("192.168.1.20")] });
  for (const host of ["192.168.1.20:3217", "127.0.0.1:3217", "localhost:3217", "LOCALHOST:3217"]) {
    assert.equal(isAllowedViewerHost(host, config, urls), true, host);
  }

  for (const host of [undefined, "", "0.0.0.0:3217", "attacker.example:3217", "192.168.1.21:3217", "192.168.1.20:3218", "192.168.1.20", "192.168.1.20:03217", "192.168.1.20:3217.", "192.168.1.20:3217@attacker.example", "http://192.168.1.20:3217", "localhost.:3217"]) {
    assert.equal(isAllowedViewerHost(host, config, urls), false, host);
  }

  const explicit = resolveViewerNetworkConfig({ port: 3217, exposure: "lan", host: "192.168.1.20" });
  assert.equal(isAllowedViewerHost("127.0.0.1:3217", explicit, getViewerUrls(explicit)), false);
  assert.equal(isAllowedViewerHost("localhost:3217", explicit, getViewerUrls(explicit)), false);
});

test("Host validation requires brackets for IPv6 and permits default HTTP port spelling", () => {
  const config = resolveViewerNetworkConfig({ port: 3217, exposure: "lan", host: "fd00::40" });
  const urls = getViewerUrls(config);
  assert.equal(isAllowedViewerHost("[fd00::40]:3217", config, urls), true);
  assert.equal(isAllowedViewerHost("fd00::40:3217", config, urls), false);
  assert.equal(isAllowedViewerHost("[fd00::41]:3217", config, urls), false);

  const defaultPort = resolveViewerNetworkConfig({ port: 80, host: "::1" });
  for (const host of ["[::1]", "[::1]:80", "localhost", "localhost:80"]) {
    assert.equal(isAllowedViewerHost(host, defaultPort, getViewerUrls(defaultPort)), true, host);
  }

  const wildcard = resolveViewerNetworkConfig({ port: 80, exposure: "lan" });
  const wildcardUrls = getViewerUrls(wildcard, { eth0: [interfaceAddress("192.168.1.20")] });
  assert.equal(isAllowedViewerHost("192.168.1.20", wildcard, wildcardUrls), true);
  assert.equal(isAllowedViewerHost("192.168.1.20:80", wildcard, wildcardUrls), true);
});

test("Tailscale URL and Host derive only from the supplied trusted hostname", () => {
  const config = resolveViewerNetworkConfig({ port: 3217, exposure: "tailscale", tailscaleHostname: "Server.Tailnet.TS.NET." });
  assert.equal(config.tailscaleHostname, "server.tailnet.ts.net");
  assert.deepEqual(getViewerUrls(config), ["https://server.tailnet.ts.net"]);

  for (const host of ["server.tailnet.ts.net", "SERVER.TAILNET.TS.NET", "server.tailnet.ts.net:443", "127.0.0.1:3217", "localhost:3217"]) {
    assert.equal(isAllowedViewerHost(host, config, getViewerUrls(config)), true, host);
  }

  for (const host of ["other.tailnet.ts.net", "server.tailnet.ts.net:3217", "server.tailnet.ts.net:80", "server.tailnet.ts.net.", "server.tailnet.ts.net.attacker.example"]) {
    assert.equal(isAllowedViewerHost(host, config, getViewerUrls(config)), false, host);
  }

  assert.throws(() => getViewerUrls(resolveViewerNetworkConfig({ port: 3217, exposure: "tailscale" })), /Resolve the Tailscale hostname/);
  assert.throws(() => resolveViewerNetworkConfig({ port: 3217, tailscaleHostname: "server.tailnet.ts.net" }), /requires tailscale/);

  for (const tailscaleHostname of [null, "", "https://server.tailnet.ts.net", "server.tailnet.ts.net:443", "server.tailnet.ts.net/path", "ts.net", "tailnet.ts.net", "server..ts.net", "-server.tailnet.ts.net", "server.tailnet.ts.net\n", `${"a".repeat(64)}.tailnet.ts.net`]) {
    assert.throws(() => parseViewerNetworkConfig({ port: 3217, exposure: "tailscale", tailscaleHostname }), /hostname/);
  }
});

function interfaceAddress(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    internal,
    family: isIP(address) === 4 ? "IPv4" : "IPv6",
    netmask: isIP(address) === 4 ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    mac: "00:00:00:00:00:00",
    cidr: null,
    scopeid: 0,
  };
}
