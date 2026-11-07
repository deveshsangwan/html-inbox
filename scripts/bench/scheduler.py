#!/usr/bin/env python3
"""Paired Linux worker measurements. Execution requires a separately granted slot."""
import argparse
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess
import tarfile
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
PARENT = '610c931b7b22920cce59cf03e49c0de15ebaf2a2'


def fingerprint(directory):
    digest = hashlib.sha256()
    for file in sorted(directory.rglob('*.js')):
        digest.update(str(file.relative_to(directory)).encode() + b'\0' + file.read_bytes())
    return digest.hexdigest()


def emit(file, value):
    with file.open('a') as stream:
        stream.write(json.dumps(value) + '\n')


def processes(group):
    result = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / 'stat').read_text()
            fields = text[text.rfind(')') + 2:].split()
            if int(fields[2]) == group:
                result.append(dict(pid=int(entry.name), ppid=int(fields[1]), state=fields[0],
                                   start_ticks=int(fields[19]), cpu_ticks=int(fields[11]) + int(fields[12]),
                                   rss_bytes=int(fields[21]) * os.sysconf('SC_PAGE_SIZE')))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return result


def terminate(child):
    for signum in [signal.SIGTERM, signal.SIGKILL]:
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass
        if child.returncode is None:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            pid, _ = os.waitpid(-child.pid, os.WNOHANG)
        except ChildProcessError:
            break
        if not pid:
            time.sleep(.01)
    remaining = processes(child.pid)
    if remaining:
        raise RuntimeError(f'Owned process group did not fully reap: {remaining}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True, help='Full committed candidate SHA')
    parser.add_argument('--node20', type=Path, required=True)
    parser.add_argument('--node24', type=Path, required=True)
    parser.add_argument('--phase', choices=['smoke', 'feasibility', 'qualify'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--budget-seconds', type=int, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    if os.name != 'posix' or not Path('/proc/self/stat').exists():
        parser.error('Linux process accounting is required')
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0):
        raise RuntimeError('Could not become a child subreaper')
    if not 60 <= args.budget_seconds <= 36_000:
        parser.error('Supply an explicit bounded execution budget between 60 and 36000 seconds')
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True):
        parser.error('Pin and clean the source/harness before measuring')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    if args.candidate != head:
        parser.error('Candidate must equal the clean current full HEAD')
    if subprocess.check_output(['git', 'merge-base', PARENT, head], cwd=REPO, text=True).strip() != PARENT:
        parser.error('The candidate must descend from the required immediate parent')
    for filename in ['pnpm-lock.yaml', 'package.json', 'packages/cli/package.json']:
        baseline = subprocess.check_output(['git', 'show', f'{PARENT}:{filename}'], cwd=REPO)
        candidate = subprocess.check_output(['git', 'show', f'{head}:{filename}'], cwd=REPO)
        if baseline != candidate:
            parser.error(f'Unexpected dependency/runtime/version change: {filename}')
    runtimes = [('20.20.2', args.node20.resolve()), ('24.19.0', args.node24.resolve())]
    versions = []
    for version, node in runtimes:
        actual = subprocess.check_output([str(node), '--version'], text=True).strip()
        if actual != f'v{version}':
            parser.error(f'Expected Node {version}, got {actual}')
        versions.append(dict(version=actual, path=str(node), sha256=hashlib.sha256(node.read_bytes()).hexdigest()))

    counts = [0] if args.phase == 'smoke' else [0, 1000, 10000]
    samples = 5 if args.phase == 'qualify' else 1
    global_deadline = time.monotonic() + args.budget_seconds
    commands = args.out / 'commands.jsonl'
    rows = []
    fixture_root = None
    groups = []

    def interrupt(signum, _frame):
        raise InterruptedError(f'Received signal {signum}')

    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    metadata = dict(parent=PARENT, candidate=head, phase=args.phase, counts=counts, samples=samples,
                    directions=['none', 'outbound', 'inbound'], idle_ms=65000, case_seconds=240,
                    budget_seconds=args.budget_seconds, runtimes=versions, machine=list(os.uname()),
                    clock_ticks=os.sysconf('SC_CLK_TCK'), observation_ms=100,
                    cache='fresh disposable fixtures; uncontrolled warm OS caches; no cache eviction',
                    harness={file: hashlib.sha256((REPO / 'scripts/bench' / file).read_bytes()).hexdigest()
                             for file in ['scheduler.py', 'scheduler-workload.cjs', 'scheduler-process.cjs']})
    (args.out / 'environment.json').write_text(json.dumps(metadata, indent=2) + '\n')
    try:
        with tempfile.TemporaryDirectory(prefix='html-inbox-scheduler-') as directory:
            fixture_root = Path(directory)
            environment = dict(PATH=f'{args.node24.resolve().parent}:{os.environ.get("PATH", "")}',
                               HOME=directory, USERPROFILE=directory, TMPDIR=directory, TMP=directory, TEMP=directory,
                               XDG_CONFIG_HOME=directory, XDG_STATE_HOME=directory, XDG_DATA_HOME=directory,
                               XDG_CACHE_HOME=directory, ZDOTDIR=directory, HTML_INBOX_CATALOG_HOME=str(fixture_root / 'catalog'))
            metadata['fixture_root'] = directory
            metadata['filesystem'] = subprocess.check_output(['stat', '-f', '-c', '%T', directory], text=True).strip()
            metadata['builds'] = {}
            for label, revision in [('parent', PARENT), ('candidate', head)]:
                export = fixture_root / f'build-{label}'
                export.mkdir()
                archive = subprocess.check_output(['git', 'archive', revision, 'packages/cli/src', 'packages/cli/tsconfig.json', 'tsconfig.base.json'], cwd=REPO)
                with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                    tar.extractall(export, filter='data')
                (export / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
                build_command = [str(REPO / 'node_modules/.bin/tsc-rs'), '-p', str(export / 'packages/cli/tsconfig.json')]
                with (args.out / f'build-{label}.log').open('w') as log:
                    completed = subprocess.run(build_command, cwd=export, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                               timeout=max(1, min(60, global_deadline - time.monotonic())))
                emit(commands, dict(label=f'build-{label}', command=build_command, exit=completed.returncode))
                if completed.returncode:
                    raise RuntimeError(f'{label} build failed')
                dist = export / 'packages/cli/dist'
                metadata['builds'][label] = dict(revision=revision, dist=str(dist), dist_js_sha256=fingerprint(dist))
            (args.out / 'environment.json').write_text(json.dumps(metadata, indent=2) + '\n')

            # Check actual fresh admission without weakening the reader-race assertions.
            for version, node in runtimes:
                for label in ['parent', 'candidate']:
                    command = [str(node), '--test', '--test-name-pattern=an enabled owned worker keeps its process identity',
                               str(Path(metadata['builds'][label]['dist']) / 'sync-ledger-read-race.test.js')]
                    with (args.out / f'reader-race-{version}-{label}.log').open('w') as log:
                        completed = subprocess.run(command, cwd=REPO, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                                   timeout=max(1, min(15, global_deadline - time.monotonic())))
                    emit(commands, dict(label=f'reader-race-{version}-{label}', command=command, exit=completed.returncode))
                    if completed.returncode:
                        raise RuntimeError('The unchanged enabled-worker reader-race check failed')

            for version, node in runtimes:
                for count in counts:
                    for direction in ['none', 'outbound', 'inbound']:
                        for sample in range(samples):
                            order = ['parent', 'candidate'] if sample % 2 == 0 else ['candidate', 'parent']
                            for label in order:
                                if time.monotonic() >= global_deadline:
                                    raise TimeoutError('The granted total execution budget is exhausted; remaining cells are unqualified')
                                name = f'{version}-{count}-{direction}-{sample}-{label}'
                                unit = fixture_root / name
                                unit.mkdir()
                                (unit / '.issue95-fixture').write_text('disposable scheduler fixture\n')
                                command = [str(node), str(REPO / 'scripts/bench/scheduler-workload.cjs'),
                                           metadata['builds'][label]['dist'], str(unit), str(count), direction, '65000']
                                child = None
                                started = time.monotonic()
                                try:
                                    with (args.out / f'{name}.jsonl').open('w') as stdout, (args.out / f'{name}.stderr').open('w') as stderr:
                                        child = subprocess.Popen(command, cwd=REPO, env=environment, stdout=stdout, stderr=stderr, start_new_session=True)
                                        groups.append(child.pid)
                                        while True:
                                            emit(args.out / f'{name}.proc.jsonl', dict(monotonic_ns=time.monotonic_ns(), wall_ns=time.time_ns(), processes=processes(child.pid)))
                                            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                                            if pid:
                                                child.returncode = os.waitstatus_to_exitcode(status)
                                                break
                                            if time.monotonic() - started > 240 or time.monotonic() >= global_deadline:
                                                raise TimeoutError('Preselected case or granted total bound exceeded')
                                            time.sleep(.1)
                                    elapsed = time.monotonic() - started
                                    row = dict(name=name, runtime=version, count=count, direction=direction, sample=sample, revision=label,
                                               command=command, exit=child.returncode, elapsed_seconds=elapsed,
                                               waited_cpu_seconds=usage.ru_utime + usage.ru_stime, waited_peak_rss_kib=usage.ru_maxrss)
                                    traces = [json.loads(line) for line in (args.out / f'{name}.jsonl').read_text().splitlines()]
                                    idle = [entry for entry in traces if entry.get('type') == 'idle-stop']
                                    if idle:
                                        row['idle'] = idle[-1]['observations']
                                    row['qualified_case'] = child.returncode == 0 and bool(idle)
                                except (InterruptedError, KeyboardInterrupt) as error:
                                    row = dict(name=name, command=command, qualified_case=False, error=repr(error))
                                    rows.append(row)
                                    emit(commands, row)
                                    raise
                                except Exception as error:
                                    row = dict(name=name, runtime=version, count=count, direction=direction, sample=sample, revision=label,
                                               command=command, qualified_case=False, error=repr(error))
                                finally:
                                    if child:
                                        try:
                                            terminate(child)
                                        except Exception as error:
                                            row['qualified_case'] = False
                                            row['cleanup_error'] = repr(error)
                                            rows.append(row)
                                            emit(commands, row)
                                            raise
                                    # Only disposable homes are removed. Artifacts retain every failed run.
                                    shutil.rmtree(unit)
                                rows.append(row)
                                emit(commands, row)
                                print(json.dumps({key: row[key] for key in ['name', 'qualified_case']}), flush=True)
    finally:
        remaining = [dict(group=group, processes=processes(group)) for group in groups if processes(group)]
        (args.out / 'cleanup.json').write_text(json.dumps(dict(process_groups_reaped=not remaining, remaining=remaining,
                                                           fixture_root_removed=fixture_root is None or not fixture_root.exists()), indent=2) + '\n')
        pairs = []
        for index in range(0, len(rows) - 1, 2):
            pair = rows[index:index + 2]
            if all(row.get('qualified_case') for row in pair):
                values = {row['revision']: row['idle'][0]['cpuFraction'] for row in pair}
                pairs.append(dict(runtime=pair[0]['runtime'], count=pair[0]['count'], direction=pair[0]['direction'], sample=pair[0]['sample'],
                                  parent=values['parent'], candidate=values['candidate'], delta=values['candidate'] - values['parent']))
        summary = dict(phase=args.phase, qualified_cases=sum(bool(row.get('qualified_case')) for row in rows), total_cases=len(rows),
                       required_cases=len(runtimes) * len(counts) * 3 * samples * 2,
                       complete=len(rows) == len(runtimes) * len(counts) * 3 * samples * 2 and all(row.get('qualified_case') for row in rows),
                       pairs=pairs, performance_retention_decision='pending all required gates and independent reviews')
        summary['groups'] = []
        keys = sorted({(pair['runtime'], pair['count'], pair['direction']) for pair in pairs})
        for runtime, count, direction in keys:
            group = [pair for pair in pairs if (pair['runtime'], pair['count'], pair['direction']) == (runtime, count, direction)]
            values = {key: [pair[key] for pair in group] for key in ['parent', 'candidate', 'delta']}
            summary['groups'].append(dict(runtime=runtime, count=count, direction=direction, n=len(group),
                                          cpu_fraction={key: dict(median=statistics.median(items), minimum=min(items), maximum=max(items))
                                                        for key, items in values.items()}))
        (args.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if not summary['complete']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
