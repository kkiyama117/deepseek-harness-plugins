"""Dispatch one DSH worker on a card, a card review, or a landing.

Run from the issue worktree:

    python3 bin/dispatch.py ambiguity [ID ...]
    python3 bin/dispatch.py card ID [--no-worker]
    python3 bin/dispatch.py gate ID
    python3 bin/dispatch.py review ID [--kind KIND [--reason TEXT]] [--main PATH ...]
    python3 bin/dispatch.py land ID

Cards are `tasks/<ID>.md`. `ambiguity` with IDs reviews those cards whatever
their status; without IDs it reviews every card that is not done. `card`
creates the worktree `reports/worktrees/<ID>` of the main checkout, on branch
`card/<ID>` (for example `card/T1`), made from the issue branch, and runs the
implementer there. `review` pipes the diff of that worktree since it left the
issue branch to a second reviewer; with `--main`, it pipes the lead's
uncommitted change of the given paths. `land` fast-forwards the issue branch,
then removes the worktree and `card/<ID>`.

Every verb that starts a worker, except `card`, starts it with `--read-only`, so
`review` runs the gate itself, before the reviewer, and puts the exit code and
the last lines of its output in the brief. The worker's answer (stdout) goes to
`reports/agents/<UTC>-<name>.md` of the main checkout and its reasoning and
errors (stderr) to the matching `.log`; a name already taken gains a `-2`,
`-3`, ... suffix. Prints the paths and exits with the worker's code.

`card` also writes `reports/agents/evidence/<ID>/scope.json` of the main
checkout for kstack-accept, before the worker starts: the tier from the card's
`Tier:` line (a card without a valid one is refused before the worktree is
made), the implementer lineage of the worker's model, the card worktree, and
its base, the merge base of `card/<ID>` and the issue branch. Workers never
read or write that directory.

`gate` refreshes the base in scope.json (the merge base of `card/<ID>` and the
issue branch), runs the full gate in the card worktree, and writes gate.json
and gate.log beside scope.json. `review` reuses gate.json when its states
still match the worktree, and runs the same gate step otherwise; a failing
gate stops the review. `review --kind round|fixcheck|supplement|optional`
writes review-<seq>.json for kstack-accept; a reviewer that exits nonzero is
recorded as optional. `gate`, and `review` without `--main`, refuse a card
without scope.json.

`land` reads KSTACK_ACCEPT: `off` (the default) lands as before; `shadow`
runs `kstack-accept check` first, keeps accept-<UTC>.json beside the
evidence, appends one row to reports/agents/accept-shadow.tsv, and lands
whatever the verdict; `enforce` does the same but exits 7 without landing
when the check does not accept or card/<ID> moved after it.

`review` derives the run kind from the earlier review records and
findings.tsv (kstack acceptance section 5), refuses until every finding of
an earlier run that is not optional has a findings.tsv row, and refuses a worktree whose state is
not committed. A fix check's brief adds the change since the covered run, a
range-diff when the base moved, and the covered findings.

Every worker starts through kstack's launch boundary: the installed
~/.config/kstack/boundary/bin/kstack-policy supplies child_env and
wrap_argv for the launch.json entry dsh-ro (read-only verbs) or dsh-ws
(card). Without the boundary or the entry the dispatcher refuses to start a
worker; it never falls back to a bare launch.
"""
import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import fnmatch
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
KSTACK = Path('/data/softwares/kstack')
WORKER = KSTACK / 'skills/kiyama-mode/scripts/run-worker.sh'
WORKER_ROUTE = ['dsh', 'ollama-cloud', 'deepseek-v4.1-flash', 'high']
TIERS = ('R0', 'R1', 'R1s', 'R2')
LINEAGE = {'deepseek-v4.1-flash': 'deepseek', 'gpt-6.1-sol': 'openai'}
SCOPE_SCHEMA = 'kstack-accept/scope/1'
LAND_REPO = 'deepseek-harness-plugins'
REVIEW_ROUTE = ['dsh', 'openai-codex', 'gpt-6.1-sol', 'high']
GATE = 'python3 bin/gate.py'
ACCEPT = KSTACK / 'bin/kstack-accept'
BOUNDARY = Path.home() / '.config/kstack/boundary'
POLICY = BOUNDARY / 'bin/kstack-policy'
LAUNCH = BOUNDARY / 'launch.json'
READ_ONLY_ENTRY = 'dsh-ro'
WRITE_ENTRY = 'dsh-ws'
REVIEW_KINDS = ('round', 'fixcheck', 'supplement', 'optional')
GATE_SCHEMA = 'kstack-accept/gate/1'
REVIEW_SCHEMA = 'kstack-accept/review/1'
ACCEPT_MODES = ('off', 'shadow', 'enforce')
REFUSED_EXIT = 7
SHADOW_HEADER = 'utc\tcard\ttier\tverdict\texit\treasons\tcommits\told_land\taccept_json'
HEADING = re.compile(r'^## (T[0-9]+)\. (.+)$')
CARD_ID = re.compile(r'^T[0-9]+$')
FINDING = re.compile(r'^(?P<loc>[^|]+?)\s*\|\s*(?P<sev>high|medium|low)\s*\|', re.IGNORECASE)
FENCE = re.compile(r'^\s*(```|~~~)')

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

Card {id}, worktree `{wt}`, branched from `{branch}`. Read `{wt}/AGENTS.md`, `{wt}/tasks/README.md`, the card below, and the files in `{wt}` that the diff touches. {never} Do not run any command that builds or tests code: you run read-only. Run one bash command, `pwd`, before anything else; the sandbox evidence needs at least one bash call. {gate_block}

Card:

{card_text}

Diff of the card worktree since it left {branch} (`git diff $(git merge-base HEAD {branch})`): the card's commits and uncommitted changes.

```diff
{diff}
```

Untracked files (read each one):
{untracked_lines}
{fixcheck_block}
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


def card_tier(card):
    declared = ', '.join(TIERS)
    for line in card.text.splitlines():
        if line.startswith('Tier:'):
            words = line[len('Tier:'):].split()
            tier = words[0] if words else ''
            if tier in TIERS:
                return tier
            raise DispatchError(f'card {card.id}: unknown tier "{tier}"; '
                                f'declare one of {declared}')
    raise DispatchError(f'card {card.id}: no Tier: line; declare one of {declared}')


def implementer_lineage(route):
    try:
        return LINEAGE[route[2]]
    except KeyError:
        raise DispatchError(f'no implementer lineage for {route[2]}') from None


def scope_record(root, card, worktree, branch, tier, lineage):
    base = git('merge-base', f'card/{card.id}', branch, cwd=root).stdout.strip()
    return {
        'schema': SCOPE_SCHEMA,
        'card': card.id,
        'card_file': str(Path(root) / 'tasks' / f'{card.id}.md'),
        'tier': tier,
        'implementer_lineage': lineage,
        'repos': [{'name': LAND_REPO, 'path': str(worktree), 'base': base}],
        'gate_repos': [],
        'degraded': False,
        'degraded_reason': '',
    }


def evidence_dir(main, card_id):
    return Path(main) / 'reports/agents/evidence' / card_id


def write_evidence(main, card_id, name, text):
    directory = evidence_dir(main, card_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    descriptor, temporary_name = tempfile.mkstemp(prefix=f'.{name}.', suffix='.tmp', dir=directory)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            handle.write(text)
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise
    return path


def write_scope(main, card_id, record):
    return write_evidence(main, card_id, 'scope.json', json.dumps(record, indent=2) + '\n')


def read_scope(main, card_id):
    path = evidence_dir(main, card_id) / 'scope.json'
    if not path.exists():
        raise DispatchError(f'no scope.json for {card_id}; run card first')
    try:
        record = json.loads(path.read_text(encoding='utf-8'))
    except ValueError:
        raise DispatchError(f'bad scope.json for {card_id}') from None
    repos = record.get('repos') if isinstance(record, dict) else None
    if (not isinstance(repos, list) or not repos
            or any(not isinstance(entry, dict)
                   or any(not isinstance(entry.get(key), str) for key in ('name', 'path', 'base'))
                   for entry in repos)):
        raise DispatchError(f'bad scope.json for {card_id}')
    return record


def work_state(path):
    done = subprocess.run([str(ACCEPT), 'state', str(path)], capture_output=True, text=True)
    if done.returncode or not done.stdout.strip():
        raise DispatchError(f'kstack-accept state failed for {path}: {done.stderr.strip()}')
    return done.stdout.strip()


def refresh_base(main, card_id, branch, scope):
    moved = False
    for entry in scope['repos']:
        new = git('merge-base', f'card/{card_id}', branch, cwd=entry['path']).stdout.strip()
        if new != entry['base']:
            print(f'base {entry["name"]} {entry["base"]} -> {new}')
            entry['base'] = new
            moved = True
    if moved:
        try:
            write_scope(main, card_id, scope)
        except OSError as error:
            raise DispatchError(f'cannot write scope.json: {error}') from None


def current_states(scope):
    states = {entry['name']: work_state(entry['path']) for entry in scope['repos']}
    for entry in scope.get('gate_repos') or []:
        states[entry['name']] = work_state(entry['path'])
    return states


def repo_states(scope):
    return {entry['name']: work_state(entry['path']) for entry in scope['repos']}


def parse_answer(path):
    findings = []
    total = None
    stopped = False
    fenced = False
    text = Path(path).read_text(encoding='utf-8', errors='replace')
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        if FINDING.match(line):
            findings.append(line)
        elif re.match(r'^TOTAL\s+\d+\s*$', line):
            total = int(line.split()[1])
        elif re.match(r'^STOPPED\b', line):
            stopped = True
    return findings, total == len(findings) and not stopped


def read_findings(directory):
    path = Path(directory) / 'findings.tsv'
    if not path.exists():
        return None
    lines = path.read_text(encoding='utf-8').splitlines()
    rows = {}
    for line in lines[1:]:
        if not line:
            continue
        fields = line.split('\t')
        if len(fields) != 3:
            rows[fields[0].strip()] = ('', '')
            continue
        key, disposition, detail = (field.strip() for field in fields)
        rows[key] = (disposition, detail)
    return rows


def runtime_rev():
    cli = os.environ.get('DSH_CLI') or shutil.which('dsh')
    if not cli:
        return 'unknown'
    directory = Path(cli).resolve().parent
    while not (directory / '.git').exists():
        if directory.parent == directory:
            return 'unknown'
        directory = directory.parent
    head = git('rev-parse', 'HEAD', cwd=directory, allow_failure=True)
    status = git('status', '--porcelain', cwd=directory, allow_failure=True)
    if head.returncode or status.returncode:
        return 'unknown'
    return head.stdout.strip() + ('-dirty' if status.stdout.strip() else '')


def worker_command(worker, workdir, route, read_only):
    return [str(worker), *(['--read-only'] if read_only else []), str(workdir), *route]


def _regular_file(path):
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def load_boundary(entry_name):
    for path in (POLICY, LAUNCH):
        if not _regular_file(path):
            raise DispatchError(
                f'kstack launch boundary is not installed: {path} is missing or not a regular '
                'file; refusing to start a worker without it')
    loader = importlib.machinery.SourceFileLoader('kstack_policy_module', str(POLICY))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        loader.exec_module(module)
    except Exception as error:
        raise DispatchError(
            f'kstack launch boundary cannot be loaded from {POLICY}: '
            f'{type(error).__name__}; refusing to start a worker without it') from None
    finally:
        sys.dont_write_bytecode = previous
    for name, kind in (('child_env', 'no child_env'), ('wrap_argv', 'no wrap_argv')):
        if not callable(getattr(module, name, None)):
            raise DispatchError(
                f'kstack launch boundary cannot be loaded from {POLICY}: {kind}; '
                'refusing to start a worker without it')
    try:
        launch = json.loads(LAUNCH.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise DispatchError(
            f'kstack launch boundary cannot be read: {LAUNCH}: {type(error).__name__}; '
            'refusing to start a worker without it') from None
    entry = launch.get(entry_name) if isinstance(launch, dict) else None
    if not isinstance(entry, dict):
        raise DispatchError(
            f'kstack launch boundary has no entry {entry_name} in {LAUNCH}; '
            'refusing to start a worker without it')
    return module, entry


def _check_bwrap(command):
    if command[0] == 'bwrap' and shutil.which('bwrap') is None:
        raise DispatchError('bwrap is not installed; the kstack launch boundary needs it')


def gate_step(main, root, card_id, worktree, branch):
    scope = read_scope(main, card_id)
    refresh_base(main, card_id, branch, scope)
    states = current_states(scope)
    started = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    done = subprocess.run(GATE, shell=True, cwd=worktree, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, errors='replace')
    ended = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    write_evidence(main, card_id, 'gate.log', done.stdout)
    path = write_evidence(main, card_id, 'gate.json', json.dumps({
        'schema': GATE_SCHEMA,
        'command': GATE,
        'cwd': str(worktree),
        'exit': done.returncode,
        'started_utc': started,
        'ended_utc': ended,
        'log': 'gate.log',
        'states': states,
    }, indent=2) + '\n')
    print(f'gate exit {done.returncode}')
    print(f'gate.json {path}')
    tail = '\n'.join(done.stdout.splitlines()[-40:])
    return done.returncode, tail or '(no output)'


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


def review_brief(main, wt, branch, card, diff, untracked, gate_code, gate_tail,
                 fixcheck_block=''):
    return REVIEW_BRIEF.format(
        opening=_opening(), never=_never(main, wt), wt=wt, id=card.id, branch=branch,
        card_text=card.text, diff=diff, untracked_lines=_untracked_lines(untracked),
        gate_block=_gate_block(gate_code, gate_tail), fixcheck_block=fixcheck_block)


def main_review_brief(main, root, card, diff, untracked, gate_code, gate_tail):
    return MAIN_REVIEW_BRIEF.format(
        opening=_opening(), never=_never(main, root), root=root, id=card.id, card_text=card.text,
        diff=diff, untracked_lines=_untracked_lines(untracked),
        gate_block=_gate_block(gate_code, gate_tail))


def _unquote(line):
    line = line.strip()
    if len(line) >= 2 and line.startswith('`') and line.endswith('`'):
        return line[1:-1]
    return line


def summarize_ambiguity(text, ids):
    lines = [_unquote(line) for line in text.splitlines()]
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


def run_worker(agents, name, workdir, route, brief, read_only, worker=WORKER, changed=None, env=None):
    entry_name = WRITE_ENTRY if not read_only else READ_ONLY_ENTRY
    module, entry = load_boundary(entry_name)
    provider = route[1] if len(route) > 1 else ''
    environment = module.child_env(entry, provider,
                                   dict(env if env is not None else os.environ))
    command = module.wrap_argv(entry, worker_command(worker, workdir, route, read_only))
    _check_bwrap(command)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    answer, log, stdout, stderr = _open_outputs(agents, stamp, name)
    with stdout, stderr:
        code = subprocess.run(command, input=brief, text=True,
                              stdout=stdout, stderr=stderr, env=environment).returncode
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
    issue_branch(root)
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
    tier = card_tier(card)
    lineage = implementer_lineage(WORKER_ROUTE)
    if not args.no_worker:
        module, entry = load_boundary(WRITE_ENTRY)
        _check_bwrap(module.wrap_argv(entry, ['true']))
    if git('status', '--porcelain', cwd=root).stdout.strip():
        print(f'warning: the checkout has uncommitted changes; the worktree starts from {branch}')
    (main / 'reports/worktrees').mkdir(parents=True, exist_ok=True)
    added = git('worktree', 'add', '-b', card_branch, worktree, branch, cwd=root,
                allow_failure=True)
    if added.returncode:
        _discard_worktree(root, worktree, card_branch)
        raise DispatchError(f'git worktree add failed: {added.stderr.strip()}')
    has_gate = (worktree / 'bin/gate.py').is_file()
    try:
        record = scope_record(root, card, worktree, branch, tier, lineage)
        scope = write_scope(main, card.id, record)
    except (OSError, DispatchError) as error:
        _discard_worktree(root, worktree, card_branch)
        raise DispatchError(f'cannot write scope.json: {error}') from None
    print(f'worktree {worktree}')
    print(f'land {branch}')
    print(f'scope {scope}')
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
    branch = issue_branch(root)
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
    card = find_card(root, args.id)
    worktree = _worktree(main, card.id)
    if not worktree.is_dir():
        raise DispatchError(f'no worktree {worktree}')
    head = git('symbolic-ref', '--quiet', '--short', 'HEAD', cwd=worktree, allow_failure=True)
    if head.returncode or head.stdout.strip() != f'card/{card.id}':
        raise DispatchError(f'the worktree is not on card/{card.id}')
    scope = read_scope(main, card.id)
    refresh_base(main, card.id, branch, scope)
    directory = evidence_dir(main, card.id)
    records = []
    for path in directory.glob('review-*.json'):
        match = re.fullmatch(r'review-([0-9]+)\.json', path.name)
        if match:
            records.append((int(match.group(1)), path))
    all_records = []
    history = []
    required = []
    whole = set()
    for n, path in sorted(records):
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
        except ValueError:
            raise DispatchError(f'bad review record {path}') from None
        kind = record.get('kind') if isinstance(record, dict) else None
        if (not isinstance(record, dict) or type(record.get('seq')) is not int
                or record['seq'] != n or kind not in REVIEW_KINDS
                or (kind in ('round', 'fixcheck') and not isinstance(record.get('state'), dict))
                or (kind == 'round' and not (type(record.get('round')) is int
                                             and record['round'] >= 1))):
            raise DispatchError(f'bad review record {path}')
        all_records.append((path, record))
        if kind in ('round', 'fixcheck'):
            required.append(record)
            try:
                _, complete = parse_answer(record['answer'])
            except OSError:
                raise DispatchError(f'bad review record {path}: cannot read '
                                    f'{record["answer"]}') from None
            if type(record.get('exit')) is int and record['exit'] == 0 and complete:
                whole.add(record['seq'])
                history.append(record)
    latest = history[-1] if history else None
    last_required = required[-1] if required else None
    numbers = [int(match.group(1)) for path in directory.iterdir()
               if (match := re.match(r'^review-([0-9]+)\.', path.name))]
    seq = max(numbers, default=0) + 1
    if args.kind == 'fixcheck' and latest is None:
        raise DispatchError('review --kind fixcheck needs an earlier round or fixcheck')
    if args.kind == 'supplement' and last_required is None:
        raise DispatchError('review --kind supplement needs an earlier round or fixcheck')
    if args.kind == 'supplement' and last_required['seq'] not in whole:
        raise DispatchError(
            f'run {last_required["seq"]} was cut off; rerun it (the derived kind gives the same '
            'kind, and the same covers_from for a fix check); its UNREAD/DENIED lines are passed '
            'over once a whole run stands in, and a supplement then covers the whole rerun if that '
            'one has such lines')
    rows = read_findings(directory)
    for path, record in all_records:
        if record['kind'] == 'optional':
            continue
        try:
            findings, _ = parse_answer(record['answer'])
        except OSError:
            raise DispatchError(f'bad review record {path}: cannot read {record["answer"]}') from None
        for index in range(1, len(findings) + 1):
            finding_id = f'{record["seq"]}.{index}'
            if rows is None or finding_id not in rows:
                raise DispatchError(f'dispose the findings of run {record["seq"]} first: '
                                    f'findings.tsv has no row {finding_id}')
            disposition, detail = rows[finding_id]
            if disposition not in ('fixed', 'wrong', 'open') or not detail:
                raise DispatchError(f'dispose the findings of run {record["seq"]} first: '
                                    f'row {finding_id} needs fixed, wrong or open and a detail')
    if not (worktree / 'bin/gate.py').is_file():
        print('gate skipped: no bin/gate.py')
        gate_code, gate_tail = None, ''
    else:
        states = current_states(scope)
        gate_path = directory / 'gate.json'
        log_path = directory / 'gate.log'
        gate_code, gate_tail = None, ''
        if gate_path.exists() and log_path.exists():
            try:
                gate_record = json.loads(gate_path.read_text(encoding='utf-8'))
            except ValueError:
                gate_record = None
            if (isinstance(gate_record, dict) and type(gate_record.get('exit')) is int
                    and gate_record.get('states') == states):
                gate_code = gate_record['exit']
                gate_tail = '\n'.join(
                    log_path.read_text(encoding='utf-8', errors='replace').splitlines()[-40:])
                gate_tail = gate_tail or '(no output)'
                print(f'gate reused gate.json (exit {gate_code})')
        if gate_code is None:
            gate_code, gate_tail = gate_step(main, root, card.id, worktree, branch)
        if gate_code != 0:
            raise DispatchError(f'the gate exited {gate_code}; the review does not start')
    state = repo_states(scope)
    for entry in scope['repos']:
        tree = git('rev-parse', 'HEAD^{tree}', cwd=entry['path']).stdout.strip()
        if state[entry['name']] != tree:
            raise DispatchError(f'commit the worktree first: {entry["name"]} has changes '
                                'that HEAD does not hold')
    heads = {entry['name']: git('rev-parse', 'HEAD', cwd=entry['path']).stdout.strip()
             for entry in scope['repos']}
    bases = {entry['name']: entry['base'] for entry in scope['repos']}
    lineage = implementer_lineage(REVIEW_ROUTE)
    rounds = [record for record in history if record['kind'] == 'round']
    latest_round = rounds[-1] if rounds else None
    first_round = next((record for record in rounds if record['round'] == 1), None)
    round2_case = False
    if first_round is not None and not any(record['round'] == 2 for record in rounds):
        for record in required:
            if record['kind'] != 'fixcheck' or record['seq'] <= first_round['seq']:
                continue
            if record['state'] == state:
                continue
            findings, _ = parse_answer(record['answer'])
            for index, line in enumerate(findings, 1):
                match = FINDING.match(line)
                disposition = (rows or {}).get(f'{record["seq"]}.{index}', ('', ''))[0]
                if (match and match.group('sev').lower() == 'high'
                        and disposition == 'fixed'):
                    round2_case = True
                    break
            if round2_case:
                break
    round2_number = None
    if round2_case:
        derived = 'round'
        round2_number = 1 + max((record['round'] for record in rounds), default=0)
    elif latest_round is not None and latest_round['state'] == state and not any(
            record['lineage'] == lineage and record['round'] == latest_round['round']
            for record in rounds):
        derived = 'round'
    elif not rounds:
        derived = 'round'
    else:
        derived = 'fixcheck'
    if args.kind is None:
        kind = derived
        print(f'kind {derived} (derived)')
    elif args.kind in ('supplement', 'optional') or args.kind == derived:
        kind = args.kind
        if args.kind == derived:
            print(f'kind {derived} (derived)')
    else:
        if not args.reason:
            raise DispatchError(f'--kind {args.kind} differs from the derived kind {derived}; '
                                'pass --reason to override')
        print(f'kind {args.kind} instead of derived {derived}: {args.reason}')
        kind = args.kind
    round_number = None
    if kind == 'round':
        if round2_number is not None:
            round_number = round2_number
        elif latest_round is not None and latest_round['state'] == state:
            round_number = latest_round['round']
        else:
            round_number = 1 + max((record['round'] for record in rounds), default=0)
    covers = last_required['seq'] if kind == 'supplement' else None
    covers_from = latest['state'] if kind == 'fixcheck' else None
    base = git('merge-base', 'HEAD', branch, cwd=worktree).stdout.strip()
    diff = git('diff', base, cwd=worktree).stdout
    untracked = [str(worktree / path) for path in _untracked(worktree)]
    fixcheck_block = ''
    if kind == 'fixcheck':
        covered = latest
        covered_heads = covered.get('heads')
        covered_bases = covered.get('bases')
        if not isinstance(covered_heads, dict) or LAND_REPO not in covered_heads:
            print(f'warning: run {covered["seq"]} has no heads; '
                  'the fix check shows the full diff')
        else:
            old_base = (covered_bases.get(LAND_REPO)
                        if isinstance(covered_bases, dict) else None)
            covered_head = covered_heads[LAND_REPO]
            if old_base is None or old_base == bases[LAND_REPO]:
                delta = git('diff', covered_head, 'HEAD', cwd=worktree).stdout
                body = (f'This run is a fix check of run {covered["seq"]}. '
                        f'Change since that run (`git diff {covered_head} HEAD`):\n\n'
                        f'```diff\n{delta}```')
            else:
                delta = git('range-diff', f'{old_base}..{covered_head}',
                            f'{bases[LAND_REPO]}..HEAD', cwd=worktree).stdout
                body = (f'This run is a fix check of run {covered["seq"]}. The base moved since '
                        'that run, so here is how the card\'s own diff changed '
                        f'(`git range-diff {old_base}..{covered_head} '
                        f'{bases[LAND_REPO]}..HEAD`):\n\n'
                        f'```text\n{delta}```')
            sources = [covered]
            if covered['kind'] == 'round':
                for record in reversed(history[:-1]):
                    if (record['kind'] == 'fixcheck'
                            or record['round'] != covered['round']
                            or record['state'] != covered['state']):
                        break
                    sources.append(record)
                sources.reverse()
            lines = []
            for record in sources:
                findings, _ = parse_answer(record['answer'])
                for index, line in enumerate(findings, 1):
                    finding_id = f'{record["seq"]}.{index}'
                    disposition, detail = (rows or {}).get(finding_id, ('', ''))
                    lines.append(f'- {finding_id} | {disposition} | {detail} | {line}')
            listed = '\n'.join(lines) if lines else '- none'
            fixcheck_block = ('\n' + body + '\n\nFindings of the covered run, as the lead disposed '
                              'them (id | disposition | detail | finding):\n' + listed +
                              '\n\nCheck that each finding disposed `fixed` is fixed by the '
                              'change, and report any defect the change adds.\n')
    brief = review_brief(main, worktree, branch, card, diff, untracked, gate_code, gate_tail,
                         fixcheck_block=fixcheck_block)
    events = directory / f'review-{seq}.events.jsonl'
    directory.mkdir(parents=True, exist_ok=True)
    argv = worker_command(worker, worktree, REVIEW_ROUTE, True)
    code, answer = run_worker(
        main / 'reports/agents', f'review-{card.id}', worktree, REVIEW_ROUTE, brief,
        read_only=True, worker=worker,
        env={**os.environ, 'RUN_WORKER_EVENTS': str(events)})
    log = answer.with_suffix('.log')
    if any(line.startswith('run-worker.sh: RUN_WORKER_EVENTS ')
           for line in log.read_text(encoding='utf-8', errors='replace').splitlines()):
        print('no review record: the wrapper refused the events file')
        return code
    state_after = repo_states(scope)
    if code != 0 and kind != 'optional':
        print(f'review-{seq}.json written as optional: the reviewer exited {code}')
        kind = 'optional'
    if code == 0 and kind in ('round', 'fixcheck'):
        findings, complete = parse_answer(answer)
        if not complete:
            if findings:
                print(f'review-{seq}.json keeps kind {kind}: the answer is incomplete but has '
                      f'{len(findings)} finding lines')
            else:
                print(f'review-{seq}.json written as optional: the answer is incomplete and '
                      'has no finding')
                kind = 'optional'
    if kind == 'optional':
        round_number, covers, covers_from = None, None, None
    rev = runtime_rev()
    if rev == 'unknown':
        print('warning: runtime revision unknown')
    path = write_evidence(main, card.id, f'review-{seq}.json', json.dumps({
        'schema': REVIEW_SCHEMA,
        'seq': seq,
        'kind': kind,
        'round': round_number,
        'covers': covers,
        'argv': argv,
        'exit': code,
        'answer': str(answer),
        'events': str(events),
        'stderr': str(log),
        'runtime_rev': rev,
        'host': socket.gethostname(),
        'lineage': implementer_lineage(REVIEW_ROUTE),
        'state': state,
        'state_after': state_after,
        'covers_from': covers_from,
        'heads': heads,
        'bases': bases,
    }, indent=2) + '\n')
    print(f'review-{seq}.json {path}')
    findings, _ = parse_answer(answer)
    for index, line in enumerate(findings, 1):
        print(f'finding {seq}.{index} {line}')
    return code


def _gate(args, root):
    branch = issue_branch(root)
    main = main_checkout(root)
    find_card(root, args.id)
    worktree = _worktree(main, args.id)
    if not worktree.is_dir():
        raise DispatchError(f'no worktree {worktree}')
    read_scope(main, args.id)
    if not (worktree / 'bin/gate.py').is_file():
        raise DispatchError(f'no bin/gate.py in {worktree}')
    if _status_paths(worktree):
        print('warning: the worktree has uncommitted changes; gate.json holds their state, '
              'so commit exactly this tree')
    return gate_step(main, root, args.id, worktree, branch)[0]


def utc_stamp():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def _shadow_path(agents):
    return Path(agents) / 'accept-shadow.tsv'


def _scope_tier(evidence):
    try:
        record = json.loads((Path(evidence) / 'scope.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return ''
    tier = record.get('tier') if isinstance(record, dict) else None
    return tier if isinstance(tier, str) else ''


def _copy_accept(evidence, utc):
    evidence = Path(evidence)
    target = evidence / f'accept-{utc}.json'
    index = 2
    while target.exists():
        target = evidence / f'accept-{utc}-{index}.json'
        index += 1
    shutil.copyfile(evidence / 'accept.json', target)
    return target


def _accept_record(agents, evidence, card_id):
    record = {
        'utc': utc_stamp(),
        'card': card_id,
        'tier': _scope_tier(evidence),
        'verdict': 'error',
        'exit': '',
        'reasons': '',
        'commits': '',
        'copy': None,
        'step_error': None,
    }
    try:
        done = subprocess.run([str(ACCEPT), 'check', str(agents), card_id],
                              capture_output=True, text=True)
        sys.stdout.write(done.stdout)
        sys.stderr.write(done.stderr)
        if done.returncode < 0:
            raise ChildProcessError(f'kstack-accept check killed by signal {-done.returncode}')
        record['exit'] = done.returncode
        record['verdict'] = {0: 'accept', 1: 'refuse'}.get(done.returncode, 'error')
        if done.returncode in (0, 1):
            copy = _copy_accept(evidence, record['utc'])
            copied = json.loads(copy.read_text(encoding='utf-8'))
            record['commits'] = ';'.join(f'{name}={commit}' for name, commit
                                         in copied['commits'].items())
            record['copy'] = copy
            lines = [line for line in done.stdout.splitlines() if line.strip()]
            record['reasons'] = ';'.join(line.split()[0] for line in lines[:-1])
    except Exception as error:
        record.update(verdict='error', exit='', reasons=f'exception:{type(error).__name__}',
                      commits='', copy=None, step_error=error)
        print(f'warning: kstack-accept step failed: {type(error).__name__}: {error}',
              file=sys.stderr)
    return record


def _shadow_line(record, old_land):
    copy = record['copy']
    return '\t'.join([record['utc'], record['card'], record['tier'], record['verdict'],
                      str(record['exit']), record['reasons'], record['commits'], old_land,
                      str(copy) if copy is not None else '']) + '\n'


def _error_record(record, error):
    return {**record, 'verdict': 'error', 'exit': '',
            'reasons': f'exception:{type(error).__name__}', 'commits': '', 'copy': None}


def _append_row(agents, line):
    path = _shadow_path(agents)
    with path.open('a', encoding='utf-8') as handle:
        if path.stat().st_size == 0:
            handle.write(SHADOW_HEADER + '\n')
        handle.write(line)


def _shadow_warning(agents, error, record, old_land):
    print(f'warning: kstack-accept shadow row not written: {error}', file=sys.stderr)
    try:
        _append_row(agents, _shadow_line(_error_record(record, error), old_land))
    except OSError as second:
        print(f'warning: kstack-accept shadow row not written: {second}', file=sys.stderr)


def _append_shadow(agents, record, old_land):
    try:
        _append_row(agents, _shadow_line(record, old_land))
    except OSError as error:
        _shadow_warning(agents, error, record, old_land)


def _finish_shadow(handle, agents, record, old_land):
    if handle is None:
        _append_shadow(agents, record, old_land)
        return
    try:
        with handle:
            handle.write(_shadow_line(record, old_land))
    except OSError as error:
        _shadow_warning(agents, error, record, old_land)


def _shadow_stop(error):
    print(f'warning: kstack-accept shadow row not written: {error}', file=sys.stderr)
    raise DispatchError(f'kstack-accept shadow row not written: {error}') from None


def _open_shadow(agents):
    path = _shadow_path(agents)
    try:
        handle = path.open('a', encoding='utf-8')
    except OSError as error:
        _shadow_stop(error)
    try:
        if path.stat().st_size == 0:
            handle.write(SHADOW_HEADER + '\n')
    except OSError as error:
        try:
            handle.close()
        except OSError:
            pass
        _shadow_stop(error)
    return handle


def _recorded_commit(copy):
    try:
        record = json.loads(Path(copy).read_text(encoding='utf-8'))
        return record['commits'][LAND_REPO]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _land(args, root):
    mode = os.environ.get('KSTACK_ACCEPT') or 'off'
    if mode not in ACCEPT_MODES:
        raise DispatchError(f'KSTACK_ACCEPT must be off, shadow or enforce, not {mode}')
    main = main_checkout(root)
    agents = main / 'reports/agents'
    evidence = evidence_dir(main, args.id)
    shadow = None if mode == 'off' else _accept_record(agents, evidence, args.id)
    card_branch = f'card/{args.id}'
    worktree = _worktree(main, args.id)
    try:
        branch = issue_branch(root)
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
        ancestor = git('merge-base', '--is-ancestor', branch, card_branch, cwd=root,
                       allow_failure=True)
        if ancestor.returncode:
            raise DispatchError(f'{branch} has moved since the dispatch. Rebase {card_branch} onto '
                                f'{branch} in {worktree}, run the full gate again, then land again.')
    except DispatchError:
        if shadow is not None:
            _append_shadow(agents, shadow, 'refused')
        raise
    shadow_handle = None
    if mode == 'enforce':
        step_error = shadow['step_error']
        if step_error is not None:
            _append_shadow(agents, shadow, 'refused')
            raise DispatchError(f'kstack-accept step failed: {type(step_error).__name__}: '
                                f'{step_error}')
        if shadow['verdict'] != 'accept':
            _append_shadow(agents, shadow, 'refused')
            print('land refused by kstack-accept (KSTACK_ACCEPT=enforce)', file=sys.stderr)
            return REFUSED_EXIT
        try:
            current = git('rev-parse', card_branch, cwd=root).stdout.strip()
        except DispatchError:
            _append_shadow(agents, shadow, 'refused')
            raise
        if _recorded_commit(shadow['copy']) != current:
            _append_shadow(agents, shadow, 'refused')
            print(f'{card_branch} moved after kstack-accept check; land refused', file=sys.stderr)
            return REFUSED_EXIT
        shadow_handle = _open_shadow(agents)
    merged = git('merge', '--ff-only', '--no-overwrite-ignore', card_branch, cwd=root,
                 allow_failure=True)
    if merged.returncode:
        if shadow is not None:
            _finish_shadow(shadow_handle, agents, shadow, 'failed')
        raise DispatchError(f'the fast-forward failed: {merged.stderr.strip()}')
    if shadow is not None:
        _finish_shadow(shadow_handle, agents, shadow, 'landed')
    for command in (('worktree', 'remove', '--force', worktree), ('branch', '-d', card_branch)):
        done = git(*command, cwd=root, allow_failure=True)
        if done.returncode:
            print(f'warning: landed, but cleanup failed: {done.stderr.strip()}')
    print(f'landed {branch} {git("log", "--oneline", "-1", cwd=root).stdout.strip()}')
    return 0


def _check_ids(ids):
    for card_id in ids:
        if not CARD_ID.fullmatch(card_id):
            raise DispatchError(f'not a card ID: {card_id}')


def main(argv=None, root=ROOT, worker=WORKER):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    verbs = parser.add_subparsers(dest='verb', required=True)
    ambiguity = verbs.add_parser('ambiguity', help='review cards for missing decisions')
    ambiguity.add_argument('ids', nargs='*', metavar='id')
    card = verbs.add_parser('card', help='make the card worktree and run the implementer')
    card.add_argument('id')
    card.add_argument('--no-worker', action='store_true')
    gate = verbs.add_parser('gate', help='refresh the base, run the full gate, and write gate.json')
    gate.add_argument('id')
    review = verbs.add_parser('review', help='run the second reviewer on a worktree or a change')
    review.add_argument('id')
    review.add_argument('--kind', choices=REVIEW_KINDS, default=None)
    review.add_argument('--reason', default=None)
    review.add_argument('--main', nargs='+', metavar='PATH')
    land = verbs.add_parser('land', help='fast-forward the issue branch and remove the worktree')
    land.add_argument('id')
    args = parser.parse_args(argv)
    root = Path(root).resolve()
    try:
        _check_ids(args.ids if args.verb == 'ambiguity' else [args.id])
        if args.verb == 'ambiguity':
            return _ambiguity(args, root, worker)
        if args.verb == 'card':
            return _card(args, root, worker)
        if args.verb == 'gate':
            return _gate(args, root)
        if args.verb == 'review':
            return _review(args, root, worker)
        return _land(args, root)
    except DispatchError as error:
        print(f'dispatch: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
