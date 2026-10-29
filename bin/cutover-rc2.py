# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Restart the canonical DSH services and verify rc.2 independently of the GUI.

Run under a separate systemd user unit. Offline copies retain the latest user
state. A failure before the listener becomes ready restores the saved runtime;
verification failures after readiness leave rc.2 available for diagnosis.
"""
import http.cookiejar
import json
import os
import re
import sys
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path('/data/softwares/deepseek-harness')
PLUGINS = Path('/data/softwares/deepseek-harness-plugins')
BACKUP = Path('/data/backups/dsh-rc2-20261019-1232')
FAILED = Path('/data/softwares/deepseek-harness-rc2-failed-20261019')
NODE = Path('/home/kiyama/.local/share/mise/installs/node/latest/bin/node')
UNITS = ['dsh-web-managed.service', 'slack-intake-bridge.service']
TIMER = 'ai-reference-store-daily.timer'
os.umask(0o077)


def run(argv, timeout=180, **kwargs):
    return subprocess.run([str(value) for value in argv], check=True, timeout=timeout, **kwargs)


def record(status, **values):
    payload = {'status': status, 'time': time.time(), 'target': '0.2.1-rc.2', **values}
    (BACKUP / 'cutover-state.json').write_text(json.dumps(payload, indent=2) + '\n')
    print(json.dumps(payload), flush=True)


def ready(timeout=90):
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pid = subprocess.check_output(['systemctl', '--user', 'show', UNITS[0], '-p', 'MainPID', '--value'], text=True).strip()
        journal = subprocess.check_output(['journalctl', '--user', '-u', UNITS[0], f'_PID={pid}', '--no-pager', '-o', 'cat'], text=True)
        match = re.search(r'http://127\.0\.0\.1:3080/\?token=([^\s\x1b]+)', journal)
        if match:
            try:
                with client.open('http://127.0.0.1:3080/?token=' + match[1], timeout=3) as response:
                    if response.status == 200 and b'<html' in response.read():
                        return
            except OSError:
                pass  # Bounded authenticated readiness probe while the service starts.
        time.sleep(1)
    raise RuntimeError('The authenticated canonical Web page did not become ready')


def rollback_runtime():
    run(['systemctl', '--user', 'stop', *UNITS], timeout=90)
    assert ROOT.resolve() == ROOT and ROOT.is_dir() and (ROOT / '.git').is_dir()
    assert FAILED.resolve() == FAILED and not FAILED.exists()
    ROOT.rename(FAILED)
    shutil.copytree(BACKUP / 'checkout', ROOT, symlinks=True)
    # Restore only source files changed by this upgrade, not other plugin work.
    changed = json.loads((BACKUP / 'plugin-changed-files.json').read_text())
    for relative in changed:
        source = BACKUP / 'plugins' / relative
        target = PLUGINS / relative
        assert target.resolve().is_relative_to(PLUGINS) and source.is_file()
        shutil.copy2(source, target)
    run(['systemctl', '--user', 'start', *UNITS], timeout=90)
    ready()


if '--probe-only' in sys.argv:
    ready(timeout=10)
    print('Authenticated readiness probe passed')
    raise SystemExit(0)

restore_staged = '--restore-staged' in sys.argv
prepared = FAILED if restore_staged else ROOT
replaced = Path('/data/softwares/deepseek-harness-alpha2-recovery-20261019')
assert prepared.resolve() == prepared and (prepared / '.git').is_dir()
assert json.loads((prepared / 'package.json').read_text())['version'] == '0.2.1-rc.2'
run(['git', '-C', prepared, 'merge-base', '--is-ancestor', 'dsh-v0.2.1-rc.2', 'HEAD'])
if restore_staged:
    assert ROOT.resolve() == ROOT and (ROOT / '.git').is_dir()
    assert replaced.resolve() == replaced and not replaced.exists()
run(['python3', '-B', PLUGINS / 'bin/check-runtime-placement.py', '--all'])
was_timer_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', TIMER]).returncode == 0
record('stopping')
listener_ready = False
stopped = False
try:
    if was_timer_active:
        run(['systemctl', '--user', 'stop', TIMER])
    run(['systemctl', '--user', 'stop', *UNITS], timeout=90)
    stopped = True
    record('offline-backup')
    run(['rsync', '-a', '/home/kiyama/.dsh-recovery-20261005/', str(BACKUP / 'recovery-data-live') + '/'], timeout=180)
    run(['rsync', '-a', '--exclude=node_modules', '--exclude=backups', '/home/kiyama/.dsh/', str(BACKUP / 'dsh-home-offline') + '/'], timeout=180)
    if restore_staged:
        assert ROOT.resolve() == ROOT and FAILED.resolve() == FAILED and not replaced.exists()
        ROOT.rename(replaced)
        FAILED.rename(ROOT)
        os.chdir(ROOT)
    record('starting')
    run(['systemctl', '--user', 'start', *UNITS], timeout=90)
    ready()
    listener_ready = True
    worker_deadline = time.monotonic() + 60
    while True:
        worker = json.loads(Path('/home/kiyama/.local/state/slack-intake-bridge/status.json').read_text())
        socket = worker.get('socket')
        if worker.get('phase') == 'online' and isinstance(socket, dict) and socket.get('status') == 'connected' and worker.get('last_error') is None:
            break
        if time.monotonic() >= worker_deadline:
            raise RuntimeError('Slack worker did not reconnect within 60 seconds')
        time.sleep(1)
    record('verifying')
    with (BACKUP / 'verify-runtime.log').open('w') as log:
        run([NODE, PLUGINS / 'bin/verify-runtime-location.mjs'], timeout=150, stdout=log, stderr=subprocess.STDOUT)
        run([NODE, PLUGINS / 'bin/verify-rc2-runtime.mjs'], timeout=240, stdout=log, stderr=subprocess.STDOUT)
    record('verified', version='0.2.1-rc.2')
except Exception as error:
    record('verification-failed' if listener_ready else 'startup-failed', error=str(error))
    if stopped and not listener_ready:
        try:
            rollback_runtime()
            record('rolled-back-not-complete', error=str(error))
        except Exception as rollback_error:
            record('rollback-failed', error=str(error), rollbackError=str(rollback_error))
    raise
finally:
    if was_timer_active:
        run(['systemctl', '--user', 'start', TIMER])
