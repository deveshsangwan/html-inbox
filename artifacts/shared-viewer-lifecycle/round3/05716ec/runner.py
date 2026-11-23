"""PR120 round-3 sequential qualification for one exact candidate.

Runs only inside a root-granted LOCAL slot. Steps 1-3 always run first; full verify runs
only when they all pass and its whole cap still fits the application budget.
"""
import gzip
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

CANDIDATE = sys.argv[1]
WORKTREE = Path('/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47')
SCRATCH = Path(__file__).resolve().parent
RUN = SCRATCH / f'round3-{CANDIDATE[:7]}-{time.strftime("%Y%m%dT%H%M%S")}'
APPLICATION_BUDGET = 1200
VERIFY_CAP = 600
GENERATED = ['packages/cli/dist', 'packages/cli/bundle']
FOCUSED = [
    'packages/cli/dist/viewer-owned-lifecycle.test.js', 'packages/cli/dist/viewer-mutation-shutdown.test.js',
    'packages/cli/dist/viewer-shutdown.test.js', 'packages/cli/dist/viewer-startup-races.test.js',
    'packages/cli/dist/viewer-tailscale-lifecycle.test.js', 'scripts/viewer-fixture-browser.test.mjs',
    'scripts/document-deletion-browser.test.mjs', 'scripts/document-isolation-browser.test.mjs',
]
OWNERSHIP = [
    'packages/cli/dist/sync-maintenance.test.js', 'packages/cli/dist/sync-acquisition-deadline.test.js',
    'packages/cli/dist/viewer-service-owner.test.js', 'packages/cli/dist/viewer-service.test.js',
    'packages/cli/dist/hub-http.test.js',
]
RUNTIMES = ['20.20.2', '24.19.0']
rows = []
started = time.monotonic()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=WORKTREE, text=True).strip()


def tree_hashes(relative):
    base = WORKTREE / relative
    return {str(p.relative_to(WORKTREE)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(base.rglob('*')) if p.is_file()}


def record():
    (RUN / 'commands.json').write_text(json.dumps(rows, indent=2) + '\n')


def run(label, command, timeout):
    elapsed = time.monotonic() - started
    remaining = APPLICATION_BUDGET - elapsed
    if remaining < timeout:
        rows.append(dict(label=label, command=command, outcome='UNRUN', reason=f'cap {timeout}s exceeds remaining {remaining:.0f}s'))
        record()
        return None

    log_path = RUN / f'{label}.log'
    begin = time.monotonic()
    with log_path.open('wb') as log:
        log.write(('$ ' + ' '.join(command) + '\n').encode())
        log.flush()
        child = subprocess.Popen(command, cwd=WORKTREE, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, env=ENV)
        code = None
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            code = 'TIMEOUT'
        finally:
            # The session belongs to this exact child; never signal another owner's processes.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        log.write(f'\nEXIT {code}\n'.encode())
    rows.append(dict(label=label, command=command, exit_code=code, seconds=round(time.monotonic() - begin, 1)))
    record()
    return code


assert git('rev-parse', 'HEAD') == CANDIDATE, 'HEAD is not the pinned candidate'
assert not git('status', '--porcelain'), 'Worktree is not clean'
RUN.mkdir()
(RUN / 'tmp').mkdir()
ENV = {**os.environ, 'TMPDIR': str(RUN / 'tmp')}

backup = RUN / 'generated-backup'
prior = {}
for relative in GENERATED:
    if (WORKTREE / relative).exists():
        prior.update(tree_hashes(relative))
        shutil.copytree(WORKTREE / relative, backup / relative, symlinks=True)
(RUN / 'prior-generated.json').write_text(json.dumps(prior, indent=2) + '\n')

try:
    gates = [
        run('typecheck-node24', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'typecheck'], 60),
        run('build-node24', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'build'], 60),
    ]
    if gates == [0, 0]:
        (RUN / 'candidate-generated.json').write_text(json.dumps(tree_hashes('packages/cli/dist'), indent=2) + '\n')
        for runtime in RUNTIMES:
            gates.append(run(f'focused-node{runtime.split(".")[0]}',
                             ['fnm', 'exec', f'--using={runtime}', 'node', '--test', *FOCUSED], 180))
        for runtime in RUNTIMES:
            gates.append(run(f'ownership-node{runtime.split(".")[0]}',
                             ['fnm', 'exec', f'--using={runtime}', 'node', '--test', *OWNERSHIP], 120))

    if all(code == 0 for code in gates) and len(gates) == 6:
        run('verify-node24', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'verify'], VERIFY_CAP)
    else:
        rows.append(dict(label='verify-node24', outcome='UNRUN', reason='earlier gate did not pass'))
        record()
finally:
    cleanup_begin = time.monotonic()
    for relative in GENERATED:
        shutil.rmtree(WORKTREE / relative, ignore_errors=True)
        if (backup / relative).exists():
            shutil.copytree(backup / relative, WORKTREE / relative, symlinks=True)
    restored = {}
    for relative in GENERATED:
        if (WORKTREE / relative).exists():
            restored.update(tree_hashes(relative))
    leftovers = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            cwd = os.readlink(proc / 'cwd')
            argv = (proc / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
        except OSError:
            continue
        if cwd.startswith(str(WORKTREE)) or str(RUN) in argv:
            leftovers.append(dict(pid=int(proc.name), cwd=cwd, argv=argv[:300]))
    cleanup = dict(
        application_seconds=round(cleanup_begin - started, 1),
        cleanup_seconds=round(time.monotonic() - cleanup_begin, 1),
        generated_restored=restored == prior,
        generated_file_count=len(prior),
        leftover_processes=leftovers,
        worktree_status=git('status', '--porcelain'),
        head=git('rev-parse', 'HEAD'),
    )
    (RUN / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
    for log in RUN.glob('*.log'):
        data = log.read_bytes()
        with gzip.GzipFile(str(log) + '.gz', 'wb', compresslevel=9, mtime=0) as archive:
            archive.write(data)
    print(json.dumps(dict(run=str(RUN), rows=rows, cleanup=cleanup), indent=2))
