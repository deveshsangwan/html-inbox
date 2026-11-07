import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess

root = Path.cwd()
out = root / 'artifacts/shared-viewer-lifecycle/round2'
candidate = '5829aa42741a16c1099efb71f41dab1d94660529'
reviewed = '6546267e0bf6053cb699ef5284de18b50987f7f8'
production = ['packages/cli/src/viewer-server.ts', 'scripts/browser-fixtures.mjs']
rows = []


def run(label, command, timeout=120):
    with (out / (label + '.log')).open('wb') as log:
        log.write(('$ ' + ' '.join(command) + '\n').encode())
        log.flush()
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=timeout)
        finally:
            # This session was created by this exact retained child, never another owner.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        log.write(('\nEXIT ' + str(code) + '\n').encode())
    rows.append(dict(label=label, command=command, exit_code=code))
    (out / 'commands.json').write_text(json.dumps(rows, indent=2) + '\n')
    return code


def identity(label):
    files = [*sorted((root / 'packages/cli/src').glob('*.ts')), root / 'scripts/browser-fixtures.mjs',
             root / 'scripts/viewer-fixture-browser.test.mjs', *sorted((root / 'packages/cli/dist').glob('*.js'))]
    hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    (out / (label + '-identity.json')).write_text(json.dumps(dict(candidate_ref=candidate, reviewed_ref=reviewed, files=hashes), indent=2) + '\n')


assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
assert not subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()
red_code = None
try:
    subprocess.run(['git', 'restore', '--source=' + reviewed, '--', *production], check=True)
    assert run('reviewed-overlay-build', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'build']) == 0
    identity('reviewed-overlay')
    red_code = run('reviewed-red', ['fnm', 'exec', '--using=24.19.0', 'node', '--test',
        '--test-name-pattern=failed viewer startup|preserves browser and root-removal',
        'scripts/viewer-fixture-browser.test.mjs'], timeout=45)
finally:
    subprocess.run(['git', 'restore', '--source=' + candidate, '--', *production], check=True)
    restoration = run('candidate-restoration-build', ['fnm', 'exec', '--using=24.19.0', 'pnpm', 'build'])
    identity('candidate-restored')
    assert restoration == 0, 'Candidate sources restored, but candidate dist rebuild FAILED'

assert red_code == 1, f'Unexpected red outcome {red_code}; inspect before claiming reproduction'
print('Expected-red exit1 captured; candidate production restored and rebuilt. Inspect exact failed assertions next.')
