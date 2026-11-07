"""Run only in the granted scheduler harness slot; owns every process and port."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import unittest

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


if __name__ == '__main__':
    unittest.main()
