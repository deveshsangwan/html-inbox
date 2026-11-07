"""Exercise cleanup through the public runner, including an uncooperative descendant."""
import json
import os
from pathlib import Path
import subprocess
import socket
import tempfile
import unittest

RUNNER = Path(__file__).with_name('run.py')


class CleanupTests(unittest.TestCase):
    def exercise(self, hangs):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'fake-node'
            pids = root / 'pids.json'
            executable.write_text('''#!/usr/bin/env python3
import json, os, signal, socket, sys, time
if sys.argv[1] == '--version':
    print('v20.0.0'); sys.exit(0)
if sys.argv[1] == '-p':
    print('{}'); sys.exit(0)
''' + (f'''
signal.signal(signal.SIGTERM, signal.SIG_IGN)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
child = os.fork()
if child == 0:
    while True: time.sleep(1)
open({str(pids)!r}, 'w').write(json.dumps([os.getpid(), child, listener.getsockname()[1]]))
while True: time.sleep(1)
''' if hangs else "print('synthetic failure', file=sys.stderr)\nsys.exit(17)\n"))
            executable.chmod(0o700)
            output = root / 'results'
            result = subprocess.run(['python3', str(RUNNER), 'cli', '--counts', '0', '--samples', '1',
                                     '--node', str(executable), '--timeout', '1', '--out', str(output)], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads((output / 'cleanup.json').read_text()),
                             {'fixture_root_removed': True, 'children_reaped': True})
            self.assertFalse(json.loads((output / 'summary.json').read_text())['success'])
            if hangs:
                parent, child, port = json.loads(pids.read_text())
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', port))
                for pid in [parent, child]:
                    status = Path(f'/proc/{pid}/stat')
                    self.assertTrue(not status.exists() or status.read_text().split()[2] == 'Z', f'live descendant {pid}')
            else:
                row = json.loads((output / 'samples.jsonl').read_text().splitlines()[0])
                self.assertEqual(row['exit_code'], 17)
                self.assertIn('synthetic failure', row['stderr'])

    def test_nonzero_exit(self):
        self.exercise(False)

    def test_timeout_kills_owned_process_group(self):
        self.exercise(True)


if __name__ == '__main__':
    unittest.main()
