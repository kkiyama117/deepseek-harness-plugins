# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Restart the canonical deployment after a checked release build; retain offline state."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.error

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--version', required=True)
parser.add_argument('--backup', type=Path, required=True)
args = parser.parse_args()
os.umask(0o077)
root = Path('/data/softwares/deepseek-harness')
assert root.resolve() == root and (root / '.git').is_dir()
assert args.backup.is_dir()
node = '/home/kiyama/.local/share/mise/installs/node/latest/bin/node'
units = ['dsh-web-managed.service', 'slack-intake-bridge.service']
timer = 'ai-reference-store-daily.timer'

def run(argv, **kwargs):
    return subprocess.run([str(x) for x in argv], check=True, timeout=300, **kwargs)

def record(phase, **extra):
    data = {'phase': phase, 'version': args.version, 'time': time.time(), **extra}
    (args.backup / 'cutover-state.json').write_text(json.dumps(data, indent=2) + '\n')
    print(json.dumps(data), flush=True)

version = subprocess.check_output([node, str(root / 'apps/cli/lib/bin.js'), '--version'], text=True).strip()
assert version == args.version, version
run(['git', '-C', root, 'merge-base', '--is-ancestor', 'dsh-v' + args.version, 'HEAD'])
run(['python3', '-B', Path(__file__).with_name('check-runtime-placement.py'), '--all'])
was_timer_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', timer]).returncode == 0
stopped = False
try:
    if was_timer_active:
        run(['systemctl', '--user', 'stop', timer])
    record('stopping')
    run(['systemctl', '--user', 'stop', *units])
    stopped = True
    record('offline-backup')
    run(['rsync', '-a', '/home/kiyama/.dsh-recovery-20261005/', str(args.backup / 'data-offline') + '/'])
    run(['rsync', '-a', '--exclude=node_modules', '--exclude=backups', '/home/kiyama/.dsh/', str(args.backup / 'home-offline') + '/'])
    record('starting')
    run(['systemctl', '--user', 'start', *units])
    stopped = False
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 90
    while True:
        try:
            with client.open('http://127.0.0.1:3080/', timeout=3) as response:
                assert response.status == 200
                break
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                break
            if time.monotonic() >= deadline:
                raise
        except OSError:
            if time.monotonic() >= deadline:
                raise
        time.sleep(1)
    pid = subprocess.check_output(['systemctl', '--user', 'show', units[0], '-p', 'MainPID', '--value'], text=True).strip()
    assert Path('/proc/' + pid + '/cwd').resolve() == root
    record('running-needs-plugin-update-and-client-verification', pid=pid)
except Exception as error:
    record('failed', error=str(error))
    raise
finally:
    if stopped:
        run(['systemctl', '--user', 'start', *units])
    if was_timer_active:
        run(['systemctl', '--user', 'start', timer])
