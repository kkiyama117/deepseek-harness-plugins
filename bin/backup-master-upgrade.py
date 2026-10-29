#!/usr/bin/env python3
"""Save deployment inputs without caches; refuse to overwrite completed archives."""
import os
from pathlib import Path
import subprocess

os.umask(0o077)
root = Path('/home/kiyama/.dsh/backups/master-upgrade-20261005')
root.mkdir(parents=True, exist_ok=True)
archives = [
    ('plugins-source-complete.tar.gz', '/data/softwares', ['deepseek-harness-plugins'], ['node_modules', '.git', '.pnpm-store', '.dsh-cli']),
    ('dsh-config.tar.gz', '/home/kiyama/.dsh', ['.agent-presets', 'profiles', 'skills', 'AGENTS.md', 'settings.yaml', 'cordis.patch.yml', '.credentials.yaml'], ['node_modules']),
    ('kura-config-and-data.tar.gz', '/home/kiyama', ['.config/kura', '.local/share/kura'], []),
    ('systemd-user.tar.gz', '/home/kiyama', ['.config/systemd/user'], []),
]
for name, cwd, paths, exclusions in archives:
    target = root / name
    if target.exists():
        subprocess.run(['tar', '-tzf', str(target)], check=True, stdout=subprocess.DEVNULL)
        continue
    temp = target.with_suffix('.partial')
    subprocess.run(['tar', *[f'--exclude={x}' for x in exclusions], '-czf', str(temp), '-C', cwd, *paths], check=True)
    subprocess.run(['tar', '-tzf', str(temp)], check=True, stdout=subprocess.DEVNULL)
    temp.rename(target)
    print(target, flush=True)
