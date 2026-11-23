"""Exercise the public runner end to end with synthetic Node executables."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest

RUNNER = Path(__file__).with_name('run.py')
CLEAN = {'fixture_root_removed': True, 'children_reaped': True, 'process_groups_empty': True}

# Answers the runner's metadata probes; the scenario body then handles workload commands.
FAKE_NODE = '''#!/usr/bin/env python3
import json, os, signal, socket, sys, time
if sys.argv[1] == '--version':
    print('v20.0.0'); sys.exit(0)
if sys.argv[1] == '-p':
    print('{}'); sys.exit(0)
command = sys.argv[2] if len(sys.argv) > 2 else ''
'''

# Completes the `cli --counts 0` workload: version, seed, an empty list and an empty export.
SUCCEEDING = '''
if command == 'seed' and LOCK_FIXTURES:
    locked = os.path.join(os.environ['TMPDIR'], 'locked')
    os.makedirs(locked)
    open(os.path.join(locked, 'file'), 'w').close()
    os.chmod(locked, 0o500)
if command == 'list':
    print(LIST_OUTPUT)
if command == 'export':
    os.makedirs(sys.argv[sys.argv.index('--out') + 1])
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
open(PIDS, 'w').write(json.dumps([os.getpid(), child, listener.getsockname()[1]]))
while True: time.sleep(1)
'''

# Exits successfully while a forked descendant keeps running in the same process group.
STRAY = '''
child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: time.sleep(1)
open(PIDS, 'w').write(json.dumps([os.getpid(), child, 0]))
sys.exit(0)
'''

FAILING = "print('synthetic failure', file=sys.stderr)\nsys.exit(17)\n"


class RunnerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.pids = self.root / 'pids.json'
        self.executable = self.root / 'fake-node'
        self.addCleanup(self.kill_recorded_processes)

    def kill_recorded_processes(self):
        # Only processes still running this test's fake executable are ours; PIDs may have been recycled.
        if not self.pids.exists():
            return
        for pid in json.loads(self.pids.read_text())[:2]:
            try:
                if str(self.executable).encode() in Path(f'/proc/{pid}/cmdline').read_bytes():
                    os.kill(pid, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass

    def start(self, scenario, timeout, output, lock_fixtures=False, list_output='[]'):
        settings = f'PIDS = {str(self.pids)!r}\nLOCK_FIXTURES = {lock_fixtures}\nLIST_OUTPUT = {list_output!r}\n'
        self.executable.write_text(FAKE_NODE + settings + scenario)
        self.executable.chmod(0o700)

        self.addCleanup(self.remove_fixture_root, output)
        runner = subprocess.Popen(['python3', str(RUNNER), 'cli', '--counts', '0', '--samples', '1', '--allow-stale-build',
                                   '--node', str(self.executable), '--timeout', str(timeout), '--out', str(output)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop_runner, runner)
        return runner

    def remove_fixture_root(self, output):
        # Runs after stop_runner, so a regressed runner cannot leave its synthetic fixture root in TMPDIR.
        environment = output / 'environment.json'
        if not environment.exists():
            return
        root = Path(json.loads(environment.read_text())['fixture_root'])
        for directory, _, _ in os.walk(root):
            os.chmod(directory, 0o700)
        shutil.rmtree(root, ignore_errors=True)

    def stop_runner(self, runner):
        if runner.poll() is None:
            runner.kill()
        runner.communicate()

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
        parent, child, port = json.loads(self.pids.read_text())
        if port:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', port))

        for pid in [parent, child]:
            try:
                state = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
            except FileNotFoundError:
                continue
            self.assertEqual(state, 'Z', f'live descendant {pid}')

    def failures(self, output):
        return [json.loads(line) for line in (output / 'failures.jsonl').read_text().splitlines()]

    def test_successful_run_reports_samples_and_clean_receipt(self):
        output = self.root / 'results'
        exit_code, cleanup, summary = self.finish(self.start(SUCCEEDING, 10, output), output)

        self.assertEqual(exit_code, 0)
        self.assertEqual(cleanup, CLEAN)
        self.assertTrue(summary['success'])
        self.assertEqual(sorted(summary['groups']), ['cli/export/0', 'cli/list/0', 'cli/version', 'setup/0'])
        self.assertFalse((output / 'failures.jsonl').exists())
        rows = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines()]
        self.assertTrue(all(row['wall_ms'] > 0 and row['exit_code'] == 0 for row in rows if 'wall_ms' in row))

    def test_failed_behavior_check_is_recorded(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(SUCCEEDING, 10, output, list_output='[{"id": "unexpected"}]'), output)

        failure = self.failures(output)[0]
        self.assertEqual(failure['label'], 'cli/list/0')
        self.assertIn('BehaviorCheckError', failure['error'])

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

        row = json.loads((output / 'samples.jsonl').read_text().splitlines()[0])
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
                self.assertIn('InterruptedError', self.failures(output)[0]['error'])

    def test_descendant_outliving_successful_leader_fails_run(self):
        output = self.root / 'results'
        self.assert_failed_cleanly(self.start(STRAY, 10, output), output)

        self.assert_processes_gone()
        self.assertIn('outlived the workload process', self.failures(output)[0]['error'])
        self.assertEqual(json.loads((output / 'samples.jsonl').read_text().splitlines()[0])['exit_code'], 0)


if __name__ == '__main__':
    unittest.main()
