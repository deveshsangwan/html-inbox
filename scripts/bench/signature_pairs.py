#!/usr/bin/env python3
"""Interleaved parent/candidate process pairs for the signature workloads.

Builds are the caller's job: pass each compiled dist and the source pin it came from.
run.py hashes every dist it loads, so the per-process environment.json records build identity.
"""
import argparse
import json
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RUNNER = REPO / 'scripts/bench/run.py'


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parent-dist', type=Path, required=True)
    parser.add_argument('--parent-ref', required=True)
    parser.add_argument('--candidate-dist', type=Path, required=True)
    parser.add_argument('--candidate-ref', required=True)
    parser.add_argument('--node', action='append', required=True, help='Node executable; repeat to measure each runtime separately')
    parser.add_argument('--workload', choices=['signatures', 'signature-history'], default='signatures')
    parser.add_argument('--cells', default='100:10240', help='comma-separated count:size cells')
    parser.add_argument('--variants', default='parent,candidate', help='ordered subset of parent,keys,candidate')
    parser.add_argument('--pairs', type=int, default=5)
    parser.add_argument('--timeout', type=int, default=1200)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()

    variants = args.variants.split(',')
    if not variants or len(set(variants)) != len(variants) or not set(variants) <= {'parent', 'keys', 'candidate'}:
        parser.error('--variants must be a duplicate-free subset of parent,keys,candidate')
    if not 1 <= args.pairs <= 20:
        parser.error('--pairs must be between 1 and 20')
    if args.out.exists():
        parser.error('--out must not exist; every qualification uses a fresh directory')

    args.variants = variants
    args.cells = [tuple(int(part) for part in cell.split(':')) for cell in args.cells.split(',')]
    return args


def run_pairs(args):
    builds = {'parent': (args.parent_dist, args.parent_ref), 'candidate': (args.candidate_dist, args.candidate_ref)}
    commands = []
    for node in args.node:
        runtime = subprocess.check_output([node, '--version'], text=True).strip()
        for count, size in args.cells:
            for pair in range(args.pairs):
                # Reverse alternate pairs so warm-up and thermal drift do not favor one variant.
                order = args.variants if pair % 2 == 0 else list(reversed(args.variants))
                for variant in order:
                    dist, ref = builds['parent' if variant == 'parent' else 'candidate']
                    output = args.out / f'{runtime}-{count}-{size}-pair{pair}-{variant}'
                    command = [sys.executable, str(RUNNER), args.workload, '--node', node, '--counts', str(count), '--sizes', str(size),
                               '--samples', '1', '--timeout', str(args.timeout), '--implementation-dist', str(dist),
                               '--implementation-ref', ref, '--out', str(output)]
                    if variant == 'keys':
                        command += ['--signature-mode', 'keys']

                    started = time.time()
                    with output.with_suffix('.log').open('w') as log:
                        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
                    entry = dict(runtime=runtime, count=count, size=size, pair=pair, variant=variant, command=command,
                                 exit_code=result.returncode, wall_seconds=round(time.time() - started, 3), out=str(output))
                    commands.append(entry)
                    with (args.out / 'commands.jsonl').open('a') as log:
                        log.write(json.dumps(entry) + '\n')
                    print('DONE', output.name, result.returncode, entry['wall_seconds'], flush=True)

                    if result.returncode:
                        print(output.with_suffix('.log').read_text(), flush=True)
                        sys.exit(result.returncode)

    return commands


def summarize(commands):
    per_process = defaultdict(list)
    for entry in commands:
        output = Path(entry['out'])
        assert json.loads((output / 'summary.json').read_text())['success'], output
        assert json.loads((output / 'cleanup.json').read_text()) == {'fixture_root_removed': True, 'children_reaped': True}, output

        operations = defaultdict(list)
        for raw in (output / 'samples.jsonl').read_text().splitlines():
            sample = json.loads(raw)
            for line in sample['stdout'].splitlines():
                operation = json.loads(line)
                operations[operation['label']].append(operation)

        for label, rows in operations.items():
            key = (entry['runtime'], entry['count'], entry['size'], label, entry['variant'])
            per_process[key].append(dict(cpu_ms=statistics.median(row['cpu_ms'] for row in rows),
                                         wall_ms=statistics.median(row['wall_ms'] for row in rows),
                                         verifications=statistics.median(row['crypto']['verifications'] for row in rows),
                                         retained_heap_bytes=max(row['memory_after_gc']['heapUsed'] for row in rows)))

    summary = []
    for (runtime, count, size, label, variant), processes in sorted(per_process.items()):
        cpu = [process['cpu_ms'] for process in processes]
        summary.append(dict(runtime=runtime, count=count, body_bytes=size, operation=label, variant=variant, processes=len(processes),
                            cpu_ms_median=statistics.median(cpu), cpu_ms_min=min(cpu), cpu_ms_max=max(cpu),
                            wall_ms_median=statistics.median(process['wall_ms'] for process in processes),
                            verifications_median=statistics.median(process['verifications'] for process in processes),
                            retained_heap_bytes_max=max(process['retained_heap_bytes'] for process in processes)))
    return summary


def main():
    args = parse_args()
    args.out.mkdir(parents=True)
    harness = dict(commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
                   dirty=subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True),
                   invocation=sys.argv)
    (args.out / 'harness.json').write_text(json.dumps(harness, indent=2) + '\n')

    summary = summarize(run_pairs(args))
    (args.out / 'pairs-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    for row in summary:
        print(f"{row['runtime']} {row['count']}:{row['body_bytes']} {row['operation']} {row['variant']}: "
              f"CPU median {row['cpu_ms_median']:.3f} ms [{row['cpu_ms_min']:.3f}, {row['cpu_ms_max']:.3f}] n={row['processes']}")


if __name__ == '__main__':
    main()
