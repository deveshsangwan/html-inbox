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


def plan_runs(args, runtimes):
    """Every process in execution order. Runtime versions contain dots, so logs append to the full name."""
    runs = []
    for runtime in runtimes:
        for count, size in args.cells:
            for pair in range(args.pairs):
                # Reverse alternate pairs so warm-up and thermal drift do not favor one variant.
                order = args.variants if pair % 2 == 0 else list(reversed(args.variants))
                for variant in order:
                    output = args.out / f'{runtime}-{count}-{size}-pair{pair}-{variant}'
                    runs.append(dict(runtime=runtime, count=count, size=size, pair=pair, variant=variant,
                                     out=output, log=output.parent / (output.name + '.log')))

    paths = [run['out'] for run in runs] + [run['log'] for run in runs]
    if len(set(paths)) != len(paths):
        raise ValueError('planned output or log paths collide')

    return runs


def run_pairs(args):
    builds = {'parent': (args.parent_dist, args.parent_ref), 'candidate': (args.candidate_dist, args.candidate_ref)}
    nodes = {subprocess.check_output([node, '--version'], text=True).strip(): node for node in args.node}
    if len(nodes) != len(args.node):
        raise ValueError('each --node must be a distinct runtime version')

    planned = plan_runs(args, list(nodes))
    commands = []
    for run in planned:
        dist, ref = builds['parent' if run['variant'] == 'parent' else 'candidate']
        command = [sys.executable, str(RUNNER), args.workload, '--node', nodes[run['runtime']], '--counts', str(run['count']),
                   '--sizes', str(run['size']), '--samples', '1', '--timeout', str(args.timeout), '--implementation-dist', str(dist),
                   '--implementation-ref', ref, '--out', str(run['out'])]
        if run['variant'] == 'keys':
            command += ['--signature-mode', 'keys']

        started = time.time()
        with run['log'].open('x') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
        entry = dict(run, out=str(run['out']), log=str(run['log']), command=command, exit_code=result.returncode,
                     wall_seconds=round(time.time() - started, 3))
        commands.append(entry)
        with (args.out / 'commands.jsonl').open('a') as log:
            log.write(json.dumps(entry) + '\n')
        print('DONE', run['out'].name, result.returncode, entry['wall_seconds'], flush=True)

        if result.returncode:
            # Stop measuring, but still summarize so the failed and unrun blocks are reported as missing.
            print(run['log'].read_text(), flush=True)
            break

    return planned, commands


def block(run):
    return (run['runtime'], run['count'], run['size'], run['variant'], run['pair'])


def summarize(planned, commands):
    exit_codes = {block(entry): entry['exit_code'] for entry in commands}
    missing_processes = [dict(runtime=run['runtime'], count=run['count'], body_bytes=run['size'], variant=run['variant'], pair=run['pair'],
                              reason='not run' if block(run) not in exit_codes else f"exit {exit_codes[block(run)]}")
                         for run in planned if exit_codes.get(block(run)) != 0]

    per_process = defaultdict(list)
    per_pair = {}
    for entry in commands:
        if entry['exit_code']:
            continue

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
            process = dict(cpu_ms=statistics.median(row['cpu_ms'] for row in rows),
                           wall_ms=statistics.median(row['wall_ms'] for row in rows),
                           verifications=statistics.median(row['crypto']['verifications'] for row in rows),
                           retained_heap_bytes=max(row['memory_after_gc']['heapUsed'] for row in rows), samples=len(rows))
            per_process[key].append(process)
            per_pair[key + (entry['pair'],)] = process

    summary = []
    for (runtime, count, size, label, variant), processes in sorted(per_process.items()):
        cpu = [process['cpu_ms'] for process in processes]
        summary.append(dict(runtime=runtime, count=count, body_bytes=size, operation=label, variant=variant, processes=len(processes),
                            samples=sum(process['samples'] for process in processes),
                            cpu_ms_median=statistics.median(cpu), cpu_ms_min=min(cpu), cpu_ms_max=max(cpu),
                            wall_ms_median=statistics.median(process['wall_ms'] for process in processes),
                            verifications_median=statistics.median(process['verifications'] for process in processes),
                            retained_heap_bytes_max=max(process['retained_heap_bytes'] for process in processes)))
    # Any operation seen in one block is expected in every planned block of the same cell.
    operations = {(runtime, count, size, label) for runtime, count, size, label, _variant in per_process}
    missing_operations = [dict(runtime=runtime, count=count, body_bytes=size, operation=label, variant=run['variant'], pair=run['pair'])
                          for runtime, count, size, label in sorted(operations)
                          for run in planned if (run['runtime'], run['count'], run['size']) == (runtime, count, size)
                          and (runtime, count, size, label, run['variant'], run['pair']) not in per_pair]

    return dict(complete=not missing_processes and not missing_operations, missing_processes=missing_processes,
                missing_operations=missing_operations, marginal=summary, paired=paired_comparisons(per_pair))


def paired_comparisons(per_pair):
    """Each variant against the parent inside the same interleaved block, so drift between blocks cancels."""
    comparisons = []
    for (runtime, count, size, label, variant, pair), process in sorted(per_pair.items()):
        parent = per_pair.get((runtime, count, size, label, 'parent', pair))
        if variant == 'parent' or parent is None:
            continue

        comparisons.append(dict(runtime=runtime, count=count, body_bytes=size, operation=label, pair=pair, variant=variant,
                                parent_cpu_ms=parent['cpu_ms'], variant_cpu_ms=process['cpu_ms'],
                                cpu_ms_delta=process['cpu_ms'] - parent['cpu_ms'],
                                cpu_ratio=process['cpu_ms'] / parent['cpu_ms'] if parent['cpu_ms'] else None))
    return comparisons


def main():
    args = parse_args()
    args.out.mkdir(parents=True)
    harness = dict(commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
                   dirty=subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True),
                   invocation=sys.argv)
    (args.out / 'harness.json').write_text(json.dumps(harness, indent=2) + '\n')

    result = summarize(*run_pairs(args))
    (args.out / 'pairs-summary.json').write_text(json.dumps(result, indent=2) + '\n')
    for row in result['marginal']:
        print(f"{row['runtime']} {row['count']}:{row['body_bytes']} {row['operation']} {row['variant']}: "
              f"CPU median {row['cpu_ms_median']:.3f} ms [{row['cpu_ms_min']:.3f}, {row['cpu_ms_max']:.3f}] "
              f"processes={row['processes']} samples={row['samples']}")
    for row in result['paired']:
        print(f"{row['runtime']} {row['count']}:{row['body_bytes']} {row['operation']} pair{row['pair']} {row['variant']}/parent: "
              f"{row['variant_cpu_ms']:.3f}/{row['parent_cpu_ms']:.3f} ms")
    for row in result['missing_processes'] + result['missing_operations']:
        print('MISSING', json.dumps(row), flush=True)

    if not result['complete']:
        sys.exit(1)


if __name__ == '__main__':
    main()
