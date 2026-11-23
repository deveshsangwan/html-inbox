"""Exercise the public runner end to end with synthetic Node executables."""
import json
import os
import select
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

RUNNER = Path(__file__).with_name('run.py')
CLEAN = {'fixture_root_removed': True, 'children_reaped': True, 'process_groups_empty': True}

# Answers the runner's metadata probes; the scenario body then handles workload commands.
# HANG_PROBE makes the version probe fork a descendant and hang, to exercise probe supervision.
FAKE_NODE = '''
def record_fakes(child, port=0):
    identities = []
    for pid in (os.getpid(), child):
        with open(f'/proc/{pid}/stat', 'rb') as stream:
            start = int(stream.read().rsplit(b')', 1)[1].split()[19])
        identities.append([pid, start])

    with open(PIDS + '.tmp', 'w') as stream:
        json.dump({'identities': identities, 'port': port}, stream)
    os.replace(PIDS + '.tmp', PIDS)

if sys.argv[1] == '--version':
    if HANG_PROBE:
        child = os.fork()
        if child == 0:
            while True: time.sleep(1)
        record_fakes(child)
        while True: time.sleep(1)
    print('v20.0.0'); sys.exit(0)
if sys.argv[1] == '-p':
    print('{}'); sys.exit(0)
command = sys.argv[2] if len(sys.argv) > 2 else ''
'''

# Completes the `cli --counts 0` workload: version, seed, an empty list and a minimal empty-library export.
SUCCEEDING = '''
if command == 'seed' and LOCK_FIXTURES:
    locked = os.path.join(os.environ['TMPDIR'], 'locked')
    os.makedirs(locked)
    open(os.path.join(locked, 'file'), 'w').close()
    os.chmod(locked, 0o500)
if command == 'list':
    print(LIST_OUTPUT)
if command == 'export':
    out = sys.argv[sys.argv.index('--out') + 1]
    for name in ['index.html', '__html-inbox/ownership.json', 'i/capability/index.html']:
        if name == MISSING_EXPORT_FILE:
            continue
        os.makedirs(os.path.dirname(os.path.join(out, name)), exist_ok=True)
        open(os.path.join(out, name), 'w').close()
    os.makedirs(out, exist_ok=True)
    if SIGNAL_RUNNER:
        os.kill(os.getppid(), signal.SIGTERM)
    if FAIL_THEN_SIGNAL:
        # The child waits for cleanup TERM, then signals the runner after the export leader exits.
        runner = os.getppid()
        ready, notify = os.pipe()
        child = os.fork()
        if child == 0:
            signal.signal(signal.SIGTERM, lambda *_: (os.kill(runner, signal.SIGTERM), os._exit(0)))
            os.close(ready)
            os.write(notify, b'1')
            os.close(notify)
            while True: time.sleep(1)
        os.close(notify)
        assert os.read(ready, 1) == b'1'
        os.close(ready)
        record_fakes(child)
        sys.exit(17)
'''

# Ignores SIGTERM, holds a listener and forks a descendant, then records their identities.
HANGING = '''
signal.signal(signal.SIGTERM, signal.SIG_IGN)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
child = os.fork()
if child == 0:
    while True: time.sleep(1)
record_fakes(child, listener.getsockname()[1])
while True: time.sleep(1)
'''

# Exits successfully while a forked descendant keeps running in the same process group.
STRAY = '''
child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: time.sleep(1)
record_fakes(child)
sys.exit(0)
'''

FAILING = "print('synthetic failure', file=sys.stderr)\nsys.exit(17)\n"


def observe_process(pid):
    """Return (state, start time in ticks, command line) for `pid`.

    The state is 'running', 'exited' or 'absent', or None when the process cannot be observed.
    The start time survives exec, so it identifies a process across a changing command line.
    """
    try:
        stat = Path(f'/proc/{pid}/stat').read_bytes()
        command = Path(f'/proc/{pid}/cmdline').read_bytes()
    except (FileNotFoundError, ProcessLookupError):
        return 'absent', None, b''
    except OSError:
        return None, None, b''

    fields = stat.rsplit(b')', 1)[1].split()
    return ('exited' if fields[0] in (b'Z', b'X') else 'running'), int(fields[19]), command


def recorded_process_state(pid, executable):
    """Check whether a live PID's arguments include this test's fake executable."""
    state, _, command = observe_process(pid)
    if state != 'running':
        return state
    return 'ours' if os.fsencode(executable) in command.split(b'\0') else 'unconfirmed'


def kill_recorded_process(pid, executable, recorded_start):
    """SIGKILL a recorded fake that is provably ours; return a description when a live fake may remain."""
    state, start, command = observe_process(pid)
    if state is None:
        return f'{pid}: owner unobservable'
    if state != 'running' or start != recorded_start:
        return None
    if os.fsencode(executable) not in command.split(b'\0'):
        return f'{pid}: same start time but fixture command line unconfirmed'

    def still_ours():
        # The same start time proves the same process even mid-exec; absence, exit or a new start time prove it gone.
        later_state, later_start, _ = observe_process(pid)
        if later_state is None:
            return None
        return later_state == 'running' and later_start == start

    try:
        process = os.pidfd_open(pid)
    except OSError as error:
        # Descriptor exhaustion or access failures can leave a live fake behind; only proof of its end excuses them.
        if still_ours() is False:
            return None
        return f'{pid}: pidfd_open failed with errno {error.errno} while the fake may still run'

    try:
        ours = still_ours()
        if ours:
            signal.pidfd_send_signal(process, signal.SIGKILL)
            poller = select.poll()
            poller.register(process, select.POLLIN)
            if not poller.poll(2000):
                return f'{pid}: still running after SIGKILL'
        elif ours is None:
            return f'{pid}: owner unobservable after pinning'
    except ProcessLookupError:
        pass
    except OSError as error:
        return f'{pid}: could not confirm exit after pinning: {error}'
    finally:
        os.close(process)
    return None


class RunnerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.pids = self.root / 'pids.json'
        self.executable = self.root / 'fake-node'
        # unittest reports cleanup failures separately from a test's primary failure.
        self.teardown_problems = []
        self.addCleanup(self.assert_no_unobservable_fakes)
        self.addCleanup(self.kill_recorded_processes)

    def kill_recorded_processes(self):
        if not self.pids.exists():
            return
        for pid, start in json.loads(self.pids.read_text())['identities']:
            problem = kill_recorded_process(pid, self.executable, start)
            if problem:
                self.teardown_problems.append(problem)

    def assert_no_unobservable_fakes(self):
        if self.teardown_problems:
            self.fail(f'synthetic processes may still run: {self.teardown_problems}')

    def start(self, scenario, timeout, output, lock_fixtures=False, list_output='[]', missing_export_file=None,
              signal_runner=False, fail_then_signal=False, hang_probe=False, executable_mode=0o700):
        settings = (f'PIDS = {str(self.pids)!r}\nLOCK_FIXTURES = {lock_fixtures}\nLIST_OUTPUT = {list_output!r}\n'
                    f'MISSING_EXPORT_FILE = {missing_export_file!r}\nSIGNAL_RUNNER = {signal_runner}\n'
                    f'FAIL_THEN_SIGNAL = {fail_then_signal}\nHANG_PROBE = {hang_probe}\n')
        header = '#!/usr/bin/env python3\nimport json, os, signal, socket, sys, time\n'
        self.executable.write_text(header + settings + FAKE_NODE + scenario)
        self.executable.chmod(executable_mode)

        self.addCleanup(self.remove_fixture_root, output)
        # The runner's fixture roots go inside this test's directory, so even a regressed runner cannot leave one in /tmp.
        temporary = self.root / 'tmp'
        temporary.mkdir(exist_ok=True)
        runner = subprocess.Popen(['python3', str(RUNNER), 'cli', '--counts', '0', '--samples', '1', '--allow-stale-build',
                                   '--node', str(self.executable), '--timeout', str(timeout), '--out', str(output)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, 'TMPDIR': str(temporary)})
        self.addCleanup(self.stop_runner, runner)
        return runner

    def remove_fixture_root(self, output):
        # Runs after stop_runner, so a regressed runner cannot leave its synthetic fixture root in TMPDIR.
        environment = output / 'environment.json'
        if not environment.exists():
            return
        root = Path(json.loads(environment.read_text())['fixture_root'])
        self.assertEqual(root.parent, self.root / 'tmp')
        self.assertTrue(root.name.startswith('html-inbox-bench-') and not root.is_symlink())
        for directory, _, _ in os.walk(root):
            os.chmod(directory, 0o700)
        shutil.rmtree(root, ignore_errors=True)

    def stop_runner(self, runner):
        if runner.poll() is None:
            runner.kill()
        try:
            runner.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            # A leaked fake can hold the runner's output pipes open; stop it, then collect the runner.
            self.kill_recorded_processes()
            runner.communicate(timeout=5)

    def finish(self, runner, output):
        runner.communicate(timeout=20)
        cleanup = json.loads((output / 'cleanup.json').read_text())
        summary = json.loads((output / 'summary.json').read_text())

        return runner.returncode, {key: cleanup[key] for key in CLEAN}, summary

    def assert_failed_cleanly(self, runner, output):
        exit_code, cleanup, summary = self.finish(runner, output)
        self.assertNotEqual(exit_code, 0)
        self.assertEqual(cleanup, CLEAN)
        self.assertFalse(summary['success'])

    def assert_processes_gone(self):
        recorded = json.loads(self.pids.read_text())
        port = recorded['port']
        if port:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', port))

        for pid, start in recorded['identities']:
            state, observed_start, _ = observe_process(pid)
            self.assertIsNotNone(state, f'cannot verify process {pid}')
            self.assertFalse(state == 'running' and observed_start == start, f'live descendant {pid}')

    def failures(self, output):
        return [json.loads(line) for line in (output / 'failures.jsonl').read_text().splitlines()]

    def test_successful_run_reports_samples_and_clean_receipt(self):
        output = self.root / 'results'
        exit_code, cleanup, summary = self.finish(self.start(SUCCEEDING, 10, output), output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(cleanup, CLEAN)
        self.assertTrue(summary['success'])
        self.assertEqual(sorted(summary['groups']), ['cli/export/0', 'cli/list/0', 'cli/version', 'control/spawn-floor', 'setup/0'])
        self.assertEqual(summary['groups']['control/spawn-floor']['n'], 2)
        self.assertFalse((output / 'failures.jsonl').exists())
        rows = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines()]
        self.assertTrue(all(row['wall_ms'] > 0 and row['exit_code'] == 0 for row in rows if 'wall_ms' in row))
        self.assertEqual({row['label']: row['behavior'] for row in rows if 'wall_ms' in row},
                         {'control/spawn-floor': 'none', 'cli/version': 'none', 'setup/0': 'passed: helper exit status',
                          'cli/list/0': 'passed', 'cli/export/0': 'passed'})
        self.assertTrue(all(row['runner_peak_rss_kib_at_spawn'] > 0 for row in rows if 'wall_ms' in row))
        environment = json.loads((output / 'environment.json').read_text())
        self.assertGreater(environment['runner_peak_rss_kib_before_workloads'], 0)
        self.assertEqual(len(environment['fingerprints']['node_sha256']), 64)

    def test_failed_behavior_check_is_recorded(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(SUCCEEDING, 10, output, list_output='[{"id": "unexpected"}]'), output)

        failure = self.failures(output)[0]
        self.assertEqual(failure['label'], 'cli/list/0')
        self.assertIn('BehaviorCheckError', failure['error'])
        rows = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines()]
        self.assertEqual([row['behavior'] for row in rows if row['label'] == 'cli/list/0'], ['failed'])

    def test_export_missing_any_required_file_fails(self):
        cases = {'index.html': 'no root index.html', '__html-inbox/ownership.json': 'no ownership marker',
                 'i/capability/index.html': 'exactly one inbox index'}
        for name, expected_error in cases.items():
            with self.subTest(missing=name):
                output = self.root / f'results-{name.replace("/", "-")}'
                self.assert_failed_cleanly(self.start(SUCCEEDING, 10, output, missing_export_file=name), output)

                failure = self.failures(output)[0]
                self.assertEqual(failure['label'], 'cli/export/0')
                self.assertIn('BehaviorCheckError', failure['error'])
                self.assertIn(expected_error, failure['error'])

    def test_unlaunchable_node_is_recorded_as_probe_failure(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(SUCCEEDING, 10, output, executable_mode=0o600), output)

        failure = self.failures(output)[0]
        self.assertTrue(failure['label'].startswith('probe/'))
        self.assertIn('PermissionError', failure['error'])

    def test_hanging_probe_and_its_descendant_are_stopped(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(SUCCEEDING, 1, output, hang_probe=True), output)

        self.assert_processes_gone()
        failure = self.failures(output)[0]
        self.assertEqual(failure['label'], 'probe/node-version')
        self.assertIn('TimeoutError', failure['error'])

    def test_signal_from_a_workload_cancels_run(self):
        output = self.root / 'results'
        runner = self.start(SUCCEEDING, 10, output, signal_runner=True)
        exit_code, cleanup, summary = self.finish(runner, output)

        self.assertEqual(exit_code, 128 + signal.SIGTERM)
        self.assertEqual(cleanup, CLEAN)
        self.assertFalse(summary['success'])
        self.assertEqual(summary['interrupted_by'], signal.SIGTERM)

    def test_signal_takes_exit_status_precedence_over_workload_failure(self):
        output = self.root / 'results'
        runner = self.start(SUCCEEDING, 10, output, fail_then_signal=True)
        exit_code, cleanup, summary = self.finish(runner, output)

        self.assertEqual(exit_code, 128 + signal.SIGTERM)
        self.assertEqual(cleanup, CLEAN)
        self.assertFalse(summary['success'])
        self.assertEqual(summary['interrupted_by'], signal.SIGTERM)
        self.assertIn('exit 17', summary['failure'])
        self.assert_processes_gone()

    @unittest.skipIf(os.geteuid() == 0, 'root can remove read-only directories')
    def test_failed_fixture_removal_fails_successful_workloads(self):
        output = self.root / 'results'
        runner = self.start(SUCCEEDING, 10, output, lock_fixtures=True)
        runner.communicate(timeout=20)
        cleanup = json.loads((output / 'cleanup.json').read_text())
        fixture_root = Path(cleanup['fixture_root'])

        self.assertNotEqual(runner.returncode, 0)
        self.assertFalse(cleanup['fixture_root_removed'])
        self.assertTrue(fixture_root.exists())
        self.assertFalse(json.loads((output / 'summary.json').read_text())['success'])
        self.assertFalse((output / 'failures.jsonl').exists())

    def test_nonzero_exit(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(FAILING, 1, output), output)

        row = next(row for row in map(json.loads, (output / 'samples.jsonl').read_text().splitlines()) if row['label'] == 'cli/version')
        self.assertEqual(row['exit_code'], 17)
        self.assertIn('synthetic failure', row['stderr'])

    def test_timeout_kills_owned_process_group(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(HANGING, 1, output), output)

        self.assert_processes_gone()
        self.assertIn('TimeoutError', self.failures(output)[0]['error'])

    def test_runner_signals_clean_up_before_exit(self):
        for signum in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
            with self.subTest(signal=signum.name):
                self.kill_recorded_processes()
                self.pids.unlink(missing_ok=True)
                output = self.root / f'results-{signum.name}'
                runner = self.start(HANGING, 60, output)
                deadline = time.monotonic() + 10
                while not self.pids.exists():
                    self.assertLess(time.monotonic(), deadline, 'fake workload never started')
                    time.sleep(.05)

                runner.send_signal(signum)
                self.assert_failed_cleanly(runner, output)

                self.assert_processes_gone()
                self.assertIn('RunInterrupted', self.failures(output)[0]['error'])

    def test_descendant_outliving_successful_leader_fails_run(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(STRAY, 10, output), output)

        self.assert_processes_gone()
        self.assertIn('outlived the workload process', self.failures(output)[0]['error'])
        rows = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines()]
        self.assertEqual([row['exit_code'] for row in rows if row['label'] == 'cli/version'], [0])


class TeardownTests(unittest.TestCase):
    """Deterministic branches of the identity-checked teardown used by RunnerTests."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.executable = Path(directory.name) / 'fake-node'
        self.executable.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n')
        self.executable.chmod(0o700)

    def start_fake(self):
        process = subprocess.Popen([str(self.executable)])
        self.addCleanup(process.wait, 10)
        self.addCleanup(process.kill)
        deadline = time.monotonic() + 10
        while recorded_process_state(process.pid, self.executable) != 'ours':
            self.assertLess(time.monotonic(), deadline, 'fake never started')
            time.sleep(.01)
        return process, observe_process(process.pid)[1]

    def test_live_fake_is_killed(self):
        process, start = self.start_fake()

        self.assertIsNone(kill_recorded_process(process.pid, self.executable, start))
        self.assertEqual(process.wait(10), -signal.SIGKILL)

    def test_reaped_fake_is_absent(self):
        process, start = self.start_fake()
        process.kill()
        process.wait(10)

        self.assertIsNone(kill_recorded_process(process.pid, self.executable, start))

    def test_other_program_is_left_alone(self):
        process, start = self.start_fake()

        self.assertIsNone(kill_recorded_process(process.pid, self.executable, start + 1))
        self.assertIn('unconfirmed', kill_recorded_process(process.pid, Path('/not/the/fake'), start))
        self.assertIsNone(process.poll())

    def test_pin_failure_with_live_owner_is_reported(self):
        process, start = self.start_fake()

        for code in [24, 13]:  # EMFILE, EACCES
            with self.subTest(errno=code), mock.patch('os.pidfd_open', side_effect=OSError(code, 'synthetic')):
                problem = kill_recorded_process(process.pid, self.executable, start)
                self.assertIn(f'errno {code}', problem)
                self.assertIsNone(process.poll())

    def test_pin_failure_after_proved_end_is_not_reported(self):
        module = sys.modules[__name__]
        command = str(self.executable).encode()
        for later in [('absent', None, b''), ('exited', 100, command), ('running', 200, b'/bin/other')]:
            with self.subTest(later=later[0]):
                observations = iter([('running', 100, command), later])
                with mock.patch.object(module, 'observe_process', side_effect=lambda pid: next(observations)), \
                        mock.patch('os.pidfd_open', side_effect=OSError(22, 'synthetic EINVAL')):
                    self.assertIsNone(kill_recorded_process(12345, self.executable, 100))

    def test_pin_failure_with_same_process_mid_exec_is_reported(self):
        module = sys.modules[__name__]
        observations = iter([('running', 100, str(self.executable).encode()), ('running', 100, b'')])
        with mock.patch.object(module, 'observe_process', side_effect=lambda pid: next(observations)), \
                mock.patch('os.pidfd_open', side_effect=OSError(24, 'synthetic EMFILE')):
            self.assertIn('errno 24', kill_recorded_process(12345, self.executable, 100))

    def test_unobservable_owner_is_reported(self):
        module = sys.modules[__name__]
        with mock.patch.object(module, 'observe_process', return_value=(None, None, b'')):
            self.assertIn('owner unobservable', kill_recorded_process(12345, self.executable, 100))


if __name__ == '__main__':
    unittest.main()
