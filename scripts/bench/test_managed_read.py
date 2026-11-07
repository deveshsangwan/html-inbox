"""Check that export comparison admits only the explicitly recorded CLI nonces."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from managed_read import CAPABILITY, GENERATED_AT, MANIFEST_FILE, OWNER, OWNER_FILE, compare_exports, inspect_export


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
