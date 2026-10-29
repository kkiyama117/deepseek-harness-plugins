#!/usr/bin/env python3
"""Reject noncanonical DSH service launches and temporary profile dependencies."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path('/data/softwares/deepseek-harness')
NODE = Path('/home/kiyama/.local/share/mise/installs/node/latest/bin/node')
HOME = Path('/home/kiyama/.dsh')
SERVICES = {
    'dsh-web-managed.service': 'web',
    'slack-intake-bridge.service': 'headless',
    'ai-reference-store-daily.service': 'ai-reference-store-daily',
}


class PlacementError(Exception):
    """A deployment path violates the local placement policy."""


def require(condition, message):
    if not condition:
        raise PlacementError(message)


def bus(*args):
    result = subprocess.run(['busctl', '--user', '--json=short', *args], check=True,
                            capture_output=True, text=True, timeout=10)
    return json.loads(result.stdout)['data']


def service_properties(unit):
    path = bus('call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
               'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit)[0]
    def prop(name):
        return bus('get-property', 'org.freedesktop.systemd1', path,
                   'org.freedesktop.systemd1.Service', name)
    return prop('ExecStart'), prop('WorkingDirectory'), prop('ExecStartPre')


def check_command(commands, cwd, profile):
    require(ROOT.resolve(strict=True) == ROOT and (ROOT / '.git').is_dir(),
            'canonical checkout must be the main Git checkout, not a symlink/worktree')
    require(len(commands) == 1, 'exactly one ExecStart command is required')
    executable, argv = commands[0][:2]
    cli = str(ROOT / 'apps/cli/lib/bin.js')
    require(Path(cli).resolve(strict=True) == Path(cli), 'CLI must not resolve outside canonical checkout')
    if profile == 'ai-reference-store-daily':
        wrapper = str(HOME / 'profiles/ai-reference-store-daily/daily-start.sh')
        require(executable == '/bin/bash' and len(argv) >= 7 and argv[1] == wrapper,
                'daily service must use its supported daily-start.sh wrapper')
        offset = 4 if argv[2:3] == ['--check-placement'] else 0
        require(len(argv) >= 7 + offset, 'incomplete daily launcher arguments')
        node_arg, cli_arg = argv[5 + offset:7 + offset]
    else:
        require(len(argv) >= 2, 'missing DSH CLI argument')
        node_arg, cli_arg = executable, argv[1]
    require(cli_arg == cli, f'noncanonical CLI: {cli_arg}; expected {cli}')
    require(Path(node_arg).resolve(strict=True) == NODE.resolve(strict=True),
            'unexpected Node executable')
    if profile == 'web':
        require(cwd == str(ROOT), f'noncanonical Web WorkingDirectory: {cwd}')


def check_dependency(path):
    resolved = path.resolve(strict=True)
    require(not any(resolved.is_relative_to(base) for base in
                    [Path('/tmp'), Path('/var/tmp'), Path('/run')]),
            f'temporary dependency: {path}')
    require(not {'.artifacts', '.dsh-maintenance'}.intersection(resolved.parts),
            f'staging artifact dependency: {path}')
    if resolved.is_file():
        return
    for parent in [resolved, *resolved.parents]:
        git = parent / '.git'
        if git.is_file():
            require(False, f'linked Git worktree dependency: {path}')
        if git.is_dir():
            break


def check_profile(profile):
    directory = HOME / 'profiles' / profile
    for name in ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules/.modules.yaml']:
        config = directory / name
        if not config.exists():
            continue
        text = config.read_text()
        forbidden = ['deepseek-harness-master', 'deepseek-harness-0.1.5',
                     'deepseek-harness-preupgrade-20261013', 'deepseek-harness-upgrade-master',
                     '.dsh-maintenance']
        require(not any(value in text for value in forbidden),
                f'obsolete deployment reference in package-manager configuration: {config}')
    manifest = json.loads((directory / 'package.json').read_text())
    for name, spec in manifest.get('dependencies', {}).items():
        if spec.startswith(('link:', 'file:')):
            source = Path(os.path.expanduser(spec.split(':', 1)[1]))
            check_dependency(source if source.is_absolute() else directory / source)
        check_dependency(directory / 'node_modules' / name)


def check_unit(unit, profile, require_installed=False):
    commands, cwd, pre = service_properties(unit)
    if require_installed:
        expected = ['/usr/bin/python3', '-B', str(Path(__file__).resolve()),
                    '--unit', unit, '--profile', profile]
        daily_guard = (profile == 'ai-reference-store-daily' and len(commands) == 1
                       and commands[0][1][2:6] == ['--check-placement', str(Path(__file__).resolve()), unit, profile])
        require(daily_guard or any(row[1] == expected and row[2] is False for row in pre),
                f'mandatory ExecStartPre or post-readiness guard is missing or ignored: {unit}')
    check_command(commands, cwd, profile)
    check_profile(profile)
    print(f'PLACEMENT_OK {unit} {profile}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unit')
    parser.add_argument('--profile', choices=sorted(set(SERVICES.values())))
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args()
    if args.all and not args.unit and not args.profile:
        targets = SERVICES.items()
    elif not args.all and args.unit and args.profile:
        targets = [(args.unit, args.profile)]
    else:
        parser.error('use --all or both --unit and --profile')
    try:
        for unit, profile in targets:
            check_unit(unit, profile, require_installed=args.all)
    except (PlacementError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'PLACEMENT_DENIED: {error}. Restore the canonical checkout/configuration; do not disable the guard.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
