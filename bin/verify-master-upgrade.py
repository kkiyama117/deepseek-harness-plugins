#!/usr/bin/env python3
"""Run bounded zero-model deployment probes and retain private diagnostics."""
import os
from pathlib import Path
import subprocess
import sys

root = Path('/data/softwares/deepseek-harness-upgrade-master')
home = Path('/home/kiyama/.dsh-upgrade-stage-20261005')
env = dict(os.environ, DSH_HOME=str(home), DSH_TELEMETRY_DISABLED='1')
node = '/home/kiyama/.local/share/mise/installs/node/latest/bin/node'
commands = {
    'boot': ['web', '--patch', str(home / 'boot-probe.patch.yml'), '--port', '0', '--no-open'],
    'daily': ['--profile', 'ai-reference-store-daily', 'daily', 'check'],
}
for mode in sys.argv[1:] or ['boot', 'daily']:
    argv = commands[mode]
    result = subprocess.run([node, str(root / 'apps/cli/lib/bin.js'), *argv], cwd=root, env=env,
                            capture_output=True, text=True, timeout=90)
    output = result.stdout + result.stderr
    log = home / f'verify-{mode}.log'
    log.write_text(output)
    log.chmod(0o600)
    assert result.returncode == 0, f'{mode} failed, exit={result.returncode}; {log}'
    assert 'did not activate' not in output and 'failed to import' not in output, f'{mode}: inactive plugin; {log}'
    print(f'{mode}: exit=0, no inactive-plugin warnings; {log}')
