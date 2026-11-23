#!/usr/bin/env python3
"""Linux resource runner. No third party Python packages; build and bundle first."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
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
MAX_FIXTURE_BYTES = 1 << 30
DEFERRED_SIGNALS = [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]
TERMINATE_GRACE_SECONDS = 2
KILL_SETTLE_SECONDS = 2
PROBE_TIMEOUT_SECONDS = 60
HASH_CHUNK_BYTES = 1 << 20


class BehaviorCheckError(RuntimeError):
    """A workload produced output that does not match its fixture."""


def expect(condition, message):
    # Explicit raises keep behavior checks active under `python -O`, which strips assert statements.
    if not condition:
        raise BehaviorCheckError(message)


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
                        help='measure even when build inputs are newer than the build; recorded in environment.json')
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
    if any(n not in SUPPORTED_SIZES for n in args.sizes):
        parser.error('sizes must be drawn from 10240,1048576,9437184')
    if args.workload != 'parser' and max(args.counts) * args.sizes[0] > MAX_FIXTURE_BYTES:
        parser.error('record count times the first size must not exceed 1 GiB of fixture bodies')
    if not 1 <= args.samples <= 100:
        parser.error('samples must be between 1 and 100')
    if not 1 <= args.timeout <= 3600:
        parser.error('timeout must be between 1 and 3600 seconds')
    if not Path('/proc/self/io').exists() or not hasattr(os, 'pidfd_open'):
        parser.error('resource collection requires Linux 5.3+ /proc and Python 3.9+ pidfd_open')
    if not BUNDLE.is_file() or not (DIST / 'index.js').is_file():
        parser.error('build and bundle first: pnpm build && pnpm --filter html-inbox bundle')

    stale_inputs = stale_build_inputs()
    if stale_inputs and not args.allow_stale_build:
        parser.error(f'the build is older than its inputs; rebuild or pass --allow-stale-build: {stale_inputs[:5]}')

    args.stale_inputs = stale_inputs
    args.node = str(Path(args.node).resolve())
    args.out = args.out.resolve()
    return args


def stale_build_inputs():
    """Return build inputs newer than the compiled output, and the bundle if it predates that output.

    Modification times detect edits or checkouts after the last build, and a
    bundle refreshed over old compiled output. The fingerprints remain the
    authoritative identity of the measured bytes.
    """
    compiled_mtime = max(p.stat().st_mtime for p in DIST.rglob('*.js'))
    cli = REPO / 'packages/cli'
    inputs = [cli / 'package.json', cli / 'tsconfig.json', REPO / 'tsconfig.base.json', REPO / 'pnpm-lock.yaml',
              *(cli / 'src').rglob('*')]

    stale = sorted(str(p.relative_to(REPO)) for p in inputs if p.is_file() and p.stat().st_mtime > compiled_mtime)
    if BUNDLE.stat().st_mtime < compiled_mtime:
        stale.append(f'{BUNDLE.relative_to(REPO)} predates packages/cli/dist')
    return stale


def update_hash(digest, path):
    # Children inherit the runner's memory high-water mark at exec, so large files are never read whole.
    with path.open('rb') as stream:
        while chunk := stream.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest


def sha256_file(path):
    return update_hash(hashlib.sha256(), path).hexdigest()


def build_fingerprints(args):
    dist_hash = hashlib.sha256()
    for artifact in sorted(DIST.rglob('*.js')):
        dist_hash.update(str(artifact.relative_to(REPO)).encode() + b'\0')
        update_hash(dist_hash, artifact)

    return dict(bundle_sha256=sha256_file(BUNDLE), dist_js_sha256=dist_hash.hexdigest(),
                node_sha256=sha256_file(Path(args.node)),
                harness_sha256={str(p.relative_to(REPO)): sha256_file(p) for p in HARNESS},
                candidate_sha256=sha256_file(Path(args.candidate)) if args.candidate else None)


def host_description():
    cpuinfo = Path('/proc/cpuinfo').read_text()
    model = next((line.split(':', 1)[1].strip() for line in cpuinfo.splitlines() if line.startswith('model name')), None)
    memory = next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))

    return dict(machine=list(os.uname()), cpu_model=model, cpu_count=os.cpu_count(), mem_total_kib=int(memory),
                python=sys.version)


def load_average():
    return [float(value) for value in Path('/proc/loadavg').read_text().split()[:3]]


def runner_peak_rss_kib():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


def collect_metadata(args, runner, fixture_root):
    # Probes run under the same process-group supervision and environment as workloads, but record no samples.
    def probe(label, *command):
        return runner.capture(f'probe/{label}', list(command), min(PROBE_TIMEOUT_SECONDS, args.timeout))

    return dict(commit=probe('commit', 'git', 'rev-parse', 'HEAD').strip(), dirty=probe('dirty', 'git', 'status', '--porcelain'),
                node=probe('node-version', args.node, '--version').strip(),
                versions=json.loads(probe('node-versions', args.node, '-p', 'JSON.stringify(process.versions)')),
                parser=json.loads((REPO / 'node_modules/parse5/package.json').read_text())['version'],
                filesystem=probe('filesystem', 'stat', '-f', '-c', '%T', str(fixture_root)).strip(),
                host=host_description(), load_average_before=load_average(),
                samples=args.samples, counts=args.counts, sizes=args.sizes,
                cache='fresh isolated fixtures; filesystem cache uncontrolled/warm; no OS cache eviction',
                bundle_bytes=BUNDLE.stat().st_size, stale_build_inputs=args.stale_inputs,
                allow_stale_build=args.allow_stale_build,
                limits={'timeout_seconds': args.timeout, 'concurrency': 1}, fixture_root=str(fixture_root),
                fingerprints=build_fingerprints(args), runner_peak_rss_kib_before_workloads=runner_peak_rss_kib(),
                invocation=sys.argv)


def live_group_members(group):
    """List non-zombie processes whose process group is `group`."""
    members = []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        # Task names are raw bytes and may not be valid UTF-8; only the numeric fields after them are parsed.
        try:
            fields = Path(entry.path, 'stat').read_bytes().rsplit(b')', 1)[1].split()
            state, process_group = fields[0], int(fields[2])
        except (OSError, IndexError, ValueError):
            continue
        if process_group == group and state not in (b'Z', b'X'):
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
    """Turn SIGINT/SIGTERM/SIGHUP into a flag plus a wakeup descriptor.

    Raising from the handler could abandon a half-finished cleanup, so signals
    are acted on only at explicit checkpoints and while waiting for a child.
    """

    def __init__(self):
        self.signum = None
        self.reader, writer = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        signal.set_wakeup_fd(writer, warn_on_full_buffer=False)
        for signum in DEFERRED_SIGNALS:
            signal.signal(signum, self.handle)

    def handle(self, signum, frame):
        self.signum = signum

    def drain(self):
        while True:
            try:
                os.read(self.reader, 512)
            except BlockingIOError:
                return

    def check(self):
        if self.signum is not None:
            raise InterruptedError(f'signal {self.signum}')


class ProcessRunner:
    """Run each command in its own process group and collect wait4 resources."""

    def __init__(self, out, env, timeout, interrupts):
        self.out = out
        self.env = env
        self.timeout = timeout
        self.interrupts = interrupts
        self.rows = []
        self.active = None
        self.unverified_groups = {}

    def append(self, row):
        self.rows.append(row)
        with (self.out / 'samples.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')

    def run(self, label, command, check=None):
        """Run a measured command; its row records whether the behavior check passed."""
        def measured(result, completed):
            behavior = 'not checked: command failed' if not completed else 'unchecked'
            try:
                if completed and check:
                    check(result['output'])
                    behavior = 'passed'
            except BaseException:
                behavior = 'failed'
                raise
            finally:
                self.append(dict(label=label, command=command, exit_code=result['exit_code'], wall_ms=result['wall_ms'],
                                 cpu_ms=result['cpu_ms'], peak_rss_kib=result['peak_rss_kib'],
                                 input_blocks=result['input_blocks'], output_blocks=result['output_blocks'],
                                 behavior=behavior, stdout=result['output'], stderr=result['errors']))
            return result['output']

        return self.supervise(label, command, self.timeout, measured)

    def capture(self, label, command, timeout):
        """Run an unmeasured helper command, such as a metadata probe, and return its output."""
        return self.supervise(label, command, timeout, lambda result, completed: result['output'])

    def supervise(self, label, command, timeout, finish):
        self.interrupts.check()

        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                result = self.execute(label, command, timeout, stdout, stderr)
                if result['exit_code']:
                    finish(result, False)
                    raise RuntimeError(f"{label}: exit {result['exit_code']}: {result['errors'][-2000:]}")
                if result['strays']:
                    finish(result, False)
                    raise RuntimeError(f"{label}: descendants {result['strays']} outlived the workload process")
                return finish(result, True)
            except BaseException as error:
                self.record_failure(label, command, error, stdout, stderr)
                raise

    def execute(self, label, command, timeout, stdout, stderr):
        start = time.perf_counter()
        child = subprocess.Popen(command, env=self.env, cwd=REPO, stdout=stdout, stderr=stderr, start_new_session=True)
        self.active = child
        self.unverified_groups[child.pid] = []
        try:
            self.wait_for_exit(child.pid, label, start + timeout)
            wall_ms = (time.perf_counter() - start) * 1000
        finally:
            strays, survivors = self.stop_group(child.pid)
            exit_code, usage = self.reap(child)
        if survivors:
            raise RuntimeError(f'{label}: process group {child.pid} survived SIGKILL: {survivors}')

        stdout.seek(0)
        stderr.seek(0)
        return dict(exit_code=exit_code, wall_ms=wall_ms, cpu_ms=(usage.ru_utime + usage.ru_stime) * 1000,
                    peak_rss_kib=usage.ru_maxrss, input_blocks=usage.ru_inblock, output_blocks=usage.ru_oublock,
                    output=stdout.read().decode(errors='replace'), errors=stderr.read().decode(errors='replace'),
                    strays=strays)

    def record_failure(self, label, command, error, stdout, stderr):
        stdout.seek(0)
        stderr.seek(0)
        # A cleanup failure raised during a timeout or interrupt keeps the original cause visible.
        with (self.out / 'failures.jsonl').open('a') as stream:
            stream.write(json.dumps(dict(label=label, command=command, error=repr(error),
                                         context=repr(error.__context__) if error.__context__ else None,
                                         stdout=stdout.read().decode(errors='replace'),
                                         stderr=stderr.read().decode(errors='replace'))) + '\n')

    def wait_for_exit(self, pid, label, deadline):
        """Wait without reaping, so the zombie leader keeps its group ID reserved for cleanup."""
        process = os.pidfd_open(pid)
        poller = select.poll()
        poller.register(process, select.POLLIN)
        poller.register(self.interrupts.reader, select.POLLIN)
        try:
            while True:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    raise TimeoutError(label)

                ready = {fd for fd, _ in poller.poll(remaining * 1000)}
                # A pending signal wins over a simultaneous exit, so cancellation is never lost.
                if self.interrupts.reader in ready:
                    self.interrupts.drain()
                    self.interrupts.check()
                if process in ready:
                    return
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
            self.unverified_groups[group] = survivors
        else:
            del self.unverified_groups[group]
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

    # A trivial process shows the peak RSS floor that every process row inherits from the runner.
    runner.run('control/spawn-floor', ['/bin/true'])

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
                listed = sorted(document['id'] for document in json.loads(output))
                expect(listed == expected_ids, f'list returned {listed[:5]}..., expected {count} fixture IDs')

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

    runner.run('control/spawn-floor', ['/bin/true'])
    runner.interrupts.check()


def measure_export(runner, cli, home, destination, count, expected_ids):
    def check_export(output):
        # Even an empty library exports the private root, ownership marker and one inbox index.
        expect((destination / 'index.html').is_file(), 'export has no root index.html')
        expect((destination / '__html-inbox/ownership.json').is_file(), 'export has no ownership marker')
        expect(len(list(destination.glob('i/*/index.html'))) == 1, 'export does not have exactly one inbox index')

        exported = list(destination.glob('**/documents/*/content/index.html'))
        exported_ids = sorted(content.parent.parent.name for content in exported)
        expect(exported_ids == expected_ids, f'export wrote {len(exported_ids)} documents, expected {count}')
        for content in exported:
            original = home / 'documents' / content.parent.parent.name / 'index.html'
            expect(content.read_bytes() == original.read_bytes(), f'{content} differs from its source document')

    runner.run(f'cli/export/{count}', cli + ['export', '--json', '--home', str(home), '--out', str(destination)], check_export)

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


def cleanup_receipt(root, runner):
    return dict(fixture_root_removed=not root.exists(),
                children_reaped=runner.active is None,
                process_groups_empty=not runner.unverified_groups,
                fixture_root=str(root),
                unverified_groups=[dict(group=group, survivors=members) for group, members in runner.unverified_groups.items()])


def main():
    args = parse_arguments()
    args.out.mkdir(parents=True, exist_ok=False)
    interrupts = Interrupts()
    root = Path(tempfile.mkdtemp(prefix='html-inbox-bench-'))
    env = {'PATH': os.environ.get('PATH', ''), 'HOME': str(root), 'TMPDIR': str(root),
           'XDG_CONFIG_HOME': str(root), 'XDG_STATE_HOME': str(root), 'XDG_DATA_HOME': str(root),
           'HTML_INBOX_HOME': str(root), 'HTML_INBOX_CATALOG_HOME': str(root / 'catalog')}
    runner = ProcessRunner(args.out, env, args.timeout, interrupts)
    workloads_succeeded = False
    try:
        (args.out / 'environment.json').write_text(json.dumps(collect_metadata(args, runner, root), indent=2))
        run_workloads(args, runner, root)
        workloads_succeeded = True
    except InterruptedError:
        pass
    finally:
        # Cleanup decides success too: a run that leaves fixtures or processes behind is not accepted.
        # TMPDIR is inside the root, so this also removes TLS credentials.
        shutil.rmtree(root, ignore_errors=True)
        cleanup = cleanup_receipt(root, runner)
        is_clean = cleanup['fixture_root_removed'] and cleanup['children_reaped'] and cleanup['process_groups_empty']
        # A signal received at any point, including during cleanup, cancels the run.
        interrupted = interrupts.signum is not None
        (args.out / 'cleanup.json').write_text(json.dumps(cleanup, indent=2))
        (args.out / 'summary.json').write_text(json.dumps(dict(
            success=workloads_succeeded and is_clean and not interrupted, interrupted_by=interrupts.signum,
            load_average_after=load_average(), runner_peak_rss_kib_after=runner_peak_rss_kib(),
            groups=summarize(runner.rows)), indent=2))

    if interrupted:
        print(f'interrupted by signal {interrupts.signum}; see {args.out}', file=sys.stderr)
        sys.exit(128 + interrupts.signum)
    if not is_clean:
        sys.exit(f'cleanup incomplete; see {args.out / "cleanup.json"}')


if __name__ == '__main__':
    main()
