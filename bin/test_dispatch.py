import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dispatch  # noqa: E402

REAL_RUNTIME_REV = dispatch.runtime_rev

CARD_T1 = '''## T1. Card dispatcher

Issue: #1.

Tier: R0

Needs: nothing.

Spec: `AGENTS.md`.

Files: `bin/a.py`, `bin/test_a.py`.

Implement card T1.

Done: `python3 bin/gate.py` exits 0.
'''

COMMIT_CONFIG = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
                 '-c', 'commit.gpgsign=false']


def clean_git_env():
    return {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}


def git(*args, cwd):
    return subprocess.run(['git', *args], cwd=cwd, check=True, env=clean_git_env(),
                          capture_output=True, text=True).stdout


def commit(directory, message):
    git('add', '-A', cwd=directory)
    git(*COMMIT_CONFIG, 'commit', '-m', message, cwd=directory)


def card_text(card_id, title, files='`bin/a.py`', done=False, tier='R0'):
    tier_line = '' if tier is None else f'Tier: {tier}\n\n'
    text = f'## {card_id}. {title}\n\nIssue: #1.\n\n{tier_line}Files: {files}.\n\nBody.\n'
    return text + ('\nStatus: done\n' if done else '')


def make_repo(base):
    repo = base / 'repo'
    repo.mkdir()
    (repo / '.gitignore').write_text('/reports/\n/ignored.txt\n')
    (repo / 'AGENTS.md').write_text('# Rules for card implementers\n')
    (repo / 'tasks').mkdir()
    (repo / 'tasks' / 'README.md').write_text('# Cards\n')
    git('init', '-b', 'main', cwd=repo)
    commit(repo, 'init')
    git('switch', '--create', 'issue/1-x', cwd=repo)
    (repo / 'tasks' / 'T1.md').write_text(CARD_T1)
    commit(repo, 'card T1')
    return repo


def fake_worker(directory, record, stdout_lines=('answer', 'TOTAL 0'),
                stderr_lines=('reasoning',), code=0, touch=(), name='worker.sh'):
    path = directory / name
    lines = ['#!/bin/sh',
             f'printf "%s\\n" "$@" >> {shlex.quote(str(record / "argv.txt"))}',
             f'printf "run\\n" >> {shlex.quote(str(record / "runs.txt"))}',
             f'n=$(wc -l < {shlex.quote(str(record / "runs.txt"))} | tr -d " ")',
             f'cat > {shlex.quote(str(record))}/stdin-$n.txt',
             f'cat {shlex.quote(str(record))}/stdin-$n.txt '
             f'>> {shlex.quote(str(record / "stdin.txt"))}']
    for line in stderr_lines:
        lines.append(f'printf "%s\\n" {shlex.quote(line)} >&2')
    for line in stdout_lines:
        lines.append(f'printf "%s\\n" {shlex.quote(line)}')
    for item in touch:
        lines.append(f'mkdir -p {shlex.quote(str(Path(item).parent))}')
        lines.append(f'printf "x\\n" > {shlex.quote(str(item))}')
    lines.append(f'exit {code}')
    path.write_text('\n'.join(lines) + '\n')
    path.chmod(0o755)
    return path


def fake_accept(directory):
    path = directory / 'kstack-accept'
    path.write_text("#!/bin/sh\n"
                    "if [ -n \"$(git -C \"$2\" status --porcelain)\" ]; then\n"
                    "  prefix=dirty-\n"
                    "else\n"
                    "  prefix=\n"
                    "fi\n"
                    "printf '%s%s\\n' \"$prefix\" \"$(git -C \"$2\" rev-parse 'HEAD^{tree}')\"\n")
    path.chmod(0o755)
    return path


class DispatchTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, clean_git_env(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop('KSTACK_ACCEPT', None)
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name).resolve()
        self.root = make_repo(self.base)
        self.record = self.base / 'record'
        self.record.mkdir()
        self.worktree = self.root / 'reports/worktrees/T1'
        self.scope = self.root / 'reports/agents/evidence/T1/scope.json'
        self.evidence = self.root / 'reports/agents/evidence/T1'
        accept = mock.patch.object(dispatch, 'ACCEPT', fake_accept(self.base))
        accept.start()
        self.addCleanup(accept.stop)
        revision = mock.patch.object(dispatch, 'runtime_rev', lambda: 'unknown')
        revision.start()
        self.addCleanup(revision.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def worker(self, **kwargs):
        return fake_worker(self.base, self.record, **kwargs)

    def invoke(self, *argv, worker=None, root=None):
        worker = worker or self.worker()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = dispatch.main(list(argv), root=root or self.root, worker=worker)
        return code, out.getvalue(), err.getvalue()

    def recorded(self, name):
        path = self.record / name
        return path.read_text().splitlines() if path.exists() else []

    def runs(self):
        return len(self.recorded('runs.txt'))

    def record_text(self, name):
        return (self.record / name).read_text()

    def add_gate(self, body):
        (self.worktree / 'bin').mkdir(parents=True, exist_ok=True)
        (self.worktree / 'bin/gate.py').write_text(body)
        commit(self.worktree, 'add the gate')

    def state(self):
        return git('rev-parse', 'HEAD^{tree}', cwd=self.worktree).strip()

    def dispose(self, *rows):
        self.evidence.mkdir(parents=True, exist_ok=True)
        lines = ['id\tdisposition\tdetail', *(f'{row[0]}\t{row[1]}\t{row[2]}' for row in rows)]
        (self.evidence / 'findings.tsv').write_text('\n'.join(lines) + '\n')

    def commit_change(self, name, text='x\n'):
        (self.worktree / name).write_text(text)
        commit(self.worktree, f'change {name}')

    def load(self, name):
        return json.loads((self.evidence / name).read_text())

    def set_lineage(self, n, value):
        record = self.load(f'review-{n}.json')
        record['lineage'] = value
        (self.evidence / f'review-{n}.json').write_text(json.dumps(record, indent=2) + '\n')

    def revert(self):
        git(*COMMIT_CONFIG, 'revert', '--no-edit', 'HEAD', cwd=self.worktree)

    def fake_check(self, exit, lines, commit=None, stderr='', killed=False):
        path = self.base / 'kstack-accept-check'
        script = ['#!/bin/sh',
                  'if [ "$1" = "state" ]; then',
                  "  if [ -n \"$(git -C \"$2\" status --porcelain)\" ]; then",
                  '    prefix=dirty-',
                  '  else',
                  '    prefix=',
                  '  fi',
                  "  printf '%s%s\\n' \"$prefix\" \"$(git -C \"$2\" rev-parse 'HEAD^{tree}')\"",
                  '  exit 0',
                  'fi',
                  f'printf "check\\n" >> {shlex.quote(str(self.record / "checks.txt"))}']
        for line in lines:
            script.append(f'printf "%s\\n" {shlex.quote(line)}')
        if stderr:
            script.append(f'printf "%s\\n" {shlex.quote(stderr)} >&2')
        if commit is not None:
            payload = json.dumps({'schema': 'kstack-accept/result/1',
                                  'commits': {'deepseek-harness-plugins': commit}})
            script.append('mkdir -p "$2/evidence/$3"')
            script.append(f'printf "%s\\n" {shlex.quote(payload)} > "$2/evidence/$3/accept.json"')
        script.append('kill -9 $$' if killed else f'exit {exit}')
        path.write_text('\n'.join(script) + '\n')
        path.chmod(0o755)
        patcher = mock.patch.object(dispatch, 'ACCEPT', path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def rows(self):
        path = self.root / 'reports/agents/accept-shadow.tsv'
        if not path.exists():
            return []
        return [line.split('\t') for line in path.read_text().splitlines()]

    def ready_card(self):
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 0)
        (self.worktree / 'bin').mkdir(exist_ok=True)
        (self.worktree / 'bin/a.py').write_text('x\n')
        commit(self.worktree, 'implement T1')
        return git('rev-parse', 'card/T1', cwd=self.root).strip()

    def copies(self):
        return sorted(path.name for path in self.evidence.glob('accept-*.json'))

    def commit_card(self, text):
        (self.root / 'tasks/T1.md').write_text(text)
        commit(self.root, 'card T1')

    def test_parse_card(self):
        path = self.root / 'tasks/T3.md'
        path.write_text('## T3. Third\n\nIssue: #12.\n\nFiles: `a.py`, `b/c.py`.\n\nStatus: done\n')
        card = dispatch.parse_card(path)
        self.assertEqual(card.id, 'T3')
        self.assertEqual(card.title, 'Third')
        self.assertEqual(card.issue, 12)
        self.assertEqual(card.files, ['a.py', 'b/c.py'])
        self.assertTrue(card.done)

    def test_card_needs_an_issue_line(self):
        path = self.root / 'tasks/T3.md'
        path.write_text('## T3. Third\n\nFiles: `a.py`.\n')
        with self.assertRaises(dispatch.DispatchError) as caught:
            dispatch.parse_card(path)
        self.assertIn('no "Issue: #<N>" line', str(caught.exception))

    def test_card_heading_must_match_the_file(self):
        path = self.root / 'tasks/T4.md'
        path.write_text('## T5. x\n\nIssue: #1.\n\nFiles: `a.py`.\n')
        with self.assertRaises(dispatch.DispatchError) as caught:
            dispatch.parse_card(path)
        self.assertIn('the first line must be "## T4. <title>"', str(caught.exception))

    def test_all_cards_skip_the_readme_and_sort_by_number(self):
        other = self.base / 'sorting'
        (other / 'tasks').mkdir(parents=True)
        (other / 'tasks/README.md').write_text('# Cards\n')
        (other / 'tasks/T10.md').write_text(card_text('T10', 'Ten'))
        (other / 'tasks/T2.md').write_text(card_text('T2', 'Two'))
        self.assertEqual([card.id for card in dispatch.all_cards(other)], ['T2', 'T10'])

    def test_main_checkout_from_a_worktree(self):
        second = self.base / 'second'
        git('worktree', 'add', '-b', 'side', str(second), cwd=self.root)
        self.assertEqual(dispatch.main_checkout(second), self.root)

    def test_git_helpers_ignore_the_callers_git_environment(self):
        fresh = self.base / 'fresh'
        trap = self.base / 'trap'
        fresh.mkdir()
        trap.mkdir()
        with mock.patch.dict(os.environ, {'GIT_INDEX_FILE': str(trap / 'index'),
                                          'GIT_DIR': str(trap / 'nothing')}):
            root = make_repo(fresh)
            with mock.patch.dict(os.environ, clean_git_env(), clear=True):
                code, out, err = self.invoke('card', 'T1', '--no-worker', root=root)
        self.assertEqual(code, 0)
        self.assertEqual(list(trap.iterdir()), [])
        worktree = root / 'reports/worktrees/T1'
        self.assertTrue(worktree.is_dir())
        self.assertEqual(git('symbolic-ref', '--short', 'HEAD', cwd=worktree).strip(),
                         'card/T1')

    def test_card_refuses_main(self):
        git('switch', 'main', cwd=self.root)
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('on main', err)

    def test_card_refuses_a_detached_checkout(self):
        git('checkout', '--detach', cwd=self.root)
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('not on a branch', err)

    def test_malformed_card_id_is_refused(self):
        cases = {
            'ambiguity': ('ambiguity', 'Z9'),
            'card': ('card', 't1'),
            'review': ('review', 'T1x'),
            'land': ('land', '../T1'),
        }
        for name, argv in cases.items():
            with self.subTest(name):
                code, out, err = self.invoke(*argv)
                self.assertEqual(code, 2)
                self.assertIn('not a card ID:', err)
                self.assertIn(argv[1], err)
        self.assertEqual(self.runs(), 0)
        git('switch', 'main', cwd=self.root)
        code, out, err = self.invoke('card', 'Z9')
        self.assertEqual(code, 2)
        self.assertIn('not a card ID: Z9', err)
        self.assertNotIn('on main', err)
        self.assertEqual(self.runs(), 0)
        self.assertFalse((self.root / 'reports').exists())

    def test_card_without_worker(self):
        tip = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 0)
        self.assertEqual(err, '')
        self.assertEqual(self.runs(), 0)
        self.assertTrue(self.worktree.is_dir())
        self.assertEqual(git('rev-parse', 'card/T1', cwd=self.root).strip(), tip)
        self.assertEqual(git('symbolic-ref', '--short', 'HEAD', cwd=self.worktree).strip(),
                         'card/T1')
        self.assertIn('land issue/1-x\n', out)

    def test_card_needs_a_files_line(self):
        path = self.root / 'tasks/T3.md'
        path.write_text('## T3. Third\n\nIssue: #1.\n')
        with self.assertRaises(dispatch.DispatchError) as caught:
            dispatch.parse_card(path)
        self.assertIn('no "Files:" line', str(caught.exception))

    def test_card_refuses_a_done_card(self):
        self.commit_card(card_text('T1', 'Card dispatcher', done=True))
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('card T1 is done', err)

    def test_card_refuses_an_uncommitted_card(self):
        (self.root / 'tasks/T1.md').write_text(CARD_T1 + '\nMore.\n')
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('commit the card first', err)

    def test_card_refuses_an_existing_worktree(self):
        self.worktree.mkdir(parents=True)
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('land or remove it first', err)

    def test_card_refuses_an_existing_branch(self):
        git('branch', 'card/T1', cwd=self.root)
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('branch card/T1 already exists', err)

    def test_card_cleans_up_after_a_failed_worktree_add(self):
        real = dispatch.git

        def wrapper(*args, cwd=None, allow_failure=False):
            if args[:2] == ('worktree', 'add'):
                git('branch', 'card/T1', cwd=self.root)
                self.worktree.mkdir(parents=True)
                (self.worktree / 'x').write_text('x\n')
                return subprocess.CompletedProcess(['git', *args], 128, '', 'boom\n')
            return real(*args, cwd=cwd, allow_failure=allow_failure)

        with mock.patch.object(dispatch, 'git', wrapper):
            code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 2)
        self.assertIn('git worktree add failed: boom', err)
        self.assertFalse(self.worktree.exists())
        self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')

    def test_outputs_and_worktrees_go_to_the_main_checkout(self):
        repo = self.base / 'main-repo'
        repo.mkdir()
        (repo / '.gitignore').write_text('/reports/\n/ignored.txt\n')
        (repo / 'AGENTS.md').write_text('# Rules\n')
        (repo / 'tasks').mkdir()
        (repo / 'tasks/README.md').write_text('# Cards\n')
        git('init', '-b', 'main', cwd=repo)
        commit(repo, 'init')
        (repo / 'reports/worktrees').mkdir(parents=True)
        issue = repo / 'reports/worktrees/issue-1'
        git('worktree', 'add', '-b', 'issue/1-x', str(issue), cwd=repo)
        (issue / 'tasks/T1.md').write_text(CARD_T1)
        commit(issue, 'card T1')
        code, out, err = self.invoke('card', 'T1', worker=self.worker(), root=issue)
        self.assertEqual(code, 0)
        self.assertTrue((repo / 'reports/worktrees/T1').is_dir())
        self.assertEqual(len(list((repo / 'reports/agents').glob('*.md'))), 1)
        self.assertFalse((issue / 'reports').exists())
        scope = repo / 'reports/agents/evidence/T1/scope.json'
        self.assertTrue(scope.is_file())
        record = json.loads(scope.read_text())
        self.assertEqual(record['card_file'], str(issue / 'tasks/T1.md'))
        self.assertEqual(record['repos'][0]['path'], str(repo / 'reports/worktrees/T1'))

    def test_card_writes_scope_json(self):
        self.commit_card(card_text('T1', 'Card dispatcher', tier='R1'))
        base = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
        code, out, err = self.invoke('card', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(self.runs(), 1)
        record = json.loads(self.scope.read_text())
        self.assertEqual(record, {
            'schema': 'kstack-accept/scope/1',
            'card': 'T1',
            'card_file': str(self.root / 'tasks/T1.md'),
            'tier': 'R1',
            'implementer_lineage': 'deepseek',
            'repos': [{'name': 'deepseek-harness-plugins', 'path': str(self.worktree),
                       'base': base}],
            'gate_repos': [],
            'degraded': False,
            'degraded_reason': '',
        })
        self.assertEqual(list(record), ['schema', 'card', 'card_file', 'tier',
                                        'implementer_lineage', 'repos', 'gate_repos',
                                        'degraded', 'degraded_reason'])
        self.assertTrue(self.scope.read_text().endswith('\n'))
        self.assertIn(f'scope {self.scope}\n', out)

    def test_card_scope_base_is_the_merge_base(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'a.txt').write_text('a\n')
        commit(self.worktree, 'card change')
        (self.root / 'b.txt').write_text('b\n')
        commit(self.root, 'issue change')
        card = dispatch.find_card(self.root, 'T1')
        record = dispatch.scope_record(self.root, card, self.worktree, 'issue/1-x',
                                       'R0', 'deepseek')
        base = record['repos'][0]['base']
        self.assertEqual(base,
                         git('merge-base', 'card/T1', 'issue/1-x', cwd=self.root).strip())
        self.assertNotEqual(base, git('rev-parse', 'card/T1', cwd=self.root).strip())
        self.assertNotEqual(base, git('rev-parse', 'issue/1-x', cwd=self.root).strip())

    def test_card_accepts_each_declared_tier(self):
        for tier in ('R0', 'R1', 'R1s', 'R2'):
            with self.subTest(tier):
                self.commit_card(card_text('T1', 'Card dispatcher', tier=tier))
                code, out, err = self.invoke('card', 'T1', '--no-worker')
                self.assertEqual(code, 0)
                self.assertEqual(err, '')
                self.assertEqual(json.loads(self.scope.read_text())['tier'], tier)
                dispatch._discard_worktree(self.root, self.worktree, 'card/T1')

    def test_card_refuses_a_card_without_a_tier(self):
        self.commit_card(card_text('T1', 'Card dispatcher', tier=None))
        code, out, err = self.invoke('card', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('card T1: no Tier: line; declare one of R0, R1, R1s, R2', err)
        self.assertEqual(self.runs(), 0)
        self.assertFalse(self.worktree.exists())
        self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')
        self.assertFalse((self.root / 'reports/agents/evidence').exists())

    def test_card_refuses_an_unknown_tier(self):
        for tier in ('R3', 'r1', ''):
            with self.subTest(tier):
                self.commit_card(card_text('T1', 'Card dispatcher', tier=tier))
                code, out, err = self.invoke('card', 'T1')
                self.assertEqual(code, 2)
                self.assertIn(f'card T1: unknown tier "{tier}"; '
                              'declare one of R0, R1, R1s, R2', err)
                self.assertEqual(self.runs(), 0)
                self.assertFalse(self.worktree.exists())
                self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')
                self.assertFalse((self.root / 'reports/agents/evidence').exists())

    def test_card_refuses_a_model_without_lineage(self):
        with mock.patch.object(dispatch, 'WORKER_ROUTE',
                               ['dsh', 'x', 'unknown-model', 'high']):
            code, out, err = self.invoke('card', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('no implementer lineage for unknown-model', err)
        self.assertEqual(self.runs(), 0)
        self.assertFalse(self.worktree.exists())
        self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')

    def test_card_replaces_an_existing_scope_json(self):
        self.scope.parent.mkdir(parents=True, exist_ok=True)
        self.scope.write_text('{}')
        (self.scope.parent / 'review-1.json').write_text('keep\n')
        (self.scope.parent / 'scope.json.tmp').write_text('keep\n')
        code, out, err = self.invoke('card', 'T1', '--no-worker')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.scope.read_text())['schema'],
                         'kstack-accept/scope/1')
        self.assertEqual((self.scope.parent / 'review-1.json').read_text(), 'keep\n')
        self.assertEqual((self.scope.parent / 'scope.json.tmp').read_text(), 'keep\n')
        self.assertEqual(sorted(path.name for path in self.scope.parent.iterdir()),
                         ['review-1.json', 'scope.json', 'scope.json.tmp'])

    def test_card_keeps_the_old_scope_when_the_replace_fails(self):
        self.scope.parent.mkdir(parents=True, exist_ok=True)
        self.scope.write_text('{}')
        with mock.patch.object(dispatch.os, 'replace', side_effect=OSError('boom')):
            code, out, err = self.invoke('card', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('cannot write scope.json: boom', err)
        self.assertEqual(self.scope.read_text(), '{}')
        self.assertEqual([path.name for path in self.scope.parent.iterdir()], ['scope.json'])
        self.assertEqual(self.runs(), 0)
        self.assertFalse(self.worktree.exists())
        self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')

    def test_card_removes_the_worktree_when_scope_cannot_be_written(self):
        evidence = self.root / 'reports/agents/evidence'
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text('x\n')
        code, out, err = self.invoke('card', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('cannot write scope.json:', err)
        self.assertEqual(self.runs(), 0)
        self.assertFalse(self.worktree.exists())
        self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')

    def test_card_brief_names_the_gate(self):
        card = dispatch.Card(id='T1', title='t', issue=1, text='## T1. t', done=False,
                             files=['bin/a.py'])
        main = Path('/x/main')
        wt = main / 'reports/worktrees/T1'
        self.assertIn('Run `python3 bin/gate.py` ', dispatch.card_brief(main, wt, card, True))
        without = dispatch.card_brief(main, wt, card, False)
        self.assertIn('There is no `bin/gate.py` yet', without)
        self.assertIn('the Done: commands', without)

    def test_changed_worktree_is_not_a_harness_failure(self):
        worker = self.worker(stdout_lines=(), stderr_lines=(), touch=[self.worktree / 'bin/a.py'])
        code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 0)
        self.assertNotIn(dispatch.HARNESS_LINE, out)

    def test_card_with_worker(self):
        worker = self.worker(stdout_lines=('implemented',), stderr_lines=('reasoning',), touch=[self.worktree / 'bin/a.py'])
        code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 0)
        answer = sorted((self.root / 'reports/agents').glob('*.md'))[0]
        self.assertEqual(answer.read_text(), 'implemented\n')
        argv = self.recorded('argv.txt')
        self.assertEqual(argv[0], str(self.worktree))
        self.assertEqual(argv[1:], dispatch.WORKER_ROUTE)
        self.assertNotIn('--read-only', argv)

    def test_card_reports_changes_outside_files(self):
        worker = self.worker(touch=[self.worktree / 'bin/else.py'])
        code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 0)
        self.assertIn('changes outside Files:\n  bin/else.py\n', out)

    def test_off_list_reports_both_sides_of_a_rename(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'old.txt').write_text('x\n')
        commit(self.worktree, 'add old')
        git('mv', 'old.txt', 'new.txt', cwd=self.worktree)
        card = dispatch.find_card(self.root, 'T1')
        self.assertEqual(sorted(dispatch.off_list(self.worktree, card)), ['new.txt', 'old.txt'])

    def test_off_list_reports_only_the_unlisted_side(self):
        self.commit_card(card_text('T1', 'Card dispatcher', files='`old.txt`'))
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'old.txt').write_text('x\n')
        commit(self.worktree, 'add old')
        git('mv', 'old.txt', 'new.txt', cwd=self.worktree)
        card = dispatch.find_card(self.root, 'T1')
        self.assertEqual(dispatch.off_list(self.worktree, card), ['new.txt'])

    def test_off_list_reports_a_non_ascii_path(self):
        self.invoke('card', 'T1', '--no-worker')
        git('config', 'core.quotepath', 'true', cwd=self.worktree)
        (self.worktree / 'ä.txt').write_text('note\n')
        card = dispatch.find_card(self.root, 'T1')
        self.assertEqual(dispatch.off_list(self.worktree, card), ['ä.txt'])

    def test_ambiguity_reviews_the_cards_that_are_not_done(self):
        self.commit_card(card_text('T1', 'Card dispatcher', done=True))
        (self.root / 'tasks/T2.md').write_text(card_text('T2', 'Second'))
        commit(self.root, 'card T2')
        worker = self.worker(stdout_lines=('T2 | 1 | a | b | c', 'TOTAL 1'))
        code, out, err = self.invoke('ambiguity', worker=worker)
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertIn('- T2: Second', brief)
        self.assertNotIn('T1', brief)
        argv = self.recorded('argv.txt')
        self.assertEqual(argv[0], '--read-only')
        self.assertEqual(argv[1], str(self.root))
        self.assertIn('exit 0\nT2: kind1=1 kind2=0 kind3=0 kind4=0 kind5=0 blocking=0', out)

    def test_ambiguity_with_ids_reviews_a_done_card(self):
        self.commit_card(card_text('T1', 'Card dispatcher', done=True))
        code, out, err = self.invoke('ambiguity', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('- T1: Card dispatcher', self.record_text('stdin.txt'))

    def test_summarize_ambiguity(self):
        text = '\n'.join(['T1 | 2 | a | b | c', '- T1 | 1 | a | b | c', 'T2 | 3 | a | b | c',
                          'prose', 'TOTAL 3'])
        expected = ['T1: kind1=1 kind2=1 kind3=0 kind4=0 kind5=0 blocking=1',
                    'T2: kind1=0 kind2=0 kind3=1 kind4=0 kind5=0 blocking=0']
        self.assertEqual(dispatch.summarize_ambiguity(text, ['T1', 'T2']), expected)
        self.assertEqual(dispatch.summarize_ambiguity('T1 | 2 | a | b | c', ['T1']),
                         ['summary: no TOTAL line; read the answer'])
        self.assertEqual(dispatch.summarize_ambiguity(text, ['T2', 'T1']), expected)

    def test_summarize_ambiguity_reads_backticked_lines(self):
        text = '`T1 | 2 | a | b | c`\n`TOTAL 1`'
        self.assertEqual(dispatch.summarize_ambiguity(text, ['T1']),
                         ['T1: kind1=0 kind2=1 kind3=0 kind4=0 kind5=0 blocking=1'])

    def test_ambiguity_without_cards(self):
        self.commit_card(card_text('T1', 'Card dispatcher', done=True))
        code, out, err = self.invoke('ambiguity')
        self.assertEqual(code, 2)
        self.assertIn('no cards to review', err)

    def test_review_runs_the_gate_and_shows_the_diff(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate("print('gate-' + 'said')\n")
        (self.worktree / 'tasks/T1.md').write_text(CARD_T1 + '\nUncommitted body change.\n')
        commit(self.worktree, 'body change')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertIn("+print('gate-' + 'said')", brief)
        self.assertIn('+Uncommitted body change.', brief)
        self.assertIn('exited 0', brief)
        self.assertIn('gate-said', brief)
        self.assertIn('gate exit 0', out)
        argv = self.recorded('argv.txt')
        self.assertEqual(argv[0], '--read-only')
        self.assertEqual(argv[1], str(self.worktree))
        self.assertEqual(argv[2:], dispatch.REVIEW_ROUTE)

    def test_review_with_a_passing_gate(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text("print('fi' + 'ne')\n")
        commit(self.worktree, 'add the gate')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('gate exit 0', out)
        brief = self.record_text('stdin.txt')
        self.assertIn('exited 0', brief)
        self.assertIn('fine', brief)
        self.assertNotIn('does not exist yet', brief)

    def test_review_without_a_gate(self):
        self.invoke('card', 'T1', '--no-worker')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('gate skipped: no bin/gate.py', out)
        self.assertIn('bin/gate.py does not exist yet', self.record_text('stdin.txt'))

    def test_review_refuses_a_dirty_worktree(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        (self.worktree / 'notes.txt').write_text('note\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('commit the worktree first: deepseek-harness-plugins has changes that '
                      'HEAD does not hold', err)
        self.assertEqual(self.runs(), 0)

    def test_review_ignores_commits_the_issue_branch_gained(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text('pass\n')
        commit(self.worktree, 'add the gate')
        (self.root / 'later.txt').write_text('issue-branch-only\n')
        commit(self.root, 'later')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertNotIn('issue-branch-only', brief)
        self.assertNotIn('later.txt', brief)

    def test_review_main(self):
        (self.root / 'tasks/T1.md').write_text(CARD_T1 + '\nLead change.\n')
        (self.root / 'later.txt').write_text('new file\n')
        code, out, err = self.invoke('review', 'T1', '--main', 'tasks/T1.md', 'later.txt')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertIn('+Lead change.', brief)
        self.assertIn(f'- {self.root}/later.txt', brief)
        self.assertEqual(self.recorded('argv.txt')[1], str(self.root))
        self.assertIn('-review-main-T1.md', out)

    def test_review_main_without_changes(self):
        code, out, err = self.invoke('review', 'T1', '--main', 'tasks/T1.md')
        self.assertEqual(code, 2)
        self.assertIn('no changes in the given paths', err)

    def test_gate_writes_gate_json(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate("print('ok')\n")
        code, out, err = self.invoke('gate', 'T1')
        self.assertEqual(code, 0)
        record = self.load('gate.json')
        expected = {
            'schema': 'kstack-accept/gate/1',
            'command': 'python3 bin/gate.py',
            'cwd': str(self.worktree),
            'exit': 0,
            'started_utc': record['started_utc'],
            'ended_utc': record['ended_utc'],
            'log': 'gate.log',
            'states': {'deepseek-harness-plugins': self.state()},
        }
        self.assertEqual(record, expected)
        self.assertEqual(list(record), list(expected))
        self.assertRegex(record['started_utc'], r'^[0-9]{8}T[0-9]{6}Z$')
        self.assertRegex(record['ended_utc'], r'^[0-9]{8}T[0-9]{6}Z$')
        self.assertIn('ok', (self.evidence / 'gate.log').read_text())
        self.assertIn('gate exit 0\n', out)
        self.assertIn(f'gate.json {self.evidence / "gate.json"}\n', out)

    def test_gate_returns_the_gate_exit(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('raise SystemExit(3)\n')
        code, out, err = self.invoke('gate', 'T1')
        self.assertEqual(code, 3)
        self.assertEqual(self.load('gate.json')['exit'], 3)

    def test_gate_refreshes_the_base(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        (self.root / 'later.txt').write_text('later\n')
        commit(self.root, 'later')
        git(*COMMIT_CONFIG, 'rebase', 'issue/1-x', cwd=self.worktree)
        old = self.load('scope.json')['repos'][0]['base']
        new = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
        code, out, err = self.invoke('gate', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(self.load('scope.json')['repos'][0]['base'], new)
        self.assertIn(f'base deepseek-harness-plugins {old} -> {new}\n', out)

    def test_gate_refuses_without_scope_json(self):
        self.invoke('card', 'T1', '--no-worker')
        path = self.base / 'gate-runs.txt'
        self.add_gate(f'with open({str(path)!r}, "a") as f:\n    f.write("run\\n")\nprint("fine")\n')
        (self.evidence / 'scope.json').unlink()
        code, out, err = self.invoke('gate', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('no scope.json for T1; run card first', err)
        self.assertFalse((self.evidence / 'gate.json').exists())
        self.assertFalse(path.exists())

    def test_gate_refuses_without_a_gate_script(self):
        self.invoke('card', 'T1', '--no-worker')
        code, out, err = self.invoke('gate', 'T1')
        self.assertEqual(code, 2)
        self.assertIn(f'no bin/gate.py in {self.worktree}', err)

    def test_gate_warns_on_a_dirty_worktree(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        (self.worktree / 'x.txt').write_text('x\n')
        code, out, err = self.invoke('gate', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('warning: the worktree has uncommitted changes; gate.json holds their '
                      'state, so commit exactly this tree\n', out)

    def test_review_writes_a_round_record(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        worker = self.worker()
        code, out, err = self.invoke('review', 'T1', worker=worker)
        self.assertEqual(code, 0)
        record = self.load('review-1.json')
        lines = out.splitlines()
        answer = next(line[len('answer '):] for line in lines if line.startswith('answer '))
        log = next(line[len('log '):] for line in lines if line.startswith('log '))
        expected = {
            'schema': 'kstack-accept/review/1',
            'seq': 1,
            'kind': 'round',
            'round': 1,
            'covers': None,
            'argv': [str(worker), '--read-only', str(self.worktree), *dispatch.REVIEW_ROUTE],
            'exit': 0,
            'answer': answer,
            'events': str(self.evidence / 'review-1.events.jsonl'),
            'stderr': log,
            'runtime_rev': 'unknown',
            'host': socket.gethostname(),
            'lineage': 'openai',
            'state': {'deepseek-harness-plugins': self.state()},
            'state_after': {'deepseek-harness-plugins': self.state()},
            'covers_from': None,
            'heads': {'deepseek-harness-plugins':
                      git('rev-parse', 'HEAD', cwd=self.worktree).strip()},
            'bases': {'deepseek-harness-plugins': self.load('scope.json')['repos'][0]['base']},
        }
        self.assertEqual(record, expected)
        self.assertEqual(list(record), list(expected))
        self.assertTrue((self.evidence / 'gate.json').exists())
        self.assertIn(f'review-1.json {self.evidence / "review-1.json"}\n', out)

    def test_review_reuses_a_fresh_gate(self):
        self.invoke('card', 'T1', '--no-worker')
        path = self.base / 'gate-runs.txt'
        self.add_gate(f'with open({str(path)!r}, "a") as f:\n    f.write("run\\n")\nprint("fine")\n')
        self.invoke('gate', 'T1')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(len(path.read_text().splitlines()), 1)
        self.assertIn('gate reused gate.json (exit 0)', out)
        (self.worktree / 'x.txt').write_text('x\n')
        commit(self.worktree, 'x')
        code, out, err = self.invoke('review', 'T1', '--kind', 'round', '--reason', 'test')
        self.assertEqual(code, 0)
        self.assertEqual(len(path.read_text().splitlines()), 2)
        self.assertEqual(self.load('review-2.json')['round'], 2)

    def test_review_on_the_same_state_keeps_the_round(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        code, out, err = self.invoke('review', 'T1', '--kind', 'round', '--reason', 'test')
        self.assertEqual(code, 0)
        record = self.load('review-2.json')
        self.assertEqual(record['round'], 1)
        self.assertEqual(record['kind'], 'round')

    def test_review_fixcheck_and_supplement(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        (self.worktree / 'x.txt').write_text('x\n')
        commit(self.worktree, 'x')
        self.invoke('review', 'T1', '--kind', 'fixcheck')
        self.invoke('review', 'T1', '--kind', 'supplement')
        first = self.load('review-1.json')
        fixcheck = self.load('review-2.json')
        supplement = self.load('review-3.json')
        self.assertEqual(fixcheck['kind'], 'fixcheck')
        self.assertIsNone(fixcheck['round'])
        self.assertIsNone(fixcheck['covers'])
        self.assertEqual(fixcheck['covers_from'], first['state'])
        self.assertEqual(supplement['kind'], 'supplement')
        self.assertIsNone(supplement['round'])
        self.assertEqual(supplement['covers'], 2)
        self.assertIsNone(supplement['covers_from'])

    def test_review_fixcheck_needs_an_earlier_run(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        code, out, err = self.invoke('review', 'T1', '--kind', 'fixcheck')
        self.assertEqual(code, 2)
        self.assertIn('review --kind fixcheck needs an earlier round or fixcheck', err)
        self.assertEqual(self.runs(), 0)

    def test_review_records_a_failed_run_as_optional(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        code, out, err = self.invoke('review', 'T1', worker=self.worker(code=1))
        self.assertEqual(code, 1)
        failed = self.load('review-1.json')
        self.assertEqual(failed['kind'], 'optional')
        self.assertEqual(failed['exit'], 1)
        self.assertIsNone(failed['round'])
        self.assertIn('review-1.json written as optional: the reviewer exited 1\n', out)
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        record = self.load('review-2.json')
        self.assertEqual(record['kind'], 'round')
        self.assertEqual(record['round'], 1)

    def test_review_seq_skips_leftover_files(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        (self.evidence / 'review-4.events.jsonl').write_text('')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertTrue((self.evidence / 'review-5.json').exists())
        self.assertEqual(self.load('review-5.json')['seq'], 5)
        self.assertFalse((self.evidence / 'review-1.json').exists())

    def test_review_writes_no_record_when_the_wrapper_refuses(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        worker = self.worker(stderr_lines=('run-worker.sh: RUN_WORKER_EVENTS /x already exists',),
                             code=2)
        code, out, err = self.invoke('review', 'T1', worker=worker)
        self.assertEqual(code, 2)
        self.assertEqual(list(self.evidence.glob('review-*.json')), [])
        self.assertIn('no review record: the wrapper refused the events file\n', out)

    def test_review_stops_on_a_failing_gate(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('raise SystemExit(3)\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('the gate exited 3; the review does not start', err)
        self.assertEqual(self.runs(), 0)
        self.assertEqual(list(self.evidence.glob('review-*.json')), [])

    def test_review_refuses_without_scope_json(self):
        self.invoke('card', 'T1', '--no-worker')
        path = self.base / 'gate-runs.txt'
        self.add_gate(f'with open({str(path)!r}, "a") as f:\n    f.write("run\\n")\nprint("fine")\n')
        (self.evidence / 'scope.json').unlink()
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('no scope.json for T1; run card first', err)
        self.assertEqual(self.runs(), 0)
        self.assertFalse(path.exists())

    def test_review_prints_finding_ids(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        worker = self.worker(stdout_lines=('a.py:1 | high | x | y', '```',
                                           'b.py:2 | low | fenced | z', '```',
                                           'c.py:3 | Medium | z | w', 'TOTAL 2'))
        code, out, err = self.invoke('review', 'T1', worker=worker)
        self.assertEqual(code, 0)
        self.assertIn('finding 1.1 a.py:1 | high | x | y\n', out)
        self.assertIn('finding 1.2 c.py:3 | Medium | z | w\n', out)
        for line in out.splitlines():
            self.assertNotIn('fenced', line)

    def test_review_records_heads_and_bases(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        record = self.load('review-1.json')
        self.assertEqual(record['heads'], {
            'deepseek-harness-plugins': git('rev-parse', 'HEAD', cwd=self.worktree).strip()})
        self.assertEqual(record['bases'], {
            'deepseek-harness-plugins': self.load('scope.json')['repos'][0]['base']})
        self.assertEqual(list(record)[-2:], ['heads', 'bases'])

    def test_review_derives_round_first(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('kind round (derived)', out)
        record = self.load('review-1.json')
        self.assertEqual(record['kind'], 'round')
        self.assertEqual(record['round'], 1)

    def test_review_derives_fixcheck_after_a_round(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('kind fixcheck (derived)', out)
        record = self.load('review-2.json')
        self.assertEqual(record['kind'], 'fixcheck')
        self.assertEqual(record['covers_from'], self.load('review-1.json')['state'])

    def test_review_derives_round_for_a_new_lineage(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        record = self.load('review-1.json')
        record['lineage'] = 'other'
        (self.evidence / 'review-1.json').write_text(json.dumps(record, indent=2) + '\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        record = self.load('review-2.json')
        self.assertEqual(record['kind'], 'round')
        self.assertEqual(record['round'], 1)

    def test_review_derives_round_2_after_a_real_high(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.commit_change('x.txt')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | high | bug | e', 'TOTAL 1')))
        self.dispose(('2.1', 'fixed', 'abc'))
        self.commit_change('y.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        record = self.load('review-3.json')
        self.assertEqual(record['kind'], 'round')
        self.assertEqual(record['round'], 2)

    def test_review_round_2_case_wins_over_a_further_reviewer(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.set_lineage(1, 'other')
        self.commit_change('x.txt')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | high | bug | e', 'TOTAL 1')))
        self.dispose(('2.1', 'fixed', 'abc'))
        self.revert()
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(self.load('review-2.json')['kind'], 'fixcheck')
        self.assertIn('kind round (derived)', out)
        record = self.load('review-3.json')
        self.assertEqual(record['kind'], 'round')
        self.assertEqual(record['round'], 2)

    def test_review_further_reviewer_after_round_2_keeps_round_2(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.set_lineage(1, 'other')
        self.commit_change('x.txt')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | high | bug | e', 'TOTAL 1')))
        self.dispose(('2.1', 'fixed', 'abc'))
        self.revert()
        self.invoke('review', 'T1')
        self.set_lineage(3, 'other')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        record = self.load('review-4.json')
        self.assertEqual(record['kind'], 'round')
        self.assertEqual(record['round'], 2)

    def test_review_derives_fixcheck_after_a_fixed_round_1_high(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | high | bug | e', 'TOTAL 1')))
        self.dispose(('1.1', 'fixed', 'abc'))
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('kind fixcheck (derived)', out)
        record = self.load('review-2.json')
        self.assertEqual(record['kind'], 'fixcheck')
        self.assertIsNone(record['round'])

    def test_review_derives_fixcheck_after_a_wrong_high(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.commit_change('x.txt')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | high | bug | e', 'TOTAL 1')))
        self.dispose(('2.1', 'wrong', 'not a bug'))
        self.commit_change('y.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(self.load('review-3.json')['kind'], 'fixcheck')

    def test_review_refuses_undisposed_findings(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | low | x | y', 'TOTAL 1')))
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('dispose the findings of run 1 first: findings.tsv has no row 1.1', err)
        self.assertEqual(self.runs(), 1)

    def test_review_refuses_a_row_without_a_detail(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | low | x | y', 'TOTAL 1')))
        self.dispose(('1.1', 'fixed', ''))
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('dispose the findings of run 1 first: row 1.1 needs fixed, wrong or open '
                      'and a detail', err)

    def test_review_refuses_a_kind_that_differs_without_a_reason(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1', '--kind', 'round')
        self.assertEqual(code, 2)
        self.assertIn('--kind round differs from the derived kind fixcheck; pass --reason to '
                      'override', err)

    def test_review_prints_the_reason_for_a_kind_override(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1', '--kind', 'round', '--reason', 'rerun')
        self.assertEqual(code, 0)
        self.assertIn('kind round instead of derived fixcheck: rerun', out)
        self.assertEqual(self.load('review-2.json')['kind'], 'round')

    def test_fixcheck_brief_shows_the_delta_and_the_findings(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | medium | x | y', 'TOTAL 1')))
        self.dispose(('1.1', 'fixed', 'c0ffee'))
        self.commit_change('fix.txt', 'fixed-text\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin-2.txt')
        head = self.load('review-1.json')['heads']['deepseek-harness-plugins']
        self.assertIn(f'This run is a fix check of run 1. Change since that run '
                      f'(`git diff {head} HEAD`):', brief)
        self.assertIn('- 1.1 | fixed | c0ffee | a.py:1 | medium | x | y', brief)
        delta = brief[brief.index('Change since that run'):brief.index('Findings of the covered run')]
        self.assertIn('+fixed-text', delta)
        self.assertNotIn('bin/gate.py', delta)
        self.assertNotIn('The base moved since that run', brief)

    def test_fixcheck_brief_shows_a_range_diff_after_a_rebase(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        (self.root / 'later.txt').write_text('later\n')
        commit(self.root, 'later')
        git(*COMMIT_CONFIG, 'rebase', 'issue/1-x', cwd=self.worktree)
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin-2.txt')
        self.assertIn("The base moved since that run, so here is how the card's own diff changed",
                      brief)
        self.assertIn('- none', brief)
        self.assertNotIn('Change since that run', brief)

    def test_fixcheck_brief_without_heads_warns(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        record = self.load('review-1.json')
        del record['heads']
        (self.evidence / 'review-1.json').write_text(json.dumps(record, indent=2) + '\n')
        self.commit_change('x.txt')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('warning: run 1 has no heads; the fix check shows the full diff', out)
        self.assertNotIn('This run is a fix check', self.record_text('stdin-2.txt'))

    def test_review_records_an_incomplete_answer_without_findings_as_optional(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        code, out, err = self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('STOPPED no access',)))
        self.assertEqual(code, 0)
        self.assertIn('review-1.json written as optional: the answer is incomplete and has no '
                      'finding', out)
        record = self.load('review-1.json')
        self.assertEqual(record['kind'], 'optional')
        self.assertIsNone(record['round'])

    def test_review_keeps_the_kind_of_an_incomplete_answer_with_findings(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        code, out, err = self.invoke('review', 'T1', worker=self.worker(
            stdout_lines=('a.py:1 | low | x | y',)))
        self.assertEqual(code, 0)
        self.assertIn('review-1.json keeps kind round: the answer is incomplete but has 1 finding '
                      'lines', out)
        self.assertEqual(self.load('review-1.json')['kind'], 'round')

    def test_review_refreshes_the_base_when_gate_json_is_reused(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('gate', 'T1')
        scope = self.load('scope.json')
        scope['repos'][0]['base'] = '0' * 40
        self.scope.write_text(json.dumps(scope, indent=2) + '\n')
        real = git('merge-base', 'card/T1', 'issue/1-x', cwd=self.root).strip()
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('gate reused gate.json (exit 0)', out)
        self.assertIn(f'base deepseek-harness-plugins {"0" * 40} -> {real}\n', out)
        self.assertEqual(self.load('scope.json')['repos'][0]['base'], real)

    def test_review_brief_asks_for_one_bash_call(self):
        self.invoke('card', 'T1', '--no-worker')
        self.add_gate('pass\n')
        self.invoke('review', 'T1')
        self.assertIn('Run one bash command, `pwd`, before anything else; the sandbox evidence '
                      'needs at least one bash call.', self.record_text('stdin.txt'))

    def test_review_without_a_gate_writes_a_record(self):
        self.invoke('card', 'T1', '--no-worker')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertTrue((self.evidence / 'review-1.json').exists())
        self.assertFalse((self.evidence / 'gate.json').exists())

    def test_land(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/a.py').write_text('x\n')
        commit(self.worktree, 'implement T1')
        head = git('rev-parse', 'HEAD', cwd=self.worktree).strip()
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        self.assertFalse(self.worktree.exists())
        self.assertEqual(git('branch', '--list', 'card/T1', cwd=self.root).strip(), '')
        self.assertIn('landed issue/1-x ', out)

    def test_land_refuses_main(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/a.py').write_text('x\n')
        commit(self.worktree, 'implement T1')
        card_head = git('rev-parse', 'HEAD', cwd=self.worktree).strip()
        main_tip = git('rev-parse', 'main', cwd=self.root).strip()
        git('switch', 'main', cwd=self.root)
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('on main', err)
        self.assertEqual(git('rev-parse', 'main', cwd=self.root).strip(), main_tip)
        self.assertTrue(self.worktree.is_dir())
        self.assertEqual(git('symbolic-ref', '--short', 'HEAD', cwd=self.worktree).strip(),
                         'card/T1')
        self.assertEqual(git('rev-parse', 'HEAD', cwd=self.worktree).strip(), card_head)
        self.assertEqual(git('status', '--porcelain', cwd=self.worktree).strip(), '')

    def test_land_refuses_when_the_issue_branch_moved(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/a.py').write_text('x\n')
        commit(self.worktree, 'implement T1')
        (self.root / 'later.txt').write_text('later\n')
        commit(self.root, 'later')
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('has moved since the dispatch', err)
        self.assertTrue(self.worktree.is_dir())

    def test_land_refuses_a_dirty_worktree(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'dirty.txt').write_text('x\n')
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('the worktree has uncommitted changes', err)

    def test_land_refuses_without_commits(self):
        self.invoke('card', 'T1', '--no-worker')
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('no commits to land', err)

    def test_land_refuses_a_worktree_off_its_branch(self):
        self.invoke('card', 'T1', '--no-worker')
        git('checkout', '--detach', cwd=self.worktree)
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('the worktree is not on card/T1', err)

    def test_land_does_not_overwrite_an_ignored_file(self):
        (self.root / 'ignored.txt').write_text('keep\n')
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'ignored.txt').write_text('tracked now\n')
        git('add', '-f', 'ignored.txt', cwd=self.worktree)
        commit(self.worktree, 'track the ignored path')
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertEqual((self.root / 'ignored.txt').read_text(), 'keep\n')

    def test_land_off_runs_no_check(self):
        head = self.ready_card()
        self.fake_check(0, ['ACCEPT'], head)
        code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        self.assertFalse((self.record / 'checks.txt').exists())
        self.assertEqual(self.rows(), [])

    def test_land_refuses_an_unknown_mode(self):
        self.ready_card()
        tip = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
        self.fake_check(0, ['ACCEPT'])
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'on'}):
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('KSTACK_ACCEPT must be off, shadow or enforce, not on', err)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), tip)
        self.assertFalse((self.record / 'checks.txt').exists())

    def test_land_shadow_accept_writes_a_row(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(0, [f'ACCEPT T1 deepseek-harness-plugins={head}'], head)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        self.assertIn(f'ACCEPT T1 deepseek-harness-plugins={head}\n', out)
        rows = self.rows()
        self.assertEqual(rows[0], dispatch.SHADOW_HEADER.split('\t'))
        utc = rows[1][0]
        self.assertRegex(utc, r'^[0-9]{8}T[0-9]{6}Z$')
        copy = self.evidence / f'accept-{utc}.json'
        self.assertEqual(rows[1], [utc, 'T1', 'R0', 'accept', '0', '',
                                   f'deepseek-harness-plugins={head}', 'landed', str(copy)])
        self.assertEqual(copy.read_text(), (self.evidence / 'accept.json').read_text())

    def test_land_shadow_refuse_still_lands(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(1, ['GATE_MISSING', 'REVIEW_MISSING', 'REFUSE T1 2 reasons'], head)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        row = self.rows()[1]
        self.assertEqual(row[3], 'refuse')
        self.assertEqual(row[4], '1')
        self.assertEqual(row[5], 'GATE_MISSING;REVIEW_MISSING')
        self.assertEqual(row[7], 'landed')

    def test_land_shadow_check_error_keeps_no_copy(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(2, [], stderr='boom')
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        self.assertIn('boom', err)
        row = self.rows()[1]
        self.assertEqual(row[3], 'error')
        self.assertEqual(row[4], '2')
        self.assertEqual(row[5], '')
        self.assertEqual(row[6], '')
        self.assertEqual(row[8], '')
        self.assertEqual(self.copies(), [])

    def test_land_shadow_step_failure_writes_an_error_row(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            with mock.patch.object(dispatch, 'ACCEPT', self.base / 'missing'):
                code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        self.assertIn('warning: kstack-accept step failed: FileNotFoundError', err)
        row = self.rows()[1]
        self.assertEqual(row[3], 'error')
        self.assertEqual(row[4], '')
        self.assertEqual(row[5], 'exception:FileNotFoundError')

    def test_land_shadow_precondition_failure_writes_a_refused_row(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(0, ['ACCEPT'], head)
            (self.worktree / 'untracked.txt').write_text('x\n')
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('the worktree has uncommitted changes', err)
        self.assertEqual(self.recorded('checks.txt'), ['check'])
        row = self.rows()[1]
        self.assertEqual(row[3], 'accept')
        self.assertEqual(row[7], 'refused')

    def test_land_shadow_failed_fast_forward_writes_a_failed_row(self):
        (self.root / 'ignored.txt').write_text('keep\n')
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            self.ready_card()
            (self.worktree / 'ignored.txt').write_text('tracked now\n')
            git('add', '-f', 'ignored.txt', cwd=self.worktree)
            commit(self.worktree, 'track the ignored path')
            head = git('rev-parse', 'card/T1', cwd=self.root).strip()
            self.fake_check(0, ['ACCEPT'], head)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertEqual(self.rows()[1][7], 'failed')

    def test_land_shadow_writes_the_header_once(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(0, ['ACCEPT'], head)
            (self.worktree / 'untracked.txt').write_text('x\n')
            code, out, err = self.invoke('land', 'T1')
            self.assertEqual(code, 2)
            (self.worktree / 'untracked.txt').unlink()
            code, out, err = self.invoke('land', 'T1')
            self.assertEqual(code, 0)
        rows = self.rows()
        header = dispatch.SHADOW_HEADER.split('\t')
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0], header)
        self.assertNotIn(header, rows[1:])
        self.assertEqual([row[7] for row in rows[1:]], ['refused', 'landed'])

    def test_land_keeps_numbered_copies(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(0, ['ACCEPT'], head)
            self.evidence.mkdir(parents=True, exist_ok=True)
            (self.evidence / 'accept-20261116T000000Z.json').write_text('kept\n')
            with mock.patch.object(dispatch, 'utc_stamp', lambda: '20261116T000000Z'):
                code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(self.copies(), ['accept-20261116T000000Z-2.json',
                                         'accept-20261116T000000Z.json'])
        self.assertTrue(self.rows()[1][8].endswith('accept-20261116T000000Z-2.json'))

    def test_land_tier_is_empty_without_scope_json(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            (self.evidence / 'scope.json').unlink()
            self.fake_check(1, ['REFUSE T1 1 reasons'], head)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(self.rows()[1][2], '')

    def test_land_enforce_accept_lands(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'enforce'}):
            head = self.ready_card()
            self.fake_check(0, ['ACCEPT'], head)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        row = self.rows()[1]
        self.assertEqual(row[3], 'accept')
        self.assertEqual(row[7], 'landed')

    def test_land_enforce_refuse_exits_7(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'enforce'}):
            head = self.ready_card()
            tip = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
            self.fake_check(1, ['GATE_MISSING', 'REFUSE T1 1 reasons'], head)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 7)
        self.assertIn('land refused by kstack-accept (KSTACK_ACCEPT=enforce)', err)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), tip)
        self.assertTrue(self.worktree.is_dir())
        row = self.rows()[1]
        self.assertEqual(row[3], 'refuse')
        self.assertEqual(row[7], 'refused')

    def test_land_enforce_check_error_exits_7(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'enforce'}):
            self.ready_card()
            self.fake_check(2, [])
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 7)
        self.assertNotEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(),
                            git('rev-parse', 'card/T1', cwd=self.root).strip())

    def test_land_enforce_step_failure_stops_the_land(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'enforce'}):
            self.ready_card()
            with mock.patch.object(dispatch, 'ACCEPT', self.base / 'missing'):
                code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('kstack-accept step failed: FileNotFoundError', err)
        self.assertNotEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(),
                            git('rev-parse', 'card/T1', cwd=self.root).strip())
        self.assertTrue(self.worktree.is_dir())
        row = self.rows()[1]
        self.assertEqual(row[3], 'error')
        self.assertEqual(row[7], 'refused')

    def test_land_shadow_signal_is_a_step_failure(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(0, ['ACCEPT'], killed=True)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        row = self.rows()[1]
        self.assertEqual(row[3], 'error')
        self.assertEqual(row[4], '')
        self.assertEqual(row[5], 'exception:ChildProcessError')

    def test_land_enforce_refuses_a_moved_card_branch(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'enforce'}):
            self.ready_card()
            tip = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
            self.fake_check(0, ['ACCEPT'], '0' * 40)
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 7)
        self.assertIn('card/T1 moved after kstack-accept check; land refused', err)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), tip)
        row = self.rows()[1]
        self.assertEqual(row[3], 'accept')
        self.assertEqual(row[7], 'refused')

    def test_land_enforce_unwritable_log_stops_the_land(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'enforce'}):
            head = self.ready_card()
            tip = git('rev-parse', 'issue/1-x', cwd=self.root).strip()
            self.fake_check(0, ['ACCEPT'], head)
            (self.root / 'reports/agents/accept-shadow.tsv').mkdir()
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 2)
        self.assertIn('kstack-accept shadow row not written:', err)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), tip)
        self.assertTrue(self.worktree.is_dir())

    def test_land_survives_a_failed_row_write(self):
        with mock.patch.dict(os.environ, {'KSTACK_ACCEPT': 'shadow'}):
            head = self.ready_card()
            self.fake_check(0, ['ACCEPT'], head)
            (self.root / 'reports/agents/accept-shadow.tsv').mkdir()
            code, out, err = self.invoke('land', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(git('rev-parse', 'issue/1-x', cwd=self.root).strip(), head)
        self.assertEqual(err.count('warning: kstack-accept shadow row not written:'), 2)

    def test_run_worker_never_overwrites_output(self):
        agents = self.base / 'agents'
        worker = self.worker()
        stamp = datetime.datetime(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)

        class Fixed:
            @staticmethod
            def now(tz=None):
                return stamp

        with mock.patch.object(dispatch, 'datetime', Fixed), \
                contextlib.redirect_stdout(io.StringIO()):
            for _ in range(2):
                dispatch.run_worker(agents, 'x', self.root, ['dsh'], 'brief',
                                    read_only=False, worker=worker)
        self.assertEqual(sorted(path.name for path in agents.iterdir()),
                         ['20260102T030405Z-x-2.log', '20260102T030405Z-x-2.md',
                          '20260102T030405Z-x.log', '20260102T030405Z-x.md'])
        self.assertEqual((agents / '20260102T030405Z-x.md').read_text(), 'answer\nTOTAL 0\n')

    def test_harness_failure_is_reported_once(self):
        worker = self.worker(stderr_lines=('dsh: UNKNOWN_MODEL',), code=1)
        code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 1)
        self.assertEqual(out.count(dispatch.HARNESS_LINE), 1)

    def test_harness_line_without_a_nonzero_exit(self):
        worker = self.worker(stdout_lines=('ok',), stderr_lines=('UNKNOWN_MODEL',), code=0)
        code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 0)
        self.assertEqual(out.count(dispatch.HARNESS_LINE), 1)

    def test_no_harness_line_for_a_normal_run(self):
        worker = self.worker(stdout_lines=('ok',), stderr_lines=('thinking',), code=1)
        code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 1)
        self.assertNotIn(dispatch.HARNESS_LINE, out)

    def test_empty_output_is_a_harness_failure(self):
        agents = self.base / 'agents'
        worker = self.worker(stdout_lines=(), stderr_lines=())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            dispatch.run_worker(agents, 'x', self.root, ['dsh'], 'brief',
                                read_only=False, worker=worker)
        self.assertIn(dispatch.HARNESS_LINE, out.getvalue())

    def test_parse_answer(self):
        path = self.base / 'answer.md'
        path.write_text('a.py:1 | high | x | y\n```\nb.py:2 | low | fenced | z\n'
                        'STOPPED inside\n```\nTOTAL 1\n')
        self.assertEqual(dispatch.parse_answer(path), (['a.py:1 | high | x | y'], True))

    def test_read_findings(self):
        directory = self.base / 'findings'
        directory.mkdir()
        (directory / 'findings.tsv').write_text('id\tdisposition\tdetail\n'
                                                '1.1\tfixed\tabc\n\n1.2\topen\n')
        self.assertEqual(dispatch.read_findings(directory),
                         {'1.1': ('fixed', 'abc'), '1.2': ('', '')})
        self.assertIsNone(dispatch.read_findings(self.base / 'no-findings'))

    def test_runtime_rev(self):
        repo = self.base / 'dsh'
        (repo / 'bin').mkdir(parents=True)
        (repo / 'bin/dsh').write_text('#!/bin/sh\n')
        git('init', '-b', 'main', cwd=repo)
        commit(repo, 'init')
        head = git('rev-parse', 'HEAD', cwd=repo).strip()
        os.environ['DSH_CLI'] = str(repo / 'bin/dsh')
        self.assertEqual(REAL_RUNTIME_REV(), head)
        (repo / 'untracked.txt').write_text('x\n')
        self.assertEqual(REAL_RUNTIME_REV(), head + '-dirty')
        os.environ['DSH_CLI'] = ''
        with mock.patch.object(dispatch.shutil, 'which', return_value=None):
            self.assertEqual(REAL_RUNTIME_REV(), 'unknown')

    def test_briefs_fence_every_never_read_path_but_the_workdir(self):
        main = Path('/x/main')
        wt = main / 'reports/worktrees/T1'
        root = main / 'reports/worktrees/issue-1'
        card = dispatch.Card(id='T1', title='t', issue=1, text='## T1. t', done=False,
                             files=['bin/a.py'])
        self.assertEqual(dispatch.NEVER_READ,
                         ['/data/references/', '~/.config/dsh/slack',
                          '~/.dsh/.credentials.yaml*', '~/.dsh/private/', '~/.dsh/sessions/',
                          '~/.dsh-recovery-*', '{main}/reports/agents/', '{main}/releases/',
                          '{main}/local-design/'])
        pairs = [(dispatch.card_brief(main, wt, card, True), wt),
                 (dispatch.card_brief(main, wt, card, False), wt),
                 (dispatch.ambiguity_brief(main, root, [card]), root),
                 (dispatch.review_brief(main, wt, 'issue/1-x', card, 'd', [], 0, 'g'), wt),
                 (dispatch.main_review_brief(main, root, card, 'd', [], 0, 'g'), root)]
        for text, own in pairs:
            fence = dispatch._never(main, own)
            self.assertIn(fence, text)
            self.assertIn(f'Search only the paths this brief and the card name. Never search recursively from `{main}`, from `{own}`, or from your home directory.', fence)
            self.assertIn('Never read any `.env` or `.env.*` file, or any other credential'
                          ' or token file.', fence)
            for entry in dispatch.NEVER_READ:
                self.assertIn(entry.format(main=main), fence)
            self.assertEqual(fence.count('Never read `'), 9)
            for sentence in fence.split('. '):
                if 'other than' in sentence or 'search' in sentence:
                    continue
                self.assertNotIn(str(own), sentence)


if __name__ == '__main__':
    unittest.main()
