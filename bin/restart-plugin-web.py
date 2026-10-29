#!/usr/bin/env python3
"""Schedule one authorized restart of the canonical Web unit, not Slack."""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['remote', 'family'])
args = parser.parse_args()
root = Path('/data/softwares/deepseek-harness')
report = Path('/data/softwares/deepseek-harness-plugins/reports/plugin-refresh-20261027')
head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
assert head == '9cef77e8fba8fa6e4f1bc64b85d79a5f6c2533d7', 'Core changed; re-evaluate before restart'
pid = subprocess.check_output(['systemctl', '--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], text=True).strip()
argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
assert argv[1].decode() == str(root / 'apps/cli/lib/bin.js')
assert Path(f'/proc/{pid}/cwd').resolve() == root
record = report / f'restart-{args.phase}.json'
assert not record.exists(), 'Do not repeat a scheduled restart'
unit = f'dsh-plugin-refresh-restart-20261027-{args.phase}'
with record.open('x') as stream:
    os.chmod(record, 0o600)
    json.dump({'unit': unit, 'old_web_pid': pid, 'core_head': head, 'phase': args.phase}, stream, indent=2)
    stream.write('\n')
subprocess.run(['systemd-run', '--user', '--collect', f'--unit={unit}', '--on-active=10s',
                '--timer-property=AccuracySec=1s', '--', '/usr/bin/systemctl', '--user', 'restart',
                'dsh-web-managed.service'], check=True)
print(json.dumps({'scheduled': unit, 'old_web_pid': pid, 'service': 'dsh-web-managed.service'}))
