"""Dispatch one DSH worker on a card, a card review, or a landing.

Run from the issue worktree:

    python3 bin/dispatch.py ambiguity [ID ...]
    python3 bin/dispatch.py card ID [--no-worker]
    python3 bin/dispatch.py review ID [--main PATH ...]
    python3 bin/dispatch.py land ID

Cards are `tasks/<ID>.md`. `ambiguity` with IDs reviews those cards whatever
their status; without IDs it reviews every card that is not done. `card`
creates the worktree `reports/worktrees/<ID>` of the main checkout, on branch
`card/<ID>` (for example `card/T1`), made from the issue branch, and runs the
implementer there. `review` pipes the diff of that worktree since it left the
issue branch to a second reviewer; with `--main`, it pipes the lead's
uncommitted change of the given paths. `land` fast-forwards the issue branch,
then removes the worktree and `card/<ID>`.

Every verb except `card` starts its worker with `--read-only`, so `review` runs
the gate itself, before the reviewer, and puts the exit code and the last lines
of its output in the brief. The worker's answer (stdout) goes to
`reports/agents/<UTC>-<name>.md` of the main checkout and its reasoning and
errors (stderr) to the matching `.log`; a name already taken gains a `-2`,
`-3`, ... suffix. Prints the paths and exits with the worker's code.
"""
import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import fnmatch
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
KSTACK = Path('/data/softwares/kstack')
WORKER = KSTACK / 'skills/kiyama-mode/scripts/run-worker.sh'
WORKER_ROUTE = ['dsh', 'ollama-cloud', 'deepseek-v4.1-flash', 'high']
REVIEW_ROUTE = ['dsh', 'openai-codex', 'gpt-6.1-sol', 'high']
GATE = 'python3 bin/gate.py'
HEADING = re.compile(r'^## (T[0-9]+)\. (.+)$')

CARD_BRIEF = '''{opening}

Goal of the owner: build this repository card by card, each card small and checked, so a reviewer can trust and commit it. You implement exactly one card.

Card {id} ("{title}"), the file `{wt}/tasks/{id}.md`. Your worktree is `{wt}`, on branch `card/{id}`.

1. Read `{wt}/AGENTS.md` in full. Its rules override everything else, including the poteto-agent file.
2. Read `{wt}/tasks/README.md`, the card, and every document its `Spec` line names.
3. Implement card {id} exactly: only the files {files}, the names and test names it gives, the values it states.
4. Write only inside `{wt}`.
5. {gate_step}
6. Do not commit. {never}
7. If the card is ambiguous, a `Needs` card is missing, or the card needs another file or a new dependency, stop and say so in the report instead of guessing.

Final report, plain text, four parts: files changed; the last 20 lines of the output of {gate_part}; anything in the card you could not do; open questions.'''

AMBIGUITY_BRIEF = '''{opening}

Goal of the owner: a fast implementation model (you) will later implement these cards from the cards and the documents they cite alone. The owner wants them good enough that the implementer never has to guess. Your job now is a read-only review that finds every place you would have to guess.

`{root}/AGENTS.md` holds the rules the implementer follows. It overrides everything else, including the poteto-agent file.

Cards to review:
{card_lines}

Read `{root}/AGENTS.md`, `{root}/tasks/README.md`, the cards above, and every document and source file a card names. {never}

Do not edit, create, or delete any file. Do not run git commit. Do not run any command that builds or tests code: you run read-only.

Review only the cards above; ignore every other card. For each, imagine implementing it now. Report every point where:
1. the card and its docs do not say what to do (a missing rule, an unstated default, error message, order, or tie-break),
2. two parts of the card or its docs, or the docs and the code, disagree,
3. a named test cannot be written as described (missing fixture, missing hook such as a clock or fake, behavior not observable),
4. the card needs a file, function, or class that is not on its file list or does not exist yet,
5. a cited document, section, or source file does not exist or does not match its description.

Output only this, as plain text:
- One line per finding: `<card> | <kind 1-5> | <file:line or section> | <what is missing or conflicting> | <the question the owner must answer>`.
- Then one line: `TOTAL <n>`.
Be concrete. Quote the words you mean. Skip style comments. Do not propose code.'''

REVIEW_BRIEF = '''{opening}

Goal of the owner: a worker implemented one card of this repository. You are the second reviewer, read-only, before the lead accepts the diff. Do not edit, create, or delete any file. Do not commit.

`{wt}/AGENTS.md` holds the rules the worker had to follow. It overrides everything else, including the poteto-agent file.

Card {id}, worktree `{wt}`, branched from `{branch}`. Read `{wt}/AGENTS.md`, `{wt}/tasks/README.md`, the card below, and the files in `{wt}` that the diff touches. {never} Do not run any command that builds or tests code: you run read-only. {gate_block}

Card:

{card_text}

Diff of the card worktree since it left {branch} (`git diff $(git merge-base HEAD {branch})`): the card's commits and uncommitted changes.

```diff
{diff}
```

Untracked files (read each one):
{untracked_lines}

Report every defect: a rule of the card, `tasks/README.md`, or `AGENTS.md` that the diff breaks; a named test that is missing or does not assert what the card says; a bug; a changed file that is not on the card's `Files:` line.

Output only this, as plain text:
- One line per finding: `<file:line> | <high, medium, or low> | <the defect> | <the evidence: quoted code, rule, or command output>`.
- Then one line: `TOTAL <n>`.
Be concrete. Skip style comments. Do not propose code.'''

MAIN_REVIEW_BRIEF = '''{opening}

Goal of the owner: before card {id} runs, its lead changed files in the checkout `{root}` by hand. You are the second reviewer, read-only, before the lead commits the change. Do not edit, create, or delete any file. Do not commit.

`{root}/AGENTS.md` holds the rules the implementer of the card will follow. It overrides everything else, including the poteto-agent file.

Read `{root}/AGENTS.md`, `{root}/tasks/README.md`, the card below, the files that the change touches, and the code in `{root}` that uses them. {never} Do not run any command that builds or tests code: you run read-only. {gate_block}

Card:

{card_text}

Uncommitted change in `{root}` (`git diff HEAD`):

```diff
{diff}
```

Untracked files (read each one):
{untracked_lines}

Report every defect: a bug or a gap in the change; a rule of the card, `tasks/README.md`, or `AGENTS.md` that the change breaks or leaves unstated; a part of the card that the change cannot support; code in `{root}` that the change breaks.

Output only this, as plain text:
- One line per finding: `<file:line> | <high, medium, or low> | <the defect> | <the evidence: quoted code, rule, or command output>`.
- Then one line: `TOTAL <n>`.
Be concrete. Skip style comments. Do not propose code.'''

GATE_BLOCK = ('The dispatcher ran `python3 bin/gate.py` before you started; it exited {gate_code}. '
              'The last lines of its output:\n\n```\n{gate_tail}\n```')
NO_GATE_BLOCK = 'bin/gate.py does not exist yet; the dispatcher ran no gate.'

HARNESS_LINE = 'the worker did not start (cause:harness). Report it; do not switch the model or the runner.'

NEVER_READ = [
    '/data/references/',
    '~/.config/dsh/slack',
    '~/.dsh/.credentials.yaml*',
    '~/.dsh/private/',
    '~/.dsh/sessions/',
    '~/.dsh-recovery-*',
    '{main}/reports/agents/',
    '{main}/releases/',
    '{main}/local-design/',
]


class DispatchError(Exception):
    """A problem the lead has to fix before the verb can run."""


@dataclass
class Card:
    id: str
    title: str
    issue: int
    text: str
    done: bool
    files: list


def git(*args, cwd=None, allow_failure=False):
    done = subprocess.run(['git', *[str(arg) for arg in args]], cwd=cwd,
                          capture_output=True, text=True)
    if done.returncode and not allow_failure:
        raise DispatchError(f'git {" ".join(str(arg) for arg in args)}: {done.stderr.strip()}')
    return done


def parse_card(path):
    path = Path(path)
    text = path.read_text(encoding='utf-8')
    lines = text.splitlines()
    first = lines[0] if lines else ''
    match = HEADING.match(first)
    if not match or match.group(1) != path.stem:
        raise DispatchError(f'{path}: the first line must be "## {path.stem}. <title>"')
    issue = None
    for line in lines:
        found = re.match(r'^Issue: #([0-9]+)\.?$', line)
        if found:
            issue = int(found.group(1))
            break
    if issue is None:
        raise DispatchError(f'{path}: no "Issue: #<N>" line')
    files = None
    for line in lines:
        if line.startswith('Files:'):
            files = re.findall(r'`([^`]+)`', line)
            break
    if not files:
        raise DispatchError(f'{path}: no "Files:" line')
    return Card(path.stem, match.group(2), issue, text,
                any(line.strip() == 'Status: done' for line in lines), files)


def _card_number(card_id):
    return int(card_id[1:])


def all_cards(root):
    root = Path(root)
    cards = [parse_card(path) for path in (root / 'tasks').glob('T*.md')
             if re.fullmatch(r'T[0-9]+', path.stem)]
    return sorted(cards, key=lambda card: _card_number(card.id))


def find_card(root, card_id):
    path = Path(root) / 'tasks' / f'{card_id}.md'
    if not path.is_file():
        raise DispatchError(f'no card {card_id} in tasks/')
    return parse_card(path)


def main_checkout(root):
    common = git('rev-parse', '--path-format=absolute', '--git-common-dir', cwd=root).stdout
    return Path(common.strip()).parent


def issue_branch(root):
    done = git('symbolic-ref', '--quiet', '--short', 'HEAD', cwd=root, allow_failure=True)
    branch = done.stdout.strip()
    if done.returncode or not branch:
        raise DispatchError('the checkout is not on a branch')
    if branch == 'main':
        raise DispatchError('the checkout is on main; run the dispatcher from the issue worktree')
    if branch.startswith('card/'):
        raise DispatchError('the checkout is a card worktree; run the dispatcher from the issue worktree')
    return branch


def run_gate(tree):
    if not (Path(tree) / 'bin/gate.py').is_file():
        print('gate skipped: no bin/gate.py')
        return None, ''
    done = subprocess.run(GATE, shell=True, cwd=tree, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, errors='replace')
    tail = '\n'.join(done.stdout.splitlines()[-40:])
    print(f'gate exit {done.returncode}')
    return done.returncode, tail or '(no output)'


def _status_paths(tree):
    status = git('status', '--porcelain', '-z', '--untracked-files=all', cwd=tree).stdout
    parts = status.split('\0')
    paths = []
    index = 0
    while index < len(parts):
        entry = parts[index]
        index += 1
        if not entry:
            continue
        paths.append(entry[3:])
        if 'R' in entry[:2] or 'C' in entry[:2]:
            paths.append(parts[index])
            index += 1
    return paths


def off_list(worktree, card):
    return [path for path in _status_paths(worktree)
            if not any(fnmatch.fnmatchcase(path, pattern) for pattern in card.files)]


def _untracked(tree, pathspec=()):
    out = git('ls-files', '--others', '--exclude-standard', '-z', *pathspec, cwd=tree).stdout
    return [path for path in out.split('\0') if path]


def _opening():
    return (f'Read `{KSTACK}/agents/poteto-agent.md` in full and follow it. '
            f"kiyama-mode's `SKILL.md` is at `{KSTACK}/skills/kiyama-mode/SKILL.md`. "
            'You cannot spawn subagents.')


def _never(main, own):
    sentences = [f'Never read `{entry.format(main=main)}`.' for entry in NEVER_READ]
    sentences.append('Never read any `.env` or `.env.*` file, or any other credential or token file.')
    sentences.append(f'Never read a directory under `{main}/reports/worktrees/` other than `{own}`, '
                     f'or any other entry directly under `{main}/reports/`.')
    sentences.append(f'Search only the paths this brief and the card name. Never search recursively '
                     f'from `{main}`, from `{own}`, or from your home directory.')
    return ' '.join(sentences)


def card_brief(main, wt, card, has_gate):
    if has_gate:
        gate_step = f'Run `{GATE}` in `{wt}` until it exits 0.'
        gate_part = GATE
    else:
        gate_step = (f'There is no `bin/gate.py` yet. Run each command on the card\'s `Done:` line '
                     f'in `{wt}` until each meets the condition written beside it.')
        gate_part = 'the Done: commands'
    return CARD_BRIEF.format(
        opening=_opening(), never=_never(main, wt), wt=wt, id=card.id, title=card.title,
        files=', '.join(f'`{path}`' for path in card.files), gate_step=gate_step,
        gate_part=gate_part)


def ambiguity_brief(main, root, cards):
    return AMBIGUITY_BRIEF.format(
        opening=_opening(), never=_never(main, root), root=root,
        card_lines='\n'.join(f'- {card.id}: {card.title} (`tasks/{card.id}.md`)' for card in cards))


def _gate_block(gate_code, gate_tail):
    if gate_code is None:
        return NO_GATE_BLOCK
    return GATE_BLOCK.format(gate_code=gate_code, gate_tail=gate_tail)


def _untracked_lines(untracked):
    return '\n'.join(f'- {path}' for path in untracked) if untracked else 'none'


def review_brief(main, wt, branch, card, diff, untracked, gate_code, gate_tail):
    return REVIEW_BRIEF.format(
        opening=_opening(), never=_never(main, wt), wt=wt, id=card.id, branch=branch,
        card_text=card.text, diff=diff, untracked_lines=_untracked_lines(untracked),
        gate_block=_gate_block(gate_code, gate_tail))


def main_review_brief(main, root, card, diff, untracked, gate_code, gate_tail):
    return MAIN_REVIEW_BRIEF.format(
        opening=_opening(), never=_never(main, root), root=root, id=card.id, card_text=card.text,
        diff=diff, untracked_lines=_untracked_lines(untracked),
        gate_block=_gate_block(gate_code, gate_tail))


def summarize_ambiguity(text, ids):
    lines = text.splitlines()
    if not any(re.match(r'^TOTAL [0-9]+$', line) for line in lines):
        return ['summary: no TOTAL line; read the answer']
    counts = {card_id: [0, 0, 0, 0, 0] for card_id in ids}
    for line in lines:
        fields = line.split(' | ')
        if len(fields) < 5:
            continue
        card_id = fields[0][2:] if fields[0].startswith('- ') else fields[0]
        kind = fields[1].strip()
        if card_id in counts and kind in '12345' and len(kind) == 1:
            counts[card_id][int(kind) - 1] += 1
    summary = []
    for card_id in sorted(counts, key=_card_number):
        count = counts[card_id]
        blocking = count[1] + count[3] + count[4]
        summary.append(f'{card_id}: kind1={count[0]} kind2={count[1]} kind3={count[2]} '
                       f'kind4={count[3]} kind5={count[4]} blocking={blocking}')
    return summary


def _open_outputs(agents, stamp, name):
    agents.mkdir(parents=True, exist_ok=True)
    index = 1
    while True:
        suffix = '' if index == 1 else f'-{index}'
        answer = agents / f'{stamp}-{name}{suffix}.md'
        try:
            stdout = answer.open('x', encoding='utf-8')
        except FileExistsError:
            index += 1
            continue
        log = agents / f'{stamp}-{name}{suffix}.log'
        try:
            stderr = log.open('x', encoding='utf-8')
        except FileExistsError:
            stdout.close()
            answer.unlink()
            index += 1
            continue
        return answer, log, stdout, stderr


def _harness_failure(log, answer, changed):
    text = log.read_text(encoding='utf-8', errors='replace')
    if 'UNKNOWN_MODEL' in text or 'MISSING_CREDENTIAL' in text:
        return True
    if log.stat().st_size == 0 and answer.stat().st_size == 0:
        return changed is None or not changed()
    return False


def run_worker(agents, name, workdir, route, brief, read_only, worker=WORKER, changed=None):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    answer, log, stdout, stderr = _open_outputs(agents, stamp, name)
    command = [str(worker), *(['--read-only'] if read_only else []), str(workdir), *route]
    with stdout, stderr:
        code = subprocess.run(command, input=brief, text=True,
                              stdout=stdout, stderr=stderr).returncode
    print(f'answer {answer}')
    print(f'log {log}')
    print(f'exit {code}')
    if _harness_failure(log, answer, changed):
        print(HARNESS_LINE)
    return code, answer


def _branch_exists(root, branch):
    done = git('rev-parse', '--verify', '--quiet', f'refs/heads/{branch}', cwd=root,
               allow_failure=True)
    return done.returncode == 0


def _worktree(main, card_id):
    return main / 'reports/worktrees' / card_id


def _ambiguity(args, root, worker):
    if args.ids:
        ids = sorted(set(args.ids), key=_card_number)
        cards = [find_card(root, card_id) for card_id in ids]
        name = 'ambiguity-' + '-'.join(ids)
    else:
        cards = [card for card in all_cards(root) if not card.done]
        name = 'ambiguity-all'
    if not cards:
        raise DispatchError('no cards to review')
    main = main_checkout(root)
    code, answer = run_worker(main / 'reports/agents', name, root, WORKER_ROUTE,
                              ambiguity_brief(main, root, cards), read_only=True, worker=worker)
    text = answer.read_text(encoding='utf-8', errors='replace')
    for line in summarize_ambiguity(text, [card.id for card in cards]):
        print(line)
    return code


def _discard_worktree(root, worktree, card_branch):
    if worktree.exists():
        shutil.rmtree(worktree, ignore_errors=True)
    git('worktree', 'prune', cwd=root, allow_failure=True)
    if _branch_exists(root, card_branch):
        git('branch', '-D', card_branch, cwd=root, allow_failure=True)


def _card(args, root, worker):
    branch = issue_branch(root)
    card = find_card(root, args.id)
    if card.done:
        raise DispatchError(f'card {card.id} is done')
    card_file = f'tasks/{card.id}.md'
    if git('status', '--porcelain', '--', card_file, cwd=root).stdout.strip():
        raise DispatchError(f'{card_file} has uncommitted changes; commit the card first')
    main = main_checkout(root)
    worktree = _worktree(main, card.id)
    if worktree.exists():
        raise DispatchError(f'worktree {worktree} exists; land or remove it first')
    card_branch = f'card/{card.id}'
    if _branch_exists(root, card_branch):
        raise DispatchError(f'branch {card_branch} already exists')
    if git('status', '--porcelain', cwd=root).stdout.strip():
        print(f'warning: the checkout has uncommitted changes; the worktree starts from {branch}')
    (main / 'reports/worktrees').mkdir(parents=True, exist_ok=True)
    added = git('worktree', 'add', '-b', card_branch, worktree, branch, cwd=root,
                allow_failure=True)
    if added.returncode:
        _discard_worktree(root, worktree, card_branch)
        raise DispatchError(f'git worktree add failed: {added.stderr.strip()}')
    has_gate = (worktree / 'bin/gate.py').is_file()
    print(f'worktree {worktree}')
    print(f'land {branch}')
    print(f'gate: {GATE}' if has_gate else f'gate: the Done line of tasks/{card.id}.md')
    if args.no_worker:
        return 0
    code, _ = run_worker(main / 'reports/agents', f'card-{card.id}', worktree, WORKER_ROUTE,
                         card_brief(main, worktree, card, has_gate), read_only=False,
                         worker=worker, changed=lambda: bool(_status_paths(worktree)))
    outside = off_list(worktree, card)
    if outside:
        print('changes outside Files:')
        for path in outside:
            print(f'  {path}')
    else:
        print('no changes outside Files')
    return code


def _review(args, root, worker):
    main = main_checkout(root)
    if args.main:
        card = find_card(root, args.id)
        diff = git('diff', 'HEAD', '--', *args.main, cwd=root).stdout
        untracked = [str(root / path) for path in _untracked(root, ('--', *args.main))]
        if not diff.strip() and not untracked:
            raise DispatchError('no changes in the given paths')
        gate_code, gate_tail = run_gate(root)
        code, _ = run_worker(
            main / 'reports/agents', f'review-main-{card.id}', root, REVIEW_ROUTE,
            main_review_brief(main, root, card, diff, untracked, gate_code, gate_tail),
            read_only=True, worker=worker)
        return code
    branch = issue_branch(root)
    card = find_card(root, args.id)
    worktree = _worktree(main, card.id)
    if not worktree.is_dir():
        raise DispatchError(f'no worktree {worktree}')
    base = git('merge-base', 'HEAD', branch, cwd=worktree).stdout.strip()
    diff = git('diff', base, cwd=worktree).stdout
    untracked = [str(worktree / path) for path in _untracked(worktree)]
    gate_code, gate_tail = run_gate(worktree)
    code, _ = run_worker(main / 'reports/agents', f'review-{card.id}', worktree, REVIEW_ROUTE,
                         review_brief(main, worktree, branch, card, diff, untracked,
                                      gate_code, gate_tail), read_only=True, worker=worker)
    return code


def _land(args, root):
    branch = issue_branch(root)
    main = main_checkout(root)
    card_branch = f'card/{args.id}'
    worktree = _worktree(main, args.id)
    if not worktree.is_dir():
        raise DispatchError(f'no worktree {worktree}')
    head = git('symbolic-ref', '--quiet', '--short', 'HEAD', cwd=worktree, allow_failure=True)
    if head.returncode or head.stdout.strip() != card_branch:
        raise DispatchError(f'the worktree is not on {card_branch}')
    if _status_paths(worktree):
        raise DispatchError('the worktree has uncommitted changes')
    commits = git('rev-list', '--count', f'{branch}..{card_branch}', cwd=root).stdout.strip()
    if commits == '0':
        raise DispatchError(f'{card_branch} has no commits to land')
    ancestor = git('merge-base', '--is-ancestor', branch, card_branch, cwd=root, allow_failure=True)
    if ancestor.returncode:
        raise DispatchError(f'{branch} has moved since the dispatch. Rebase {card_branch} onto '
                            f'{branch} in {worktree}, run the full gate again, then land again.')
    merged = git('merge', '--ff-only', '--no-overwrite-ignore', card_branch, cwd=root,
                 allow_failure=True)
    if merged.returncode:
        raise DispatchError(f'the fast-forward failed: {merged.stderr.strip()}')
    for command in (('worktree', 'remove', '--force', worktree), ('branch', '-d', card_branch)):
        done = git(*command, cwd=root, allow_failure=True)
        if done.returncode:
            print(f'warning: landed, but cleanup failed: {done.stderr.strip()}')
    print(f'landed {branch} {git("log", "--oneline", "-1", cwd=root).stdout.strip()}')
    return 0


def main(argv=None, root=ROOT, worker=WORKER):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    verbs = parser.add_subparsers(dest='verb', required=True)
    ambiguity = verbs.add_parser('ambiguity', help='review cards for missing decisions')
    ambiguity.add_argument('ids', nargs='*', metavar='id')
    card = verbs.add_parser('card', help='make the card worktree and run the implementer')
    card.add_argument('id')
    card.add_argument('--no-worker', action='store_true')
    review = verbs.add_parser('review', help='run the second reviewer on a worktree or a change')
    review.add_argument('id')
    review.add_argument('--main', nargs='+', metavar='PATH')
    land = verbs.add_parser('land', help='fast-forward the issue branch and remove the worktree')
    land.add_argument('id')
    args = parser.parse_args(argv)
    root = Path(root).resolve()
    try:
        if args.verb == 'ambiguity':
            return _ambiguity(args, root, worker)
        if args.verb == 'card':
            return _card(args, root, worker)
        if args.verb == 'review':
            return _review(args, root, worker)
        return _land(args, root)
    except DispatchError as error:
        print(f'dispatch: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
