"""Check the #92 comparison's TAP checks against the archived Node 20 and 24 logs."""
import gzip
import importlib.util
from pathlib import Path
import unittest

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


if __name__ == '__main__':
    unittest.main()
