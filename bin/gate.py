#!/usr/bin/env python3
"""Run the checks of every package changed since a base ref, plus the document checks."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CHECK_KEYS = ('cwd', 'run', 'env')


class GateError(Exception):
    pass


class GitFailure(Exception):
    def __init__(self, argv, stderr):
        super().__init__(stderr)
        self.argv = argv
        self.stderr = stderr


def say(message):
    print(message, flush=True)


def package_of(path):
    parts = path.split('/')
    if path.endswith('.md'):
        return None
    if len(parts) >= 5 and parts[0] == 'plugins' and parts[1] == 'dsh-web-ui' and parts[2] == 'packages':
        return '/'.join(parts[:4])
    if len(parts) >= 3 and parts[0] in ('plugins', 'presets', 'configs', 'skills'):
        return '/'.join(parts[:2])
    if len(parts) >= 2:
        return parts[0]
    return '.'


def validate_check(root, package, check):
    if not isinstance(check, dict):
        raise GateError(f'{package}: a check is not an object')
    if set(check) - set(CHECK_KEYS) or 'cwd' not in check or 'run' not in check:
        raise GateError(f'{package}: a check has keys other than cwd, run and env')
    cwd, run = check['cwd'], check['run']
    if not isinstance(cwd, str):
        raise GateError(f'{package}: cwd is not a string')
    if not isinstance(run, str) or not run.strip():
        raise GateError(f'{package}: run is not a non-empty string')
    if PurePosixPath(cwd).is_absolute():
        raise GateError(f'{package}: cwd is absolute')
    if '\0' in cwd:
        raise GateError(f'{package}: cwd is not a valid path')
    resolved = (root / cwd).resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise GateError(f'{package}: cwd is outside the root') from None
    if not resolved.is_dir():
        raise GateError(f'{package}: cwd is not a directory')
    if 'env' in check:
        env = check['env']
        if not isinstance(env, dict):
            raise GateError(f'{package}: env is not an object')
        for name, value in env.items():
            if not isinstance(value, str):
                raise GateError(f'{package}: env {name} is not a string')


def load_checks(root):
    root = Path(root).resolve()
    path = root / 'bin' / 'gate-checks.json'
    try:
        text = path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError) as error:
        raise GateError(f'cannot read {path}: {error}')
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise GateError(f'invalid JSON: {error}')
    if not isinstance(data, dict):
        raise GateError('the top-level value is not an object')
    for package, entries in data.items():
        if not isinstance(entries, list):
            raise GateError(f'{package}: the value is not a list')
        if not entries:
            raise GateError(f'{package}: the list is empty')
        for check in entries:
            validate_check(root, package, check)
    return data


def check_env(check):
    env = dict(os.environ)
    for name, value in check.get('env', {}).items():
        env.setdefault(name, value)
    return env


def run_git(root, argv, env):
    result = subprocess.run(['git', *argv], cwd=root, env=env, capture_output=True)
    if result.returncode != 0:
        raise GitFailure(['git', *argv], result.stderr.decode('utf-8', errors='replace').strip())
    return os.fsdecode(result.stdout)


def work_items(checks, keys):
    items = []
    for key in keys:
        entries = checks.get(key)
        if entries is None:
            items.append((key, None))
        else:
            items.extend((key, check) for check in entries)
    return items


def run_in_index_copy(root, base, checks):
    with tempfile.TemporaryDirectory() as temporary:
        environment = dict(os.environ)
        index_copy = Path(temporary) / 'index'
        object_directory = Path(temporary) / 'objects'
        object_directory.mkdir()
        index_path = run_git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], environment).strip()
        objects_path = run_git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], environment).strip()
        shutil.copyfile(index_path, index_copy)
        environment.update(GIT_INDEX_FILE=str(index_copy),
                           GIT_OBJECT_DIRECTORY=str(object_directory),
                           GIT_ALTERNATE_OBJECT_DIRECTORIES=objects_path)
        untracked = [name for name in run_git(root, ['ls-files', '--others', '--exclude-standard', '-z'], environment).split('\0') if name]
        if untracked:
            run_git(root, ['add', '--intent-to-add', '--', *untracked], environment)
        changed = [name for name in run_git(root, ['diff', '--name-only', '--no-renames', '-z', base], environment).split('\0') if name]

        keys = sorted({package_of(name) for name in changed} - {None})
        failures = []
        ran = 0
        for key, check in work_items(checks, keys):
            if check is None:
                if not (root / key).is_dir():
                    say(f'gate: {key}: deleted')
                    continue
                say(f'gate: {key}: no checks defined; add them to bin/gate-checks.json')
                failures.append(key)
                continue
            run = check['run']
            say(f'gate: {key}: {run}')
            code = subprocess.run(run, shell=True, cwd=root / check['cwd'], env=check_env(check)).returncode
            ran += 1
            if code == 0:
                say(f'gate: {key}: ok')
            else:
                say(f'gate: {key}: FAIL (exit {code})')
                failures.append(f'{key}: {run}')

        document_checks = [
            ('python3 bin/check-layout-links.py', ['python3', 'bin/check-layout-links.py']),
            ('git diff --check', ['git', 'diff', '--check', base]),
        ]
        for label, argv in document_checks:
            say(f'gate: docs: {label}')
            code = subprocess.run(argv, cwd=root, env=environment).returncode
            ran += 1
            if code == 0:
                say('gate: docs: ok')
            else:
                say(f'gate: docs: FAIL (exit {code})')
                failures.append(f'docs: {label}')

        if failures:
            say(f'gate: FAIL: {", ".join(failures)}')
            return 1
        say(f'gate: PASS ({ran} checks)')
        return 0


def main(argv=None, root=ROOT):
    root = Path(root).resolve()
    parser = argparse.ArgumentParser(prog='gate.py')
    parser.add_argument('--base', default='origin/main')
    args = parser.parse_args(argv)

    try:
        checks = load_checks(root)
    except GateError as error:
        print(f'gate: invalid bin/gate-checks.json: {error}', file=sys.stderr)
        return 2

    try:
        base = run_git(root, ['merge-base', args.base, 'HEAD'], dict(os.environ)).strip()
    except GitFailure:
        print(f'gate: cannot find the merge base of {args.base} and HEAD', file=sys.stderr)
        return 2

    try:
        return run_in_index_copy(root, base, checks)
    except GitFailure as failure:
        print(f'gate: git failed: {" ".join(failure.argv)}: {failure.stderr}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
