import contextlib
import datetime
import io
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dispatch  # noqa: E402

CARD_T1 = '''## T1. Card dispatcher

Issue: #1.

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


def card_text(card_id, title, files='`bin/a.py`', done=False):
    text = f'## {card_id}. {title}\n\nIssue: #1.\n\nFiles: {files}.\n\nBody.\n'
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


def fake_worker(directory, record, stdout_lines=('answer',), stderr_lines=('reasoning',),
                code=0, touch=(), name='worker.sh', env_out=None):
    path = directory / name
    lines = ['#!/bin/sh',
             f'printf "%s\\n" "$@" >> {shlex.quote(str(record / "argv.txt"))}',
             f'cat >> {shlex.quote(str(record / "stdin.txt"))}',
             f'printf "run\\n" >> {shlex.quote(str(record / "runs.txt"))}']
    if env_out is not None:
        variable, output = env_out
        lines.append(f'printf "%s" "${{{variable}:-unset}}" > {shlex.quote(str(output))}')
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


class DispatchTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, clean_git_env(), clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name).resolve()
        self.root = make_repo(self.base)
        self.record = self.base / 'record'
        self.record.mkdir()
        self.worktree = self.root / 'reports/worktrees/T1'

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

    def test_git_ignores_the_callers_git_environment(self):
        trap = self.base / 'trap'
        trap.mkdir()
        with mock.patch.dict(os.environ, {'GIT_DIR': str(trap / 'nothing')}):
            done = dispatch.git('rev-parse', '--show-toplevel', cwd=self.root)
        self.assertEqual(done.returncode, 0)
        self.assertEqual(done.stdout.strip(), str(self.root))
        self.assertEqual(list(trap.iterdir()), [])

    def test_worker_does_not_get_the_callers_git_environment(self):
        worker = self.worker(env_out=('GIT_DIR', self.record / 'gitdir.txt'))
        with mock.patch.dict(os.environ, {'GIT_DIR': '/nonexistent'}):
            code, out, err = self.invoke('card', 'T1', worker=worker)
        self.assertEqual(code, 0)
        self.assertEqual((self.record / 'gitdir.txt').read_text(), 'unset')

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

    def test_git_keeps_a_carriage_return_in_a_file_name(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'a\rb.txt').write_text('x\n')
        card = dispatch.find_card(self.root, 'T1')
        self.assertIn('a\rb.txt', dispatch.off_list(self.worktree, card))

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
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text("print('gate-' + 'said')\nraise SystemExit(3)\n")
        commit(self.worktree, 'add the gate')
        (self.worktree / 'tasks/T1.md').write_text(CARD_T1 + '\nUncommitted body change.\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertIn("+print('gate-' + 'said')", brief)
        self.assertIn('+Uncommitted body change.', brief)
        self.assertIn('exited 3', brief)
        self.assertIn('gate: FAIL', brief)
        self.assertNotIn('gate-said', brief)
        self.assertIn('gate exit 3', out)
        self.assertIn('gate-said', out)
        argv = self.recorded('argv.txt')
        self.assertEqual(argv[0], '--read-only')
        self.assertEqual(argv[1], str(self.worktree))
        self.assertEqual(argv[2:], dispatch.REVIEW_ROUTE)

    def test_review_with_a_passing_gate(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text(
            "print('fi' + 'ne')\nprint('gate: ' + 'PASS (1 checks)')\n")
        commit(self.worktree, 'add the gate')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('gate exit 0', out)
        self.assertIn('fine', out)
        brief = self.record_text('stdin.txt')
        self.assertIn('exited 0', brief)
        self.assertIn('gate: PASS (1 checks)', brief)
        self.assertNotIn('fine', brief)
        self.assertNotIn('does not exist yet', brief)

    def test_review_brief_holds_only_gate_lines(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text(
            "print('SECRET-' + 'TOKEN')\nprint('gate: ' + 'PASS (1 checks)')\n")
        commit(self.worktree, 'add the gate')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('gate exit 0', out)
        self.assertIn('SECRET-TOKEN', out)
        brief = self.record_text('stdin.txt')
        self.assertIn('exited 0', brief)
        self.assertIn('gate: PASS (1 checks)', brief)
        self.assertNotIn('SECRET-TOKEN', brief)

    def test_review_brief_drops_gate_lines_the_worktree_printed(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text(
            "print('gate: SECRET-' + 'LINE')\nprint('gate: ' + 'PASS (1 checks)')\n")
        commit(self.worktree, 'add the gate')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertIn('gate: PASS (1 checks)', brief)
        self.assertNotIn('SECRET-LINE', brief)
        self.assertIn('gate: SECRET-LINE', out)

    def test_non_utf8_brief_reaches_the_worker(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text('pass\n')
        commit(self.worktree, 'add the gate')
        path = os.fsencode(self.worktree) + b'/notes-\xff.txt'
        with open(path, 'wb') as handle:
            handle.write(b'x\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn(b'\xff', (self.record / 'stdin.txt').read_bytes())

    def test_review_does_not_show_an_untracked_symlink(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text('pass\n')
        commit(self.worktree, 'add the gate')
        outside = self.base / 'outside.txt'
        outside.write_text('secret\n')
        (self.worktree / 'link.md').symlink_to(outside)
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertNotIn('link.md', brief)
        self.assertIn(f'untracked symlink not shown to the reviewer: '
                      f'{self.worktree}/link.md -> {outside}', out)

    def test_review_main_does_not_show_an_untracked_symlink(self):
        (self.root / 'other.txt').write_text('one\n')
        commit(self.root, 'add other')
        (self.root / 'other.txt').write_text('two\n')
        outside = self.base / 'outside.txt'
        outside.write_text('secret\n')
        (self.root / 'link.md').symlink_to(outside)
        code, out, err = self.invoke('review', 'T1', '--main', 'link.md', 'other.txt')
        self.assertEqual(code, 0)
        brief = self.record_text('stdin.txt')
        self.assertIn('other.txt', brief)
        self.assertNotIn('link.md', brief)
        self.assertIn(f'untracked symlink not shown to the reviewer: '
                      f'{self.root}/link.md -> {outside}', out)

    def test_review_gate_does_not_get_the_callers_git_environment(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        target = self.record / 'gate-gitdir.txt'
        (self.worktree / 'bin/gate.py').write_text(
            'import os\n'
            f'open({str(target)!r}, "w").write(os.environ.get("GIT_DIR", "unset"))\n')
        commit(self.worktree, 'add the gate')
        with mock.patch.dict(os.environ, {'GIT_DIR': '/nonexistent'}):
            code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertEqual(target.read_text(), 'unset')

    def test_review_without_a_gate(self):
        self.invoke('card', 'T1', '--no-worker')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn('gate skipped: no bin/gate.py', out)
        self.assertIn('bin/gate.py does not exist yet', self.record_text('stdin.txt'))

    def test_review_lists_untracked_files_as_absolute_paths(self):
        self.invoke('card', 'T1', '--no-worker')
        (self.worktree / 'bin').mkdir()
        (self.worktree / 'bin/gate.py').write_text('pass\n')
        commit(self.worktree, 'add the gate')
        (self.worktree / 'notes.txt').write_text('note\n')
        code, out, err = self.invoke('review', 'T1')
        self.assertEqual(code, 0)
        self.assertIn(f'- {self.worktree}/notes.txt', self.record_text('stdin.txt'))

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
        self.assertEqual((agents / '20260102T030405Z-x.md').read_text(), 'answer\n')

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
