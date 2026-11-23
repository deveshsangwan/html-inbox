"""Check the #92 comparison's TAP checks on archived logs and its faked timeout path."""
import gzip
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest import mock

BENCH = Path(__file__).parent
EVIDENCE = BENCH / 'evidence/permission-92'
COMPARISONS = [EVIDENCE / 'comparison', EVIDENCE / 'requalification/comparison']

specification = importlib.util.spec_from_file_location('permissions', BENCH / 'permissions.py')
permissions = importlib.util.module_from_spec(specification)
specification.loader.exec_module(permissions)


def archived(directory, name):
    return gzip.decompress((directory / f'{name}.log.gz').read_bytes()).decode()


class ArchivedLogTests(unittest.TestCase):
    def test_archived_runs_satisfy_both_checks(self):
        for directory in COMPARISONS:
            for runtime in ['20', '24']:
                with self.subTest(directory=directory.name, runtime=runtime):
                    permissions.check_baseline(archived(directory, f'baseline-{runtime}'))
                    permissions.check_candidate(archived(directory, f'candidate-{runtime}'))


class NegativeControlTests(unittest.TestCase):
    def setUp(self):
        self.baseline = archived(COMPARISONS[1], 'baseline-24')
        self.candidate = archived(COMPARISONS[1], 'candidate-24')

    def test_candidate_failing_for_another_reason_is_rejected(self):
        output = self.candidate.replace('511 !== 448', 'ENOTDIR fixture failure')

        with self.assertRaisesRegex(RuntimeError, 'did not fail with'):
            permissions.check_candidate(output)

    def test_candidate_output_is_not_a_baseline(self):
        with self.assertRaisesRegex(RuntimeError, 'four passing baseline'):
            permissions.check_baseline(self.candidate)

    def test_baseline_output_is_not_a_candidate(self):
        with self.assertRaisesRegex(RuntimeError, 'all four candidate'):
            permissions.check_candidate(self.baseline)

    def test_skipped_baseline_case_is_rejected(self):
        name = 'private file removed after inspection still reports ENOENT'
        output = self.baseline.replace(f'ok 1 - {name}', f'ok 1 - {name} # SKIP')

        with self.assertRaisesRegex(RuntimeError, 'did not pass'):
            permissions.check_baseline(output)

    def test_unnamed_result_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'no test name'):
            permissions.tap_results('ok 1\n')


class CandidateTimeoutTests(unittest.TestCase):
    """Drive the real comparison through a faked timed-out candidate build."""

    def setUp(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            self.addCleanup(signal.signal, signum, signal.getsignal(signum))

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / 'checkout'
        self.out = Path(directory.name) / 'out'
        self.source = self.root / 'packages/cli/src/private-storage.ts'
        self.source.parent.mkdir(parents=True)
        self.original = (BENCH.parents[1] / 'packages/cli/src/private-storage.ts').read_bytes()
        self.source.write_bytes(self.original)
        self.baseline = archived(COMPARISONS[1], 'baseline-24')
        self.built_sources = []
        self.is_log_unwritable = False

    def fake_run(self, command, **_options):
        if command[:2] == ['pnpm', 'build']:
            self.built_sources.append(self.source.read_bytes())

            if len(self.built_sources) == 2:
                if self.is_log_unwritable:
                    (self.out / 'build-candidate.log').mkdir()

                raise subprocess.TimeoutExpired(command, 300, output=b'partial stdout\n', stderr=b'partial stderr\n')

            dist = self.root / 'packages/cli/dist'
            dist.mkdir(parents=True, exist_ok=True)
            (dist / 'private-storage.js').write_bytes(self.built_sources[-1])
            return subprocess.CompletedProcess(command, 0, '', '')

        if command[1:] == ['--version']:
            return subprocess.CompletedProcess(command, 0, f'v{command[0][-2:]}.0.0\n', '')

        if '--test' in command:
            return subprocess.CompletedProcess(command, 0, self.baseline, '')

        return subprocess.CompletedProcess(command, 0, '', '')

    def compare(self):
        with mock.patch.object(subprocess, 'run', self.fake_run):
            with self.assertRaises(permissions.CommandTimedOut) as raised:
                permissions.compare(self.root, self.out, '/fake/node20', '/fake/node24')

        return raised.exception

    def assert_source_restored_without_rebuild(self):
        self.assertEqual(len(self.built_sources), 2)
        self.assertNotEqual(self.built_sources[1], self.original)
        self.assertEqual(self.source.read_bytes(), self.original)

        restoration = json.loads((self.out / 'restoration.json').read_text())
        self.assertEqual(restoration, {
            'sourceByteIdentical': True,
            'allBuildHashesIdentical': None,
            'buildRestoration': 'skipped after timeout; discard this checkout',
        })

    def test_timed_out_candidate_keeps_partial_output_and_skips_rebuild(self):
        self.compare()

        self.assert_source_restored_without_rebuild()
        self.assertEqual((self.out / 'build-candidate.log').read_bytes(), b'partial stdout\npartial stderr\n')

        commands = [json.loads(line) for line in (self.out / 'commands.jsonl').read_text().splitlines()]
        self.assertEqual(commands[-1]['label'], 'build-candidate')
        self.assertEqual(commands[-1]['exit'], 'timeout')
        self.assertNotIn('build-restored', [entry['label'] for entry in commands])

    def test_timeout_survives_unsaved_diagnostics(self):
        self.is_log_unwritable = True

        timeout = self.compare()

        self.assert_source_restored_without_rebuild()
        self.assertTrue(any('diagnostics not saved' in note for note in timeout.__notes__))


if __name__ == '__main__':
    unittest.main()
