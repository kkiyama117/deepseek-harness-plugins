#!/usr/bin/env python3
"""Compare npm pack file lists against a pre-migration source checkout.

This does not establish that generated files are current or byte-identical.
Both checkouts must already contain any generated package files being compared.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', type=Path, help='Pre-migration checkout')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
baseline = args.baseline.resolve(strict=True)
env = dict(os.environ, npm_config_cache=str(root / '.cache' / 'npm'))
groups = {
    'plugins': 'dsh-evolve dsh-prompt-compact dsh-goal-acceptance dsh-workflow-results dsh-session-cleanup dsh-codex-transport-recovery dsh-open-in-app-icons dsh-request-acceptance-pilot dsh-acceptance-pilot-isolation dsh-aistore-native-preset dsh-slack-intake llm-fallback dsh-web-search dsh-llm-cursor dsh-market dsh-web-ui/packages/dsh-aionui-panel dsh-web-ui/packages/dsh-git-graph dsh-web-ui/packages/dsh-ssh dsh-web-ui/packages/dsh-web-ui-settings dsh-web-ui/packages/dsh-web-ui-all dsh-web-ui/packages/modlens'.split(),
    'configs': 'zotero-mcp chrome-devtools-mcp-config dsh-inspector-origin dsh-slack-worker-config'.split(),
}

def package_files(directory):
    result = subprocess.run(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'], cwd=directory, env=env, text=True, capture_output=True, check=True)
    return {entry['path'] for entry in json.loads(result.stdout)[0]['files']}

failed = []
for category, names in groups.items():
    for name in names:
        try:
            old = package_files(baseline / name)
            new = package_files(root / category / name)
            if old != new:
                failed.append(name)
                print(f'{name}: missing={sorted(old-new)}, added={sorted(new-old)}', flush=True)
            else:
                print(f'{name}: same {len(old)} files', flush=True)
        except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as exc:
            failed.append(name)
            print(f'{name}: {exc}', flush=True)
print(f'Compared {sum(map(len, groups.values()))} packages; {len(failed)} differ or failed')
raise SystemExit(bool(failed))
