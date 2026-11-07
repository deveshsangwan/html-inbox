#!/usr/bin/env python3
"""#91 only. Build base/8/32, then run sequential paired warm ext4 workloads."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
BASE = '610c931b7b22920cce59cf03e49c0de15ebaf2a2'


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--node20', required=True)
    parser.add_argument('--node24', required=True)
    parser.add_argument('--samples', type=int, default=3)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = REPO / 'packages/cli/src/backend.ts'
    candidate = source.read_bytes()
    baseline = subprocess.check_output(['git', 'show', f'{BASE}:packages/cli/src/backend.ts'], cwd=REPO)
    builds = {}

    try:
        for variant, content in [('base', baseline), ('8', re.sub(rb'LISTING_READ_LIMIT = \d+', b'LISTING_READ_LIMIT = 8', candidate)), ('32', re.sub(rb'LISTING_READ_LIMIT = \d+', b'LISTING_READ_LIMIT = 32', candidate))]:
            source.write_bytes(content)
            with (out / f'build-{variant}.log').open('w') as log:
                subprocess.run(['pnpm', 'build'], cwd=REPO, stdout=log, stderr=subprocess.STDOUT, check=True)
            target = out / f'dist-{variant}'
            shutil.copytree(REPO / 'packages/cli/dist', target)
            builds[variant] = {'source_sha256': hashlib.sha256(content).hexdigest(),
                               'files': {str(file.relative_to(target)): digest(file) for file in sorted(target.glob('*.js'))}}
    finally:
        source.write_bytes(candidate)

    fixture_root = Path(tempfile.mkdtemp(prefix='listing-fixtures-', dir=out))
    environment = {'base': BASE, 'candidate_diff': subprocess.check_output(['git', 'diff', '--', 'packages/cli/src/backend.ts'], cwd=REPO, text=True),
                   'build_node': subprocess.check_output(['node', '--version'], text=True).strip(),
                   'kernel': subprocess.check_output(['uname', '-a'], text=True).strip(),
                   'filesystem': subprocess.check_output(['df', '-T', str(fixture_root)], text=True),
                   'builds': builds, 'fixture_root': str(fixture_root), 'samples': args.samples,
                   'cache': 'uncontrolled warm OS cache; fixtures freshly written on ext4; child warms once before timing; no physical disk I/O claim'}
    (out / 'environment.json').write_text(json.dumps(environment, indent=2))
    hashes = {}

    try:
        for count in [100, 1000, 5000]:
            home = fixture_root / str(count)
            env = {'PATH': os.environ['PATH'], 'HOME': str(fixture_root), 'TMPDIR': str(fixture_root),
                   'HTML_INBOX_HOME': str(home), 'HTML_INBOX_CATALOG_HOME': str(fixture_root / 'catalog')}
            subprocess.run([args.node24, str(REPO / 'scripts/bench/workload.cjs'), 'seed', str(home), str(count), '10240', '1'], env=env, check=True)
            for node in [args.node20, args.node24]:
                for mode in ['direct1', 'direct4', 'http4']:
                    for sample in range(args.samples):
                        variants = ['base', '8', '32']
                        variants = variants[sample % 3:] + variants[:sample % 3]
                        for variant in variants:
                            command = [node, str(REPO / 'scripts/bench/listing.cjs'), str(out / f'dist-{variant}'), str(home), str(count), mode]
                            start = time.monotonic()
                            result = subprocess.run(command, cwd=REPO, env=env, text=True, capture_output=True, timeout=180)
                            row = {'variant': variant, 'sample': sample, 'command': command, 'exit_code': result.returncode,
                                   'process_wall_ms': (time.monotonic() - start) * 1000, 'stdout': result.stdout, 'stderr': result.stderr}
                            with (out / 'samples.jsonl').open('a') as stream:
                                stream.write(json.dumps(row) + '\n')
                            if result.returncode:
                                raise RuntimeError(result.stderr)
                            measured = json.loads(result.stdout)
                            key = (count, mode)
                            if key in hashes:
                                assert hashes[key] == measured['output_hash'], key
                            hashes[key] = measured['output_hash']
                    print(node, count, mode, 'complete', flush=True)
    finally:
        shutil.rmtree(fixture_root)
        (out / 'cleanup.json').write_text(json.dumps({'fixture_removed': not fixture_root.exists(), 'children': 'sequential subprocess.run with timeout; no detached services'}))


if __name__ == '__main__':
    main()
