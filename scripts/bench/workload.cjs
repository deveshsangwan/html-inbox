const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
let dist = path.resolve(__dirname, '../../packages/cli/dist');
const load = name => require(path.join(dist, name));

function html(size, shape = 'text') {
  const head = '<!doctype html><html><head><title>Benchmark</title></head><body>';
  const tail = '</body></html>';
  const unit = shape === 'dense' ? '<p>Benchmark</p>' : 'Benchmark text. ';
  const remaining = size - head.length - tail.length;

  return head + unit.repeat(Math.floor(remaining / unit.length)) + ' '.repeat(remaining % unit.length) + tail;
}

async function seed(root, count, size) {
  const { parseDocumentMetadata } = load('documents.js');
  const bytes = html(size);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (let i = 0; i < count; i++) {
    const id = `bench-${String(i).padStart(5, '0')}`;
    const directory = path.join(root, 'documents', id);
    const metadata = parseDocumentMetadata({ schemaVersion: 1, id, title: `Benchmark ${i}`, type: 'report',
      createdAt: '2026-11-07T00:00:00.000Z', sourceFileName: 'fixture.html' });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'index.html'), bytes, { mode: 0o600 });
  }
}

async function main() {
  const [mode, root, countValue, sizeValue, samplesValue, shape = 'text', candidate, implementationDist] = process.argv.slice(2);
  const count = Number(countValue), size = Number(sizeValue), samples = Number(samplesValue);
  const record = async (label, operation, inspect) => {
    const ioBefore = await fs.readFile('/proc/self/io', 'utf8');
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = await operation();
    const elapsed = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const ioAfter = await fs.readFile('/proc/self/io', 'utf8');
    const ioValue = (text, key) => Number(text.match(new RegExp(['signatures', 'signature-history'].includes(mode) ? `^${key}: ([0-9]+)$` : `^${key}: (\\\\d+)$`, 'm'))?.[1] ?? 0);
    const io = Object.fromEntries(['rchar', 'wchar', 'read_bytes', 'write_bytes', 'cancelled_write_bytes'].map(key => [key, ioValue(ioAfter, key) - ioValue(ioBefore, key)]));
    const inspection = inspect ? await inspect() : {};
    console.log(JSON.stringify({ label: ['viewer', 'worker'].includes(mode) ? `${label}/${count}` : label, io, wall_ms: elapsed, cpu_ms: (used.user + used.system) / 1000,
      rss_bytes: process.memoryUsage().rss, ...result, ...inspection }));
  };

  if (mode === 'seed') return seed(root, count, size);
  if (mode === 'signature-setup' || mode === 'signatures' || mode === 'signature-history') {
    if (implementationDist) dist = path.resolve(implementationDist);

    return require('./signatures.cjs').runSignatures({ root, count, size, record, seed, html, setup: mode === 'signature-setup', historyOnly: mode === 'signature-history', signatureMode: shape, implementationDist: dist });
  }
  if (mode === 'sync' || mode === 'managed') {
    return require('./sync.cjs').runSync({ root, count, size, samples, record, mode });
  }
  if (mode === 'parser') {
    const baseline = load('html-validation.js').validateHtml;
    const validate = candidate ? require(path.resolve(candidate)).validateHtml : baseline;
    assert.equal(typeof validate, 'function');
    const fixtures = [html(size, shape), '<html><a href="javascript:alert(1)">x</a></html>',
      '<html><template><img src="remote.png"></template></html>', '<select><html></select>',
      '<html><svg><style><a href="javascript:x">x</a></style></svg></html>'];
    for (const fixture of fixtures) assert.deepEqual(validate(fixture), baseline(fixture));

    for (let i = 0; i < samples; i++) {
      await record(`parser/${shape}/${size}`, () => {
        assert.deepEqual(validate(fixtures[0]), { ok: true, errors: [], warnings: [] });
        return { bytes: size, behavior: 'exact validation result', scope: 'in-process validator, prebuilt input; warm after behavior checks' };
      });
    }
    return;
  }
  if (mode === 'viewer') {
    const backend = new (load('backend.js').LocalDocumentBackend)(root);
    assert.equal((await backend.listDocuments()).length, count);
    const server = await load('viewer-http-server.js').startViewerHttpServer(backend,
      load('viewer-network.js').resolveViewerNetworkConfig(0),
      { instanceId: 'benchmark', processId: 'benchmark', protocolVersion: 1, pid: process.pid });
    try {
      await record('viewer/idle', async () => { await delay(1000); return { interval_ms: 1000 }; });
      for (let i = 0; i < samples; i++) {
        await record('viewer/index', async () => {
          const response = await fetch(server.urls[0] + '/');
          assert.equal(response.status, 200);
          const body = await response.text();
          if (count) assert.ok(body.includes('Benchmark 0'));
          return { response_bytes: Buffer.byteLength(body), scope: 'loopback client and server in one process' };
        });
        if (count) await record('viewer/content', async () => {
          const response = await fetch(server.urls[0] + '/documents/bench-00000/content');
          assert.equal(response.status, 200);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(html(size)));
          return { response_bytes: size, behavior: 'exact source bytes' };
        });
      }
    } finally {
      await server.close();
    }
    return;
  }
  if (mode === 'worker') {
    const store = new (load('sync-store.js').ManagedSyncStore)(root);
    await store.enroll();
    for (let i = 0; i < count; i++) {
      await store.publish({ originalBytes: Buffer.from(html(size)), title: `Benchmark ${i}`, type: 'report', sourceFileName: 'fixture.html' }, `bench-${i}`);
    }
    await store.setWorkerEnabled(true);
    const worker = await load('sync-worker.js').startOwnedSyncWorker(root);
    try {
      const deadline = Date.now() + 10000;
      while (worker.status().processState !== 'idle') {
        assert.ok(Date.now() < deadline, 'worker readiness deadline');
        await delay(10);
      }
      for (let i = 0; i < samples; i++) {
        await record('worker/idle', async () => { await delay(1000); return { interval_ms: 1000, state: worker.status().processState }; });
      }
      assert.equal(worker.status().processState, 'idle');
    } finally {
      await worker.close();
    }
    return;
  }
  throw new Error(`Unknown workload ${mode}`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { html, seed };
