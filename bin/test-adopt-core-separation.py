#!/usr/bin/env python3
"""Fixture tests for the one-shot adoption; no production command or path is ever used."""
from pathlib import Path
import ast, hashlib, importlib.util, io, json, os, shutil, subprocess, sys, tarfile, tempfile, unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parent / 'adopt-core-separation.py'
SIX = ['claude-review-request.txt', 'claude-review-result.json', 'claude-review-stderr.log',
       'claude-review-summary.ja.md', 'jev-dsh-design-readable.ja.md', 'jev-dsh-design.ja.md']
STAGED = 'local-design/jev-design-iTPPoocQ/'
CORE_NAMES = ['jev-design-iTPPoocQ/' + name for name in SIX]
PLUGIN_NAMES = [STAGED + name for name in SIX]


def load_module():
    spec = importlib.util.spec_from_file_location('adopt_core_separation', SOURCE)
    module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text); return path
def done(code=0, out=''): return subprocess.CompletedProcess([], code, out, '')


def snapshot(root):
    """Every file, directory and symlink below root, so a transition between them shows."""
    state = {}
    for path in sorted(Path(root).rglob('*')):
        name = str(path.relative_to(root))
        state[name] = ('link', os.readlink(path)) if path.is_symlink() else (
            ('file', digest(path)) if path.is_file() else ('dir', None))
    return state


def archive(path, name, version, dependencies=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({'name': name, 'version': version, 'dependencies': dependencies or {}}).encode()
    with tarfile.open(path, 'w:gz') as package:
        member = tarfile.TarInfo('package/package.json'); member.size = len(payload)
        package.addfile(member, io.BytesIO(payload))


class AdoptionFixture(unittest.TestCase):
    """A complete fixture tree plus a recording runner; the module never reaches the machine."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, self.root)
        self.core, self.live, self.stage = (self.root / name for name in ('core', 'live', 'stage'))
        self.home, self.report = self.root / 'home', self.root / 'report'
        self.calls, self.head = [], None
        self.module = load_module(); self.head = self.module.PREV
        for name, value in (('CORE', self.core), ('LIVE', self.live), ('STAGE', self.stage),
                            ('HOME', self.home), ('REPORT', self.report), ('run', self.fake_run),
                            ('worker_ready', lambda: {'phase': 'online'}),
                            ('web_ready', lambda: {'active': 'active'}), ('checks', lambda: ['ok'])):
            patcher = mock.patch.object(self.module, name, value); patcher.start(); self.addCleanup(patcher.stop)
        self.build()

    def fake_run(self, argv, cwd=None, timeout=900, check=True):
        command = [str(part) for part in argv]; self.calls.append(command)
        if command[:2] == ['cp', '-a']:
            shutil.copytree(command[2], command[3]); return done()
        if any(part.endswith('read-live-session-status.mjs') for part in command): return done(0, json.dumps({'ok':True,'active':[]}))
        if command[0] == 'git': return self.git(command)
        if command[0] == 'systemctl': return done(0, 'active\n' if 'is-active' in command else '')
        if 'plugin' in command: return self.cli(command)
        return done()

    def git(self, command):
        verb = command[3]
        if verb == 'rev-parse': return done(0, self.head + '\n')
        if verb == 'status': return done(0, ''.join(f'A  {name}\n' for name in CORE_NAMES))
        if verb == 'merge': self.head = self.module.NEXT
        if verb == 'rm' and '--cached' not in command:
            for name in command[command.index('--')+1:]: (self.core / name).unlink(missing_ok=True)
        return done()

    def cli(self, command):
        """The built CLI is the only writer of a profile manifest in this procedure."""
        profile = command[command.index('--profile') + 1]; directory = self.home / 'profiles' / profile
        manifest = json.loads((directory / 'package.json').read_text())
        for spec in command[command.index('add') + 1:-1]:
            name = self.module.PILOT if 'pilot' in spec else self.module.PRESET
            manifest['dependencies'][name] = spec
            write(directory / 'node_modules' / name / 'package.json',
                  json.dumps({'name': name, 'version': self.module.VERSIONS[name]}))
            if name == self.module.PILOT:
                write(directory / 'node_modules' / self.module.GOAL / 'package.json',
                      json.dumps({'version': self.module.VERSIONS[self.module.GOAL]}))
        (directory / 'package.json').write_text(json.dumps(manifest))
        return done()

    def build(self):
        write(self.live / 'bin/removed.mjs', 'obsolete\n'); write(self.live / 'bin/changed.mjs', 'old\n')
        write(self.live / 'unrelated/keep.txt', 'other agent work\n')
        write(self.stage / 'bin/added.mjs', 'fresh\n'); write(self.stage / 'bin/changed.mjs', 'new\n')
        write(self.core / 'README.md', 'core\n')
        (self.core / '.git').mkdir()
        write(self.core / self.module.CLI, 'built cli\n')
        for name in SIX:
            body = '' if name == 'claude-review-stderr.log' else f'preserved {name}\n'
            write(self.stage / STAGED / name, body); write(self.core / 'jev-design-iTPPoocQ' / name, body)
        changes = [{'status': 'M', 'path': 'bin/changed.mjs', 'currentSha256': digest(self.live / 'bin/changed.mjs'),
                    'newSha256': digest(self.stage / 'bin/changed.mjs')},
                   {'status': 'D', 'path': 'bin/removed.mjs', 'currentSha256': digest(self.live / 'bin/removed.mjs'),
                    'newSha256': None},
                   {'status': 'A', 'path': 'bin/added.mjs', 'currentSha256': None,
                    'newSha256': digest(self.stage / 'bin/added.mjs')}]
        for index in range(46):
            name = f'filler/{index:02d}.txt'; write(self.stage / name, f'filler {index}\n')
            changes.append({'status': 'A', 'path': name, 'currentSha256': None, 'newSha256': digest(self.stage / name)})
        for name in CORE_NAMES:
            changes.append({'status': 'A', 'path': STAGED + name.split('/', 1)[1], 'currentSha256': None,
                            'newSha256': digest(self.core / name)})
        assert len(changes) == self.module.SCOPE_PATHS
        for profile, dependencies in (('web', {self.module.PILOT: 'file:/old-pilot.tgz',
                                                self.module.PRESET: 'link:/old-preset'}),
                                       ('headless', {}),
                                       ('ai-reference-store-daily', {self.module.PRESET: 'link:/old-preset'})):
            directory = self.home / 'profiles' / profile
            write(directory / 'package.json', json.dumps({'dependencies': dependencies,
                                                          'dsh': {'profile': {'bundles': [profile]}}}))
            write(directory / 'cordis.patch.yml', '[]\n'); write(directory / 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
            write(directory / 'pnpm-workspace.yaml', 'autoInstallPeers: false\n')
            write(directory / 'node_modules/.modules.yaml', profile + '\n')
        goal = self.report / 'releases/goal.tgz'; archive(goal, self.module.GOAL, '1.1.0')
        releases = [{'name': self.module.GOAL, 'artifact': str(goal), 'sha256': digest(goal)}]
        for name, filename, dependencies in ((self.module.PILOT, 'pilot.tgz',
                                              {self.module.GOAL: f'file:{goal}'}),
                                             (self.module.PRESET, 'preset.tgz', None)):
            artifact = self.report / f'releases/{filename}'
            archive(artifact, name, self.module.VERSIONS[name], dependencies)
            releases.append({'name': name, 'artifact': str(artifact), 'sha256': digest(artifact)})
        base = 'f' * 40
        self.inputs = {'progress': {'preparedCoreCommit': self.module.NEXT,
                                    'liveCoreHeadAtStart': self.module.PREV},
                       'before': {'pluginBase': base, 'stagedCore': CORE_NAMES},
                       'scope': {'base': base, 'changes': changes, 'conflicts': [], 'profileHashes': {}}, 'releases': releases}
        for key, value in self.inputs.items():
            write(self.report / ('adoption-scope.json' if key == 'scope' else f'{key}.json'), json.dumps(value))
        self.receipt = self.report / 'adoption-receipt.json'

    # --- scoped apply and document move -------------------------------------------------
    def test_adoption_writes_only_the_scoped_paths_and_moves_the_six_documents(self):
        state = self.module.adopt(False)
        self.assertEqual(state['status'], 'completed')
        self.assertEqual((self.live / 'bin/changed.mjs').read_text(), 'new\n')
        self.assertTrue((self.live / 'bin/added.mjs').is_file())
        self.assertFalse((self.live / 'bin/removed.mjs').exists())
        self.assertEqual((self.live / 'unrelated/keep.txt').read_text(), 'other agent work\n')
        self.assertTrue(all((self.live / name).is_file() for name in PLUGIN_NAMES))
        self.assertFalse(any((self.core / name).exists() for name in CORE_NAMES))
        remove = [call for call in self.calls if call[0] == 'git' and call[3] == 'rm'][0]
        add = [call for call in self.calls if call[0] == 'git' and call[3] == 'add'][0]
        self.assertEqual(remove[remove.index('--')+1:], CORE_NAMES); self.assertIn('--cached',remove); self.assertEqual(add[5:], PLUGIN_NAMES)
        install = [call for call in self.calls if 'plugin' in call]
        self.assertEqual(len(install), 2)  # the pilot and the preset, never a standalone Goal bundle
        web = [call for call in install if 'web' in call][0]
        self.assertEqual(web[web.index('add') + 1:-1],
                         [f'file:{self.report}/releases/pilot.tgz', f'file:{self.report}/releases/preset.tgz'])
        self.assertEqual(web[-1], '--ignore-scripts')
        manifest = json.loads((self.home / 'profiles/web/package.json').read_text())
        self.assertEqual(manifest['dependencies'][self.module.PILOT], f'file:{self.report}/releases/pilot.tgz')
        self.assertEqual(manifest['dsh']['profile']['bundles'], ['web'])
        self.assertEqual(json.loads((self.home / 'profiles/headless/package.json').read_text())['dependencies'], {})

    def test_unrelated_live_change_blocks_before_any_command_runs(self):
        write(self.live / 'bin/changed.mjs', 'another agent\n')
        before = snapshot(self.root)
        with self.assertRaises(self.module.AdoptionError) as raised:
            self.module.adopt(True)
        self.assertIn('does not apply cleanly', str(raised.exception))
        self.assertEqual(snapshot(self.root), before); self.assertEqual(self.calls, [])

    def test_document_move_with_real_git_preserves_unrelated_staged_work(self):
        def actual_git(directory, *args):
            self.assertIn(directory, [self.core, self.live])
            return subprocess.run(['git', '-C', str(directory), *args], check=True, text=True, capture_output=True)
        for directory in [self.core, self.live]:
            actual_git(directory, 'init', '-q', '-b', 'fixture')
            actual_git(directory, 'config', 'user.name', 'Fixture')
            actual_git(directory, 'config', 'user.email', 'fixture@example.invalid')
            actual_git(directory, 'config', 'commit.gpgsign', 'false')
            actual_git(directory, 'commit', '--allow-empty', '-qm', 'base')
        actual_git(self.core, 'add', '--', *CORE_NAMES)
        actual_git(self.live, 'add', '--', 'unrelated/keep.txt')
        for name in SIX:
            write(self.live / STAGED / name, (self.core / self.module.CORE_STAGED / name).read_text())
        def fixture_command(argv, **options):
            self.assertEqual(argv[0], 'git')
            return actual_git(Path(argv[2]), *[str(part) for part in argv[3:]])
        with mock.patch.object(self.module, 'run', side_effect=fixture_command):
            self.module.move_documents(CORE_NAMES)
        self.assertEqual(actual_git(self.core, 'diff', '--cached', '--name-only').stdout.strip(), '')
        staged = set(actual_git(self.live, 'diff', '--cached', '--name-only').stdout.splitlines())
        self.assertEqual(staged, set(PLUGIN_NAMES) | {'unrelated/keep.txt'})
        self.assertFalse(any((self.core / name).exists() for name in CORE_NAMES))

    # --- rollback -----------------------------------------------------------------------
    def test_rollback_restores_the_full_generated_tree_across_a_symlink_directory_swap(self):
        rows = self.module.scope_rows(self.inputs['scope']); plan = self.module.profile_plan(self.inputs['releases'])
        self.assertEqual([entry['profile'] for entry in plan], ['ai-reference-store-daily', 'web'])
        profile = self.home / 'profiles/web'; modules = profile / 'node_modules'
        (modules / '@local').mkdir(parents=True, exist_ok=True)
        (modules / '@local/dsh-request-acceptance-pilot').symlink_to('/nonexistent/store/pilot')
        write(modules / 'linked/index.js', 'real directory\n')
        original, untouched = snapshot(profile), snapshot(self.home / 'profiles/headless')
        directory = self.module.backup(rows, plan)
        shutil.rmtree(modules)
        (modules / '@local/dsh-request-acceptance-pilot').mkdir(parents=True)
        (modules / 'linked').symlink_to('/nonexistent/store/other')
        (profile / 'cordis.patch.yml').write_text('user edit during adoption\n')
        state = {'status': 'running'}
        self.assertTrue(self.module.rollback(self.inputs, {'profiles': plan}, directory, self.receipt, state))
        restored = snapshot(profile)
        self.assertEqual({name: entry for name, entry in restored.items() if 'cordis' not in name},
                         {name: entry for name, entry in original.items() if 'cordis' not in name})
        self.assertEqual((profile / 'cordis.patch.yml').read_text(), 'user edit during adoption\n')
        self.assertEqual(snapshot(self.home / 'profiles/headless'), untouched)
        self.assertTrue(state['rollback'].endswith('checked'))
        self.assertTrue((self.report / 'adoption-receipt.json').is_file())
        self.assertIn('adoption-backup', str(directory))
        # the restored runtime is the snapshot itself: no package manager or build ran again
        self.assertFalse([call for call in self.calls if call[0] == str(self.module.PNPM)])
        self.assertEqual((self.core / 'README.md').read_text(), 'core\n')
        self.assertTrue((directory / 'core-failed').is_dir())

    # --- purity and shadowing -----------------------------------------------------------
    def test_import_runs_no_command_and_the_source_starts_no_detached_scope(self):
        with mock.patch('subprocess.run', side_effect=AssertionError('import touched the machine')):
            self.assertTrue(callable(load_module().main))
        source = SOURCE.read_text()
        self.assertNotIn('systemd-run', source); self.assertNotIn('--scope', source)
        self.assertIn("'--ff-only'", source); self.assertIn("'add'", source)

    def test_no_function_shadows_the_injected_runner_or_a_module_constant(self):
        tree = ast.parse(SOURCE.read_text())
        module_names = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        module_names |= {target.id for node in tree.body if isinstance(node, ast.Assign)
                         for target in node.targets if isinstance(target, ast.Name)}
        for function in [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]:
            local = {argument.arg for argument in function.args.args + function.args.kwonlyargs}
            for node in ast.walk(function):
                if isinstance(node, ast.Assign):
                    local |= {target.id for target in node.targets if isinstance(target, ast.Name)}
                elif isinstance(node, (ast.AnnAssign, ast.AugAssign)) and isinstance(node.target, ast.Name):
                    local.add(node.target.id)
            self.assertFalse(local & (module_names - {function.name}), f'{function.name} shadows a module name')


if __name__ == '__main__':
    unittest.main()
