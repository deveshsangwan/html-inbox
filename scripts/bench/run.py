#!/usr/bin/env python3
"""Linux resource runner. No third party Python packages; build and bundle first."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
BUNDLE = REPO / 'packages/cli/bundle/index.js'
DIST = REPO / 'packages/cli/dist'
HARNESS = [Path(__file__).resolve(), REPO / 'scripts/bench/workload.cjs', REPO / 'scripts/bench/sync.cjs']
SUPPORTED_COUNTS = [0, 100, 1000, 5000, 10000]
SUPPORTED_SIZES = [10240, 1048576, 9437184]
TERMINATE_GRACE_SECONDS = 2
KILL_SETTLE_SECONDS = 2


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workload', choices=['baseline', 'cli', 'viewer', 'worker', 'parser', 'managed', 'sync'])
    parser.add_argument('--counts', default='0,100')
    parser.add_argument('--sizes', default='10240,1048576,9437184')
    parser.add_argument('--samples', type=int, default=3)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--candidate', help='CommonJS module exporting validateHtml for exact-result parser comparison')
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--allow-stale-build', action='store_true',
                        help='measure even when CLI sources are newer than the bundle; recorded in environment.json')
    args = parser.parse_args()

    try:
        args.counts = [int(n) for n in args.counts.split(',')]
        args.sizes = [int(n) for n in args.sizes.split(',')]
    except ValueError:
        parser.error('counts and sizes must be comma-separated integers')

    if not args.node:
        parser.error('node was not found; supply --node with an executable path')
    if args.candidate and args.workload not in ['baseline', 'parser']:
        parser.error('--candidate requires the parser or baseline workload')
    if len(set(args.counts)) != len(args.counts) or len(set(args.sizes)) != len(args.sizes):
        parser.error('counts and sizes must not contain duplicates')
    if any(n not in SUPPORTED_COUNTS for n in args.counts):
        parser.error('counts must be drawn from 0,100,1000,5000,10000')
    if any(n not in SUPPORTED_SIZES for n in args.sizes) or not 1 <= args.samples <= 100 or not 1 <= args.timeout <= 3600:
        parser.error('invalid sizes, samples or timeout')
    if not Path('/proc/self/io').exists() or not hasattr(os, 'wait4') or not hasattr(os, 'pidfd_open'):
        parser.error('resource collection requires Linux /proc, wait4 and pidfd_open')
    if not BUNDLE.is_file() or not (DIST / 'index.js').is_file():
        parser.error('build and bundle first: pnpm build && pnpm --filter html-inbox bundle')

    stale_inputs = stale_build_inputs()
    if stale_inputs and not args.allow_stale_build:
        parser.error(f'CLI sources are newer than the bundle; rebuild or pass --allow-stale-build: {stale_inputs[:5]}')

    args.stale_inputs = stale_inputs
    args.node = str(Path(args.node).resolve())
    args.out = args.out.resolve()
    return args


def stale_build_inputs():
    """Return CLI build inputs modified after the bundle was written.

    Modification times only detect edits or checkouts after the last bundle; the
    fingerprints remain the authoritative identity of the measured bytes.
    """
    bundle_mtime = BUNDLE.stat().st_mtime
    cli = REPO / 'packages/cli'
    inputs = [cli / 'package.json', cli / 'tsconfig.json', REPO / 'pnpm-lock.yaml', *(cli / 'src').rglob('*')]

    return sorted(str(p.relative_to(REPO)) for p in inputs if p.is_file() and p.stat().st_mtime > bundle_mtime)


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_fingerprints(candidate):
    dist_hash = hashlib.sha256()
    for artifact in sorted(DIST.rglob('*.js')):
        dist_hash.update(str(artifact.relative_to(REPO)).encode() + b'\0')
        dist_hash.update(artifact.read_bytes())

    return dict(bundle_sha256=sha256_file(BUNDLE), dist_js_sha256=dist_hash.hexdigest(),
                harness_sha256={str(p.relative_to(REPO)): sha256_file(p) for p in HARNESS},
                candidate_sha256=sha256_file(Path(candidate)) if candidate else None)


def collect_metadata(args, fixture_root):
    node = [args.node]
    git = lambda *command: subprocess.check_output(['git', *command], cwd=REPO, text=True)

    return dict(commit=git('rev-parse', 'HEAD').strip(), dirty=git('status', '--porcelain'),
                node=subprocess.check_output(node + ['--version'], text=True).strip(),
                versions=json.loads(subprocess.check_output(node + ['-p', 'JSON.stringify(process.versions)'], text=True)),
                parser=json.loads((REPO / 'node_modules/parse5/package.json').read_text())['version'],
                filesystem=subprocess.check_output(['stat', '-f', '-c', '%T', str(fixture_root)], text=True).strip(),
                machine=list(os.uname()), samples=args.samples, counts=args.counts, sizes=args.sizes,
                cache='fresh isolated fixtures; filesystem cache uncontrolled/warm; no OS cache eviction',
                bundle_bytes=BUNDLE.stat().st_size, stale_build_inputs=args.stale_inputs,
                allow_stale_build=args.allow_stale_build,
                limits={'timeout_seconds': args.timeout, 'concurrency': 1}, fixture_root=str(fixture_root),
                fingerprints=build_fingerprints(args.candidate), invocation=sys.argv)


def live_group_members(group):
    """List non-zombie processes whose process group is `group`."""
    members = []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        try:
            fields = Path(entry.path, 'stat').read_text().rsplit(')', 1)[1].split()
        except (OSError, IndexError):
            continue
        if int(fields[2]) == group and fields[0] not in 'ZX':
            members.append(int(entry.name))

    return members


def wait_for_group_exit(group, seconds):
    deadline = time.monotonic() + seconds
    while (members := live_group_members(group)) and time.monotonic() < deadline:
        time.sleep(.01)

    return members


def signal_group(group, signum):
    try:
        os.killpg(group, signum)
    except ProcessLookupError:
        pass


class Interrupts:
    """Turn SIGINT/SIGTERM into a flag plus a wakeup descriptor.

    Raising from the handler could abandon a half-finished cleanup, so signals
    are acted on only at explicit checkpoints and while waiting for a child.
    """

    def __init__(self):
        self.signum = None
        self.reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        signal.set_wakeup_fd(writer, warn_on_full_buffer=False)
        for signum in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(signum, self.handle)

    def handle(self, signum, frame):
        self.signum = signum

    def check(self):
        if self.signum is not None:
            raise InterruptedError(f'signal {self.signum}')


class ProcessRunner:
    """Run each workload command in its own process group and collect wait4 resources."""

    def __init__(self, out, env, timeout, interrupts):
        self.out = out
        self.env = env
        self.timeout = timeout
        self.interrupts = interrupts
        self.rows = []
        self.active = None
        self.unclean_groups = []

    def append(self, row):
        self.rows.append(row)
        with (self.out / 'samples.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')

    def run(self, label, command, check=None):
        self.interrupts.check()

        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            start = time.perf_counter()
            child = subprocess.Popen(command, env=self.env, cwd=REPO, stdout=stdout, stderr=stderr, start_new_session=True)
            self.active = child
            try:
                try:
                    self.wait_for_exit(child.pid, label, start + self.timeout)
                    wall_ms = (time.perf_counter() - start) * 1000
                finally:
                    strays, survivors = self.stop_group(child.pid)
                    exit_code, usage = self.reap(child)
                if survivors:
                    raise RuntimeError(f'{label}: process group {child.pid} survived SIGKILL: {survivors}')

                stdout.seek(0)
                stderr.seek(0)
                output, errors = stdout.read().decode(), stderr.read().decode()
                self.append(dict(label=label, command=command, exit_code=exit_code, wall_ms=wall_ms,
                                 cpu_ms=(usage.ru_utime + usage.ru_stime) * 1000, peak_rss_kib=usage.ru_maxrss,
                                 input_blocks=usage.ru_inblock, output_blocks=usage.ru_oublock,
                                 stdout=output, stderr=errors))

                if exit_code:
                    raise RuntimeError(f'{label}: {errors[-2000:]}')
                if strays:
                    raise RuntimeError(f'{label}: descendants {strays} outlived the workload process')
                if check:
                    check(output)
                return output
            except BaseException as error:
                stdout.seek(0)
                stderr.seek(0)
                with (self.out / 'failures.jsonl').open('a') as stream:
                    stream.write(json.dumps(dict(label=label, command=command, error=repr(error),
                                                 stdout=stdout.read().decode(errors='replace'),
                                                 stderr=stderr.read().decode(errors='replace'))) + '\n')
                raise

    def wait_for_exit(self, pid, label, deadline):
        """Wait without reaping, so the zombie leader keeps its group ID reserved for cleanup."""
        process = os.pidfd_open(pid)
        try:
            while True:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    raise TimeoutError(label)

                ready, _, _ = select.select([process, self.interrupts.reader], [], [], remaining)
                if process in ready:
                    return
                if self.interrupts.reader in ready:
                    while True:
                        try:
                            os.read(self.interrupts.reader, 512)
                        except BlockingIOError:
                            break
                    self.interrupts.check()
        finally:
            os.close(process)

    def stop_group(self, group):
        """Terminate the owned group, returning descendants that outlived the leader and any survivors.

        Linux will not reuse the leader's PID as a group ID until the leader is
        reaped, so signalling here cannot reach an unrelated process group.
        """
        strays = [pid for pid in live_group_members(group) if pid != group]

        signal_group(group, signal.SIGTERM)
        wait_for_group_exit(group, TERMINATE_GRACE_SECONDS)
        signal_group(group, signal.SIGKILL)
        survivors = wait_for_group_exit(group, KILL_SETTLE_SECONDS)

        if survivors:
            self.unclean_groups.append(dict(group=group, survivors=survivors))
        return strays, survivors

    def reap(self, child):
        # A leader stuck after SIGKILL stays unreaped and keeps the receipt false rather than blocking forever.
        if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
            raise RuntimeError(f'workload process {child.pid} survived SIGKILL')

        _, status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        self.active = None

        return child.returncode, usage


def run_workloads(args, runner, root):
    node = [args.node]
    helper = node + [str(REPO / 'scripts/bench/workload.cjs')]
    cli = node + [str(BUNDLE)]

    if args.workload in ['baseline', 'cli']:
        for _ in range(args.samples):
            runner.run('cli/version', cli + ['--version'])

    for count in args.counts:
        home = root / f'library-{count}'
        expected_ids = [f'bench-{i:05}' for i in range(count)]
        if args.workload in ['baseline', 'cli', 'viewer']:
            runner.run(f'setup/{count}', helper + ['seed', str(home), str(count), str(args.sizes[0]), '1'])

        if args.workload in ['baseline', 'cli']:
            def check_list(output):
                documents = json.loads(output)
                assert sorted(d['id'] for d in documents) == expected_ids, (count, documents)

            for _ in range(args.samples):
                runner.run(f'cli/list/{count}', cli + ['list', '--json', '--home', str(home)], check_list)
                measure_export(runner, cli, home, root / 'export', count, expected_ids)

        for mode in ['viewer', 'worker', 'managed', 'sync']:
            if args.workload in ['baseline', mode]:
                store = home if mode == 'viewer' else root / f'{mode}-{count}'
                runner.run(f'{mode}/{count}', helper + [mode, str(store), str(count), str(args.sizes[0]), str(args.samples)])

    if args.workload in ['baseline', 'parser']:
        for size in args.sizes:
            for shape in ['text', 'dense']:
                command = helper + ['parser', str(root), '0', str(size), str(args.samples), shape]
                if args.candidate:
                    command.append(str(Path(args.candidate).resolve()))
                runner.run(f'parser/{shape}/{size}', command)

    runner.interrupts.check()


def measure_export(runner, cli, home, destination, count, expected_ids):
    runner.run(f'cli/export/{count}', cli + ['export', '--json', '--home', str(home), '--out', str(destination)])

    exported = list(destination.glob('**/documents/*/content/index.html'))
    assert sorted(content.parent.parent.name for content in exported) == expected_ids
    for content in exported:
        original = home / 'documents' / content.parent.parent.name / 'index.html'
        assert content.read_bytes() == original.read_bytes()

    files = [p for p in destination.rglob('*') if p.is_file()]
    runner.append(dict(label=f'disk/export/{count}', logical_bytes=sum(p.stat().st_size for p in files),
                       allocated_bytes=sum(p.stat().st_blocks * 512 for p in files)))
    shutil.rmtree(destination)


def summarize(rows):
    groups = {}
    for row in rows:
        if 'wall_ms' in row:
            groups.setdefault(row['label'], []).append(row['wall_ms'])
        for line in row.get('stdout', '').splitlines():
            try:
                nested = json.loads(line)
            except ValueError:
                continue
            if isinstance(nested, dict) and 'wall_ms' in nested:
                groups.setdefault('operation/' + nested['label'], []).append(nested['wall_ms'])

    return {label: dict(n=len(values), min_ms=min(values), median_ms=statistics.median(values), max_ms=max(values))
            for label, values in groups.items()}


def main():
    args = parse_arguments()
    args.out.mkdir(parents=True, exist_ok=False)
    interrupts = Interrupts()
    root = Path(tempfile.mkdtemp(prefix='html-inbox-bench-'))
    runner = None
    try:
        env = {'PATH': os.environ.get('PATH', ''), 'HOME': str(root), 'TMPDIR': str(root),
               'XDG_CONFIG_HOME': str(root), 'XDG_STATE_HOME': str(root), 'XDG_DATA_HOME': str(root),
               'HTML_INBOX_HOME': str(root), 'HTML_INBOX_CATALOG_HOME': str(root / 'catalog')}
        runner = ProcessRunner(args.out, env, args.timeout, interrupts)
        (args.out / 'environment.json').write_text(json.dumps(collect_metadata(args, root), indent=2))

        success = False
        try:
            run_workloads(args, runner, root)
            success = True
        finally:
            (args.out / 'summary.json').write_text(json.dumps(dict(success=success, groups=summarize(runner.rows)), indent=2))
    finally:
        # Children may already be killed here; TMPDIR inside the root means this also removes TLS credentials.
        shutil.rmtree(root, ignore_errors=True)
        (args.out / 'cleanup.json').write_text(json.dumps(dict(
            fixture_root_removed=not root.exists(),
            children_reaped=runner is None or runner.active is None,
            process_groups_empty=runner is None or not runner.unclean_groups)))


if __name__ == '__main__':
    main()
