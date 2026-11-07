#!/usr/bin/env python3
"""Linux resource runner. No third party Python packages; build and bundle first."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import statistics
import sys
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workload', choices=['baseline', 'cli', 'viewer', 'worker', 'parser', 'managed', 'sync', 'signatures'])
    parser.add_argument('--counts', default='0,100')
    parser.add_argument('--sizes', default='10240,1048576,9437184')
    parser.add_argument('--samples', type=int, default=3)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--candidate', help='CommonJS module exporting validateHtml for exact-result parser comparison')
    parser.add_argument('--signature-mode', choices=['full', 'keys'], default='full',
                        help='Signatures companion only: production behavior or parsed-key reuse without verification reuse')
    parser.add_argument('--implementation-dist', type=Path, help='Signatures only: prebuilt production dist directory')
    parser.add_argument('--implementation-ref', help='Signatures only: asserted source pin for the selected build, independently verify its build receipt')
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    try:
        counts = [int(n) for n in args.counts.split(',')]
        sizes = [int(n) for n in args.sizes.split(',')]
    except ValueError:
        parser.error('counts and sizes must be comma-separated integers')

    if not args.node:
        parser.error('node was not found; supply --node with an executable path')
    if args.candidate and args.workload not in ['baseline', 'parser']:
        parser.error('--candidate requires the parser or baseline workload')
    if args.signature_mode != 'full' and args.workload != 'signatures':
        parser.error('--signature-mode requires the signatures workload')
    if (args.implementation_dist or args.implementation_ref) and args.workload != 'signatures':
        parser.error('--implementation-dist and --implementation-ref require the signatures workload')
    if bool(args.implementation_dist) != bool(args.implementation_ref):
        parser.error('--implementation-dist and --implementation-ref must be supplied together')
    if len(set(counts)) != len(counts) or len(set(sizes)) != len(sizes):
        parser.error('counts and sizes must not contain duplicates')
    if not counts or any(n not in [0, 100, 1000, 5000, 10000] for n in counts):
        parser.error('counts must be drawn from 0,100,1000,5000,10000')
    if any(n not in [10240, 1048576, 9437184] for n in sizes) or not 1 <= args.samples <= 100 or not 1 <= args.timeout <= 3600:
        parser.error('invalid sizes, samples or timeout')
    if not Path('/proc/self/io').exists() or not hasattr(os, 'wait4'):
        parser.error('resource collection requires Linux /proc and wait4')
    args.node = str(Path(args.node).resolve())
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    rows = []
    active = None

    def interrupt(signum, frame):
        raise InterruptedError(f'signal {signum}')

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    root = None
    try:
        with tempfile.TemporaryDirectory(prefix='html-inbox-bench-') as directory:
            root = Path(directory)
            env = {'PATH': os.environ.get('PATH', ''), 'HOME': directory, 'TMPDIR': directory,
                   'XDG_CONFIG_HOME': directory, 'XDG_STATE_HOME': directory, 'XDG_DATA_HOME': directory,
                   'HTML_INBOX_HOME': directory, 'HTML_INBOX_CATALOG_HOME': str(root / 'catalog')}

            def run(label, command, check=None):
                nonlocal active
                with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                    start = time.perf_counter()
                    active = subprocess.Popen(command, env=env, cwd=REPO, stdout=stdout, stderr=stderr, start_new_session=True)
                    child = active
                    try:
                        while True:
                            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                            if pid:
                                child.returncode = os.waitstatus_to_exitcode(status)
                                break
                            if time.perf_counter() - start > args.timeout:
                                raise TimeoutError(label)
                            time.sleep(.005)
                        elapsed = (time.perf_counter() - start) * 1000
                        stdout.seek(0)
                        stderr.seek(0)
                        output, errors = stdout.read().decode(), stderr.read().decode()
                        row = dict(label=label, command=command, exit_code=child.returncode, wall_ms=elapsed,
                                   cpu_ms=(usage.ru_utime + usage.ru_stime) * 1000, peak_rss_kib=usage.ru_maxrss,
                                   input_blocks=usage.ru_inblock, output_blocks=usage.ru_oublock,
                                   stdout=output, stderr=errors)
                        rows.append(row)
                        with (args.out / 'samples.jsonl').open('a') as stream:
                            stream.write(json.dumps(row) + '\n')
                        if child.returncode:
                            raise RuntimeError(f'{label}: {errors[-2000:]}')
                        if check:
                            check(output)
                        return output
                    except BaseException as error:
                        stdout.seek(0)
                        stderr.seek(0)
                        with (args.out / 'failures.jsonl').open('a') as stream:
                            stream.write(json.dumps(dict(label=label, command=command, error=repr(error),
                                                         stdout=stdout.read().decode(errors='replace'),
                                                         stderr=stderr.read().decode(errors='replace'))) + '\n')
                        raise
                    finally:
                        # Kill the owned group even if its leader exited, so failed workloads cannot orphan helpers.
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            child.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            pass
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait()
                        # Only a successful wait clears the direct child from the cleanup receipt.
                        assert child.returncode is not None
                        active = None

            node = [args.node]
            helper = node + [str(REPO / 'scripts/bench/workload.cjs')]
            cli = node + [str(REPO / 'packages/cli/bundle/index.js')]
            dist_hash = hashlib.sha256()
            for artifact in sorted((REPO / 'packages/cli/dist').rglob('*.js')):
                dist_hash.update(str(artifact.relative_to(REPO)).encode() + b'\0')
                dist_hash.update(artifact.read_bytes())

            fingerprints = dict(bundle_sha256=hashlib.sha256((REPO / 'packages/cli/bundle/index.js').read_bytes()).hexdigest(),
                                dist_js_sha256=dist_hash.hexdigest(),
                                candidate_sha256=hashlib.sha256(Path(args.candidate).read_bytes()).hexdigest() if args.candidate else None)
            signature_implementation = None
            if args.workload == 'signatures':
                signature_dist = (args.implementation_dist or REPO / 'packages/cli/dist').resolve()
                if not (signature_dist / 'sync-store.js').is_file():
                    parser.error('signature implementation dist must contain sync-store.js')
                signature_hash = hashlib.sha256()
                for artifact in sorted(signature_dist.rglob('*.js')):
                    signature_hash.update(str(artifact.relative_to(signature_dist)).encode() + b'\0')
                    signature_hash.update(artifact.read_bytes())
                signature_implementation = dict(dist=str(signature_dist), asserted_source_ref=args.implementation_ref,
                                                dist_js_sha256=signature_hash.hexdigest(), signature_mode=args.signature_mode,
                                                source_pin_verified=False)
            metadata = dict(commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
                            dirty=subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True),
                            node=subprocess.check_output(node + ['--version'], text=True).strip(),
                            versions=json.loads(subprocess.check_output(node + ['-p', 'JSON.stringify(process.versions)'], text=True)),
                            parser=json.loads((REPO / 'node_modules/parse5/package.json').read_text())['version'],
                            filesystem=subprocess.check_output(['stat', '-f', '-c', '%T', directory], text=True).strip(),
                            machine=list(os.uname()), samples=args.samples, counts=counts, sizes=sizes,
                            cache='fresh isolated fixtures; filesystem cache uncontrolled/warm; no OS cache eviction',
                            bundle_bytes=(REPO / 'packages/cli/bundle/index.js').stat().st_size,
                            limits={'timeout_seconds': args.timeout, 'concurrency': 1}, fixture_root=directory,
                            fingerprints=fingerprints, signature_implementation=signature_implementation, invocation=sys.argv)
            (args.out / 'environment.json').write_text(json.dumps(metadata, indent=2))
            success = False
            try:
                if args.workload in ['baseline', 'cli']:
                    for _ in range(args.samples):
                        run('cli/version', cli + ['--version'])
                for count in counts:
                    home = root / f'library-{count}'
                    if args.workload == 'signatures':
                        signature_helper = node + ['--expose-gc', str(REPO / 'scripts/bench/workload.cjs')]
                        for sample in range(args.samples):
                            signature_root = root / f'signatures-{count}-{sample}'
                            fixture_args = [str(signature_root), str(count), str(sizes[0]), '1', args.signature_mode, '-', str(signature_dist)]
                            run(f'signatures/setup/{count}', signature_helper + ['signature-setup'] + fixture_args)
                            run(f'signatures/process/{count}', signature_helper + ['signatures'] + fixture_args)
                            shutil.rmtree(signature_root)
                    if args.workload in ['baseline', 'cli', 'viewer']:
                        run(f'setup/{count}', helper + ['seed', str(home), str(count), str(sizes[0]), '1'])
                    if args.workload in ['baseline', 'cli']:
                        def check_list(output):
                            documents = json.loads(output)
                            assert len(documents) == count, (count, documents)
                            assert sorted(d['id'] for d in documents) == [f'bench-{i:05}' for i in range(count)]
                        for _ in range(args.samples):
                            run(f'cli/list/{count}', cli + ['list', '--json', '--home', str(home)], check_list)
                            destination = root / 'export'
                            run(f'cli/export/{count}', cli + ['export', '--json', '--home', str(home), '--out', str(destination)])
                            exported = list(destination.glob('**/documents/*/content/index.html'))
                            assert len(exported) == count
                            for content in exported:
                                original = home / 'documents' / content.parent.parent.name / 'index.html'
                                assert content.read_bytes() == original.read_bytes()
                            row = dict(label=f'disk/export/{count}', logical_bytes=sum(p.stat().st_size for p in destination.rglob('*') if p.is_file()),
                                       allocated_bytes=sum(p.stat().st_blocks * 512 for p in destination.rglob('*')))
                            rows.append(row)
                            with (args.out / 'samples.jsonl').open('a') as stream:
                                stream.write(json.dumps(row) + '\n')
                            shutil.rmtree(destination)
                    for mode in ['viewer', 'worker', 'managed', 'sync']:
                        if args.workload in ['baseline', mode]:
                            run(f'{mode}/{count}', helper + [mode, str(home if mode == 'viewer' else root / f'{mode}-{count}'), str(count), str(sizes[0]), str(args.samples)])
                if args.workload in ['baseline', 'parser']:
                    for size in sizes:
                        for shape in ['text', 'dense']:
                            command = helper + ['parser', str(root), '0', str(size), str(args.samples), shape]
                            if args.candidate:
                                command.append(str(Path(args.candidate).resolve()))
                            run(f'parser/{shape}/{size}', command)
                success = True
            finally:
                groups = {}
                for row in rows:
                    if 'wall_ms' in row:
                        groups.setdefault(row['label'], []).append(row['wall_ms'])
                    for line in row.get('stdout', '').splitlines():
                        try:
                            nested = json.loads(line)
                            if isinstance(nested, dict) and 'wall_ms' in nested:
                                groups.setdefault('operation/' + nested['label'], []).append(nested['wall_ms'])
                        except (ValueError, KeyError):
                            pass
                summary = {label: dict(n=len(values), min_ms=min(values), median_ms=statistics.median(values), max_ms=max(values)) for label, values in groups.items()}
                (args.out / 'summary.json').write_text(json.dumps(dict(success=success, groups=summary), indent=2))
    finally:
        (args.out / 'cleanup.json').write_text(json.dumps(dict(fixture_root_removed=root is None or not root.exists(), children_reaped=active is None)))



if __name__ == '__main__':
    main()
