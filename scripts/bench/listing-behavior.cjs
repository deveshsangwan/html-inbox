// Compare exact diagnostics/security outcomes on an owned synthetic fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const [home, ...builds] = process.argv.slice(2);
  await fs.mkdir(home, { mode: 0o700 }); // Refuse an existing path, including real libraries.
  const results = [];

  try {
    for (const dist of builds) {
      const warnings = [];
      const Backend = require(path.join(dist, 'backend.js')).LocalDocumentBackend;
      const documents = path.join(home, 'documents');
      await fs.rm(documents, { recursive: true, force: true });
      const backend = new Backend(home, warning => warnings.push(warning));
      for (const id of ['good', 'json', 'missing', 'directory-link', 'metadata-link', 'html-link', 'identity']) {
        const directory = path.join(documents, id);
        await fs.mkdir(directory, { recursive: true, mode: 0o755 });
        await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ schemaVersion: 1, id,
          title: id, type: 'report', sourceFileName: 'fixture.html', createdAt: '2026-11-07T00:00:00.000Z' }), { mode: 0o644 });
        await fs.writeFile(path.join(directory, 'index.html'), '<html>fixture</html>', { mode: 0o644 });
      }
      await fs.mkdir(path.join(documents, 'unsafe name'));
      await fs.writeFile(path.join(documents, 'json/metadata.json'), '{');
      await fs.rm(path.join(documents, 'missing/index.html'));
      await fs.rm(path.join(documents, 'directory-link'), { recursive: true });
      await fs.symlink(path.join(documents, 'good'), path.join(documents, 'directory-link'));
      for (const [id, file] of [['metadata-link', 'metadata.json'], ['html-link', 'index.html']]) {
        await fs.rm(path.join(documents, id, file));
        await fs.symlink(path.join(documents, 'good', file), path.join(documents, id, file));
      }
      const identityPath = path.join(documents, 'identity/metadata.json');
      const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
      await fs.writeFile(identityPath, JSON.stringify({ ...identity, id: 'different' }));
      const records = await backend.listDocuments();
      assert.deepEqual(records.map(record => record.id), ['good']);
      assert.equal(warnings.length, 6);
      assert.equal(await backend.getDocumentMetadata('absent'), null);
      assert.equal(await backend.getDocumentMetadata('../escape'), null);
      const modes = await Promise.all(['good', 'good/metadata.json', 'good/index.html'].map(async name => (await fs.stat(path.join(documents, name))).mode & 0o777));
      assert.deepEqual(modes, [0o700, 0o600, 0o600]);
      const chmod = fs.chmod;
      let deniedCode;
      fs.chmod = async (...args) => {
        if (String(args[0]) === path.join(documents, 'good')) {
          throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' });
        }
        return chmod(...args);
      };
      try {
        await assert.rejects(backend.getDocumentMetadata('good'), error => {
          deniedCode = error.code;
          return error.code === 'EACCES';
        });
      } finally {
        fs.chmod = chmod;
      }
      results.push({ records, warnings: warnings.slice(0, 6).sort(), modes, deniedCode });
    }
    for (const result of results) assert.deepEqual(result, results[0]);
    console.log(JSON.stringify({ node: process.version, builds, results, equivalent: true }));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
