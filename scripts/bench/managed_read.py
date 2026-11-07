"""Managed read workloads composed with run.py's existing owned-process runner."""
import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import statistics
import subprocess

PARENT = '610c931b7b22920cce59cf03e49c0de15ebaf2a2'
CAPABILITY = 'AAAAAAAAAAAAAAAAAAAAAA'
OWNER = '11111111-1111-4111-8111-111111111111'
GENERATED_AT = '2026-11-07T00:00:00.000Z'
OWNER_FILE = '__html-inbox/ownership.json'
MANIFEST_FILE = f'i/{CAPABILITY}/snapshot-manifest.json'
PROC_IO_FIELDS = ('rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes', 'cancelled_write_bytes')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_proc_io(text):
    if not isinstance(text, str):
        raise ValueError('/proc I/O snapshot must be text')

    values = {}
    for line in text.splitlines():
        name, separator, number = line.partition(':')
        if separator != ':' or name not in PROC_IO_FIELDS or name in values:
            raise ValueError(f'Unexpected or duplicate /proc I/O field: {name!r}')
        if not re.fullmatch(r'[0-9]+', number.strip()):
            raise ValueError(f'Invalid integer for /proc I/O field: {name}')

        values[name] = int(number.strip())

    if set(values) != set(PROC_IO_FIELDS):
        raise ValueError(f'Missing /proc I/O fields: {sorted(set(PROC_IO_FIELDS) - set(values))}')

    return values


def checked_proc_io(raw_before, raw_after):
    before = parse_proc_io(raw_before)
    after = parse_proc_io(raw_after)
    delta = {name: after[name] - before[name] for name in PROC_IO_FIELDS}
    if any(value < 0 for value in delta.values()):
        raise ValueError('/proc I/O counters decreased within one process')

    return dict(raw_before=raw_before, raw_after=raw_after, before=before, after=after, delta=delta)


def build_info(repo):
    repo = Path(repo).resolve()
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True)
    if dirty:
        raise ValueError(f'Measured checkout is dirty: {repo}')
    bundle = repo / 'packages/cli/bundle/index.js'
    modules = {str(p.relative_to(repo)): sha(p.read_bytes()) for p in sorted((repo / 'packages/cli/dist').rglob('*.js'))}
    if not modules:
        raise ValueError(f'Build the measured checkout first: {repo}')
    return dict(repo=str(repo), commit=commit, bundle_sha256=sha(bundle.read_bytes()), bundle_bytes=bundle.stat().st_size,
                dist_js=modules, dist_sha256=sha(json.dumps(modules, sort_keys=True, separators=(',', ':')).encode()))


def inventory(directory):
    assert directory.is_dir() and not directory.is_symlink() and directory.stat().st_mode & 0o077 == 0
    files = {}
    for filename in sorted(directory.rglob('*')):
        if filename.is_symlink():
            raise AssertionError(f'Unexpected output symlink: {filename}')
        if filename.is_file():
            info = filename.stat()
            assert info.st_nlink == 1 and info.st_mode & 0o077 == 0
            data = filename.read_bytes()
            files[str(filename.relative_to(directory))] = dict(sha256=sha(data), size=len(data))
        else:
            assert filename.is_dir() and filename.stat().st_mode & 0o077 == 0
    return files


def inspect_export(destination, spec, stdout, deterministic=False):
    result = json.loads(stdout)
    assert set(result) == {'outputDir', 'capability', 'inboxPath', 'ownerId', 'manifest'}
    assert result['outputDir'] == str(destination) and result['capability'] == CAPABILITY
    assert result['inboxPath'] == f'/i/{CAPABILITY}'
    owner = json.loads((destination / OWNER_FILE).read_text())
    assert set(owner) == {'schemaVersion', 'ownerId'} and owner['schemaVersion'] == 1
    assert owner['ownerId'] == result['ownerId']
    assert re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', owner['ownerId'])
    assert (destination / OWNER_FILE).read_bytes() == json.dumps(dict(schemaVersion=1, ownerId=owner['ownerId']), indent=2).encode()
    manifest = json.loads((destination / MANIFEST_FILE).read_text())
    assert manifest == result['manifest']
    assert set(manifest) == {'schemaVersion', 'generatedAt', 'documentCount', 'snapshotHash', 'files'}
    assert manifest['schemaVersion'] == 1
    assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', manifest['generatedAt'])
    datetime.datetime.fromisoformat(manifest['generatedAt'].replace('Z', '+00:00'))
    owned = [entry for entry in spec['documents'] if not entry['metadata'].get('origin')]
    assert manifest['documentCount'] == len(owned)
    files = inventory(destination)
    expected_paths = {'index.html', OWNER_FILE, f'i/{CAPABILITY}/index.html', f'i/{CAPABILITY}/assets/viewer.css',
                      f'i/{CAPABILITY}/assets/viewer.js', f'i/{CAPABILITY}/security-headers.json', MANIFEST_FILE}
    for entry in owned:
        prefix = f"i/{CAPABILITY}/documents/{entry['metadata']['id']}"
        expected_paths.update({f'{prefix}/index.html', f'{prefix}/content/index.html', f'{prefix}/copy.json'})
    assert set(files) == expected_paths
    digest = hashlib.sha256()
    paths = []
    for entry in manifest['files']:
        assert set(entry) == {'path', 'sha256', 'size'}
        name = PurePosixPath(entry['path'])
        assert not name.is_absolute() and '..' not in name.parts
        assert files[entry['path']] == {'sha256': entry['sha256'], 'size': entry['size']}
        paths.append(entry['path'])
        for value in [entry['path'], entry['sha256'], str(entry['size'])]:
            digest.update(value.encode()); digest.update(b'\0')
    assert paths == sorted(set(paths))
    assert set(files) == set(paths) | {MANIFEST_FILE}
    assert digest.hexdigest() == manifest['snapshotHash']
    canonical = dict(schemaVersion=1, generatedAt=manifest['generatedAt'], documentCount=manifest['documentCount'],
                     snapshotHash=manifest['snapshotHash'], files=[dict(path=e['path'], sha256=e['sha256'], size=e['size']) for e in manifest['files']])
    assert (destination / MANIFEST_FILE).read_bytes() == json.dumps(canonical, indent=2).encode()
    if not deterministic:
        canonical_result = dict(outputDir=str(destination), capability=CAPABILITY, inboxPath=f'/i/{CAPABILITY}', ownerId=owner['ownerId'], manifest=canonical)
        assert stdout == json.dumps(canonical_result, indent=2) + '\n'
    content_paths = {name for name in files if name.endswith('/content/index.html')}
    assert content_paths == {f"i/{CAPABILITY}/documents/{entry['metadata']['id']}/content/index.html" for entry in owned}
    for entry in owned:
        filename = f"i/{CAPABILITY}/documents/{entry['metadata']['id']}/content/index.html"
        assert files[filename] == {'sha256': entry['sha256'], 'size': entry['bytes']}
    if deterministic:
        assert owner['ownerId'] == OWNER and manifest['generatedAt'] == GENERATED_AT
    return dict(files=files, result=result)


def compare_exports(first_dir, second_dir, first, second, deterministic):
    assert set(first['files']) == set(second['files'])
    differences = []
    for name in first['files']:
        if not deterministic and name in [OWNER_FILE, MANIFEST_FILE]:
            if (first_dir / name).read_bytes() != (second_dir / name).read_bytes():
                differences.append(name)
            continue
        assert (first_dir / name).read_bytes() == (second_dir / name).read_bytes(), name
    # CLI has no owner/time flags. Their complete raw values and derived hashes remain in evidence.
    return dict(exact_all_file_bytes=deterministic, stable_file_bytes_equal=True, differing_nonce_files=differences,
                first_owner=first['result']['ownerId'], second_owner=second['result']['ownerId'],
                first_generated_at=first['result']['manifest']['generatedAt'], second_generated_at=second['result']['manifest']['generatedAt'])


def run_count(args, repo, root, count, node, run, rows, builds):
    companion = node + [str(repo / 'scripts/bench/managed-read.cjs')]
    fixture = root / f'managed-read-{count}'
    size = 10240
    dist = {role: str(Path(info['repo']) / 'packages/cli/dist') for role, info in builds.items()}
    bundles = {role: node + [str(Path(info['repo']) / 'packages/cli/bundle/index.js')] for role, info in builds.items()}

    def emit(name, value):
        with (args.out / name).open('a') as output:
            output.write(json.dumps(value) + '\n')

    def execute(label, command, extra_env=None, destination=None, evidence=None):
        try:
            output = run(label, command, extra_env=extra_env)
        finally:
            if destination is not None:
                assert destination.parent == root
                # Preserve only generated export trees, including partial failures, never the library or donor.
                paths = [destination, *root.glob(destination.name + '.staging-*'), *root.glob(destination.name + '.backup-*')]
                for generated in paths:
                    if generated.exists() or generated.is_symlink():
                        target = args.out / 'outputs' / evidence / generated.name
                        if generated.is_symlink():
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.symlink_to(generated.readlink())
                        else:
                            shutil.copytree(generated, target, symlinks=True)

        row = rows[-1]
        assert not row['stderr'], f'Unexpected diagnostic: {row["stderr"]}'
        return output, row

    def control(fixture_root, label):
        spec = json.loads((fixture_root / 'fixture.json').read_text())
        exports = {}
        for role in ['baseline', 'candidate']:
            destination = root / f'{label}-{role}-api'
            output, _ = execute(f'behavior/{label}/{role}/api-export',
                                companion + ['api-export', dist[role], str(fixture_root), role, str(destination)],
                                destination=destination, evidence=Path(label) / role / 'api-export')
            exports[role] = (destination, inspect_export(destination, spec, output, deterministic=True))
            batch, _ = execute(f'behavior/{label}/{role}/batch', companion + ['batch', dist[role], str(fixture_root), role])
            assert json.loads(batch)['documents'] == spec['documents']
        comparison = compare_exports(exports['baseline'][0], exports['candidate'][0], exports['baseline'][1], exports['candidate'][1], True)
        emit('behavior.jsonl', dict(label=label, comparison=comparison, documents=spec['documents']))
        assert sha((Path(spec['home']) / 'sync/ledger.json').read_bytes()) == spec['ledgerSha256']
        return spec

    execute(f'setup/managed-read/{count}', companion + ['seed', dist['baseline'], str(fixture), str(count), str(size), 'owned'])
    spec = control(fixture, f'owned-{count}')
    if count == args.managed_first_count:
        mixed = root / 'managed-read-mixed'
        execute('setup/managed-read/mixed', companion + ['seed', dist['baseline'], str(mixed), '2', str(size), 'mixed'])
        control(mixed, 'mixed-origins-terminal-suppressed')

    pairs = []
    for sample in range(args.samples):
        order = ['baseline', 'candidate'] if sample % 2 == 0 else ['candidate', 'baseline']
        exports = {}
        batches = {}
        for role in order:
            destination = root / f'cli-{count}-{sample}-{role}'
            output, row = execute(f'managed-read/cli-export/{role}/{count}',
                                  bundles[role] + ['export', '--json', '--home', spec['home'], '--capability', CAPABILITY, '--out', str(destination)],
                                  destination=destination, evidence=Path(f'owned-{count}') / f'pair-{sample}' / role / 'cli-export')
            exports[role] = (destination, inspect_export(destination, spec, output), row)
            batch, batch_row = execute(f'managed-read/batch/{role}/{count}', companion + ['batch', dist[role], str(fixture), role])
            batches[role] = (json.loads(batch), batch_row)
        comparison = compare_exports(exports['baseline'][0], exports['candidate'][0], exports['baseline'][1], exports['candidate'][1], False)
        assert batches['baseline'][0]['documents'] == batches['candidate'][0]['documents'] == spec['documents']
        pair = dict(count=count, sample=sample, order=order, equivalence=comparison, metrics={})
        for metric, baseline, candidate in [
            ('cli_export_process_ms', exports['baseline'][2]['wall_ms'], exports['candidate'][2]['wall_ms']),
            ('cli_export_process_cpu_ms', exports['baseline'][2]['cpu_ms'], exports['candidate'][2]['cpu_ms']),
            ('cli_export_process_peak_rss_kib', exports['baseline'][2]['peak_rss_kib'], exports['candidate'][2]['peak_rss_kib']),
            ('cli_export_input_blocks', exports['baseline'][2]['input_blocks'], exports['candidate'][2]['input_blocks']),
            ('cli_export_output_blocks', exports['baseline'][2]['output_blocks'], exports['candidate'][2]['output_blocks']),
            ('batch_process_ms', batches['baseline'][1]['wall_ms'], batches['candidate'][1]['wall_ms']),
            ('batch_process_cpu_ms', batches['baseline'][1]['cpu_ms'], batches['candidate'][1]['cpu_ms']),
            ('batch_process_peak_rss_kib', batches['baseline'][1]['peak_rss_kib'], batches['candidate'][1]['peak_rss_kib']),
            ('batch_operation_ms', batches['baseline'][0]['wall_ms'], batches['candidate'][0]['wall_ms']),
            ('batch_operation_cpu_ms', batches['baseline'][0]['cpu_ms'], batches['candidate'][0]['cpu_ms']),
            ('batch_operation_rss_bytes', batches['baseline'][0]['rss_bytes'], batches['candidate'][0]['rss_bytes']),
        ]:
            pair['metrics'][metric] = dict(baseline=baseline, candidate=candidate, delta=candidate-baseline,
                                          percent=(candidate/baseline-1)*100 if baseline else None)
        pairs.append(pair)
        emit('pairs.jsonl', pair)

    # Separate full-operation I/O probes, never part of primary paired timing labels.
    for role in ['baseline', 'candidate']:
        for operation in ['cli-export', 'batch']:
            profile = args.out / f'io-{count}-{role}-{operation}.json'
            overrides = {'NODE_OPTIONS': '--require=' + str(repo / 'scripts/bench/managed-read-io.cjs'),
                         'HTML_INBOX_BENCH_HOME': spec['home'], 'HTML_INBOX_BENCH_IO': str(profile)}
            if operation == 'cli-export':
                destination = root / f'io-export-{count}-{role}'
                command = bundles[role] + ['export', '--json', '--home', spec['home'], '--capability', CAPABILITY, '--out', str(destination)]
            else:
                command = companion + ['batch', dist[role], str(fixture), role]
            output, _ = execute(f'count-probe/{operation}/{role}/{count}', command, overrides,
                                destination=destination if operation == 'cli-export' else None,
                                evidence=Path(f'owned-{count}') / role / 'count-probe')
            if operation == 'cli-export':
                inspect_export(destination, spec, output)
            probe = json.loads(profile.read_text())
            probe['proc_io'] = checked_proc_io(probe['proc_io']['raw_before'], probe['proc_io']['raw_after'])
            probe['io'] = probe['proc_io']['delta']
            probe['scope'] = 'instrumented complete operation including startup; raw /proc snapshots validated in parent; parent parsing excluded from process metrics; not primary timing'
            profile.write_text(json.dumps(probe, indent=2) + '\n')
            assert probe['exitCode'] == 0
            assert probe['counts']['bodyOpens'] == count and probe['counts']['bodyBytes'] == count * size
            # CLI selection performs its independent managed-lifecycle snapshot before export.
            reads = count + (2 if operation == 'cli-export' else 1)
            assert probe['counts']['ledgerOpens'] == reads
            ledger = Path(spec['home']) / 'sync/ledger.json'
            assert probe['counts']['checkedLedgerBytes'] == reads * ledger.stat().st_size
            assert probe['io']['rchar'] >= probe['counts']['checkedLedgerBytes'] + probe['counts']['bodyBytes']
            assert probe['io']['syscr'] >= probe['counts']['ledgerOpens'] + probe['counts']['bodyOpens']
    assert sha((Path(spec['home']) / 'sync/ledger.json').read_bytes()) == spec['ledgerSha256']
    emit('paired-summary.jsonl', dict(count=count, n=len(pairs), metrics={
        key: dict(delta_min=min(pair['metrics'][key]['delta'] for pair in pairs),
                  delta_median=statistics.median(pair['metrics'][key]['delta'] for pair in pairs),
                  delta_max=max(pair['metrics'][key]['delta'] for pair in pairs),
                  percent_median=statistics.median(pair['metrics'][key]['percent'] for pair in pairs
                                                  if pair['metrics'][key]['percent'] is not None)
                  if any(pair['metrics'][key]['percent'] is not None for pair in pairs) else None)
        for key in pairs[0]['metrics']}))
