#!/usr/bin/env python3
"""Compare two npm-installed CLI artifacts on Linux; build/install before running."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import statistics
import subprocess
import tempfile
import time


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fingerprint(directory):
    return {str(p.relative_to(directory)): digest(p)
            for p in sorted(directory.rglob('*')) if p.is_file()}


class SampleInterrupted(Exception):
    """Ends a sample's wait so its group is killed and reaped before the recorded signal is re-raised."""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True, help='baseline consumer directory')
    parser.add_argument('--candidate', type=Path, required=True, help='candidate consumer directory')
    parser.add_argument('--base-ref', required=True)
    parser.add_argument('--candidate-ref', required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--launchers', default='direct,npm,npx')
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    launchers = args.launchers.split(',')
    if not hasattr(os, 'wait4') or not 1 <= args.samples <= 100 or any(x not in ['direct', 'npm', 'npx'] for x in launchers):
        parser.error('Linux wait4, 1..100 samples and direct/npm/npx launchers required')

    def interrupt(signum, frame):
        raise InterruptedError(f'signal {signum}')

    signal.signal(signal.SIGTERM, interrupt)
    args.out.mkdir(parents=True, exist_ok=False)
    node = args.node.resolve()
    consumers = {'base': args.base.resolve(), 'candidate': args.candidate.resolve()}
    metadata = dict(base_ref=args.base_ref, candidate_ref=args.candidate_ref, node=str(node),
                    node_version=subprocess.check_output([node, '--version'], text=True).strip(),
                    machine=list(os.uname()), samples=args.samples, warmups=2,
                    node_sha256=digest(node),
                    runner_sha256=digest(Path(__file__)),
                    cache='uncontrolled warm filesystem caches', launchers=launchers,
                    fingerprints={v: fingerprint(p / 'node_modules/html-inbox') for v, p in consumers.items()})
    for name in ['npm', 'npx']:
        cli = (node.parent / name).resolve()
        metadata[name] = dict(path=str(cli), sha256=digest(cli),
                              version=subprocess.check_output([node, cli, '--version'], text=True).strip())
    (args.out / 'environment.json').write_text(json.dumps(metadata, indent=2) + '\n')
    rows = []
    expected = {}
    with tempfile.TemporaryDirectory(prefix='html-inbox-startup-') as temporary:
        root = Path(temporary)
        env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': temporary, 'TMPDIR': temporary,
               'XDG_CONFIG_HOME': temporary, 'HTML_INBOX_HOME': str(root / 'library'),
               'HTML_INBOX_CATALOG_HOME': str(root / 'catalog'), 'npm_config_cache': str(root / 'npm-cache'),
               'npm_config_update_notifier': 'false', 'NO_COLOR': '1'}

        def run(variant, launcher, operation, arguments, sample):
            consumer = consumers[variant]
            if launcher == 'direct':
                command = [str(node), str(consumer / 'node_modules/html-inbox/bundle/index.js'), *arguments]
            else:
                cli = str((node.parent / launcher).resolve())
                prefix = ['exec', '--offline', '--', 'html-inbox'] if launcher == 'npm' else ['--offline', 'html-inbox']
                command = [str(node), cli, *prefix, *arguments]

            with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
                # SIGINT and SIGTERM are recorded while the child is being created or cleaned up, and interrupt
                # only the wait between, so a sample group is always killed and reaped before the signal takes
                # effect. Handlers raise only while waiting and clear that state first, so nothing raises inside
                # the cleanup. An inherited SIG_IGN is left alone, and the child starts with default
                # dispositions because exec resets caught signals.
                interrupts = []
                is_waiting = False

                def interrupt(signum, frame):
                    nonlocal is_waiting
                    interrupts.append(signum)
                    if is_waiting:
                        is_waiting = False
                        raise SampleInterrupted(signum)

                def timeout(signum, frame):
                    nonlocal is_waiting
                    if is_waiting:
                        is_waiting = False
                        raise TimeoutError(command)

                deferred = {number: signal.signal(number, interrupt) for number in (signal.SIGINT, signal.SIGTERM)
                            if signal.getsignal(number) is not signal.SIG_IGN}
                previous = signal.signal(signal.SIGALRM, timeout)
                try:
                    start = time.perf_counter()
                    child = subprocess.Popen(command, cwd=consumer, env=env, stdout=stdout, stderr=stderr, start_new_session=True)

                    try:
                        is_waiting = True
                        if interrupts:
                            is_waiting = False
                            raise SampleInterrupted(interrupts[0])
                        signal.alarm(30)
                        os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
                        is_waiting = False
                        elapsed = (time.perf_counter() - start) * 1000
                    finally:
                        is_waiting = False
                        signal.alarm(0)
                        # Kill the group before reaping: the unreaped leader keeps its group ID from being reused.
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        _, status, usage = os.wait4(child.pid, 0)
                finally:
                    signal.signal(signal.SIGALRM, previous)
                    for number, handler in deferred.items():
                        signal.signal(number, handler)
                    # The recorded signal takes precedence over a timeout or the internal interruption. Under the
                    # runner's own SIGTERM handler it surfaces as InterruptedError.
                    if interrupts:
                        signal.raise_signal(interrupts[0])
                child.returncode = os.waitstatus_to_exitcode(status)
                stdout.seek(0)
                stderr.seek(0)
                output, errors = stdout.read().decode(), stderr.read().decode()
            behavior = dict(stdout=output, stderr=errors, exit_code=child.returncode)
            key = (launcher, operation)
            if key in expected:
                assert behavior == expected[key], (variant, key, behavior, expected[key])
            else:
                assert child.returncode == (1 if operation == 'error' else 0), behavior
                expected[key] = behavior
            if sample < 0:
                return

            row = dict(variant=variant, launcher=launcher, operation=operation, sample=sample,
                       command=command, cwd=str(consumer), wall_ms=elapsed,
                       cpu_ms=(usage.ru_utime + usage.ru_stime) * 1000, peak_rss_kib=usage.ru_maxrss, **behavior)
            rows.append(row)
            with (args.out / 'samples.jsonl').open('a') as stream:
                stream.write(json.dumps(row) + '\n')

        operations = {'help': ['--help'], 'version': ['--version'], 'noargs': [],
                      'error': ['--version', '--json'], 'list': ['list', '--json']}
        for launcher in launchers:
            for operation, arguments in operations.items():
                for sample in range(-2, args.samples):
                    for variant in (['base', 'candidate'] if sample % 2 == 0 else ['candidate', 'base']):
                        run(variant, launcher, operation, arguments, sample)

    summary = []
    for launcher in launchers:
        for operation in operations:
            for variant in consumers:
                subset = [r for r in rows if (r['variant'], r['launcher'], r['operation']) == (variant, launcher, operation)]
                metrics = {metric: dict(min=min(values), median=statistics.median(values), max=max(values))
                           for metric in ['wall_ms', 'cpu_ms', 'peak_rss_kib']
                           for values in [[r[metric] for r in subset]]}
                summary.append(dict(variant=variant, launcher=launcher, operation=operation, n=len(subset), **metrics))
    (args.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    (args.out / 'cleanup.json').write_text(json.dumps(dict(fixture_removed=not root.exists(), children_reaped=True)) + '\n')


if __name__ == '__main__':
    main()
