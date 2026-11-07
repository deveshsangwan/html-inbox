// Separate count probe only. Primary CLI/batch timings never load this preload.
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
const home = process.env.HTML_INBOX_BENCH_HOME;
const destination = process.env.HTML_INBOX_BENCH_IO;
if (!home || !destination) throw new Error('Managed read I/O probe requires explicit synthetic paths');
const ledger = path.join(home, 'sync', 'ledger.json');
const bodies = path.join(home, 'sync', 'bodies') + path.sep;
const open = promises.open;
const counts = { ledgerOpens: 0, checkedLedgerBytes: 0, bodyOpens: 0, bodyBytes: 0 };
const before = fs.readFileSync('/proc/self/io', 'utf8');

promises.open = async (...args) => {
  const file = await open(...args);
  const isLedger = args[0] === ledger;
  const isBody = typeof args[0] === 'string' && args[0].startsWith(bodies);
  if (isLedger || isBody) {
    counts[isLedger ? 'ledgerOpens' : 'bodyOpens'] += 1;
    const read = file.read.bind(file);
    file.read = async (...readArgs) => {
      const result = await read(...readArgs);
      counts[isLedger ? 'checkedLedgerBytes' : 'bodyBytes'] += result.bytesRead;
      return result;
    };
  }
  return file;
};

process.once('exit', (code) => {
  const after = fs.readFileSync('/proc/self/io', 'utf8');
  const value = (text, key) => Number(text.match(new RegExp(`^${key}: (\d+)$`, 'm'))?.[1] ?? 0);
  const io = Object.fromEntries(['rchar', 'wchar', 'syscr', 'read_bytes', 'write_bytes', 'cancelled_write_bytes']
    .map((key) => [key, value(after, key) - value(before, key)]));
  fs.writeFileSync(destination, JSON.stringify({ exitCode: code, counts, io, rss_bytes: process.memoryUsage().rss,
    scope: 'instrumented complete operation including startup; /proc probe overhead included; not primary timing' }, null, 2), { mode: 0o600 });
});
