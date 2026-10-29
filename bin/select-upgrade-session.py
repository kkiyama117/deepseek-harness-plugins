#!/usr/bin/env python3
"""Choose a small existing conversation for private UI text/image acceptance."""
import json
import os
from pathlib import Path
import subprocess

home = Path(os.environ.get('DSH_SMOKE_HOME', '/home/kiyama/.dsh-upgrade-stage-20261005'))
archived = set(json.loads((home / 'storages/workspace.json').read_text())['global']['archivedSessionIds'])
candidates = []
for path in (home / 'sessions').glob('*/*/session.v4.jsonl.zstd'):
    lines = subprocess.check_output(['zstd', '-dc', str(path)]).splitlines()
    rows = [json.loads(line) for line in lines]
    header = rows[0]
    if header.get('delegationDepth', 0) != 0 or header['id'] in archived:
        continue
    titles = [row['data']['title'] for row in rows if row.get('type') == 'session/title']
    messages = [row['data'] for row in rows if row.get('type') == 'user/message' and row['data'].get('source', {}).get('kind') == 'user']
    tool_messages = [row['data'].get('message', {}) for row in rows if row.get('type') == 'tool/result']
    images = [part for msg in messages + tool_messages for part in msg.get('content', []) if part.get('type') == 'image']
    texts = [part['text'] for msg in messages for part in msg.get('content', []) if part.get('type') == 'text' and len(part['text']) >= 12]
    if titles and images and texts:
        image_turn = next((row['data'].get('turn') for row in rows if row.get('type') == 'tool/result' and any(part.get('attachment', {}).get('attachmentId') == images[0]['attachment']['attachmentId'] for part in row['data'].get('message', {}).get('content', []))), None)
        candidates.append((len(rows), {'id': header['id'], 'workspace': Path(header['cwd']).name, 'title': titles[-1], 'text': texts[0][:60], 'tailText': texts[-1][:60], 'image': images[0], 'imageTurn': image_turn, 'events': len(rows), 'journalRelative': str(path.relative_to(home))}))
if not candidates:
    raise RuntimeError('No small existing image-bearing conversation found')
_, selected = min(candidates, key=lambda item: item[0])
output = home / 'session-acceptance.json'
output.write_text(json.dumps(selected, ensure_ascii=False, indent=2) + '\n')
output.chmod(0o600)
print(json.dumps({key: selected[key] for key in ['id', 'workspace', 'title', 'events']}, ensure_ascii=False))
