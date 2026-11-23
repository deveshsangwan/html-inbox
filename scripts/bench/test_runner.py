"""Exercise cleanup through the public runner with synthetic Node executables."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest

RUNNER = Path(__file__).with_name('run.py')
CLEAN_RECEIPT = {'fixture_root_removed': True, 'children_reaped': True, 'process_groups_empty': True}

# Answers the runner's metadata probes, then runs the scenario body for workload commands.
FAKE_NODE = '''#!/usr/bin/env python3
import json, os, signal, socket, sys, time
if sys.argv[1] == '--version':
    print('v20.0.0'); sys.exit(0)
if sys.argv[1] == '-p':
    print('{}'); sys.exit(0)
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


class CleanupTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.pids = self.root / 'pids.json'
        self.output = self.root / 'results'
        self.addCleanup(self.kill_recorded_processes)

    def kill_recorded_processes(self):
        # A regression must not leak the SIGTERM-ignoring fakes past a failed test.
        if not self.pids.exists():
            return
        for pid in json.loads(self.pids.read_text())[:2]:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def start(self, scenario, timeout):
        executable = self.root / 'fake-node'
        executable.write_text(FAKE_NODE + f'PIDS = {str(self.pids)!r}\n' + scenario)
        executable.chmod(0o700)

        return subprocess.Popen(['python3', str(RUNNER), 'cli', '--counts', '0', '--samples', '1', '--allow-stale-build',
                                 '--node', str(executable), '--timeout', str(timeout), '--out', str(self.output)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def assert_failed_cleanly(self, runner):
        runner.communicate(timeout=20)
        self.assertNotEqual(runner.returncode, 0)
        self.assertEqual(json.loads((self.output / 'cleanup.json').read_text()), CLEAN_RECEIPT)
        self.assertFalse(json.loads((self.output / 'summary.json').read_text())['success'])

    def assert_processes_gone(self):
        parent, child, port = json.loads(self.pids.read_text())
        if port:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', port))

        for pid in [parent, child]:
            status = Path(f'/proc/{pid}/stat')
            self.assertTrue(not status.exists() or status.read_text().split()[2] == 'Z', f'live descendant {pid}')

    def failures(self):
        return [json.loads(line) for line in (self.output / 'failures.jsonl').read_text().splitlines()]

    def test_nonzero_exit(self):
        self.assert_failed_cleanly(self.start(FAILING, 1))

        row = json.loads((self.output / 'samples.jsonl').read_text().splitlines()[0])
        self.assertEqual(row['exit_code'], 17)
        self.assertIn('synthetic failure', row['stderr'])

    def test_timeout_kills_owned_process_group(self):
        self.assert_failed_cleanly(self.start(HANGING, 1))

        self.assert_processes_gone()
        self.assertIn('TimeoutError', self.failures()[0]['error'])

    def test_runner_sigterm_cleans_up_before_exit(self):
        runner = self.start(HANGING, 60)
        deadline = time.monotonic() + 10
        while not self.pids.exists():
            self.assertLess(time.monotonic(), deadline, 'fake workload never started')
            time.sleep(.05)

        runner.send_signal(signal.SIGTERM)
        self.assert_failed_cleanly(runner)

        self.assert_processes_gone()
        self.assertIn('InterruptedError', self.failures()[0]['error'])

    def test_descendant_outliving_successful_leader_fails_run(self):
        self.assert_failed_cleanly(self.start(STRAY, 10))

        self.assert_processes_gone()
        self.assertIn('outlived the workload process', self.failures()[0]['error'])
        self.assertEqual(json.loads((self.output / 'samples.jsonl').read_text().splitlines()[0])['exit_code'], 0)


if __name__ == '__main__':
    unittest.main()
