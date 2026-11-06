import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate  # noqa: E402

BIN = Path(__file__).resolve().parent
LAYOUT_LINKS = BIN / 'check-layout-links.py'
GATE_SCRIPT = BIN / 'gate.py'
COMMIT_CONFIG = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false']


def clean_git_env():
    return {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}


def git(*args, cwd):
    return subprocess.run(['git', *COMMIT_CONFIG, *args], cwd=cwd, check=True,
                          env=clean_git_env(), capture_output=True, text=True).stdout


def commit(directory, message):
    git('add', '-A', cwd=directory)
    git('commit', '-m', message, cwd=directory)


def dump(checks):
    return json.dumps(checks, indent=2) + '\n'


def env_without(*names):
    return {name: value for name, value in os.environ.items() if name not in names}


def make_repo(base, checks_text, files=None):
    repo = Path(base)
    (repo / 'bin').mkdir()
    shutil.copyfile(LAYOUT_LINKS, repo / 'bin' / 'check-layout-links.py')
    if checks_text is not None:
        (repo / 'bin' / 'gate-checks.json').write_text(checks_text)
    for name, content in (files or {}).items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    git('init', '-b', 'main', cwd=repo)
    commit(repo, 'init')
    return repo


def run_gate(root, base='main'):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = gate.main(['--base', base], root=root)
    return code, out.getvalue(), err.getvalue()


def last_line(output):
    return output.strip().splitlines()[-1]


class PackageTest(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict(os.environ, clean_git_env(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_package_of(self):
        cases = {
            'plugins/dsh-web-ui/packages/modlens/src/a.ts': 'plugins/dsh-web-ui/packages/modlens',
            'plugins/dsh-slack-intake/x.mjs': 'plugins/dsh-slack-intake',
            'plugins/README.md': None,
            'plugins/x.json': 'plugins',
            'skills/a/b/c.py': 'skills/a',
            'bin/gate.py': 'bin',
            'package.json': '.',
            '.github/x.yml': '.github',
            'plugins/dsh-web-ui/packages/index.json': 'plugins/dsh-web-ui',
            'plugins/dsh-web-ui/packages/modlens/README.md': None,
            'presets/p/x.yml': 'presets/p',
            'configs/c/x.json': 'configs/c',
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(gate.package_of(path), expected)


class GateTest(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict(os.environ, clean_git_env(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_git_helpers_ignore_the_callers_git_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'repo'
            repo.mkdir()
            trap = Path(tmp) / 'trap'
            trap.mkdir()
            with mock.patch.dict(os.environ, {'GIT_INDEX_FILE': str(trap / 'index'),
                                              'GIT_DIR': str(trap / 'nothing')}):
                make_repo(repo, dump({'p': [{'cwd': '.', 'run': 'true'}]}))
                (repo / 'p').mkdir()
                (repo / 'p' / 'x.txt').write_text('x\n')
                with mock.patch.dict(os.environ, clean_git_env(), clear=True):
                    code, out, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertEqual(list(trap.iterdir()), [])

    def test_gate_passes_when_every_changed_package_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'true'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x\n')
            code, out, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertEqual(last_line(out), 'gate: PASS (3 checks)')

    def test_gate_fails_for_a_changed_package_without_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({}))
            (repo / 'q').mkdir()
            (repo / 'q' / 'x.txt').write_text('x\n')
            code, out, _ = run_gate(repo)
            self.assertEqual(code, 1)
            self.assertIn('gate: q: no checks defined', out)
            self.assertTrue(last_line(out).startswith('gate: FAIL:'))
            self.assertIn('q', last_line(out))

    def test_gate_fails_when_a_check_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'exit 3'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x\n')
            code, out, _ = run_gate(repo)
            self.assertEqual(code, 1)
            self.assertIn('FAIL (exit 3)', out)

    def test_gate_runs_every_check_after_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'a': [{'cwd': '.', 'run': 'exit 3'}],
                                        'b': [{'cwd': '.', 'run': 'touch marker'}]}))
            for name in ('a', 'b'):
                (repo / name).mkdir()
                (repo / name / 'x.txt').write_text('x\n')
            code, _, _ = run_gate(repo)
            self.assertEqual(code, 1)
            self.assertTrue((repo / 'marker').exists())

    def test_gate_counts_an_untracked_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'touch marker'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'new.txt').write_text('x\n')
            code, _, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertTrue((repo / 'marker').exists())

    def test_gate_markdown_only_change_runs_only_document_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'plugins/p': [{'cwd': 'plugins/p', 'run': 'touch marker'}]}))
            (repo / 'plugins' / 'p').mkdir(parents=True)
            (repo / 'plugins' / 'p' / 'README.md').write_text('# p\n')
            code, _, _ = run_gate(repo)
            self.assertFalse((repo / 'plugins' / 'p' / 'marker').exists())
            self.assertEqual(code, 0)

    def test_gate_fails_on_trailing_whitespace_in_an_untracked_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'true'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x \n')
            code, out, _ = run_gate(repo)
            self.assertEqual(code, 1)
            self.assertIn('docs: git diff --check', last_line(out))

    def test_gate_does_not_change_the_real_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'true'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'new.txt').write_text('x\n')
            status_before = git('status', '--porcelain', cwd=repo)
            index = repo / '.git' / 'index'
            before = index.read_bytes()
            code, _, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertEqual(index.read_bytes(), before)
            self.assertEqual(git('status', '--porcelain', cwd=repo), status_before)

    def test_gate_runs_with_a_read_only_object_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'true'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'new.txt').write_text('x\n')
            objects = repo / '.git' / 'objects'
            paths = [objects, *objects.rglob('*')]
            try:
                for path in paths:
                    os.chmod(path, 0o555 if path.is_dir() else 0o444)
                code, out, _ = run_gate(repo)
            finally:
                for path in paths:
                    os.chmod(path, 0o755 if path.is_dir() else 0o644)
            self.assertEqual(code, 0)
            self.assertIn('gate: p: ok', out)

    def test_gate_keeps_a_carriage_return_in_a_file_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'touch marker'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'a\rb.txt').write_text('x\n')
            code, _, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertTrue((repo / 'marker').exists())

    def test_gate_env_does_not_override_the_caller(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'printf %s "$X" > marker',
                                              'env': {'X': 'from-file'}}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x\n')
            environment = env_without('GIT_INDEX_FILE')
            environment['X'] = 'caller'
            with mock.patch.dict(os.environ, environment, clear=True):
                code, _, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertEqual((repo / 'marker').read_text(), 'caller')

    def test_gate_rejects_an_invalid_checks_file(self):
        cases = {
            'missing': None,
            'invalid JSON': '{',
            'empty list': dump({'p': []}),
            'unknown key': dump({'p': [{'cwd': '.', 'run': 'touch marker', 'extra': 'x'}]}),
            'missing cwd': dump({'p': [{'run': 'touch marker'}]}),
            'missing run': dump({'p': [{'cwd': '.'}]}),
            'cwd that does not exist': dump({'p': [{'cwd': 'nope', 'run': 'touch marker'}]}),
            'cwd with a NUL': dump({'p': [{'cwd': 'bin\u0000x', 'run': 'touch marker'}]}),
            'cwd of ..': dump({'p': [{'cwd': '..', 'run': 'touch marker'}]}),
            'env that is a list': dump({'p': [{'cwd': '.', 'run': 'touch marker', 'env': []}]}),
            'env value that is a number': dump({'p': [{'cwd': '.', 'run': 'touch marker', 'env': {'A': 1}}]}),
            'whitespace-only run': dump({'p': [{'cwd': '.', 'run': '   '}]}),
            'absolute cwd': dump({'p': [{'cwd': '/tmp', 'run': 'touch marker'}]}),
            'package value that is an object': dump({'p': {'cwd': '.', 'run': 'touch marker'}}),
            'check that is a string': dump({'p': ['touch marker']}),
        }
        for name, text in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                repo = make_repo(tmp, text)
                code, _, err = run_gate(repo)
                self.assertEqual(code, 2)
                self.assertIn('gate: invalid bin/gate-checks.json', err)
                self.assertFalse((repo / 'marker').exists())

    def test_gate_runs_the_rest_of_a_package_after_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'exit 3'},
                                              {'cwd': '.', 'run': 'touch marker'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x\n')
            code, _, _ = run_gate(repo)
            self.assertTrue((repo / 'marker').exists())
            self.assertEqual(code, 1)

    def test_package_checks_do_not_get_the_index_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.',
                                              'run': 'printf %s "${GIT_INDEX_FILE:-unset}" > marker'}]}))
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x\n')
            with mock.patch.dict(os.environ, env_without('GIT_INDEX_FILE', 'X'), clear=True):
                code, _, _ = run_gate(repo)
            self.assertEqual(code, 0)
            self.assertEqual((repo / 'marker').read_text(), 'unset')

    def test_gate_skips_a_deleted_package_without_an_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({}), {'plugins/gone/x.txt': 'x\n'})
            shutil.rmtree(repo / 'plugins' / 'gone')
            code, out, _ = run_gate(repo)
            self.assertIn('gate: plugins/gone: deleted', out)
            self.assertEqual(code, 0)

    def test_script_exit_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({'p': [{'cwd': '.', 'run': 'exit 3'}]}),
                             {'bin/gate.py': GATE_SCRIPT.read_text()})
            (repo / 'p').mkdir()
            (repo / 'p' / 'x.txt').write_text('x\n')
            result = subprocess.run(['python3', 'bin/gate.py', '--base', 'main'],
                                    cwd=repo, env=clean_git_env(),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            (repo / 'bin' / 'gate-checks.json').write_text('{')
            result = subprocess.run(['python3', 'bin/gate.py', '--base', 'main'],
                                    cwd=repo, env=clean_git_env(),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)

    def test_gate_without_a_merge_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp, dump({}))
            code, _, _ = run_gate(repo, 'no-such-ref')
            self.assertEqual(code, 2)


class RepositoryChecksTest(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict(os.environ, clean_git_env(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_repository_checks_file_is_valid(self):
        checks = gate.load_checks(gate.ROOT)
        self.assertEqual(sorted(checks), sorted([
            'bin',
            'plugins/dsh-codex-transport-recovery',
            'plugins/dsh-open-in-app-icons',
            'plugins/dsh-prompt-compact',
            'plugins/dsh-slack-intake',
            'plugins/dsh-workspace-attach',
            'plugins/llm-fallback',
            'skills/orchestrate-agents',
            'skills/slack-reference-intake',
        ]))
        self.assertEqual(checks['bin'], [
            {'cwd': '.', 'run': 'python3 bin/test-runtime-placement.py'},
            {'cwd': '.', 'run': "python3 -m unittest discover -s bin -p 'test_*.py'"},
        ])
        rows = {
            'plugins/dsh-codex-transport-recovery': ('node --test tests/*.test.mjs', None),
            'plugins/dsh-open-in-app-icons': ('python3 bin/test.py', None),
            'plugins/dsh-prompt-compact': ('node --test tests/*.test.mjs',
                                           {'DSH_UPSTREAM_ROOT': '/data/softwares/deepseek-harness'}),
            'plugins/dsh-slack-intake': ('node --import ./tests/host-imports.mjs --test tests/*.test.mjs',
                                         {'DSH_HOST_ROOT': '/data/softwares/deepseek-harness'}),
            'plugins/dsh-workspace-attach': ('node --test tests/*.test.mjs', None),
            'plugins/llm-fallback': ('node --test test.mjs mount.test.mjs',
                                     {'DSH_UPSTREAM_ROOT': '/data/softwares/deepseek-harness'}),
            'skills/orchestrate-agents': ('node --test tests/*.test.mjs', None),
            'skills/slack-reference-intake': ('python3 -m unittest discover -s tests', None),
        }
        for key, (run, env) in rows.items():
            expected = {'cwd': key, 'run': run}
            if env is not None:
                expected['env'] = env
            with self.subTest(key=key):
                self.assertEqual(checks[key], [expected])


if __name__ == '__main__':
    unittest.main()
