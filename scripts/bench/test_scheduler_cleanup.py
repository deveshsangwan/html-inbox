"""Run only in the granted scheduler harness slot; owns every process and port."""
import ctypes
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('scheduler_runner', Path(__file__).with_name('scheduler.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@unittest.skipUnless(sys.platform == 'linux', 'The scheduler collector requires Linux')
class SchedulerCleanupTests(unittest.TestCase):
    def exercise(self, leader_exits):
        self.assertEqual(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0), 0)
        script = '''
import json, os, signal, socket, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
child = os.fork()
if child == 0:
    while True: time.sleep(1)
print(json.dumps([os.getpid(), child, listener.getsockname()[1]]), flush=True)
''' + ('raise SystemExit(17)\n' if leader_exits else 'while True: time.sleep(1)\n')
        child = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            parent_pid, descendant_pid, port = json.loads(child.stdout.readline())
            if leader_exits:
                self.assertEqual(child.wait(timeout=5), 17)
            runner.terminate(child)
            self.assertEqual(runner.processes(child.pid), [])
            for pid in [parent_pid, descendant_pid]:
                self.assertFalse(Path(f'/proc/{pid}').exists(), f'Owned PID {pid} must be reaped, including zombies')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', port))
        finally:
            runner.terminate(child)
            child.stdout.close()

    def test_timeout_cleanup_kills_and_reaps_uncooperative_group(self):
        self.exercise(False)

    def test_exited_leader_does_not_leave_descendant_or_port(self):
        self.exercise(True)

    def preliminary(self, mode):
        self.assertEqual(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0), 0)
        with tempfile.TemporaryDirectory(prefix='scheduler-command-test-') as directory:
            root = Path(directory)
            script = '''
import json, os, signal, socket, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
child = os.fork()
if child == 0:
    while True: time.sleep(1)
print(json.dumps([os.getpid(), child, listener.getsockname()[1]]), flush=True)
''' + ('''time.sleep(.05)
os.kill(os.getppid(), signal.SIGTERM)
while True: time.sleep(1)
''' if mode == 'interrupt' else 'raise SystemExit(17)\n' if mode == 'compound' else 'while True: time.sleep(1)\n')
            groups = []
            previous_handler = signal.getsignal(signal.SIGTERM)

            def interrupt(_signum, _frame):
                raise InterruptedError('Synthetic preliminary-command interruption')

            signal.signal(signal.SIGTERM, interrupt)
            original_terminate = runner.terminate

            def cleanup_failure(child):
                original_terminate(child)
                raise OSError('Synthetic cleanup reporting failure')

            try:
                expected = InterruptedError if mode == 'interrupt' else BaseExceptionGroup if mode == 'compound' else subprocess.TimeoutExpired
                with mock.patch.object(runner, 'terminate', cleanup_failure if mode == 'compound' else original_terminate):
                    with self.assertRaises(expected) as raised:
                        runner.bounded_command([sys.executable, '-c', script], label='synthetic-preliminary', cwd=root, env=None,
                                               log=root / 'output.log', timeout=2, groups=groups, receipts=root / 'commands.jsonl')
                row = json.loads((root / 'commands.jsonl').read_text())
                self.assertEqual(groups, [row['pid']])
                self.assertTrue(row['group_reaped'])
                if mode == 'compound':
                    self.assertEqual(row['exit'], 17)
                    self.assertEqual(raised.exception.exceptions[0].returncode, 17)
                    self.assertIsInstance(raised.exception.exceptions[1], OSError)
                    self.assertIn('cleanup_error', row)
                else:
                    self.assertTrue(row['interrupted'] if mode == 'interrupt' else row['timed_out'])
                parent_pid, descendant_pid, port = json.loads((root / 'output.log').read_text())
                for pid in [parent_pid, descendant_pid]:
                    self.assertFalse(Path(f'/proc/{pid}').exists(), f'Preliminary-command PID {pid} must be reaped')
                self.assertEqual(runner.processes(groups[0]), [])
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', port))
            finally:
                signal.signal(signal.SIGTERM, previous_handler)

    def test_preliminary_timeout_reaps_descendant_and_releases_port(self):
        self.preliminary('timeout')

    def test_preliminary_interruption_reaps_descendant_and_releases_port(self):
        self.preliminary('interrupt')

    def test_preliminary_exit_and_cleanup_failure_preserve_both_causes(self):
        self.preliminary('compound')


class SchedulerClassificationTests(unittest.TestCase):
    """Synthetic parser inputs, not evidence of an executed native-timer case."""

    def fixture(self, *, passed=False, role='parent', count=1000, direction='inbound'):
        row = dict(revision=role, runtime='24.19.0', count=count, direction=direction, pid=100,
                   exit=0 if passed else 1, setup_seconds=1, elapsed_seconds=130, ended_monotonic=500)
        identity = dict(revision=runner.PARENT if role == 'parent' else 'c' * 40, archive_sha256='a' * 64,
                        source_blobs_sha256='b' * 64, compiled_files_sha256='c' * 64, runtime_version='24.19.0',
                        runtime_path='/exact/node24', runtime_sha256='d' * 64, observer_sha256='e' * 64, workload_sha256='f' * 64)
        provenance = dict(actual=identity, expected=copy.deepcopy(identity), candidate='c' * 40, dist='/fixture/dist',
                          workload='/repo/scheduler-workload.cjs', home='/fixture/home', observer_path='/repo/scheduler-process.cjs',
                          observer_line=79, ownership_assertions={'lifetime.lock': 339, 'runtime.json': 340}, callsites=dict(
                              tick=[380], timer=[143], lifecycle=[27], drain=[246], drain_snapshot=[277], refresh=[396], observe=[385]))
        selected = dict(readId=1, storeId=2, scriptStore=False)
        timer = ('Error: issue95-routed-held-read\n    at ManagedSyncStore.snapshot (/repo/scheduler-process.cjs:79:5)\n'
                 '    at tick (/fixture/dist/sync-worker.js:380:10)\n'
                 '    at Timeout._onTimeout (/fixture/dist/sync-worker.js:143:40)\n'
                 '    at listOnTimeout (node:internal/timers:588:17)')
        lifecycle = ('Error: issue95-routed-held-read\n    at ManagedSyncStore.snapshot (/repo/scheduler-process.cjs:79:5)\n'
                     '    at assertManagedLifecycle (/fixture/dist/sync-lifecycle.js:27:52)\n'
                     '    at async drain (/fixture/dist/sync-worker.js:246:28)')
        resource = dict(elapsedMs=65001, cpuMs=1, cpuFraction=1 / 65001, rssStart=1000, rssEnd=1000,
                        lifetimePeakRssKiB=1, completedPasses=2, requests=0)
        events = [dict(type='child-started', role='worker', pid=101),
                  dict(type='ready', role='worker', pid=101, record=dict(controlOrigin='http://127.0.0.1:3001'))]
        if direction != 'none':
            events.extend([dict(type='child-started', role='peer', pid=102),
                           dict(type='ready', role='peer', pid=102, url='https://127.0.0.1:3002')])
        events.extend([dict(type='caught-up', count=count, direction=direction),
                       dict(type='idle-start', count=count, direction=direction, duration=65000),
                       dict(type='idle-stop', count=count, direction=direction,
                            observations=[copy.deepcopy(resource) for _ in range(1 if direction == 'none' else 2)])])
        for label in ['explicit-wake', 'wall-forward', 'wall-backward', 'monotonic-gap', 'suspend-both']:
            events.append(dict(type='reaction-stop', label=label, elapsedMs=100))
        if direction != 'none':
            events.extend([dict(type='reaction-stop', label='retry-deadline', elapsedMs=700),
                           dict(type='retry-reaction', requestAt=1100, deadlineAt=1000)])
            custody = dict(type='external-commit-custody', state='deleted' if count else 'live', elapsedMs=31000)
            repair = dict(type='repair-complete', elapsedMs=31000)
            events.extend([repair, custody] if count else [custody, repair])
            events.append(dict(type='stale-route-rejected'))
        events.extend([dict(type='reply', role='worker', pid=101, monotonic=9,
                            result=dict(armed=True, traceReadsFromStartup=False, readTracingInstalled=True, activeReads=[])),
                       dict(type='read-held', role='worker', pid=101, monotonic=10, **selected,
                            caller=lifecycle if passed else timer, activeReads=[copy.deepcopy(selected)]),
                       dict(type='stopping', role='worker', pid=101, monotonic=11, activeReads=[copy.deepcopy(selected)])])
        if passed:
            events.extend([dict(type='read-released', role='worker', pid=101, monotonic=12, reason='rpc', **selected),
                           dict(type='read-finished', role='worker', pid=101, monotonic=13, outcome='fulfilled', **selected)])
        events.append(dict(type='worker-event', event='closed', role='worker', pid=101, monotonic=14,
                           activeReads=[] if passed else [copy.deepcopy(selected)]))
        if passed:
            events.extend([dict(type='shutdown-resources', stopped=True), dict(type='pending-read-shutdown-joined')])
        ports = ['http://127.0.0.1:3001'] + ([] if direction == 'none' else ['https://127.0.0.1:3002'])
        events.append(dict(type='cleanup', childrenReaped=len(ports), exactPorts=ports, failures=[]))
        if not passed:
            events.append(dict(type='workload-failed', error="Error: ENOENT: no such file or directory, lstat '/fixture/home/sync/worker/lifetime.lock'\n"
                               '    at async main (/repo/scheduler-workload.cjs:339:5)'))
        leader = dict(pid=100, start_ticks=1000, group=100, session=100, ppid=99)
        observed = [copy.deepcopy(leader), dict(pid=101, start_ticks=1001, group=100, session=100, ppid=100)]
        if direction != 'none':
            observed.append(dict(pid=102, start_ticks=1002, group=100, session=100, ppid=100))
        cleanup = dict(leader=leader, observed_processes=observed, remaining_processes=[], remaining_group=[],
                       group_joined=True, rebound_ports=sorted(ports), errors=[], checked_at=501)
        return dict(events=events, row=row, provenance=provenance, cleanup=cleanup)

    def verdict(self, data):
        return runner.classify_case(data['events'], data['row'], data['provenance'], data['cleanup'])

    def event(self, data, kind, role=None):
        return next(event for event in data['events'] if event['type'] == kind and (role is None or event.get('role') == role))

    def assert_rejected(self, data):
        result = self.verdict(data)
        self.assertFalse(result['continue_case'], result)
        self.assertFalse(result['qualified_case'], result)
        self.assertFalse(result['passing_cell'], result)
        self.assertFalse(result['resource_gain_eligible'], result)
        self.assertTrue(result['errors'], result)

    def test_exact_parent_native_timer_red_retains_failure_and_unobserved_completion(self):
        data = self.fixture()
        result = self.verdict(data)
        self.assertTrue(result['continue_case'], result)
        self.assertTrue(result['resource_observation_complete'])
        self.assertFalse(result['qualified_case'])
        self.assertFalse(result['passing_cell'])
        self.assertEqual(result['shutdown_correctness'], 'failed-proven-parent-timer')
        self.assertEqual(data['row']['exit'], 1)
        self.assertEqual(result['release_observation'], 'unobserved')
        self.assertEqual(result['completion_observation'], 'unobserved')
        self.assertFalse(result['read_joined'])
        self.event(data, 'workload-failed')['error'] = self.event(data, 'workload-failed')['error'].replace(
            'lifetime.lock', 'runtime.json').replace('.cjs:339:', '.cjs:340:')
        self.assertTrue(self.verdict(data)['continue_case'])

    def test_successful_lifecycle_controls_on_each_role_and_workload(self):
        for role in ['parent', 'candidate']:
            for count in [0, 1000, 10000]:
                for direction in ['none', 'outbound', 'inbound']:
                    with self.subTest(role=role, count=count, direction=direction):
                        data = self.fixture(passed=True, role=role, count=count, direction=direction)
                        result = self.verdict(data)
                        self.assertTrue(result['continue_case'], result)
                        self.assertTrue(result['qualified_case'])
                        self.assertEqual(result['shutdown_correctness'], 'passed')
                        self.assertTrue(result['read_joined'])
                        self.assertFalse(result['resource_gain_eligible'])

    def test_every_provenance_field_is_required_and_must_match(self):
        for field in self.fixture()['provenance']['actual']:
            for operation in ['delete', 'alter']:
                with self.subTest(field=field, operation=operation):
                    data = self.fixture()
                    if operation == 'delete':
                        del data['provenance']['actual'][field]
                    else:
                        data['provenance']['actual'][field] = 'unreviewed'
                    self.assert_rejected(data)

    def test_each_completed_original_control_is_required(self):
        for kind in ['caught-up', 'idle-start', 'idle-stop', 'retry-reaction', 'external-commit-custody',
                     'repair-complete', 'stale-route-rejected', 'reply', 'read-held', 'stopping', 'worker-event',
                     'cleanup', 'workload-failed']:
            with self.subTest(kind=kind):
                data = self.fixture()
                data['events'].remove(self.event(data, kind))
                self.assert_rejected(data)
        for role in ['worker', 'peer']:
            for kind in ['child-started', 'ready']:
                with self.subTest(role=role, kind=kind):
                    data = self.fixture()
                    data['events'].remove(self.event(data, kind, role))
                    self.assert_rejected(data)
        for label in ['explicit-wake', 'wall-forward', 'wall-backward', 'monotonic-gap', 'suspend-both', 'retry-deadline']:
            with self.subTest(reaction=label):
                data = self.fixture()
                data['events'] = [event for event in data['events'] if event.get('label') != label]
                self.assert_rejected(data)

    def test_altered_workload_identity_bounds_or_resource_data_stop(self):
        changes = [('caught-up', 'count', 0), ('idle-start', 'direction', 'none'), ('idle-stop', 'count', 0),
                   ('idle-start', 'duration', 64000), ('reaction-stop', 'elapsedMs', 30001),
                   ('retry-reaction', 'requestAt', 999), ('external-commit-custody', 'state', 'live'),
                   ('external-commit-custody', 'elapsedMs', 65001), ('repair-complete', 'elapsedMs', 65001),
                   ('cleanup', 'childrenReaped', 1), ('cleanup', 'failures', ['failed']), ('cleanup', 'exactPorts', [])]
        for kind, field, value in changes:
            with self.subTest(kind=kind, field=field):
                data = self.fixture()
                self.event(data, kind)[field] = value
                self.assert_rejected(data)
        for field, value in [('elapsedMs', 64999), ('cpuMs', float('nan')), ('rssStart', 0), ('completedPasses', 1)]:
            with self.subTest(resource=field):
                data = self.fixture()
                self.event(data, 'idle-stop')['observations'][0][field] = value
                self.assert_rejected(data)
        for field, value in [('setup_seconds', None), ('setup_seconds', 90), ('elapsed_seconds', 241),
                             ('error', 'setup failed'), ('cleanup_error', 'failed'), ('exit', 2)]:
            with self.subTest(row=field):
                data = self.fixture()
                data['row'][field] = value
                self.assert_rejected(data)

    def test_natural_arm_cannot_be_replaced_by_controlled_setup(self):
        for field, value in [('traceReadsFromStartup', True), ('readTracingInstalled', False), ('ticketId', 'extra-ticket'),
                             ('activeReads', [dict(readId=9, storeId=9, scriptStore=False)])]:
            with self.subTest(field=field):
                data = self.fixture()
                self.event(data, 'reply')['result'][field] = value
                self.assert_rejected(data)
        data = self.fixture()
        data['events'].append(dict(type='controlled-read-hold-barrier'))
        self.assert_rejected(data)

    def test_owned_pid_start_group_and_read_store_are_required(self):
        for kind, role, field, value in [('read-held', None, 'readId', True), ('read-held', None, 'storeId', 0),
                                      ('read-held', None, 'scriptStore', True), ('read-held', None, 'pid', 999),
                                      ('read-held', None, 'role', 'peer'), ('ready', 'worker', 'pid', 999),
                                      ('worker-event', None, 'pid', 999), ('stopping', None, 'pid', 999),
                                      ('read-held', None, 'activeReads', []), ('stopping', None, 'activeReads', []),
                                      ('worker-event', None, 'activeReads', [])]:
            with self.subTest(kind=kind, field=field):
                data = self.fixture()
                self.event(data, kind, role)[field] = value
                self.assert_rejected(data)

        for index, field, value in [(0, 'start_ticks', 0), (1, 'start_ticks', 0), (1, 'group', 999),
                                    (1, 'session', 999), (1, 'ppid', 999), (1, 'pid', 999)]:
            with self.subTest(witness=index, field=field):
                data = self.fixture()
                data['cleanup']['observed_processes'][index][field] = value
                self.assert_rejected(data)

    def test_required_identity_order_and_control_fields_cannot_be_omitted(self):
        fields = {'read-held': ['readId', 'storeId', 'scriptStore', 'pid', 'role', 'activeReads', 'monotonic', 'caller'],
                  'stopping': ['pid', 'role', 'activeReads', 'monotonic'],
                  'worker-event': ['pid', 'role', 'activeReads', 'monotonic', 'event'],
                  'caught-up': ['count', 'direction'], 'idle-start': ['count', 'direction', 'duration'],
                  'idle-stop': ['count', 'direction', 'observations'], 'reaction-stop': ['label', 'elapsedMs'],
                  'retry-reaction': ['requestAt', 'deadlineAt'], 'external-commit-custody': ['state', 'elapsedMs'],
                  'repair-complete': ['elapsedMs'], 'cleanup': ['failures', 'childrenReaped', 'exactPorts'],
                  'workload-failed': ['error']}
        for kind, names in fields.items():
            for name in names:
                with self.subTest(kind=kind, field=name):
                    data = self.fixture()
                    del self.event(data, kind)[name]
                    self.assert_rejected(data)
        for name in ['armed', 'traceReadsFromStartup', 'readTracingInstalled', 'activeReads']:
            data = self.fixture()
            del self.event(data, 'reply')['result'][name]
            self.assert_rejected(data)
        for name in ['elapsedMs', 'cpuMs', 'cpuFraction', 'rssStart', 'rssEnd', 'lifetimePeakRssKiB', 'completedPasses']:
            data = self.fixture()
            del self.event(data, 'idle-stop')['observations'][0][name]
            self.assert_rejected(data)

    def test_other_known_archived_owned_callers_can_pass_without_retrying_selection(self):
        for tail in ['    at async refreshSchedule (/fixture/dist/sync-worker.js:396:5)\n'
                     '    at async observeSchedule (/fixture/dist/sync-worker.js:385:5)\n'
                     '    at async drain (/fixture/dist/sync-worker.js:246:5)',
                     '    at async drain (/fixture/dist/sync-worker.js:277:5)']:
            data = self.fixture(passed=True, role='candidate')
            self.event(data, 'read-held')['caller'] = ('Error: issue95-routed-held-read\n'
                '    at ManagedSyncStore.snapshot (/repo/scheduler-process.cjs:79:5)\n' + tail)
            self.assertTrue(self.verdict(data)['continue_case'])

    def test_positive_native_callsite_and_ancestry_are_required(self):
        original = self.event(self.fixture(), 'read-held')['caller']
        for old, new in [('tick (', 'manualTick ('), ('sync-worker.js:380:', 'sync-worker.js:381:'),
                         ('Timeout._onTimeout', 'rpcClock'), ('sync-worker.js:143:', 'sync-worker.js:144:'),
                         ('listOnTimeout', 'nextTick'), ('node:internal/timers', 'other-module'),
                         ('sync-worker.js', 'foreign-worker.js'), ('scheduler-process.cjs:79:', 'scheduler-process.cjs:80:')]:
            with self.subTest(old=old):
                data = self.fixture()
                self.event(data, 'read-held')['caller'] = original.replace(old, new)
                self.assert_rejected(data)
        for caller in ['', 'Error: no actual caller', original.replace('Error: issue95-routed-held-read\n', '')]:
            data = self.fixture()
            self.event(data, 'read-held')['caller'] = caller
            self.assert_rejected(data)

    def test_release_before_close_or_foreign_completion_cannot_be_parent_exception(self):
        for field, value in [('pid', 999), ('readId', 2), ('storeId', 3), ('scriptStore', True), ('monotonic', 13)]:
            with self.subTest(field=field):
                data = self.fixture()
                release = dict(type='read-released', role='worker', pid=101, readId=1, storeId=2,
                               scriptStore=False, reason='rpc', monotonic=15)
                release[field] = value
                data['events'].append(release)
                self.assert_rejected(data)
        for monotonic in [9, 15]:
            data = self.fixture()
            self.event(data, 'stopping')['monotonic'] = monotonic
            self.assert_rejected(data)
        data = self.fixture()
        data['events'].append(data['events'].pop(data['events'].index(self.event(data, 'repair-complete'))))
        self.assert_rejected(data)

    def test_exact_original_error_and_clean_teardown_are_required(self):
        original = self.event(self.fixture(), 'workload-failed')['error']
        for old, new in [('ENOENT', 'EACCES'), ('lstat', 'open'), ('/fixture/home/', '/other/home/'),
                         ('lifetime.lock', 'other.lock'), ('lifetime.lock', 'runtime.json'),
                         ('scheduler-workload.cjs:339:', 'scheduler-workload.cjs:341:'),
                         ('Error: ENOENT', 'AggregateError: cleanup failed\nError: ENOENT')]:
            with self.subTest(old=old):
                data = self.fixture()
                self.event(data, 'workload-failed')['error'] = original.replace(old, new)
                self.assert_rejected(data)
        for field in ['leader', 'observed_processes', 'remaining_processes', 'remaining_group', 'group_joined',
                      'rebound_ports', 'errors', 'checked_at']:
            with self.subTest(missing_cleanup=field):
                data = self.fixture()
                del data['cleanup'][field]
                self.assert_rejected(data)
        for field, value in [('remaining_processes', [{'pid': 101}]), ('remaining_group', [{'pid': 101}]),
                             ('group_joined', False), ('rebound_ports', []), ('errors', ['busy']), ('checked_at', 499)]:
            with self.subTest(cleanup=field):
                data = self.fixture()
                data['cleanup'][field] = value
                self.assert_rejected(data)

    def test_candidate_unknown_callers_and_unrelated_errors_always_stop(self):
        self.assert_rejected(self.fixture(role='candidate'))
        data = self.fixture(passed=True, role='candidate')
        self.event(data, 'read-held')['caller'] = 'Error: unknown external caller'
        self.assert_rejected(data)
        for event in [dict(type='startup-failed'), dict(type='fatal'), dict(type='reply', error='credential failed')]:
            data = self.fixture()
            data['events'].append(event)
            self.assert_rejected(data)
        for kind in ['read-held', 'worker-event', 'workload-failed', 'cleanup', 'reply']:
            data = self.fixture()
            data['events'].append(copy.deepcopy(self.event(data, kind)))
            self.assert_rejected(data)

    def test_success_requires_fulfilled_rpc_read_before_close(self):
        for kind, field, value in [('read-released', 'reason', 'disconnect'), ('read-finished', 'outcome', 'rejected'),
                                 ('read-finished', 'monotonic', 15), ('read-released', 'monotonic', 14),
                                 ('read-finished', 'readId', True), ('shutdown-resources', 'stopped', False)]:
            with self.subTest(kind=kind, field=field):
                data = self.fixture(passed=True)
                self.event(data, kind)[field] = value
                self.assert_rejected(data)
        for kind in ['read-released', 'read-finished', 'shutdown-resources', 'pending-read-shutdown-joined']:
            data = self.fixture(passed=True)
            data['events'].remove(self.event(data, kind))
            self.assert_rejected(data)

    def test_late_completion_is_observed_but_never_joined_before_parent_close(self):
        data = self.fixture()
        index = data['events'].index(self.event(data, 'cleanup'))
        data['events'][index:index] = [dict(type='read-released', role='worker', pid=101, readId=1, storeId=2,
                                           scriptStore=False, monotonic=15, reason='rpc'),
                                      dict(type='read-finished', role='worker', pid=101, readId=1, storeId=2,
                                           scriptStore=False, monotonic=16, outcome='fulfilled')]
        result = self.verdict(data)
        self.assertTrue(result['continue_case'], result)
        self.assertEqual(result['completion_observation'], 'observed')
        self.assertFalse(result['read_joined'])
        self.assertFalse(result['passing_cell'])

    def test_cleanup_guard_rejects_reused_pid_before_signaling(self):
        child = mock.Mock(pid=100, returncode=None)
        foreign = dict(pid=100, start_ticks=2000, group=100, session=100)
        with mock.patch.object(runner, 'processes', return_value=[foreign]), mock.patch.object(runner.os, 'killpg') as kill:
            with self.assertRaisesRegex(RuntimeError, 'original PID/start/session witness'):
                runner.terminate(child, witnesses={(100, 1000): {}})
            kill.assert_not_called()
            child.wait.assert_not_called()

    def test_cleanup_deadline_cannot_start_another_signal_or_wait_grace(self):
        child = mock.Mock(pid=100, returncode=None)
        process = dict(pid=100, start_ticks=1000, group=100, session=100)
        with mock.patch.object(runner, 'processes', return_value=[process]), mock.patch.object(runner.time, 'monotonic', return_value=10), \
                mock.patch.object(runner.os, 'killpg') as kill, mock.patch.object(runner.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'did not fully reap'):
                runner.terminate(child, deadline=10, witnesses={(100, 1000): process})
            kill.assert_not_called()
            child.wait.assert_not_called()
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
