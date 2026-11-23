"""PR120 round-3 fifth slot (round3d with the exact assert.rejects diagnostic): two disposable-copy lock reds, caller-branch overlays, focused and browser checks.

Runs only inside a root-granted LOCAL slot against one exact clean candidate. Exits nonzero on
any unexpected failure, timeout, inconclusive red, required UNRUN or failed cleanup.
"""
import gzip
import hashlib
import json
import os
import re
import select
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
FIXTURE_ROOT = RUN / 'tmp'
APPLICATION_BUDGET = 1200
CLEANUP_BUDGET = 120
BROWSER_CAP = 300
GENERATED = ['packages/cli/dist', 'packages/cli/bundle']
OVERLAY = WORKTREE / 'scripts/zz-red-isolation-overlay.test.mjs'
NODE_ROOT = Path.home() / '.local/share/fnm/node-versions'
DIST_ENTRY = WORKTREE / 'packages/cli/dist/index.js'
RED_ASSERTION = 'isolation home removed before owned viewer cleanup completed'
FIFO_EXPECTED = ['first-registered', 'second-registered']
# assert.rejects prefixes its message argument when no rejection happens.
SIGNAL_DIAGNOSTIC = 'Missing expected rejection: startup returned a lifecycle after its shutdown had started'
FOCUSED = [
    'packages/cli/dist/viewer-owned-lifecycle.test.js', 'packages/cli/dist/viewer-mutation-shutdown.test.js',
    'packages/cli/dist/viewer-shutdown.test.js', 'packages/cli/dist/viewer-startup-races.test.js',
    'packages/cli/dist/viewer-tailscale-lifecycle.test.js', 'packages/cli/dist/viewer-background.test.js',
    'packages/cli/dist/viewer-record-shutdown-race.test.js', 'scripts/viewer-fixture-browser.test.mjs',
    'scripts/document-deletion-browser.test.mjs', 'scripts/document-isolation-browser.test.mjs',
    'scripts/hub-browser.test.mjs',
]
OWNERSHIP = [
    'packages/cli/dist/sync-maintenance.test.js', 'packages/cli/dist/sync-acquisition-deadline.test.js',
    'packages/cli/dist/viewer-service-owner.test.js', 'packages/cli/dist/viewer-service.test.js',
    'packages/cli/dist/hub-http.test.js',
]
RUNTIMES = ['20.20.2', '24.19.0']
FIFO_PROBE = '''import { appendFileSync } from "node:fs";
import { test } from "node:test";
const log = process.env.FIFO_PROBE_LOG;
test("after-hook order", (t) => {
  t.after(() => appendFileSync(log, "first-registered\\n"));
  t.after(() => appendFileSync(log, "second-registered\\n"));
});
'''
rows = []
reaped = []
problems = []
state = dict(halted=None)
started = time.monotonic()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=WORKTREE, text=True).strip()


def tree_hashes(base, relative_to):
    return {str(p.relative_to(relative_to)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(base.rglob('*')) if p.is_file() and not p.is_symlink()}


def record():
    (RUN / 'commands.json').write_text(json.dumps(rows, indent=2) + '\n')


def fail(message):
    problems.append(message)
    (RUN / 'problems.json').write_text(json.dumps(problems, indent=2) + '\n')


def process_identity(pid):
    """Read argv, cwd and kernel start time; None when the process is gone or unreadable."""
    proc = Path(f'/proc/{pid}')
    try:
        argv = [part.decode(errors='replace') for part in (proc / 'cmdline').read_bytes().split(b'\0') if part]
        cwd = os.readlink(proc / 'cwd')
        stat = (proc / 'stat').read_text()
    except OSError:
        return None
    # Field 22 (starttime) follows the parenthesized command name, which may itself contain spaces.
    return dict(argv=argv, cwd=cwd, start_time=stat[stat.rindex(')') + 2:].split()[19])


def discover_run_processes():
    """Discovery only: candidates whose argv or cwd lies under this run's isolated TMPDIR."""
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        identity = process_identity(int(proc.name))
        if identity and (any(str(FIXTURE_ROOT) in part for part in identity['argv'])
                         or identity['cwd'].startswith(str(FIXTURE_ROOT))):
            found.append(dict(pid=int(proc.name), **identity))
    return found


def owned_worker_home(argv):
    """Exact owned shape: <fnm node> <worktree dist/index.js> sync worker start ... --home <under run TMPDIR>."""
    if len(argv) < 7 or not argv[0].startswith(str(NODE_ROOT)) or argv[1] != str(DIST_ENTRY):
        return None
    if argv[2:5] != ['sync', 'worker', 'start'] or '--home' not in argv:
        return None
    index = argv.index('--home')
    if index + 1 >= len(argv):
        return None
    home = Path(argv[index + 1]).resolve()
    return home if home.is_relative_to(FIXTURE_ROOT.resolve()) else None


def wait_exit(pidfd, deadline, seconds):
    budget = max(0.0, min(seconds, deadline - time.monotonic()))
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    return bool(poller.poll(int(budget * 1000)))


def join_detached_fixtures(label, deadline):
    """Join detached fixture workers through pinned pidfds. Returns (joined, preserved)."""
    outcomes = []
    for candidate in discover_run_processes():
        outcome = dict(pid=candidate['pid'], argv=' '.join(candidate['argv'])[:300], cwd=candidate['cwd'])
        outcomes.append(outcome)
        try:
            pidfd = os.pidfd_open(candidate['pid'])
        except ProcessLookupError:
            outcome['result'] = 'exited-before-pin'
            continue
        try:
            pinned = process_identity(candidate['pid'])
            if pinned is None and wait_exit(pidfd, deadline, 0):
                outcome['result'] = 'exited-at-pin'
                continue
            if pinned != {key: candidate[key] for key in ('argv', 'cwd', 'start_time')}:
                outcome['result'] = 'preserved: identity changed between discovery and pin'
                continue
            home = owned_worker_home(pinned['argv'])
            if home is None:
                outcome['result'] = 'preserved: not an exact owned fixture worker shape'
                continue

            outcome['home'] = str(home)
            stop_budget = min(15.0, deadline - time.monotonic())
            if stop_budget <= 0:
                outcome['result'] = 'preserved: cleanup deadline reached before normal stop'
                continue
            stop = subprocess.run([pinned['argv'][0], str(DIST_ENTRY), 'sync', 'worker', 'stop', '--home', str(home)],
                                  cwd=WORKTREE, env=ENV, capture_output=True, text=True, timeout=stop_budget,
                                  start_new_session=True)
            outcome['normal_stop_exit'] = stop.returncode
            outcome['normal_stop_output'] = (stop.stdout + stop.stderr)[-600:]
            if wait_exit(pidfd, deadline, 10):
                outcome['result'] = 'joined after normal stop'
                continue
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
            if wait_exit(pidfd, deadline, 10):
                outcome['result'] = 'joined after pidfd SIGTERM'
                continue
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            outcome['result'] = ('joined after pidfd SIGKILL' if wait_exit(pidfd, deadline, 5)
                                 else 'preserved: join uncertain after SIGKILL')
        except subprocess.TimeoutExpired:
            outcome['result'] = 'preserved: normal stop timed out'
        except ProcessLookupError:
            outcome['result'] = 'exited during join'
        finally:
            os.close(pidfd)

    preserved = [o for o in outcomes if o['result'].startswith('preserved')]
    if outcomes:
        reaped.append(dict(step=label, processes=outcomes))
        (RUN / 'reaped-fixtures.json').write_text(json.dumps(reaped, indent=2) + '\n')
    if preserved and not state['halted']:
        state['halted'] = f'uncertain fixture scope after {label}; admissions stopped and roots retained'
        fail(state['halted'])
    return len(outcomes) - len(preserved), len(preserved)


def run(label, command, timeout, env=None, required=True, cwd=None):
    remaining = APPLICATION_BUDGET - (time.monotonic() - started)
    reason = state['halted'] or (f'cap {timeout}s exceeds remaining {remaining:.0f}s' if remaining < timeout else None)
    if reason:
        rows.append(dict(label=label, command=command, outcome='UNRUN', reason=reason))
        record()
        if required:
            fail(f'{label} required but UNRUN: {reason}')
        return None

    begin = time.monotonic()
    with (RUN / f'{label}.log').open('xb') as log:
        log.write(('$ ' + ' '.join(command) + '\n').encode())
        log.flush()
        child = subprocess.Popen(command, cwd=cwd or WORKTREE, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, env={**ENV, **(env or {})})
        leader = os.pidfd_open(child.pid)
        try:
            # Wait without reaping: an unreaped leader (running or zombie) keeps its session ID pinned.
            has_exited = wait_exit(leader, time.monotonic() + timeout, timeout)
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            status = child.wait()
            code = status if has_exited else 'TIMEOUT'
        finally:
            os.close(leader)
        log.write(f'\nEXIT {code}\n'.encode())
    joined, preserved = join_detached_fixtures(label, time.monotonic() + 45)
    rows.append(dict(label=label, command=command, exit_code=code, seconds=round(time.monotonic() - begin, 1),
                     joined_detached_fixtures=joined, preserved_fixtures=preserved))
    record()
    return code


def require_pass(label, code):
    if code != 0:
        fail(f'{label} did not pass: {code}')
        return False
    return True


ISOLATION = 'scripts/document-isolation-browser.test.mjs'
OLD_WIRING = [
    ('import fs, { mkdtemp, readFile, stat } from "node:fs/promises";',
     'import fs, { mkdtemp, readFile, rm, stat } from "node:fs/promises";'),
    ('import { closeFixtureResources, startFixtureViewer } from "./browser-fixtures.mjs";',
     'import { startViewer } from "../packages/cli/dist/viewer-server.js";'),
    ('''  const resources = { servers: [] };
  // Hooks run in registration order, so one hook owns the whole teardown sequence.
  t.after(() => closeFixtureResources(home, resources));
''', '''  t.after(() => rm(home, { recursive: true, force: true }));
'''),
    ('''  const viewer = await startFixtureViewer(resources, backend, home);
''', '''  const viewer = await startViewer(backend, home, 0);
  t.after(() => rawClose(viewer));
'''),
    ('''  resources.servers.push(staticServer);
''', '''  t.after(() => rawClose(staticServer));
'''),
    ('''  resources.browser = browser;
''', '''  t.after(() => browser.close());
'''),
]
RAW_CLOSE = '''
function rawClose(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
'''
# Teardown that skips owned viewer close: exercises the settles-first branch (viewer deliberately leaked).
SETTLES_FIRST = [
    ('  t.after(() => closeFixtureResources(home, resources));\n',
     '  t.after(() => closeFixtureResources(home, { ...resources, viewer: undefined }));\n'),
]
# Setup that rejects after the viewer is live: exercises the setup-failure drain branch.
SETUP_FAILURE = [
    ('  const localOrigin = serverOrigin(viewer);\n',
     '  const localOrigin = serverOrigin(viewer);\n  throw new Error("injected isolation setup failure after viewer start");\n'),
]


def write_overlay(name, replacements, appendix=''):
    source = (WORKTREE / ISOLATION).read_text()
    for old, new in replacements:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    source += appendix
    (RUN / f'{name}.mjs.txt').write_text(source)
    # Exclusive create: a preexisting path is someone else's and is never touched.
    with OVERLAY.open('x') as overlay:
        overlay.write(source)
    return hashlib.sha256(source.encode()).hexdigest()


def run_overlay(name, replacements, appendix, extra_args, cap):
    if state['halted']:
        return run(name, [], cap), ''
    digest = write_overlay(name, replacements, appendix)
    try:
        code = run(name, ['fnm', 'exec', '--using=24.19.0', 'node', '--test', *extra_args,
                          '--test-name-pattern=isolation fixture joins owned viewer cleanup', str(OVERLAY)], cap)
    finally:
        remove_own_overlay(digest)
    log = RUN / f'{name}.log'
    return code, log.read_text(errors='replace') if code is not None else ''


def failed_cases(log):
    """Parse the spec reporter: (fail count, failed case names, assertion diagnostics); never loose substrings."""
    counts = re.findall(r'^ℹ fail (\d+)$', log, re.MULTILINE)
    names = set(re.findall(r'^✖ (.+?) \(\d+(?:\.\d+)?ms\)$', log, re.MULTILINE))
    diagnostics = set(re.findall(r'^\s*AssertionError \[ERR_ASSERTION\]: (.+)$', log, re.MULTILINE))
    return (int(counts[-1]) if counts else None), names, diagnostics


def is_exact_red(code, log, expected):
    """expected maps each failing case name to its diagnostic (or a tuple of accepted alternatives).

    Exit code, failed count, failed case names and assertion messages must all match."""
    count, names, diagnostics = failed_cases(log)
    alternatives = [value if isinstance(value, tuple) else (value,) for value in expected.values()]
    return (code == 1 and count == len(expected) and names == set(expected)
            and all(any(option in diagnostics for option in options) for options in alternatives))


def judge(name, is_expected):
    rows[-1]['verdict'] = 'CONFIRMED' if is_expected else 'INCONCLUSIVE'
    record()
    if not is_expected:
        fail(f'{name} inconclusive')
    return is_expected


def remove_own_overlay(digest):
    if digest is None or not OVERLAY.exists():
        return
    if hashlib.sha256(OVERLAY.read_bytes()).hexdigest() != digest:
        fail('overlay path changed after creation; left in place')
        return
    OVERLAY.unlink()


assert git('rev-parse', 'HEAD') == CANDIDATE, 'HEAD is not the pinned candidate'
assert not git('status', '--porcelain'), 'Worktree is not clean'
assert not OVERLAY.exists(), 'Overlay path already exists; refusing to start'
RUN.mkdir()
FIXTURE_ROOT.mkdir()
ENV = {**os.environ, 'TMPDIR': str(FIXTURE_ROOT)}

# Back up generated outputs and verify the copies before any step can mutate them.
backup = RUN / 'generated-backup'
prior = {}
for relative in GENERATED:
    if (WORKTREE / relative).exists():
        prior.update(tree_hashes(WORKTREE / relative, WORKTREE))
        shutil.copytree(WORKTREE / relative, backup / relative, symlinks=True)
copied = {}
for relative in GENERATED:
    if (backup / relative).exists():
        copied.update(tree_hashes(backup / relative, backup))
assert copied == prior, 'Generated-output backup does not match the originals; refusing to start'
(RUN / 'prior-generated.json').write_text(json.dumps(prior, indent=2) + '\n')

overlay_digest = None
PRODUCTION = WORKTREE / 'packages/cli/src/viewer-server.ts'  # read-only: verified, never written
PRE_FIX = sys.argv[2]
PRIOR = sys.argv[3]
candidate_production = PRODUCTION.read_bytes()
try:
    admitted = require_pass('typecheck-node24', run('typecheck-node24', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'typecheck'], 60))

    # Negative controls in disposable copies: candidate packages/cli with only viewer-server.ts at an
    # earlier revision, built into the copy's own dist. The tracked candidate source is never written.
    def negative_control(name, revision, pattern, expected):
        copy = RUN / f'{name}-copy'
        copy.mkdir()
        archive = subprocess.run(['git', 'archive', CANDIDATE, 'tsconfig.base.json', 'packages/cli'],
                                 cwd=WORKTREE, check=True, capture_output=True).stdout
        subprocess.run(['tar', '-x', '-C', str(copy)], input=archive, check=True)
        (copy / 'packages/cli/src/viewer-server.ts').write_bytes(
            subprocess.check_output(['git', 'show', f'{revision}:packages/cli/src/viewer-server.ts'], cwd=WORKTREE))
        (copy / 'node_modules').symlink_to(WORKTREE / 'node_modules')
        if not require_pass(f'{name}-copy-build-node24', run(f'{name}-copy-build-node24', ['fnm', 'exec', '--using=24.19.0',
                            str(WORKTREE / 'node_modules/.bin/tsc-rs'), '-p', str(copy / 'packages/cli/tsconfig.json')], 30, cwd=copy)):
            return False
        emitted = copy / 'packages/cli/dist/viewer-server.js'
        rows[-1]['emitted_viewer_server_js_sha256'] = hashlib.sha256(emitted.read_bytes()).hexdigest()
        record()
        label = f'red-{name}-node24'
        code = run(label, ['fnm', 'exec', '--using=24.19.0', 'node', '--test', '--test-force-exit',
                   f'--test-name-pattern={pattern}', str(copy / 'packages/cli/dist/viewer-owned-lifecycle.test.js')], 45, cwd=copy)
        log = (RUN / f'{label}.log').read_text(errors='replace') if code is not None else ''
        count, names, _ = failed_cases(log)
        rows[-1]['failed_count'] = count
        rows[-1]['failed_cases'] = sorted(names)
        return judge(label, is_exact_red(code, log, expected))

    if admitted:
        admitted = negative_control('prefix-5c49486', PRE_FIX, 'start-lock release', {
            'start-lock release failure after readiness rolls back the live viewer':
                'live viewer record survived a start-lock release failure',
            'startup failure keeps both its cause and a start-lock release failure':
                'start-lock release failure replaced the startup cause',
            'a signal during start-lock release rejects startup after its shared shutdown':
                SIGNAL_DIAGNOSTIC,
        })
        # Control 2 is entered only after control 1 is credited and no fixture scope is uncertain.
        if admitted and not state['halted']:
            admitted = negative_control('prior-0463edb', PRIOR, 'a signal during start-lock release', {
                'a signal during start-lock release rejects startup after its shared shutdown':
                    SIGNAL_DIAGNOSTIC,
            })
        else:
            for label in ('prior-0463edb-copy-build-node24', 'red-prior-0463edb-node24'):
                rows.append(dict(label=label, outcome='UNRUN', reason=state['halted'] or 'negative control 1 not credited'))
                fail(f'{label} required but UNRUN')
            record()
        if hashlib.sha256(PRODUCTION.read_bytes()).hexdigest() != hashlib.sha256(candidate_production).hexdigest() \
                or git('status', '--porcelain'):
            fail('tracked candidate changed during the disposable negative controls')
            state['halted'] = 'tracked candidate changed during negative controls'

    if admitted and require_pass('build-node24', run('build-node24', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'build'], 60)):
        (RUN / 'candidate-generated.json').write_text(
            json.dumps(tree_hashes(WORKTREE / 'packages/cli/dist', WORKTREE), indent=2) + '\n')

        probe = RUN / 'fifo-probe.test.mjs'
        probe.write_text(FIFO_PROBE)
        for runtime in RUNTIMES:
            major = runtime.split('.')[0]
            order_log = RUN / f'fifo-order-node{major}.txt'
            label = f'fifo-probe-node{major}'
            code = run(label, ['fnm', 'exec', f'--using={runtime}', 'node', '--test', str(probe)], 20,
                       env={'FIFO_PROBE_LOG': str(order_log)})
            order = order_log.read_text().split() if order_log.exists() else []
            rows[-1]['observed_order'] = order
            record()
            if not require_pass(label, code):
                admitted = False
            elif order != FIFO_EXPECTED:
                fail(f'{label} order {order} != {FIFO_EXPECTED}')
                admitted = False

        for prefix, files, cap in (('focused', FOCUSED, 120), ('ownership', OWNERSHIP, 60)):
            for runtime in RUNTIMES:
                label = f'{prefix}-node{runtime.split(".")[0]}'
                code = run(label, ['fnm', 'exec', f'--using={runtime}', 'node', '--test', *files], cap)
                admitted = require_pass(label, code) and admitted

        code, log = run_overlay('red-old-isolation-wiring-node24', OLD_WIRING, RAW_CLOSE, [], 45)
        caller = 'isolation fixture joins owned viewer cleanup before removing its home'
        # Old wiring removes the home in hook 1; which side settles next is incidental to the red.
        admitted = judge('red-old-isolation-wiring-node24', is_exact_red(code, log, {
            caller: (f'{RED_ASSERTION} (teardown entered first)', f'{RED_ASSERTION} (teardown settled first)')})) and admitted

        code, log = run_overlay('branch-settles-first-node24', SETTLES_FIRST, '', ['--test-force-exit'], 45)
        admitted = judge('branch-settles-first-node24', is_exact_red(code, log, {
            caller: f'{RED_ASSERTION} (teardown settled first)'})) and admitted

        # No force-exit: a leaked live viewer would hold the process open past its cap.
        code, log = run_overlay('branch-setup-failure-node24', SETUP_FAILURE, '', [], 45)
        count, names, _ = failed_cases(log)
        admitted = judge('branch-setup-failure-node24', code == 1 and count == 1 and names == {caller}
                         and bool(re.search(r'^\s*Error: injected isolation setup failure after viewer start$', log, re.MULTILINE))
                         and bool(re.search(r'html-inbox: Viewer \d+ stopped \(reader-close\)$', log, re.MULTILINE))
                         and 'Isolation fixture setup and teardown failed' not in log) and admitted

        if admitted and not state['halted']:
            code = run('browser-suite-node24', ['fnm', 'exec', '--using=24.19.0', 'node', 'scripts/run-browser-tests.mjs'],
                       BROWSER_CAP)
            require_pass('browser-suite-node24', code)
        else:
            rows.append(dict(label='browser-suite-node24', outcome='UNRUN',
                             reason=state['halted'] or 'admission controls did not all pass'))
            record()
            fail('browser-suite-node24 required but UNRUN: admission controls did not all pass')
    else:
        fail('candidate build not admitted')
except Exception as error:  # Unexpected runner failure is evidence too; cleanup still runs.
    fail(f'runner exception: {type(error).__name__}: {error}')
finally:
    cleanup_begin = time.monotonic()
    cleanup_deadline = cleanup_begin + CLEANUP_BUDGET
    if OVERLAY.exists():
        fail('overlay path present at cleanup; left in place')
    if PRODUCTION.read_bytes() != candidate_production:
        fail('tracked candidate viewer-server.ts differs at cleanup; left in place for inspection')

    # Join and prove quiescence before touching generated outputs.
    join_detached_fixtures('cleanup', cleanup_deadline)
    leftovers = [dict(pid=e['pid'], argv=' '.join(e['argv'])[:300], cwd=e['cwd']) for e in discover_run_processes()]
    is_quiescent = not leftovers and not state['halted']
    restored = None
    if is_quiescent:
        for relative in GENERATED:
            shutil.rmtree(WORKTREE / relative, ignore_errors=True)
            if (backup / relative).exists():
                shutil.copytree(backup / relative, WORKTREE / relative, symlinks=True)
        restored = {}
        for relative in GENERATED:
            if (WORKTREE / relative).exists():
                restored.update(tree_hashes(WORKTREE / relative, WORKTREE))
        if restored != prior:
            fail('generated outputs not restored to backup hashes')
    else:
        fail('not quiescent; generated outputs and fixture roots retained unrestored')

    cleanup = dict(
        application_seconds=round(cleanup_begin - started, 1),
        cleanup_seconds=round(time.monotonic() - cleanup_begin, 1),
        cleanup_within_budget=time.monotonic() <= cleanup_deadline,
        quiescent=is_quiescent,
        generated_restored=restored == prior if restored is not None else False,
        generated_file_count=len(prior),
        leftover_run_processes=leftovers,
        overlay_absent=not OVERLAY.exists(),
        worktree_status=git('status', '--porcelain'),
        head=git('rev-parse', 'HEAD'),
    )
    if not cleanup['cleanup_within_budget']:
        fail('cleanup exceeded its budget')
    if cleanup['worktree_status'] or cleanup['head'] != CANDIDATE or not cleanup['overlay_absent']:
        fail('worktree not clean at the candidate after cleanup')
    (RUN / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')

    archives = {}
    for log in sorted(RUN.glob('*.log')):
        data = log.read_bytes()
        with gzip.GzipFile(str(log) + '.gz', 'xb', compresslevel=9, mtime=0) as archive:
            archive.write(data)
        packed = Path(str(log) + '.gz').read_bytes()
        assert gzip.decompress(packed) == data
        archives[log.name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                                  gz_sha256=hashlib.sha256(packed).hexdigest())
    (RUN / 'log-archives.json').write_text(json.dumps(archives, indent=2) + '\n')
    print(json.dumps(dict(run=str(RUN), rows=rows, problems=problems, cleanup=cleanup), indent=2))

sys.exit(1 if problems else 0)
