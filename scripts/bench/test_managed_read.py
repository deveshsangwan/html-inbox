"""Check that export comparison admits only the explicitly recorded CLI nonces."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from managed_read import (
    CAPABILITY,
    GENERATED_AT,
    MANIFEST_FILE,
    OWNER,
    OWNER_FILE,
    PROC_IO_FIELDS,
    build_info,
    checked_proc_io,
    compare_exports,
    inspect_export,
    parse_proc_io,
    resolve_expected_baseline_commit,
)


class ParentIdentityTests(unittest.TestCase):
    legacy = '610c931b7b22920cce59cf03e49c0de15ebaf2a2'
    parent = 'b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad'

    def test_full_sha_boundary(self):
        self.assertEqual(resolve_expected_baseline_commit('managed-read', self.parent.upper()), self.parent)
        for value in ['', self.parent[:7], self.parent[:39], self.parent+'0', 'g'*40, 'HEAD',
                      'refs/heads/t3/shared-viewer-lifecycle-repair', ' '+self.parent, self.parent+'\n']:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'exactly 40 hexadecimal'):
                resolve_expected_baseline_commit('managed-read', value)

    def test_legacy_default_explicit_parent_and_unrelated_workloads(self):
        self.assertEqual(resolve_expected_baseline_commit('managed-read', None), self.legacy)
        self.assertEqual(resolve_expected_baseline_commit('managed-read', self.parent), self.parent)
        for workload in ['baseline', 'cli', 'viewer', 'worker', 'parser', 'managed', 'sync']:
            with self.subTest(workload=workload):
                self.assertIsNone(resolve_expected_baseline_commit(workload, None))
                with self.assertRaisesRegex(ValueError, 'only supported by managed-read'):
                    resolve_expected_baseline_commit(workload, self.parent)

    def test_clean_matching_baseline_keeps_build_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            bundle = repo / 'packages/cli/bundle/index.js'
            module = repo / 'packages/cli/dist/index.js'
            for filename, data in [(bundle, b'synthetic bundle'), (module, b'synthetic compiled module')]:
                filename.parent.mkdir(parents=True)
                filename.write_bytes(data)
            with patch('managed_read.subprocess.check_output', side_effect=[self.parent+'\n', '']):
                result = build_info(repo, self.parent)

            self.assertEqual(result['commit'], self.parent)
            self.assertEqual(result['bundle_sha256'], hashlib.sha256(bundle.read_bytes()).hexdigest())
            self.assertEqual(result['dist_js'], {'packages/cli/dist/index.js': hashlib.sha256(module.read_bytes()).hexdigest()})

    def test_mismatched_baseline_is_refused_including_implicit_legacy(self):
        for actual, requested in [(self.legacy, self.parent), (self.parent, None)]:
            expected = resolve_expected_baseline_commit('managed-read', requested)
            with self.subTest(actual=actual, expected=expected):
                with patch('managed_read.subprocess.check_output', side_effect=[actual+'\n', '']):
                    with self.assertRaisesRegex(ValueError, 'baseline must be exactly'):
                        build_info(Path('unused-baseline'), expected)

    def test_dirty_baseline_is_refused(self):
        with patch('managed_read.subprocess.check_output', side_effect=[self.parent+'\n', ' M source.ts\n']):
            with self.assertRaisesRegex(ValueError, 'checkout is dirty'):
                build_info(Path('unused-baseline'), self.parent)

    def test_missing_build_files_still_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            with patch('managed_read.subprocess.check_output', side_effect=[self.parent+'\n', '']):
                with self.assertRaisesRegex(ValueError, 'Build the measured checkout first'):
                    build_info(repo, self.parent)
            module = repo / 'packages/cli/dist/index.js'
            module.parent.mkdir(parents=True)
            module.write_text('synthetic compiled module')
            with patch('managed_read.subprocess.check_output', side_effect=[self.parent+'\n', '']):
                with self.assertRaises(FileNotFoundError):
                    build_info(repo, self.parent)


class ProcIoTests(unittest.TestCase):
    def snapshot(self, values):
        return ''.join(f'{name}: {values[name]}\n' for name in PROC_IO_FIELDS)

    def test_known_nonzero_values_and_deltas_preserve_raw_text(self):
        before = dict(zip(PROC_IO_FIELDS, [100, 200, 3, 4, 500, 600, 7]))
        after = dict(zip(PROC_IO_FIELDS, [1100, 2200, 30, 40, 5500, 6600, 77]))
        raw_before, raw_after = self.snapshot(before), self.snapshot(after)
        result = checked_proc_io(raw_before, raw_after)
        self.assertEqual(result['raw_before'], raw_before)
        self.assertEqual(result['raw_after'], raw_after)
        self.assertEqual(result['before'], before)
        self.assertEqual(result['after'], after)
        self.assertEqual(result['delta'], dict(zip(PROC_IO_FIELDS, [1000, 2000, 27, 36, 5000, 6000, 70])))

    def test_zero_physical_io_is_valid(self):
        before = dict.fromkeys(PROC_IO_FIELDS, 0)
        after = {**before, 'rchar': 10240, 'syscr': 2}
        result = checked_proc_io(self.snapshot(before), self.snapshot(after))
        self.assertEqual(result['delta'], after)

    def test_every_named_field_is_required(self):
        for missing in PROC_IO_FIELDS:
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, 'Missing'):
                parse_proc_io(''.join(f'{name}: 1\n' for name in PROC_IO_FIELDS if name != missing))

    def test_malformed_duplicate_unknown_and_decreasing_fields_reject(self):
        valid = self.snapshot(dict.fromkeys(PROC_IO_FIELDS, 10))
        for bad in ['', 'NaN', '-1', '+1', '1.5', '10x']:
            with self.subTest(integer=bad), self.assertRaisesRegex(ValueError, 'Invalid integer'):
                parse_proc_io(valid.replace('rchar: 10', f'rchar: {bad}'))
        for extra in ['rchar: 1\n', 'unknown: 1\n']:
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'Unexpected or duplicate'):
                parse_proc_io(valid + extra)
        with self.assertRaisesRegex(ValueError, 'must be text'):
            parse_proc_io(None)
        with self.assertRaisesRegex(ValueError, 'decreased'):
            checked_proc_io(valid, valid.replace('rchar: 10', 'rchar: 9'))


class ExportEquivalenceTests(unittest.TestCase):
    def fixture(self, root, owner=OWNER, generated_at=GENERATED_AT, css=b'fixture style'):
        root.mkdir(mode=0o700)
        prefix = f'i/{CAPABILITY}'
        content = b'<html>distinct owned fixture</html>'
        files = {'index.html': b'private root', OWNER_FILE: json.dumps(dict(schemaVersion=1, ownerId=owner), indent=2).encode(),
                 f'{prefix}/index.html': b'list', f'{prefix}/assets/viewer.css': css, f'{prefix}/assets/viewer.js': b'script',
                 f'{prefix}/security-headers.json': b'{}', f'{prefix}/documents/original/index.html': b'shell',
                 f'{prefix}/documents/original/content/index.html': content, f'{prefix}/documents/original/copy.json': b'{}'}
        entries = [dict(path=name, sha256=hashlib.sha256(data).hexdigest(), size=len(data)) for name, data in sorted(files.items())]
        digest = hashlib.sha256()
        for entry in entries:
            for value in [entry['path'], entry['sha256'], str(entry['size'])]:
                digest.update(value.encode()); digest.update(b'\0')
        manifest = dict(schemaVersion=1, generatedAt=generated_at, documentCount=1, snapshotHash=digest.hexdigest(), files=entries)
        files[MANIFEST_FILE] = json.dumps(manifest, indent=2).encode()
        for name, data in files.items():
            filename = root / name
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_bytes(data)
            filename.chmod(0o600)
        for directory in root.rglob('*'):
            if directory.is_dir():
                directory.chmod(0o700)
        spec = {'documents': [dict(metadata=dict(id='original'), sha256=hashlib.sha256(content).hexdigest(), bytes=len(content))]}
        result = dict(outputDir=str(root), capability=CAPABILITY, inboxPath=f'/i/{CAPABILITY}', ownerId=owner, manifest=manifest)
        return spec, json.dumps(result, indent=2) + '\n'

    def test_full_fixed_options_compare_every_file_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'first', Path(directory) / 'second'
            spec, stdout = self.fixture(first)
            other, output = self.fixture(second)
            a = inspect_export(first, spec, stdout, deterministic=True)
            b = inspect_export(second, other, output, deterministic=True)
            self.assertTrue(compare_exports(first, second, a, b, True)['exact_all_file_bytes'])

    def test_cli_owner_time_differences_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'first', Path(directory) / 'second'
            spec, stdout = self.fixture(first)
            other, output = self.fixture(second, owner='22222222-2222-4222-8222-222222222222', generated_at='2026-11-07T00:00:01.000Z')
            a = inspect_export(first, spec, stdout)
            b = inspect_export(second, other, output)
            result = compare_exports(first, second, a, b, False)
            self.assertEqual(set(result['differing_nonce_files']), {OWNER_FILE, MANIFEST_FILE})
            self.assertFalse(result['exact_all_file_bytes'])

    def test_valid_changed_asset_is_not_normalized_away(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / 'first', Path(directory) / 'second'
            spec, stdout = self.fixture(first)
            other, output = self.fixture(second, css=b'wrong but internally hashed')
            a = inspect_export(first, spec, stdout)
            b = inspect_export(second, other, output)
            with self.assertRaises(AssertionError):
                compare_exports(first, second, a, b, False)

    def test_nonce_file_format_changes_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'export'
            spec, stdout = self.fixture(root)
            filename = root / OWNER_FILE
            filename.write_text(json.dumps(json.loads(filename.read_text())))
            with self.assertRaises(AssertionError):
                inspect_export(root, spec, stdout)
