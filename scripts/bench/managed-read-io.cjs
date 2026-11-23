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
  // The existing Python companion checks every field and saves parsed values/deltas after exit.
  fs.writeFileSync(destination, JSON.stringify({ exitCode: code, counts,
    proc_io: { raw_before: before, raw_after: after }, rss_bytes: process.memoryUsage().rss,
    scope: 'instrumented complete operation including startup; raw /proc snapshots await companion validation; not primary timing' }, null, 2), { mode: 0o600 });
});
