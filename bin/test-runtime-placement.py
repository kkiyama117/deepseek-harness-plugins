#!/usr/bin/env python3
"""Exercise placement checks without modifying production services."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
GUARD = Path(__file__).with_name('check-runtime-placement.py')
spec = importlib.util.spec_from_file_location('placement', GUARD)
placement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(placement)


class PlacementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='.placement-test-', dir=GUARD.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'main'
        (self.root / '.git').mkdir(parents=True)
        self.cli = self.root / 'apps/cli/lib/bin.js'
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text('')
        self.node = Path(sys.executable)
        self.context = patch.multiple(placement, ROOT=self.root, NODE=self.node)
        self.context.start()
        self.addCleanup(self.context.stop)

    def command(self, cli=None):
        return [[str(self.node), [str(self.node), str(cli or self.cli), 'web']]]

    def test_stopped_unit_definition_is_loaded_without_starting(self):
        calls = []
        def fake_bus(*args):
            calls.append(args)
            if args[0] == 'call':
                self.assertEqual(args[4], 'LoadUnit')
                return ['/org/freedesktop/systemd1/unit/example_2eservice']
            return {'ExecStart': self.command(), 'WorkingDirectory': str(self.root), 'ExecStartPre': []}[args[-1]]
        with patch.object(placement, 'bus', side_effect=fake_bus):
            self.assertEqual(placement.service_properties('example.service'), (self.command(), str(self.root), []))
        self.assertEqual(len(calls), 4)
        self.assertFalse(any('StartUnit' in call for call in calls))

    def test_main_checkout_is_accepted(self):
        placement.check_command(self.command(), str(self.root), 'web')
        placement.check_dependency(self.root)

    def test_temporary_cli_is_denied(self):
        with self.assertRaisesRegex(placement.PlacementError, 'noncanonical CLI'):
            placement.check_command(self.command('/tmp/dsh-stage/apps/cli/lib/bin.js'), str(self.root), 'web')

    def test_alternate_working_directory_is_denied(self):
        with self.assertRaisesRegex(placement.PlacementError, 'WorkingDirectory'):
            placement.check_command(self.command(), '/tmp/dsh-stage', 'web')

    def test_symlinked_canonical_checkout_is_denied(self):
        link = Path(self.temp.name) / 'link'
        link.symlink_to(self.root)
        with patch.object(placement, 'ROOT', link):
            with self.assertRaisesRegex(placement.PlacementError, 'main Git checkout'):
                placement.check_command(self.command(), str(link), 'web')

    def test_temporary_dependency_is_denied(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(placement.PlacementError, 'temporary dependency'):
                placement.check_dependency(Path(directory))

    def test_worktree_dependency_is_denied(self):
        tree = Path(self.temp.name) / 'worktree'
        tree.mkdir()
        (tree / '.git').write_text('gitdir: /unused/worktrees/example\n')
        with self.assertRaisesRegex(placement.PlacementError, 'worktree dependency'):
            placement.check_dependency(tree)

    def test_staging_artifact_dependency_is_denied(self):
        for name in ['.artifacts', '.dsh-maintenance']:
            with self.subTest(name=name):
                directory = self.root / name / 'pilot'
                directory.mkdir(parents=True)
                with self.assertRaisesRegex(placement.PlacementError, 'staging artifact'):
                    placement.check_dependency(directory)

    def test_completion_check_rejects_missing_startup_guard(self):
        with patch.object(placement, 'service_properties', return_value=(self.command(), str(self.root), [])):
            with self.assertRaisesRegex(placement.PlacementError, 'mandatory ExecStartPre'):
                placement.check_unit('example.service', 'web', require_installed=True)

    def test_completion_check_rejects_ignored_startup_guard(self):
        argv = ['/usr/bin/python3', '-B', str(GUARD.resolve()), '--unit', 'example.service', '--profile', 'web']
        pre = [['/usr/bin/python3', argv, True]]
        with patch.object(placement, 'service_properties', return_value=(self.command(), str(self.root), pre)):
            with self.assertRaisesRegex(placement.PlacementError, 'mandatory ExecStartPre'):
                placement.check_unit('example.service', 'web', require_installed=True)

    def daily_command(self, guard=GUARD):
        wrapper = str(placement.HOME / 'profiles/ai-reference-store-daily/daily-start.sh')
        return [['/bin/bash', ['/bin/bash', wrapper, '--check-placement', str(guard),
                'ai-reference-store-daily.service', 'ai-reference-store-daily',
                '300', '/data', '/data/references/AI', str(self.node), str(self.cli)]]]

    def test_daily_post_readiness_guard_is_required_and_accepted(self):
        commands = self.daily_command()
        with patch.object(placement, 'service_properties', return_value=(commands, '/home/kiyama', [])), patch.object(placement, 'check_profile'):
            placement.check_unit('ai-reference-store-daily.service', 'ai-reference-store-daily', require_installed=True)

    def test_daily_replacement_guard_is_rejected(self):
        commands = self.daily_command('/tmp/fake-guard.py')
        with patch.object(placement, 'service_properties', return_value=(commands, '/home/kiyama', [])):
            with self.assertRaisesRegex(placement.PlacementError, 'mandatory ExecStartPre'):
                placement.check_unit('ai-reference-store-daily.service', 'ai-reference-store-daily', require_installed=True)

    def test_daily_temporary_cli_is_rejected(self):
        commands = self.daily_command()
        commands[0][1][10] = '/tmp/staging/cli.js'
        with self.assertRaisesRegex(placement.PlacementError, 'noncanonical CLI'):
            placement.check_command(commands, '/home/kiyama', 'ai-reference-store-daily')

    def test_obsolete_package_manager_override_is_denied(self):
        home = Path(self.temp.name) / 'home'
        directory = home / 'profiles' / 'web'
        directory.mkdir(parents=True)
        (directory / 'package.json').write_text('{"dependencies": {}}')
        config = directory / 'pnpm-workspace.yaml'
        with patch.object(placement, 'HOME', home):
            config.write_text('overrides:\n  old: link:/data/softwares/deepseek-harness-master/vendor/cordis\n')
            with self.assertRaisesRegex(placement.PlacementError, 'package-manager configuration'):
                placement.check_profile('web')
            config.write_text('overrides:\n  current: link:/data/softwares/deepseek-harness/vendor/cordis\n')
            placement.check_profile('web')

    def test_missing_dependency_is_denied(self):
        with self.assertRaises(FileNotFoundError):
            placement.check_dependency(Path(self.temp.name) / 'missing')


def live_checks():
    for negative in [False, True]:
        unit = f'dsh-placement-test-{os.getpid()}-{int(negative)}'
        cli = '/tmp/dsh-stage/apps/cli/lib/bin.js' if negative else str(placement.ROOT / 'apps/cli/lib/bin.js')
        args = ['systemd-run', '--user', '--wait', '--pipe', '--collect', '--unit=' + unit,
                '-p', 'WorkingDirectory=' + str(placement.ROOT),
                '-p', f'ExecStartPre=/usr/bin/python3 -B {GUARD} --unit {unit}.service --profile web',
                str(placement.NODE), cli, '--version']
        result = subprocess.run(args, capture_output=True, text=True, timeout=45)
        output = result.stdout + result.stderr
        if negative:
            if result.returncode == 0 or 'PLACEMENT_DENIED: noncanonical CLI' not in output:
                raise RuntimeError('Negative systemd check did not reject the temporary CLI: ' + output)
        elif result.returncode != 0 or 'PLACEMENT_OK' not in output:
            raise RuntimeError('Canonical systemd check failed: ' + output)
        print(f'SYSTEMD_CHECK {"temporary-cli-denied" if negative else "canonical-cli-accepted"}: passed')


if __name__ == '__main__':
    live = '--live' in sys.argv
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PlacementTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        sys.exit(1)
    if live:
        live_checks()
