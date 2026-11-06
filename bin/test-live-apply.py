#!/usr/bin/env python3
"""Exercise live patch application against a fake worker and a fake DSH CLI."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name('live-apply.py')
PROBE_TASK = 'What is 17*23? Reply with only the number.'
OLD = '[]\n'
NEW = '- id: agent-default-model\n  config:\n    reasoningEffort: low\n'

WORKER_BODY = '''
import json
import os
import sys

plan = os.environ['FAKE_PLAN']
position_file = plan + '.position'
position = int(open(position_file).read()) if os.path.exists(position_file) else 0
words = open(plan).read().split()
if position >= len(words):
    sys.exit(99)
word = words[position]
open(position_file, 'w').write(str(position + 1))
try:
    target_text = open(os.environ['FAKE_TARGET']).read()
except OSError:
    target_text = None
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read(),
                          'dshCli': os.environ.get('DSH_CLI'),
                          'dshHome': os.environ.get('DSH_HOME'),
                          'target': target_text}) + '\\n')
if word == 'ok':
    print('391')
elif word == 'fail':
    sys.exit(1)
elif word == 'wrong':
    print('392')
elif word == 'write':
    open('stray', 'w').close()
    print('391')
'''

DSH_BODY = '''
import json
import os
import shutil
import sys

with open(os.environ['FAKE_DSH_LOG'], 'a') as log:
    log.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(),
                          'dshHome': os.environ.get('DSH_HOME'),
                          'dshCli': os.environ.get('DSH_CLI')}) + '\\n')
remove = os.environ.get('FAKE_DSH_REMOVE')
if remove:
    shutil.rmtree(remove, ignore_errors=True)
sys.exit(1 if os.environ.get('FAKE_DSH_FAIL') == '1' else 0)
'''


class LiveApplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='live-apply-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.profiles = self.home / 'profiles'
        self.profiles.mkdir(parents=True)
        self.add_profile('headless')
        self.record = self.root / 'record'
        self.plan = self.root / 'plan'
        self.calls_log = self.root / 'calls.jsonl'
        self.dsh_log = self.root / 'dsh.jsonl'
        self.run_worker = self.write_script('fake-run-worker', WORKER_BODY)
        self.dsh = self.write_script('fake-dsh', DSH_BODY)
        self.source = self.root / 'source.yml'
        self.source.write_text(NEW)
        self.target = self.profiles / 'web' / 'cordis.patch.yml'

    def write_script(self, name, body):
        path = self.root / name
        path.write_text(f'#!{sys.executable}\n{body}')
        path.chmod(0o755)
        return path

    def add_profile(self, name):
        directory = self.profiles / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'package.json').write_text('{}')
        return directory

    def prepare_web(self, old=OLD):
        self.add_profile('web')
        if old is not None:
            self.target.write_text(old)

    def entries(self, path):
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def calls(self):
        return self.entries(self.calls_log)

    def dsh_calls(self):
        return self.entries(self.dsh_log)

    def summary(self, result):
        return json.loads(result.stdout)

    def invoke(self, plan='', env=None, **options):
        arguments = {
            '--source': str(self.source),
            '--target': str(self.target),
            '--record': str(self.record),
            '--dsh-home': str(self.home),
            '--retry-delay': '0',
            '--run-worker': str(self.run_worker),
            '--dsh': str(self.dsh),
            '--owner-approved': None,
        }
        for key, value in options.items():
            arguments['--' + key.replace('_', '-')] = value
        environment = {key: value for key, value in os.environ.items() if not key.startswith('FAKE_')}
        environment.update({
            'FAKE_PLAN': str(self.plan),
            'FAKE_LOG': str(self.calls_log),
            'FAKE_DSH_LOG': str(self.dsh_log),
            'FAKE_TARGET': str(self.target),
        })
        environment.update(env or {})
        self.plan.write_text(plan)
        for stale in [self.root / 'plan.position', self.calls_log, self.dsh_log]:
            if stale.exists():
                stale.unlink()
        argv = []
        for name, value in arguments.items():
            if value is not None:
                argv.extend([name, str(value)])
        return subprocess.run([sys.executable, '-B', str(SCRIPT), 'patch', *argv],
                              capture_output=True, text=True, env=environment)

    def test_applies_when_probes_pass(self):
        self.prepare_web()
        result = self.invoke(plan='ok ok ok ok')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_text(), NEW)
        self.assertEqual((self.record / 'backup.yml').read_text(), OLD)
        summary = self.summary(result)
        self.assertEqual(summary['status'], 'applied')
        self.assertFalse(summary['production'])
        self.assertEqual(json.loads((self.record / 'summary.json').read_text()), summary)
        calls = self.calls()
        self.assertEqual(len(calls), 4)
        self.assertEqual([call['target'] for call in calls], [OLD, OLD, NEW, NEW])
        routes = [['dsh', 'ollama-cloud', 'deepseek-v4.1-flash', 'high'],
                  ['dsh', 'openai-codex', 'gpt-6.1-sol', 'high']]
        self.assertEqual([call['argv'][-4:] for call in calls], routes + routes)
        for call in calls:
            self.assertTrue(call['argv'][0] == '--read-only')
            self.assertEqual(call['stdin'], PROBE_TASK)
            self.assertEqual(call['dshCli'], str(self.dsh))
        self.assertTrue(self.dsh_calls())
        for call in self.dsh_calls():
            self.assertEqual(call['cwd'], str(self.home))
            self.assertEqual(call['dshHome'], str(self.home))
            self.assertEqual(call['dshCli'], str(self.dsh))
        self.assertIn('LIVE_APPLY_RESTART_NEEDED: dsh-web-managed.service', result.stderr)

    def test_unchanged_source_runs_nothing(self):
        self.prepare_web(old=NEW)
        self.record.mkdir()
        result = self.invoke(plan='ok')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.summary(result)['status'], 'unchanged')
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.dsh_calls(), [])
        self.assertEqual(list(self.record.iterdir()), [])

    def test_production_profile_refused_without_approval(self):
        self.target = self.profiles / 'headless' / 'cordis.patch.yml'
        self.target.write_text(OLD)
        result = self.invoke()
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(self.summary(result)['status'], 'refused')
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.record.exists())
        self.assertIn('LIVE_APPLY_REFUSED', result.stderr)

    def test_home_patch_refused_without_approval(self):
        self.target = self.home / 'cordis.patch.yml'
        self.target.write_text(OLD)
        result = self.invoke()
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(self.calls(), [])

    def test_blank_approval_refused(self):
        self.target = self.profiles / 'headless' / 'cordis.patch.yml'
        self.target.write_text(OLD)
        result = self.invoke(owner_approved='  ')
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(self.calls(), [])

    def test_unknown_profile_is_production(self):
        self.add_profile('other')
        self.target = self.profiles / 'other' / 'cordis.patch.yml'
        self.target.write_text(OLD)
        result = self.invoke()
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.target.read_text(), OLD)

    def test_production_applies_with_approval(self):
        self.target = self.profiles / 'headless' / 'cordis.patch.yml'
        self.target.write_text(OLD)
        result = self.invoke(plan='ok ok ok ok', owner_approved='test approval')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_text(), NEW)
        self.assertEqual(self.summary(result)['ownerApproved'], 'test approval')
        self.assertIn('slack-intake-bridge.service', result.stderr)

    def test_pre_probe_failure_changes_nothing(self):
        self.prepare_web()
        result = self.invoke(plan='fail')
        self.assertEqual(result.returncode, 4)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.summary(result)['status'], 'pre-probe-failed')

    def test_wrong_answer_fails_probe(self):
        self.prepare_web()
        result = self.invoke(plan='wrong ok ok')
        self.assertEqual(result.returncode, 4)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(len(self.calls()), 1)
        checks = self.summary(result)['checks']
        worker = [check for check in checks if check['phase'] == 'before' and check['name'] == 'worker']
        self.assertEqual(len(worker), 1)
        self.assertFalse(worker[0]['ok'])
        self.assertFalse(any(check['name'] == 'review' for check in checks))

    def test_probe_writing_a_file_fails_probe(self):
        self.prepare_web()
        result = self.invoke(plan='write ok ok')
        self.assertEqual(result.returncode, 4)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(len(self.calls()), 1)
        checks = self.summary(result)['checks']
        worker = [check for check in checks if check['phase'] == 'before' and check['name'] == 'worker']
        self.assertEqual(len(worker), 1)
        self.assertFalse(worker[0]['ok'])
        self.assertFalse(any(check['name'] == 'review' for check in checks))

    def test_after_probe_retried_once(self):
        self.prepare_web()
        result = self.invoke(plan='ok ok fail ok ok')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.target.read_text(), NEW)
        attempts = [check for check in self.summary(result)['checks']
                    if check['phase'] == 'after' and check['name'] == 'worker']
        self.assertEqual([(check['attempt'], check['ok']) for check in attempts],
                         [(1, False), (2, True)])

    def test_after_failure_rolls_back(self):
        self.prepare_web()
        result = self.invoke(plan='ok ok fail fail ok ok')
        self.assertEqual(result.returncode, 5)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(self.summary(result)['status'], 'rolled-back')
        self.assertEqual([call['target'] for call in self.calls()[-2:]], [OLD, OLD])
        rollback = [check for check in self.summary(result)['checks'] if check['phase'] == 'rollback']
        self.assertTrue(rollback)
        self.assertTrue(all(check['ok'] for check in rollback))

    def test_rollback_probe_failure_exits_6(self):
        self.prepare_web()
        result = self.invoke(plan='ok ok fail fail fail fail')
        self.assertEqual(result.returncode, 6)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertIn('LIVE_APPLY_ROLLBACK_PROBE_FAILED', result.stderr)
        self.assertIn('LIVE_APPLY_CHECK_SERVICE: dsh-web-managed.service', result.stderr)

    def test_new_target_removed_on_rollback(self):
        self.prepare_web(old=None)
        result = self.invoke(plan='ok ok fail fail ok ok')
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertFalse(self.target.exists())
        self.assertTrue((self.record / 'backup-absent').exists())

    def test_config_check_failure_aborts(self):
        self.prepare_web()
        result = self.invoke(env={'FAKE_DSH_FAIL': '1'})
        self.assertEqual(result.returncode, 4)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(self.calls(), [])
        self.assertEqual([call['argv'] for call in self.dsh_calls()],
                         [['--profile', 'web', '--dump-config']])

    def test_home_patch_checks_service_profiles(self):
        self.prepare_web()
        self.add_profile('other')
        self.target = self.home / 'cordis.patch.yml'
        self.target.write_text(OLD)
        result = self.invoke(plan='ok ok ok ok', owner_approved='test approval')
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [['--profile', 'headless', '--dump-config'],
                    ['--profile', 'web', '--dump-config']] * 2
        self.assertEqual([call['argv'] for call in self.dsh_calls()], expected)
        for service in ['slack-intake-bridge.service', 'dsh-web-managed.service',
                        'ai-reference-store-daily.service']:
            self.assertIn(service, result.stderr)

    def test_target_outside_routes_rejected(self):
        self.add_profile('web')
        self.target = self.profiles / 'web' / 'package.json'
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn('target is not a home or profile patch', result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.calls(), [])

    def test_missing_probe_profile_stops(self):
        self.prepare_web()
        shutil.rmtree(self.profiles / 'headless')
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn('probe profile headless does not exist', result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.dsh_calls(), [])
        self.assertFalse((self.profiles / 'headless').exists())

    def test_probe_profile_rechecked_before_probe(self):
        self.prepare_web()
        result = self.invoke(plan='ok ok ok ok',
                             env={'FAKE_DSH_REMOVE': str(self.profiles / 'headless')})
        self.assertEqual(result.returncode, 4)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertEqual(self.calls(), [])
        checks = self.summary(result)['checks']
        config = [check for check in checks if check['phase'] == 'before' and check['name'] == 'config-web']
        self.assertEqual(len(config), 1)
        self.assertTrue(config[0]['ok'])
        worker = [check for check in checks if check['phase'] == 'before' and check['name'] == 'worker']
        self.assertEqual(len(worker), 1)
        self.assertFalse(worker[0]['ok'])
        self.assertIsNone(worker[0]['exitCode'])
        self.assertFalse((self.profiles / 'headless').exists())

    def test_record_inside_home_rejected(self):
        self.prepare_web()
        result = self.invoke(record=str(self.home / 'rec'))
        self.assertEqual(result.returncode, 2)
        self.assertIn('record directory is inside the harness home', result.stderr)
        self.assertFalse((self.home / 'rec').exists())
        self.assertEqual(self.calls(), [])

    def test_record_directory_must_be_empty(self):
        self.prepare_web()
        self.record.mkdir()
        (self.record / 'kept').write_text('kept\n')
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertIn('record directory is not empty', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_unreadable_source_is_error(self):
        if os.geteuid() == 0:
            self.skipTest('root can read a file with mode 0o000')
        self.prepare_web()
        self.source.chmod(0o000)
        result = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.target.read_text(), OLD)
        self.assertTrue(result.stderr.startswith('live-apply: read source:'), result.stderr)
        self.assertEqual(self.summary(result)['status'], 'error')
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
