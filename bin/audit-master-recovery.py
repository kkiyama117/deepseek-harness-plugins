#!/usr/bin/env python3
"""Compare recovery/current Session roots without displaying conversation bodies."""
import hashlib
from datetime import datetime
import json
from pathlib import Path
import subprocess

original = Path('/home/kiyama/.dsh/sessions')
recovery = Path('/home/kiyama/.dsh-recovery-20261005/sessions')
def inventory(root):
    return {path.name: path for project in root.iterdir() if project.is_dir() for path in project.iterdir() if path.is_dir()}
a, b = inventory(original), inventory(recovery)
changed = []
for sid in sorted(a.keys() & b.keys()):
    for predecessor in a[sid].glob('session.v[23].jsonl.zstd'):
        other = b[sid] / predecessor.name
        if other.exists() and hashlib.sha256(predecessor.read_bytes()).digest() != hashlib.sha256(other.read_bytes()).digest():
            changed.append({'id': sid, 'generation': predecessor.name})
new_only = []
for sid in sorted(a.keys() - b.keys()):
    files = sorted(a[sid].glob('session.v*.jsonl.zstd'))
    rows = [json.loads(line) for line in subprocess.check_output(['zstd', '-dc', str(files[-1])]).splitlines()]
    new_only.append({'id': sid, 'path': str(a[sid]), 'userMessages': sum(row.get('type') == 'user/message' and row.get('data', {}).get('source', {}).get('kind') == 'user' for row in rows)})
# The failed new runtime was available briefly after the completed migration.
cutover_start = int(datetime.fromisoformat('2026-10-05T03:00:00+09:00').timestamp() * 1000)
new_runtime_users = []
for sid, folder in a.items():
    file = folder / 'session.v4.jsonl.zstd'
    if not file.exists():
        continue
    for line in subprocess.check_output(['zstd', '-dc', str(file)]).splitlines():
        row = json.loads(line)
        if row.get('type') == 'user/message' and row.get('time', 0) >= cutover_start and row['data'].get('source', {}).get('kind') == 'user':
            new_runtime_users.append({'id': sid, 'seq': row['seq'], 'time': row['time']})
result = {'originalSessions': len(a), 'recoverySessions': len(b), 'changedRecoveryGenerations': changed,
          'originalOnly': new_only, 'recoveryOnly': sorted(b.keys() - a.keys()), 'newRuntimeUserMessages': new_runtime_users}
output = Path('/home/kiyama/.dsh/backups/master-upgrade-20261005/recovery-audit.json')
output.write_text(json.dumps(result, indent=2) + '\n')
output.chmod(0o600)
print(json.dumps(result, indent=2))
