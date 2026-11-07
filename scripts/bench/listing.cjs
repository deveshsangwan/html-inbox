// Scoped #91 companion: production backend/server, synthetic ordinary fixtures only.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

async function main() {
  const [dist, home, countText, mode] = process.argv.slice(2);
  const count = Number(countText);
  const load = name => require(path.join(dist, name));
  const warnings = [];
  const backends = Array.from({ length: 4 }, () => new (load('backend.js').LocalDocumentBackend)(home, message => warnings.push(message)));
  const expected = Array.from({ length: count }, (_, index) => ({ schemaVersion: 1,
    id: `bench-${String(index).padStart(5, '0')}`, title: `Benchmark ${index}`, type: 'report',
    createdAt: '2026-11-07T00:00:00.000Z', sourceFileName: 'fixture.html' }));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const warm = await backends[0].listDocuments();
  assert.deepEqual(warm, expected);
  let server;
  let expectedBody;

  try {
    if (mode === 'http4') {
      server = await load('viewer-http-server.js').startViewerHttpServer(backends[0],
        load('viewer-network.js').resolveViewerNetworkConfig(0),
        { instanceId: 'benchmark', processId: 'benchmark', protocolVersion: 1, pid: process.pid });
      const response = await fetch(server.urls[0] + '/');
      assert.equal(response.status, 200);
      expectedBody = await response.text();
    }

    const cpu = process.cpuUsage();
    const start = performance.now();
    const results = mode === 'http4'
      ? await Promise.all(backends.map(async () => {
        const response = await fetch(server.urls[0] + '/');
        assert.equal(response.status, 200);
        return response.text();
      }))
      : await Promise.all(backends.slice(0, mode === 'direct1' ? 1 : 4).map(backend => backend.listDocuments()));
    const wall = performance.now() - start;
    const used = process.cpuUsage(cpu);

    for (const result of results) {
      assert.deepEqual(result, mode === 'http4' ? expectedBody : expected);
    }
    assert.deepEqual(warnings, []);
    console.log(JSON.stringify({ node: process.version, count, mode, wall_ms: wall,
      cpu_ms: (used.user + used.system) / 1000, peak_rss_kib: process.resourceUsage().maxRSS,
      process_cpu_ms: (process.resourceUsage().userCPUTime + process.resourceUsage().systemCPUTime) / 1000,
      output_hash: hash(mode === 'http4' ? expectedBody : JSON.stringify(expected)),
      behavior: 'exact metadata/order or full HTTP body; zero warnings', cache: 'one direct warm listing, plus one HTTP warm request for http4' }));
  } finally {
    if (server) await server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
