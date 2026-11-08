#!/usr/bin/env python3
"""Paired Linux worker measurements. Execution requires a separately granted slot."""
import argparse
import ctypes
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import statistics
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]
PARENT = '610c931b7b22920cce59cf03e49c0de15ebaf2a2'


def classify_case(events, row, provenance, cleanup):
    """Pure verdict over pinned provenance, original events and fresh teardown."""
    result = dict(qualified_case=False, passing_cell=False, resource_observation_complete=False,
                  shutdown_correctness='unrecognized', continue_case=False, resource_gain_eligible=False,
                  release_observation='unobserved', completion_observation='unobserved', errors=[])

    def check(condition, message):
        if not condition:
            raise ValueError(message)

    def one(kind, predicate=lambda event: True):
        found = [event for event in events if event.get('type') == kind and predicate(event)]
        check(len(found) == 1, f'Expected exactly one {kind}')

        return found[0]

    try:
        check(not row.get('error') and not row.get('cleanup_error'), 'Case/cleanup error')
        check(row['revision'] in ['parent', 'candidate'], 'Unknown revision role')
        expected = provenance['expected']
        actual = provenance['actual']
        check(actual == expected, 'Source/archive/emitted/runtime identity mismatch')
        check(actual['revision'] == (PARENT if row['revision'] == 'parent' else provenance['candidate']), 'Wrong archive revision')
        check(actual['runtime_version'] == row['runtime'], 'Wrong exact runtime')
        check(all(actual.get(name) for name in ['archive_sha256', 'source_blobs_sha256', 'compiled_files_sha256',
                  'runtime_path', 'runtime_sha256', 'observer_sha256', 'workload_sha256']),
              'Incomplete provenance')
        check(row['setup_seconds'] is not None and 0 <= row['setup_seconds'] < 90 and row['elapsed_seconds'] <= 240,
              'Setup/case bound failed')

        caught = one('caught-up')
        check((caught['count'], caught['direction']) == (row['count'], row['direction']), 'Wrong caught-up workload')
        idle_start, idle_stop = one('idle-start'), one('idle-stop')
        check((idle_start['count'], idle_start['direction'], idle_start['duration']) ==
              (row['count'], row['direction'], 65000), 'Wrong idle workload/window')
        check((idle_stop['count'], idle_stop['direction']) == (row['count'], row['direction']), 'Wrong idle result workload')
        idle = idle_stop['observations'][0]
        check(idle['elapsedMs'] >= 65000 and idle['completedPasses'] >= 2, 'Incomplete idle window/periodic passes')
        routed = row['direction'] != 'none'
        check(len(idle_stop['observations']) == (2 if routed else 1) and all(
            all(type(observation[name]) in [int, float] and math.isfinite(observation[name]) and observation[name] >= 0
                for name in ['elapsedMs', 'cpuMs', 'cpuFraction']) and observation['elapsedMs'] >= 65000 and
            math.isclose(observation['cpuFraction'], observation['cpuMs'] / observation['elapsedMs'], rel_tol=1e-12, abs_tol=1e-12) and
            all(type(observation[name]) is int and observation[name] > 0 for name in ['rssStart', 'rssEnd', 'lifetimePeakRssKiB'])
            for observation in idle_stop['observations']), 'Incomplete worker/peer resource observations')
        expected_reactions = ['explicit-wake', 'wall-forward', 'wall-backward', 'monotonic-gap', 'suspend-both']
        if routed:
            expected_reactions.append('retry-deadline')
        reactions = [one('reaction-stop', lambda event: event.get('label') == label) for label in expected_reactions]
        check(len([event for event in events if event.get('type') == 'reaction-stop']) == len(reactions), 'Unrecognized reaction')
        check(all(0 <= event['elapsedMs'] <= 30000 for event in reactions), 'Reaction bound failed')
        prefix = [caught, idle_start, idle_stop, *reactions]
        if routed:
            retry = one('retry-reaction')
            check(retry['requestAt'] >= retry['deadlineAt'], 'Retry request preceded durable deadline')
            custody, repair, fence = one('external-commit-custody'), one('repair-complete'), one('stale-route-rejected')
            check(custody['state'] == ('deleted' if row['count'] else 'live') and 0 <= custody['elapsedMs'] <= 65000,
                  'Actual external custody incomplete')
            check(0 <= repair['elapsedMs'] <= 65000, 'Actual repair bound failed')
            ordered = [reactions[-1], retry, repair, custody, fence] if row['count'] else [reactions[-1], retry, custody, repair, fence]
            check(all(events.index(first) < events.index(second) for first, second in zip(ordered, ordered[1:])),
                  'Original retry/custody/repair/fence order changed')
            prefix.extend([retry, custody, repair, fence])

        roles = ['worker', 'peer'] if routed else ['worker']
        starts = {role: one('child-started', lambda event: event.get('role') == role) for role in roles}
        ready = {role: one('ready', lambda event: event.get('role') == role) for role in roles}
        check(len([event for event in events if event.get('type') == 'child-started']) == len(roles), 'Unexpected child')
        observed = cleanup['observed_processes']
        leader = cleanup['leader']
        check(leader['pid'] == row['pid'] and leader['group'] == leader['session'] == row['pid'] and leader['start_ticks'] > 0,
              'Wrong owned workload identity')
        check(any(all(process.get(name) == leader[name] for name in ['pid', 'start_ticks', 'group', 'session'])
                  for process in observed), 'Missing original leader witness')
        for role in roles:
            check(starts[role]['pid'] == ready[role]['pid'], 'Child readiness identity mismatch')
            witnesses = [process for process in observed if process['pid'] == starts[role]['pid']]
            check(len(witnesses) == 1 and witnesses[0]['start_ticks'] > 0 and witnesses[0]['ppid'] == row['pid'] and
                  witnesses[0]['group'] == witnesses[0]['session'] == row['pid'], 'Missing owned child PID/start/group witness')

        worker_pid = starts['worker']['pid']
        held = one('read-held')
        read_id, store_id = held['readId'], held['storeId']
        check(type(read_id) is int and read_id > 0 and type(store_id) is int and store_id > 0 and held['scriptStore'] is False,
              'Missing selected read/store identity')
        def is_selected(read):
            return (type(read.get('readId')) is int and type(read.get('storeId')) is int and
                    read['readId'] == read_id and read['storeId'] == store_id and read.get('scriptStore') is False)

        closed = one('worker-event', lambda event: event.get('event') == 'closed' and event.get('role') == 'worker')
        stops = [event for event in events if event.get('type') == 'stopping' and event.get('role') == 'worker']
        check(stops and all(event.get('pid') == worker_pid for event in stops), 'Missing/foreign stopping event')
        check(all(type(event['monotonic']) in [int, float] and math.isfinite(event['monotonic']) and event['monotonic'] >= 0
                  for event in [held, stops[0], closed]), 'Invalid worker clock evidence')
        check(any(is_selected(read) for read in held['activeReads']) and any(is_selected(read) for read in stops[0]['activeReads']),
              'Selected read not active at hold/stop')
        check(held['pid'] == closed['pid'] == worker_pid and held['role'] == 'worker' and
              held['monotonic'] <= stops[0]['monotonic'] <= closed['monotonic'], 'Held/stop/closed identity or order mismatch')
        check(events.index(held) < events.index(stops[0]) < events.index(closed), 'Held/stop/close trace order mismatch')
        held_index = events.index(held)
        check(all(events.index(event) < held_index for event in prefix), 'Pre-hold controls did not finish first')
        check(not any(event.get('type') == 'controlled-read-hold-barrier' for event in events), 'Controlled barrier is forbidden')
        arm = one('reply', lambda event: event.get('role') == 'worker' and isinstance(event.get('result'), dict) and
                  event['result'].get('armed') is True)
        check(arm['pid'] == worker_pid and arm['monotonic'] <= held['monotonic'] and
              arm['result'].get('traceReadsFromStartup') is False and arm['result'].get('readTracingInstalled') is True and
              arm['result'].get('activeReads') == [] and 'ticketId' not in arm['result'], 'Natural late arm evidence missing')
        check(events.index(caught) < events.index(idle_start) < events.index(idle_stop) and
              all(events.index(idle_stop) < events.index(event) < events.index(arm) for event in reactions) and
              all(events.index(event) < events.index(arm) <= held_index for event in prefix), 'Original control/arm ordering changed')

        caller = held.get('caller', '')
        check(caller.startswith('Error: issue95-routed-held-read\n') and re.search(
            r'at ManagedSyncStore\.snapshot \(' + re.escape(provenance['observer_path']) + ':' +
            str(provenance['observer_line']) + r':\d+\)', caller), 'Missing exact held-read hook frame')
        sites = provenance['callsites']
        dist = Path(provenance['dist'])

        def frame(name, filename, lines):
            return any(re.search(r'at (?:async )?' + name + r' \(' + re.escape(str(dist / filename)) +
                                 ':' + str(line) + r':\d+\)', caller) for line in lines)

        timer = (frame('tick', 'sync-worker.js', sites['tick']) and
                 frame(r'Timeout\._onTimeout', 'sync-worker.js', sites['timer']) and
                 bool(re.search(r'at (?:listOnTimeout|process\.processTimers) \(node:internal/timers:\d+:\d+\)', caller)))
        lifecycle = (frame('assertManagedLifecycle', 'sync-lifecycle.js', sites['lifecycle']) and
                     frame('drain', 'sync-worker.js', sites['drain']))
        serialized = (frame('refreshSchedule', 'sync-worker.js', sites['refresh']) and
                      frame('drain', 'sync-worker.js', sites['drain']))
        direct_drain = frame('drain', 'sync-worker.js', sites['drain_snapshot'])
        reconciliation = any(re.fullmatch(
            r'Error: issue95-routed-held-read\n    at ManagedSyncStore\.snapshot \(' +
            re.escape(provenance['observer_path']) + ':' + str(provenance['observer_line']) +
            r':\d+\)' + ''.join(r'\n    at ' + re.escape(name) + r' \(' + re.escape(str(dist / filename)) +
                                ':' + str(line) + r':\d+\)' for name, filename, line in chain) + r'\n?', caller)
            for chain in sites['reconciliation_chains'])

        # A reconciliation trace must not fall through to a different known caller.
        if re.search(r'\n    at (?:async )?(?:reconcileSyncRoutes|push|pull|recordFailure) \(', caller):
            check(reconciliation, 'Unknown actual archived worker-owned caller')

        check(timer or lifecycle or serialized or direct_drain or reconciliation, 'Unknown actual archived worker-owned caller')
        result.update(caller=caller, caller_kind='native-timer' if timer else 'lifecycle' if lifecycle else
                      'serialized-observation' if serialized else 'reconciliation' if reconciliation else 'drain',
                      worker_pid=worker_pid, read_id=read_id, store_id=store_id)

        releases = [event for event in events if event.get('type') == 'read-released']
        finishes = [event for event in events if event.get('type') == 'read-finished']
        check(len(releases) <= 1 and len(finishes) <= 1, 'Duplicate selected release/completion')
        check(all(type(event['monotonic']) in [int, float] and math.isfinite(event['monotonic']) for event in releases + finishes),
              'Invalid release/completion clock')
        check(all(event.get('pid') == worker_pid and event.get('role') == 'worker' and is_selected(event) for event in releases + finishes),
              'Foreign release/completion identity')
        result.update(release_observation='observed' if releases else 'unobserved',
                      completion_observation='observed' if finishes else 'unobserved',
                      release_events=releases, finish_events=finishes, selected_active_at_close=any(is_selected(read) for read in closed['activeReads']))

        original_cleanup = one('cleanup')
        ports = [ready['worker']['record']['controlOrigin']] + ([ready['peer']['url']] if routed else [])
        check(original_cleanup['failures'] == [] and original_cleanup['childrenReaped'] == len(roles) and
              sorted(original_cleanup['exactPorts']) == sorted(ports) and len(set(ports)) == len(roles), 'Original child/listener cleanup failed')
        check(events.index(closed) < events.index(original_cleanup), 'Cleanup preceded worker close')
        check(cleanup['remaining_processes'] == [] and cleanup['remaining_group'] == [] and cleanup['errors'] == [] and
              cleanup['group_joined'] is True and cleanup['rebound_ports'] == sorted(ports) and
              cleanup['checked_at'] >= row['ended_monotonic'], 'Fresh per-case cleanup incomplete')
        failures = [event for event in events if event.get('type') == 'workload-failed']
        check(not any(event.get('type') in ['startup-failed', 'fatal'] or event.get('type') == 'worker-event' and
                      event.get('event') == 'fatal' or event.get('type') == 'reply' and event.get('error') for event in events),
              'Unrelated setup/worker/RPC failure')

        if row['exit'] == 0:
            check(not failures and len(releases) == len(finishes) == 1, 'Successful case lacks completed held read')
            release, finish = releases[0], finishes[0]
            check(release['reason'] == 'rpc' and finish['outcome'] == 'fulfilled' and
                  stops[0]['monotonic'] <= release['monotonic'] <= finish['monotonic'] <= closed['monotonic'] and
                  closed['activeReads'] == [], 'Selected read did not join close')
            check(events.index(stops[0]) < events.index(release) < events.index(finish) < events.index(closed),
                  'RPC release/read completion trace order mismatch')
            resources, joined = one('shutdown-resources'), one('pending-read-shutdown-joined')
            check(resources['stopped'] is True and events.index(closed) < events.index(resources) <
                  events.index(joined) < events.index(original_cleanup), 'Missing or reordered original shutdown result')
            result.update(qualified_case=True, passing_cell=True, shutdown_correctness='passed', read_joined=True)
        else:
            check(row['exit'] == 1 and row['revision'] == 'parent' and timer, 'Only exact parent native-timer failure may continue')
            check(any(is_selected(read) for read in closed['activeReads']) and
                  all(event['monotonic'] > closed['monotonic'] and events.index(event) > events.index(closed)
                      for event in releases + finishes),
                  'Parent red lacks selected active read before release/completion')
            check(len(failures) == 1, 'Missing unique original strict ownership failure')
            check(events.index(original_cleanup) < events.index(failures[0]), 'Original failure/cleanup trace order mismatch')
            check(not any(event.get('type') in ['shutdown-resources', 'pending-read-shutdown-joined'] for event in events),
                  'Failed ownership assertion cannot have completed later success assertions')
            error = failures[0]['error']
            matched = [line for name, line in provenance['ownership_assertions'].items() if name in ['lifetime.lock', 'runtime.json'] and
                       error.splitlines()[0] == "Error: ENOENT: no such file or directory, lstat '" +
                       str(Path(provenance['home']) / 'sync/worker' / name) + "'"]
            check(len(matched) == 1, 'Unrelated error instead of exact owned-path ENOENT')
            check(re.search(r'at (?:async )?main \(' + re.escape(provenance['workload']) + ':' + str(matched[0]) + r':\d+\)', error),
                  'Wrong ownership assertion callsite')
            result.update(shutdown_correctness='failed-proven-parent-timer', read_joined=False)

        result.update(resource_observation_complete=True, continue_case=True)
    except (KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        result['errors'].append(str(error))
    return result


def fingerprint(directory):
    digest = hashlib.sha256()
    for file in sorted(directory.rglob('*.js')):
        digest.update(str(file.relative_to(directory)).encode() + b'\0' + file.read_bytes())
    return digest.hexdigest()


def build_provenance(export, dist, revision, manifest, role):
    sources = {}
    for file in sorted(export.rglob('*')):
        if file.is_file() and not file.is_symlink() and 'node_modules' not in file.relative_to(export).parts:
            data = file.read_bytes()
            sources[str(file.relative_to(export))] = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    emitted = {str(file.relative_to(dist)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(dist.rglob('*.js'))}
    # The export already contains emitted files here; Git identities cover only the reviewed archive members.
    sources = {name: value for name, value in sources.items() if not name.startswith('packages/cli/dist/')}
    identity = dict(revision=revision, source_git_blobs=sources, compiled_files=emitted,
                    dist_js_sha256=fingerprint(dist))
    if sources != manifest['source_git_blobs'][role] or emitted != manifest['compiled_files'][role]:
        raise ValueError(f'{role}: source or emitted table differs from reviewed identities')

    if identity['dist_js_sha256'] != manifest['expected_compiled_aggregate'][role]:
        raise ValueError(f'{role}: compiled aggregate mismatch')

    return identity


def archived_callsites(dist):
    worker = (dist / 'sync-worker.js').read_text().splitlines()
    lifecycle = (dist / 'sync-lifecycle.js').read_text().splitlines()
    reconciliation = (dist / 'sync-reconciliation.js').read_text().splitlines()
    reconciliation_end = next((index for index, line in enumerate(reconciliation)
                               if re.match(r'    (?:async )?function ', line)), len(reconciliation))

    def function_lines(name, source=worker):
        start = next((index for index, line in enumerate(source) if re.match(r'    (?:async )?function ' + name + r'\(', line)), None)

        if start is None:
            return []

        end = next((index for index in range(start + 1, len(source)) if re.match(r'    (?:async )?function ', source[index])), len(source))
        return list(range(start + 1, end + 1))

    top_level = list(range(1, reconciliation_end + 1))
    snapshots = {name: [line for line in lines if 'await options.store.snapshot()' in reconciliation[line - 1]]
                 for name, lines in [('reconcileSyncRoutes', top_level),
                                     *((name, function_lines(name, reconciliation)) for name in ['push', 'pull', 'recordFailure'])]}
    calls = {(caller, callee): [line for line in lines if reconciliation[line - 1].strip().startswith('await ' + callee + '(')]
             for caller, lines in [('reconcileSyncRoutes', top_level), ('push', function_lines('push', reconciliation))]
             for callee in ['push', 'pull', 'recordFailure']}
    drain_awaits = [line for line in function_lines('drain') if worker[line - 1].strip() == 'await done;']
    drain_calls = [line for line in function_lines('drain') if 'const done = ' in worker[line - 1] and
                   '.reconcileSyncRoutes)(' in worker[line - 1]]

    # Explicit frame chains only. Synchronous helper entry differs from its async await ancestry.
    chains = []
    for await_line in drain_awaits:
        owner = [('async drain', 'sync-worker.js', await_line)]
        chains.extend([[('reconcileSyncRoutes', 'sync-reconciliation.js', line), *owner]
                       for line in snapshots['reconcileSyncRoutes']])
        for helper in ['push', 'pull']:
            for call_line in calls['reconcileSyncRoutes', helper]:
                ancestry = [('async reconcileSyncRoutes', 'sync-reconciliation.js', call_line), *owner]
                chains.extend([[(helper, 'sync-reconciliation.js', line), *ancestry] for line in snapshots[helper]])
                if helper == 'push':
                    chains.extend([[('recordFailure', 'sync-reconciliation.js', read_line),
                                    ('push', 'sync-reconciliation.js', failure_line), *ancestry]
                                   for read_line in snapshots['recordFailure'] for failure_line in calls['push', 'recordFailure']])
        chains.extend([[('recordFailure', 'sync-reconciliation.js', read_line),
                        ('reconcileSyncRoutes', 'sync-reconciliation.js', failure_line), *owner]
                       for read_line in snapshots['recordFailure'] for failure_line in calls['reconcileSyncRoutes', 'recordFailure']])

    # Initial entry is synchronous, but its promise is the same done that drain awaits and close joins.
    chains.extend([[('reconcileSyncRoutes', 'sync-reconciliation.js', snapshots['reconcileSyncRoutes'][0]),
                    ('drain', 'sync-worker.js', call_line)] for call_line in drain_calls if drain_awaits and snapshots['reconcileSyncRoutes']])

    return dict(tick=[line for line in function_lines('tick') if 'await store.snapshot()' in worker[line - 1]],
                timer=[index + 1 for index, line in enumerate(worker) if 'timer = setInterval(() => { void tick().catch(fatalStop); }, 250)' in line],
                drain=function_lines('drain'),
                drain_snapshot=[line for line in function_lines('drain') if 'await store.snapshot()' in worker[line - 1]],
                drain_reconciliation=drain_awaits, reconciliation=snapshots['reconcileSyncRoutes'], reconciliation_chains=chains,
                refresh=function_lines('refreshSchedule'), observe=function_lines('observeSchedule'),
                lifecycle=[index + 1 for index, line in enumerate(lifecycle) if 'ManagedSyncStore(home).snapshot()' in line])


def emit(file, value):
    with file.open('a') as stream:
        stream.write(json.dumps(value) + '\n')


def processes(group=None):
    result = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / 'stat').read_text()
            fields = text[text.rfind(')') + 2:].split()
            if group is None or int(fields[2]) == group:
                result.append(dict(pid=int(entry.name), ppid=int(fields[1]), state=fields[0],
                                   group=int(fields[2]), session=int(fields[3]),
                                   start_ticks=int(fields[19]), cpu_ticks=int(fields[11]) + int(fields[12]),
                                   rss_bytes=int(fields[21]) * os.sysconf('SC_PAGE_SIZE')))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return result


def terminate(child, *, deadline=None, witnesses=None):
    for signum in [signal.SIGTERM, signal.SIGKILL]:
        current = processes(child.pid)

        if not current or deadline is not None and time.monotonic() >= deadline:
            break

        if witnesses is None and not any(process['ppid'] == os.getpid() and process['session'] == child.pid for process in current):
            raise RuntimeError('Refusing group signal without a current directly owned child/session witness')

        if witnesses is not None and not any((process['pid'], process['start_ticks']) in witnesses and
                                            process['session'] == child.pid for process in current):
            raise RuntimeError('Refusing group signal without an original PID/start/session witness')

        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass
        if child.returncode is None:
            try:
                child.wait(timeout=2 if deadline is None else max(0, min(2, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass

    reap_deadline = time.monotonic() + 3 if deadline is None else min(time.monotonic() + 3, deadline)
    while time.monotonic() < reap_deadline:
        try:
            pid, _ = os.waitpid(-child.pid, os.WNOHANG)
        except ChildProcessError:
            break
        if not pid:
            time.sleep(min(.01, max(0, reap_deadline - time.monotonic())))
    remaining = processes(child.pid)
    if remaining:
        raise RuntimeError(f'Owned process group did not fully reap: {remaining}')


def bounded_command(command, *, label, cwd, env, log, timeout, groups, receipts, cleanup_deadline=None):
    child = None
    failure = None
    cleanup_failure = None
    started = time.monotonic()
    row = dict(label=label, command=command, timeout_seconds=timeout, exit=None)
    try:
        with log.open('wb') as output:
            child = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            groups.append(child.pid)
            row['pid'] = child.pid
            row['exit'] = child.wait(timeout=timeout)
            if child.returncode:
                raise subprocess.CalledProcessError(child.returncode, command)
    except BaseException as error:
        failure = error
        row.update(error=repr(error), timed_out=isinstance(error, subprocess.TimeoutExpired),
                   interrupted=isinstance(error, (InterruptedError, KeyboardInterrupt)))
    finally:
        if child:
            try:
                if cleanup_deadline is None:
                    terminate(child)
                else:
                    terminate(child, deadline=cleanup_deadline)
            except BaseException as error:
                cleanup_failure = error
                row['cleanup_error'] = repr(error)
            row.update(terminated_exit=child.returncode, group_reaped=not processes(child.pid))
        row['elapsed_seconds'] = time.monotonic() - started
        emit(receipts, row)

    if failure and cleanup_failure:
        raise BaseExceptionGroup('Command and owned-group cleanup failed', [failure, cleanup_failure])
    if failure:
        raise failure
    if cleanup_failure:
        raise cleanup_failure
    return row


def inspect_case_cleanup(child, observed, leader, events):
    snapshot = processes()
    remaining = [process for process in snapshot if (process['pid'], process['start_ticks']) in observed]
    group = [process for process in snapshot if process['group'] == child.pid]
    audit = dict(leader=leader, observed_processes=list(observed.values()), remaining_processes=remaining,
                 remaining_group=group, group_joined=not group, rebound_ports=[], errors=[])
    ready = [event for event in events if event.get('type') == 'ready']
    try:
        if remaining or group:
            raise RuntimeError('Owned case processes remain; listeners and fixtures must be retained')
        for event in ready:
            origin = event['record']['controlOrigin'] if event['role'] == 'worker' else event['url']
            url = urlsplit(origin)
            if (url.hostname != '127.0.0.1' or url.scheme not in ['http', 'https'] or not url.port or url.username or url.password or
                    url.path not in ['', '/'] or url.query or url.fragment):
                raise ValueError('Unexpected exact fixture listener origin')
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(('127.0.0.1', url.port))
                listener.listen(1)
            audit['rebound_ports'].append(origin)
    except (KeyError, ValueError, OSError, RuntimeError) as error:
        audit['errors'].append(str(error))
    audit['rebound_ports'].sort()
    audit['checked_at'] = time.monotonic()
    return audit


def case_provenance(build, manifest, row, unit, node):
    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    role, version = row['revision'], row['runtime']
    workload = REPO / 'scripts/bench/scheduler-workload.cjs'
    observer = REPO / 'scripts/bench/scheduler-process.cjs'
    actual = dict(revision=build['revision'], archive_sha256=build['identity']['archive_sha256'],
                  source_blobs_sha256=digest(build['identity']['source_git_blobs']),
                  compiled_files_sha256=digest(build['identity']['compiled_files']),
                  runtime_version=version, runtime_path=str(node), runtime_sha256=hashlib.sha256(node.read_bytes()).hexdigest(),
                  observer_sha256=hashlib.sha256(observer.read_bytes()).hexdigest(),
                  workload_sha256=hashlib.sha256(workload.read_bytes()).hexdigest())
    expected = dict(revision=PARENT if role == 'parent' else manifest['source_pin'],
                    archive_sha256=manifest['archive_sha256'][role],
                    source_blobs_sha256=digest(manifest['source_git_blobs'][role]),
                    compiled_files_sha256=digest(manifest['compiled_files'][role]),
                    runtime_version=version, runtime_path=manifest['runtimes'][version]['path'],
                    runtime_sha256=manifest['runtimes'][version]['sha256'],
                    observer_sha256=manifest['accepted_source_sha256']['scripts/bench/scheduler-process.cjs'],
                    workload_sha256=manifest['accepted_source_sha256']['scripts/bench/scheduler-workload.cjs'])
    return dict(actual=actual, expected=expected, candidate=manifest['source_pin'], dist=build['dist'], callsites=build['callsites'],
                workload=str(workload), home=str(unit / ('receiver' if row['direction'] == 'inbound' else 'source')),
                observer_path=str(observer), observer_line=next(index + 1 for index, line in enumerate(observer.read_text().splitlines())
                    if "new Error('issue95-routed-held-read').stack" in line),
                ownership_assertions={name: next(index + 1 for index, line in enumerate(workload.read_text().splitlines())
                    if "await fs.lstat(path.join(localHome, 'sync', 'worker'," in line and "'" + name + "'" in line)
                    for name in ['lifetime.lock', 'runtime.json']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True, help='Full committed candidate SHA')
    parser.add_argument('--node20', type=Path, required=True)
    parser.add_argument('--node24', type=Path, required=True)
    parser.add_argument('--phase', choices=['smoke', 'feasibility', 'qualify'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--budget-seconds', type=int, required=True)
    parser.add_argument('--identity-manifest', type=Path)
    parser.add_argument('--deadline-monotonic', type=float)
    args = parser.parse_args()
    started = time.monotonic()
    global_deadline = args.deadline_monotonic if args.deadline_monotonic is not None else started + args.budget_seconds
    if not math.isfinite(global_deadline) or not started < global_deadline <= started + args.budget_seconds:
        parser.error('Supply a future absolute application deadline within the declared budget')
    final_deadline = global_deadline + 60

    def remaining_seconds(cap):
        remaining = global_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('The fixed application deadline is exhausted')
        return min(cap, remaining)

    identity_manifest = None
    if args.phase == 'feasibility':
        if args.identity_manifest is None or args.deadline_monotonic is None:
            parser.error('Feasibility requires the reviewed identity manifest and fixed absolute deadline')
        identity_manifest = json.loads(args.identity_manifest.read_text())
        if identity_manifest['source_pin'] != args.candidate or identity_manifest['parent'] != PARENT:
            parser.error('Identity manifest does not pin this candidate and actual parent')
        if os.path.lexists(REPO / 'node_modules/.bin/node'):
            parser.error('Compiler-local node appeared; do not choose a different compiler runtime')
        for filename, expected in identity_manifest['accepted_source_sha256'].items():
            if hashlib.sha256((REPO / filename).read_bytes()).hexdigest() != expected:
                parser.error(f'Unreviewed source: {filename}')
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    if os.name != 'posix' or not Path('/proc/self/stat').exists():
        parser.error('Linux process accounting is required')
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0):
        raise RuntimeError('Could not become a child subreaper')
    if not 60 <= args.budget_seconds <= 36_000:
        parser.error('Supply an explicit bounded execution budget between 60 and 36000 seconds')
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True, timeout=remaining_seconds(5)):
        parser.error('Pin and clean the source/harness before measuring')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True, timeout=remaining_seconds(5)).strip()
    if args.candidate != head:
        parser.error('Candidate must equal the clean current full HEAD')
    if subprocess.check_output(['git', 'merge-base', PARENT, head], cwd=REPO, text=True, timeout=remaining_seconds(5)).strip() != PARENT:
        parser.error('The candidate must descend from the required immediate parent')
    for filename in ['pnpm-lock.yaml', 'package.json', 'packages/cli/package.json']:
        baseline = subprocess.check_output(['git', 'show', f'{PARENT}:{filename}'], cwd=REPO, timeout=remaining_seconds(5))
        candidate = subprocess.check_output(['git', 'show', f'{head}:{filename}'], cwd=REPO, timeout=remaining_seconds(5))
        if baseline != candidate:
            parser.error(f'Unexpected dependency/runtime/version change: {filename}')
    runtimes = [('20.20.2', args.node20.resolve()), ('24.19.0', args.node24.resolve())]
    versions = []
    for version, node in runtimes:
        actual = subprocess.check_output([str(node), '--version'], text=True, timeout=remaining_seconds(5)).strip()
        if actual != f'v{version}':
            parser.error(f'Expected Node {version}, got {actual}')
        versions.append(dict(version=actual, path=str(node), sha256=hashlib.sha256(node.read_bytes()).hexdigest()))
        if identity_manifest and identity_manifest['runtimes'][version] != dict(path=str(node), sha256=versions[-1]['sha256']):
            parser.error(f'Runtime identity mismatch: {version}')

    counts = [0] if args.phase == 'smoke' else [0, 1000, 10000]
    samples = 5 if args.phase == 'qualify' else 1
    commands = args.out / 'commands.jsonl'
    rows = []
    fixture_root = None
    groups = []
    case_identities = {}

    def interrupt(signum, _frame):
        raise InterruptedError(f'Received signal {signum}')

    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    metadata = dict(parent=PARENT, candidate=head, phase=args.phase, counts=counts, samples=samples,
                    started_monotonic=started, application_deadline=global_deadline, final_deadline=final_deadline,
                    started_wall_ns=time.time_ns(),
                    directions=['none', 'outbound', 'inbound'], idle_ms=65000, case_seconds=240,
                    setup_seconds=90 if args.phase == 'feasibility' else None,
                    budget_seconds=args.budget_seconds, runtimes=versions, machine=list(os.uname()),
                    clock_ticks=os.sysconf('SC_CLK_TCK'), observation_ms=100,
                    cache='fresh disposable fixtures; uncontrolled warm OS caches; no cache eviction',
                    harness={file: hashlib.sha256((REPO / 'scripts/bench' / file).read_bytes()).hexdigest()
                             for file in ['scheduler.py', 'scheduler-workload.cjs', 'scheduler-process.cjs']})
    (args.out / 'environment.json').write_text(json.dumps(metadata, indent=2) + '\n')
    try:
        directory = tempfile.mkdtemp(prefix='html-inbox-scheduler-')
        try:
            fixture_root = Path(directory)
            environment = dict(PATH=f'{args.node24.resolve().parent}:/usr/local/bin:/usr/bin:/bin',
                               HOME=directory, USERPROFILE=directory, TMPDIR=directory, TMP=directory, TEMP=directory,
                               XDG_CONFIG_HOME=directory, XDG_STATE_HOME=directory, XDG_DATA_HOME=directory,
                               XDG_CACHE_HOME=directory, ZDOTDIR=directory, HTML_INBOX_CATALOG_HOME=str(fixture_root / 'catalog'))
            metadata['fixture_root'] = directory
            filesystem_log = args.out / 'filesystem.log'
            bounded_command(['stat', '-f', '-c', '%T', directory], label='filesystem', cwd=REPO, env=environment,
                            log=filesystem_log, timeout=remaining_seconds(5), groups=groups, receipts=commands, cleanup_deadline=final_deadline)
            metadata['filesystem'] = filesystem_log.read_text().strip()
            metadata['builds'] = {}
            for label, revision in [('parent', PARENT), ('candidate', head)]:
                export = fixture_root / f'build-{label}'
                export.mkdir()
                archive_log = args.out / f'archive-{label}.tar'
                bounded_command(['git', 'archive', revision, 'packages/cli/src', 'packages/cli/tsconfig.json', 'tsconfig.base.json'],
                                label=f'archive-{label}', cwd=REPO, env=environment, log=archive_log,
                                timeout=remaining_seconds(15), groups=groups, receipts=commands, cleanup_deadline=final_deadline)
                archive = archive_log.read_bytes()
                with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                    tar.extractall(export, filter='data')
                (export / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
                build_command = [str(REPO / 'node_modules/.bin/tsc-rs'), '-p', str(export / 'packages/cli/tsconfig.json')]
                bounded_command(build_command, label=f'build-{label}', cwd=export, env=environment,
                                log=args.out / f'build-{label}.log', timeout=remaining_seconds(60),
                                groups=groups, receipts=commands, cleanup_deadline=final_deadline)
                dist = export / 'packages/cli/dist'
                metadata['builds'][label] = dict(revision=revision, dist=str(dist), dist_js_sha256=fingerprint(dist))
                if identity_manifest:
                    identity = build_provenance(export, dist, revision, identity_manifest, label)
                    identity['archive_sha256'] = hashlib.sha256(archive).hexdigest()
                    if identity['archive_sha256'] != identity_manifest['archive_sha256'][label]:
                        raise ValueError(f'{label}: archive byte identity mismatch')
                    (args.out / f'identities-{label}.json').write_text(json.dumps(identity, indent=2) + '\n')
                    metadata['builds'][label].update(identity=identity, callsites=archived_callsites(dist))
            (args.out / 'environment.json').write_text(json.dumps(metadata, indent=2) + '\n')

            # Check actual fresh admission without weakening the reader-race assertions.
            for version, node in runtimes:
                for label in ['parent', 'candidate']:
                    command = [str(node), '--test', '--test-name-pattern=an enabled owned worker keeps its process identity',
                               str(Path(metadata['builds'][label]['dist']) / 'sync-ledger-read-race.test.js')]
                    bounded_command(command, label=f'reader-race-{version}-{label}', cwd=REPO, env=environment,
                                    log=args.out / f'reader-race-{version}-{label}.log', timeout=remaining_seconds(15),
                                    groups=groups, receipts=commands, cleanup_deadline=final_deadline)

            for count in counts:
                for version, node in runtimes:
                    for direction in ['none', 'outbound', 'inbound']:
                        for sample in range(samples):
                            order = ['parent', 'candidate'] if sample % 2 == 0 else ['candidate', 'parent']
                            for label in order:
                                if time.monotonic() >= global_deadline:
                                    raise TimeoutError('The granted total execution budget is exhausted; remaining cells are unqualified')
                                name = f'{version}-{count}-{direction}-{sample}-{label}'
                                unit = fixture_root / name
                                unit.mkdir()
                                (unit / '.issue95-fixture').write_text('disposable scheduler fixture\n')
                                command = [str(node), str(REPO / 'scripts/bench/scheduler-workload.cjs'),
                                           metadata['builds'][label]['dist'], str(unit), str(count), direction, '65000']
                                child = None
                                started = time.monotonic()
                                setup_elapsed = None
                                observed = {}
                                leader = None
                                traces = []
                                failure = None
                                audit = provenance = None
                                row = dict(name=name, runtime=version, count=count, direction=direction, sample=sample,
                                           revision=label, command=command, exit=None, qualified_case=False, passing_cell=False,
                                           started_monotonic=started, started_wall_ns=time.time_ns())
                                try:
                                    if identity_manifest:
                                        for filename, expected in identity_manifest['accepted_source_sha256'].items():
                                            if hashlib.sha256((REPO / filename).read_bytes()).hexdigest() != expected:
                                                raise ValueError(f'Source changed before case: {filename}')
                                        if hashlib.sha256(node.read_bytes()).hexdigest() != identity_manifest['runtimes'][version]['sha256']:
                                            raise ValueError('Runtime changed before case')
                                    with (args.out / f'{name}.jsonl').open('w') as stdout, (args.out / f'{name}.stderr').open('w') as stderr:
                                        child = subprocess.Popen(command, cwd=REPO, env=environment, stdout=stdout, stderr=stderr, start_new_session=True)
                                        groups.append(child.pid)
                                        while True:
                                            snapshot = processes(child.pid)
                                            observed.update({(process['pid'], process['start_ticks']): process for process in snapshot})
                                            case_identities.update(observed)
                                            if leader is None:
                                                leader = next((process for process in snapshot if process['pid'] == child.pid), None)
                                                if leader is None or leader['group'] != child.pid or leader['session'] != child.pid:
                                                    raise ValueError('Missing original new-session workload leader')
                                            emit(args.out / f'{name}.proc.jsonl', dict(monotonic_ns=time.monotonic_ns(), wall_ns=time.time_ns(), processes=snapshot))
                                            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                                            if pid:
                                                child.returncode = os.waitstatus_to_exitcode(status)
                                                break

                                            if setup_elapsed is None:
                                                elapsed = time.monotonic() - started
                                                if args.phase == 'feasibility' and elapsed >= 90:
                                                    raise TimeoutError('Real fixture setup/custody did not complete within the preselected 90-second feasibility bound')
                                                if (unit / 'setup-complete.json').exists():
                                                    setup_elapsed = elapsed

                                            if time.monotonic() - started > 240 or time.monotonic() >= global_deadline:
                                                raise TimeoutError('Preselected case or granted total bound exceeded')
                                            time.sleep(min(.1, max(0, min(started + 240, global_deadline) - time.monotonic())))
                                    elapsed = time.monotonic() - started
                                    row.update(exit=child.returncode, elapsed_seconds=elapsed, setup_seconds=setup_elapsed,
                                               ended_monotonic=time.monotonic(), waited_cpu_seconds=usage.ru_utime + usage.ru_stime,
                                               waited_peak_rss_kib=usage.ru_maxrss, whole_case_resource_gain_eligible=False)
                                    traces = [json.loads(line) for line in (args.out / f'{name}.jsonl').read_text().splitlines()]
                                    idle = [entry for entry in traces if entry.get('type') == 'idle-stop']
                                    if idle:
                                        row['idle'] = idle[-1]['observations']
                                    row['workload_failures'] = [entry for entry in traces if entry.get('type') == 'workload-failed']
                                    if not identity_manifest:
                                        row['qualified_case'] = child.returncode == 0 and bool(idle)
                                except BaseException as error:
                                    failure = error
                                    row.update(error=repr(error), setup_seconds=setup_elapsed, elapsed_seconds=time.monotonic() - started)
                                finally:
                                    if child:
                                        try:
                                            terminate(child, deadline=final_deadline, witnesses=observed if identity_manifest else None)
                                        except Exception as error:
                                            row['qualified_case'] = False
                                            row.setdefault('cleanup_error', repr(error))
                                            row.setdefault('cleanup_errors', []).append(repr(error))
                                            if failure is None:
                                                failure = error
                                        row.update(pid=child.pid, terminated_exit=child.returncode,
                                                   exit=child.returncode if row['exit'] is None else row['exit'])
                                        if identity_manifest:
                                            try:
                                                audit = inspect_case_cleanup(child, observed, leader, traces)
                                                (args.out / f'{name}.cleanup.json').write_text(json.dumps(audit, indent=2) + '\n')
                                                provenance = case_provenance(metadata['builds'][label], identity_manifest, row, unit, node)
                                                row.setdefault('ended_monotonic', time.monotonic())
                                                row.update(classify_case(traces, row, provenance, audit))
                                            except BaseException as error:
                                                row.update(qualified_case=False, passing_cell=False, continue_case=False)
                                                row.setdefault('cleanup_error', repr(error))
                                                row.setdefault('cleanup_errors', []).append(repr(error))
                                                if failure is None:
                                                    failure = error
                                    try:
                                        if time.monotonic() >= final_deadline:
                                            raise TimeoutError('Fixed final deadline reached; retain fixture')
                                        if (not child or not processes(child.pid)) and (audit is None or not audit['remaining_processes']):
                                            shutil.rmtree(unit)
                                        row['fixture_removed'] = not unit.exists()
                                    except BaseException as error:
                                        row.update(qualified_case=False, passing_cell=False, continue_case=False)
                                        row.setdefault('cleanup_error', repr(error))
                                        row.setdefault('cleanup_errors', []).append(repr(error))
                                        if failure is None:
                                            failure = error
                                    if not row.get('fixture_removed'):
                                        row.update(qualified_case=False, passing_cell=False, continue_case=False)
                                    # These receipts precede every possible next invocation, including the parent exception.
                                    rows.append(row)
                                    try:
                                        if identity_manifest:
                                            (args.out / f'{name}.classification.json').write_text(json.dumps(dict(
                                                row=row, provenance=provenance, cleanup=audit), indent=2) + '\n')
                                            row['evidence_written_monotonic'] = time.monotonic()
                                        emit(commands, row)
                                    except BaseException as error:
                                        if failure:
                                            raise BaseExceptionGroup('Original case failure and receipt failure', [failure, error])
                                        raise
                                print(json.dumps({key: row[key] for key in ['name', 'qualified_case']}), flush=True)

                                if args.phase == 'feasibility' and (failure or not row.get('continue_case')):
                                    (args.out / 'checkpoint.json').write_text(json.dumps(dict(failed_case=name,
                                        error=row.get('error'), cleanup_error=row.get('cleanup_error'), classification_errors=row.get('errors'),
                                        reason='Stop at first unrecognized/infeasible case; remaining cells require a new disposition/grant'), indent=2) + '\n')
                                    if failure:
                                        raise failure
                                    raise RuntimeError(f'Feasibility stopped at unqualified case {name}')
                                if failure:
                                    raise failure
        finally:
            # Keep fixture evidence if any owned preliminary or timed group remains.
            escaped = [process for process in processes() if (process['pid'], process['start_ticks']) in case_identities]
            if time.monotonic() < final_deadline and not escaped and not any(processes(group) for group in groups):
                shutil.rmtree(directory)
    finally:
        remaining = [dict(group=group, processes=processes(group)) for group in groups if processes(group)]
        remaining_identities = [process for process in processes() if (process['pid'], process['start_ticks']) in case_identities]
        cleanup_ok = (not remaining and not remaining_identities and (fixture_root is None or not fixture_root.exists()) and
                      time.monotonic() <= final_deadline)
        (args.out / 'cleanup.json').write_text(json.dumps(dict(process_groups_reaped=not remaining and not remaining_identities, remaining=remaining, owned_groups=groups,
                                                           observed_case_processes=list(case_identities.values()), remaining_identities=remaining_identities,
                                                           fixture_root_removed=fixture_root is None or not fixture_root.exists()), indent=2) + '\n')
        pairs = []
        for index in range(0, len(rows) - 1, 2):
            pair = rows[index:index + 2]
            if all(row.get('resource_observation_complete') and row.get('continue_case') if args.phase == 'feasibility'
                   else row.get('qualified_case') for row in pair):
                values = {row['revision']: row['idle'][0]['cpuFraction'] for row in pair}
                pairs.append(dict(runtime=pair[0]['runtime'], count=pair[0]['count'], direction=pair[0]['direction'], sample=pair[0]['sample'],
                                  parent=values['parent'], candidate=values['candidate'], delta=values['candidate'] - values['parent'],
                                  shutdown_correctness={row['revision']: row.get('shutdown_correctness') for row in pair},
                                  resource_gain_eligible=False))
        summary = dict(phase=args.phase, qualified_cases=sum(bool(row.get('qualified_case')) for row in rows), total_cases=len(rows),
                       required_cases=len(runtimes) * len(counts) * 3 * samples * 2,
                       complete=cleanup_ok and len(rows) == len(runtimes) * len(counts) * 3 * samples * 2 and all(row.get('qualified_case') for row in rows),
                       pairs=pairs, performance_retention_decision='pending all required gates and independent reviews')
        summary.update(resource_observations_complete=sum(bool(row.get('resource_observation_complete')) for row in rows),
                       resource_feasibility_complete=cleanup_ok and len(rows) == summary['required_cases'] and all(
                           row.get('resource_observation_complete') and row.get('continue_case') for row in rows),
                       shutdown_controls_complete=summary['complete'], behavior_qualification_complete=False,
                       resource_gain_eligible=False, global_cleanup_passed=cleanup_ok,
                       failed_shutdown_controls=[dict(name=row['name'], exit=row.get('exit'), correctness=row.get('shutdown_correctness'))
                           for row in rows if row.get('shutdown_correctness') != 'passed'])
        attempted = {row['name'] for row in rows}
        summary['unrun_cases'] = [f'{version}-{count}-{direction}-{sample}-{label}'
                                 for count in counts for version, _ in runtimes for direction in ['none', 'outbound', 'inbound']
                                 for sample in range(samples) for label in (['parent', 'candidate'] if sample % 2 == 0 else ['candidate', 'parent'])
                                 if f'{version}-{count}-{direction}-{sample}-{label}' not in attempted]
        summary['groups'] = []
        keys = sorted({(pair['runtime'], pair['count'], pair['direction']) for pair in pairs})
        for runtime, count, direction in keys:
            group = [pair for pair in pairs if (pair['runtime'], pair['count'], pair['direction']) == (runtime, count, direction)]
            values = {key: [pair[key] for pair in group] for key in ['parent', 'candidate', 'delta']}
            summary['groups'].append(dict(runtime=runtime, count=count, direction=direction, n=len(group),
                                          cpu_fraction={key: dict(median=statistics.median(items), minimum=min(items), maximum=max(items))
                                                        for key, items in values.items()}))
        (args.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if not summary['complete']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
