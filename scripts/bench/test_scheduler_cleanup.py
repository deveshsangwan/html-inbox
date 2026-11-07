"""Run only in the granted scheduler harness slot; owns every process and port."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('scheduler_runner', Path(__file__).with_name('scheduler.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@unittest.skipUnless(sys.platform == 'linux', 'The scheduler collector requires Linux')
class SchedulerCleanupTests(unittest.TestCase):
    def exercise(self, leader_exits):
        self.assertEqual(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0), 0)
        script = '''
import json, os, signal, socket, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
child = os.fork()
if child == 0:
    while True: time.sleep(1)
print(json.dumps([os.getpid(), child, listener.getsockname()[1]]), flush=True)
''' + ('raise SystemExit(17)\n' if leader_exits else 'while True: time.sleep(1)\n')
        child = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            parent_pid, descendant_pid, port = json.loads(child.stdout.readline())
            if leader_exits:
                self.assertEqual(child.wait(timeout=5), 17)
            runner.terminate(child)
            self.assertEqual(runner.processes(child.pid), [])
            for pid in [parent_pid, descendant_pid]:
                self.assertFalse(Path(f'/proc/{pid}').exists(), f'Owned PID {pid} must be reaped, including zombies')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', port))
        finally:
            runner.terminate(child)
            child.stdout.close()

    def test_timeout_cleanup_kills_and_reaps_uncooperative_group(self):
        self.exercise(False)

    def test_exited_leader_does_not_leave_descendant_or_port(self):
        self.exercise(True)

    def preliminary(self, mode):
        self.assertEqual(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0), 0)
        with tempfile.TemporaryDirectory(prefix='scheduler-command-test-') as directory:
            root = Path(directory)
            script = '''
import json, os, signal, socket, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
child = os.fork()
if child == 0:
    while True: time.sleep(1)
print(json.dumps([os.getpid(), child, listener.getsockname()[1]]), flush=True)
''' + ('''time.sleep(.05)
os.kill(os.getppid(), signal.SIGTERM)
while True: time.sleep(1)
''' if mode == 'interrupt' else 'raise SystemExit(17)\n' if mode == 'compound' else 'while True: time.sleep(1)\n')
            groups = []
            previous_handler = signal.getsignal(signal.SIGTERM)

            def interrupt(_signum, _frame):
                raise InterruptedError('Synthetic preliminary-command interruption')

            signal.signal(signal.SIGTERM, interrupt)
            original_terminate = runner.terminate

            def cleanup_failure(child):
                original_terminate(child)
                raise OSError('Synthetic cleanup reporting failure')

            try:
                expected = InterruptedError if mode == 'interrupt' else BaseExceptionGroup if mode == 'compound' else subprocess.TimeoutExpired
                with mock.patch.object(runner, 'terminate', cleanup_failure if mode == 'compound' else original_terminate):
                    with self.assertRaises(expected) as raised:
                        runner.bounded_command([sys.executable, '-c', script], label='synthetic-preliminary', cwd=root, env=None,
                                               log=root / 'output.log', timeout=2, groups=groups, receipts=root / 'commands.jsonl')
                row = json.loads((root / 'commands.jsonl').read_text())
                self.assertEqual(groups, [row['pid']])
                self.assertTrue(row['group_reaped'])
                if mode == 'compound':
                    self.assertEqual(row['exit'], 17)
                    self.assertEqual(raised.exception.exceptions[0].returncode, 17)
                    self.assertIsInstance(raised.exception.exceptions[1], OSError)
                    self.assertIn('cleanup_error', row)
                else:
                    self.assertTrue(row['interrupted'] if mode == 'interrupt' else row['timed_out'])
                parent_pid, descendant_pid, port = json.loads((root / 'output.log').read_text())
                for pid in [parent_pid, descendant_pid]:
                    self.assertFalse(Path(f'/proc/{pid}').exists(), f'Preliminary-command PID {pid} must be reaped')
                self.assertEqual(runner.processes(groups[0]), [])
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', port))
            finally:
                signal.signal(signal.SIGTERM, previous_handler)

    def test_preliminary_timeout_reaps_descendant_and_releases_port(self):
        self.preliminary('timeout')

    def test_preliminary_interruption_reaps_descendant_and_releases_port(self):
        self.preliminary('interrupt')

    def test_preliminary_exit_and_cleanup_failure_preserve_both_causes(self):
        self.preliminary('compound')


if __name__ == '__main__':
    unittest.main()
