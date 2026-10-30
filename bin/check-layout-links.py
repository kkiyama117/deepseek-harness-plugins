#!/usr/bin/env python3
"""Report local Markdown links broken by the plugin-layout migration.

Compare targets with tracked files at HEAD, so absent local caches and generated
artifacts in a fresh worktree are not mistaken for migration regressions.
"""
from pathlib import Path, PurePosixPath
import re
import subprocess
from urllib.parse import unquote

root = Path(__file__).resolve().parent.parent
tracked_before = set(subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '-z', 'HEAD'], cwd=root).decode().split('\0'))
tracked_now = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
link_pattern = re.compile(r'(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)')
errors = []
checked = 0
for name in tracked_now:
    if not name.endswith('.md'):
        continue
    file = root / name
    if not file.is_file():
        continue
    parts = PurePosixPath(name).parts
    # HEAD may already contain the new layout; only map back when it does not.
    moved = name not in tracked_before and len(parts) > 2 and parts[0] in ('plugins', 'configs')
    old_name = PurePosixPath(*parts[1:]) if moved else PurePosixPath(name)
    for raw in link_pattern.findall(file.read_text(encoding='utf-8', errors='replace')):
        link = unquote(raw.split(' ', 1)[0].strip('<>').split('#', 1)[0].split('?', 1)[0])
        if not link or link.startswith('/') or re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', link):
            continue
        checked += 1
        if (file.parent / link).exists():
            continue
        old_target = (root / old_name.parent / link).resolve()
        try:
            old_relative = old_target.relative_to(root).as_posix()
        except ValueError:
            continue
        if old_relative in tracked_before or any(path.startswith(old_relative + '/') for path in tracked_before):
            errors.append((name, link))
print(f'Checked {checked} local links; {len(errors)} newly broken tracked targets')
for name, link in errors:
    print(f'{name}: {link}')
raise SystemExit(bool(errors))
