"""Exercise cleanup through the public runner, including an uncooperative descendant."""
import argparse
import importlib.util
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


class InstrumentationTests(unittest.TestCase):
    def test_existing_parser_workload_reports_nonzero_read_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'results'
            result = subprocess.run(['python3', str(RUNNER), 'parser', '--counts', '0', '--sizes', '10240',
                                     '--samples', '1', '--out', str(output)], capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            rows = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines()]
            operations = [json.loads(line) for row in rows for line in row['stdout'].splitlines()]
            self.assertEqual(len(operations), 2)
            for operation in operations:
                self.assertGreater(operation['io']['rchar'], 0, operation['label'])
            self.assertEqual(json.loads((output / 'cleanup.json').read_text()),
                             {'fixture_root_removed': True, 'children_reaped': True})

    def test_companion_arguments_stay_opt_in_and_require_complete_build_identity(self):
        cases = [(['cli', '--signature-mode', 'keys'], '--signature-mode requires'),
                 (['cli', '--implementation-dist', '/synthetic/dist', '--implementation-ref', 'synthetic'],
                  '--implementation-dist and --implementation-ref require'),
                 (['signatures', '--implementation-dist', '/synthetic/dist'], 'must be supplied together'),
                 (['signature-history', '--implementation-ref', 'synthetic'], 'must be supplied together'),
                 (['signatures', '--sizes', '10240,1048576'], 'exactly one --sizes value'),
                 (['signature-history'], 'exactly one --sizes value')]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'results'
            for arguments, message in cases:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(['python3', str(RUNNER), *arguments, '--out', str(output)],
                                            capture_output=True, timeout=5)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(message, result.stderr.decode())
                    self.assertFalse(output.exists())


    def test_signature_pair_driver_rejects_incomplete_or_reused_qualification_inputs(self):
        driver = RUNNER.with_name('signature_pairs.py')
        required = ['--parent-dist', '/synthetic/parent', '--parent-ref', 'parent', '--candidate-dist', '/synthetic/candidate',
                    '--candidate-ref', 'candidate', '--node', 'node']
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'pairs'
            cases = [(required[2:], 'the following arguments are required: --parent-dist'),
                     (required + ['--variants', 'parent,parent'], '--variants must be'),
                     (required + ['--pairs', '0'], '--pairs must be'),
                     (required + ['--out', directory], '--out must not exist')]
            for arguments, message in cases:
                with self.subTest(arguments=arguments):
                    if '--out' not in arguments:
                        arguments = arguments + ['--out', str(output)]
                    result = subprocess.run(['python3', str(driver), *arguments], capture_output=True, timeout=5)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn(message, result.stderr.decode())
                    self.assertFalse(output.exists())

    def test_signature_pair_plan_gives_every_dotted_runtime_process_its_own_output_and_log(self):
        spec = importlib.util.spec_from_file_location('signature_pairs', RUNNER.with_name('signature_pairs.py'))
        signature_pairs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(signature_pairs)
        args = argparse.Namespace(out=Path('/synthetic/pairs'), cells=[(100, 10240)], pairs=5, variants=['parent', 'keys', 'candidate'])
        runs = signature_pairs.plan_runs(args, ['v20.20.2', 'v24.19.0'])

        self.assertEqual(len(runs), 30)
        paths = [run['out'] for run in runs] + [run['log'] for run in runs]
        self.assertEqual(len(set(paths)), 60)
        for run in runs:
            self.assertEqual(run['log'].name, run['out'].name + '.log')
        self.assertEqual([run['variant'] for run in runs[:6]], ['parent', 'keys', 'candidate', 'candidate', 'keys', 'parent'])

    def test_signature_pair_summary_reports_failed_unrun_and_absent_blocks_as_missing(self):
        spec = importlib.util.spec_from_file_location('signature_pairs', RUNNER.with_name('signature_pairs.py'))
        signature_pairs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(signature_pairs)
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(out=Path(directory), cells=[(100, 10240)], pairs=2, variants=['parent', 'candidate'])
            planned = signature_pairs.plan_runs(args, ['v20.20.2'])
            commands = []
            for run, exit_code, labels in zip(planned, [0, 0, 0], [['get', 'list'], ['get', 'list'], ['get']]):
                run['out'].mkdir()
                (run['out'] / 'summary.json').write_text(json.dumps({'success': True}))
                (run['out'] / 'cleanup.json').write_text(json.dumps({'fixture_root_removed': True, 'children_reaped': True}))
                rows = [json.dumps({'label': label, 'cpu_ms': 4.0 if run['variant'] == 'candidate' else 10.0, 'wall_ms': 1.0,
                                    'crypto': {'verifications': 0}, 'memory_after_gc': {'heapUsed': 1}}) for label in labels]
                (run['out'] / 'samples.jsonl').write_text(json.dumps({'stdout': '\n'.join(rows)}) + '\n')
                commands.append(dict(run, exit_code=exit_code))
            commands[2]['exit_code'] = 1

            result = signature_pairs.summarize(planned, commands)

        self.assertFalse(result['complete'])
        self.assertEqual([(row['pair'], row['variant'], row['reason']) for row in result['missing_processes']],
                         [(1, 'candidate', 'exit 1'), (1, 'parent', 'not run')])
        self.assertEqual(sorted((row['operation'], row['pair'], row['variant']) for row in result['missing_operations']),
                         [('get', 1, 'candidate'), ('get', 1, 'parent'), ('list', 1, 'candidate'), ('list', 1, 'parent')])
        self.assertEqual([(row['operation'], row['pair'], row['cpu_ratio']) for row in result['paired']], [('get', 0, 0.4), ('list', 0, 0.4)])
        self.assertEqual({row['samples'] for row in result['marginal']}, {1})

if __name__ == '__main__':
    unittest.main()
