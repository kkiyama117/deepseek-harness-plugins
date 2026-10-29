#!/usr/bin/env python3
"""Retry the prepared upgrade without overwriting either branch of Session history."""
raise SystemExit('RETIRED: this one-shot cutover promotes a temporary worktree. Deploy only to /data/softwares/deepseek-harness and run bin/verify-runtime-location.mjs.')

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from upgrade_recovery import copy_recovery_home

os.umask(0o077)
home = Path('/home/kiyama/.dsh')
data = Path('/home/kiyama/.dsh-recovery-20261005')
stage = Path('/home/kiyama/.dsh-upgrade-retry-20261005')
root = Path('/data/softwares/deepseek-harness-upgrade-master')
old = Path('/data/softwares/deepseek-harness-master')
backup = home / 'backups/master-upgrade-20261005/retry'
fallback = Path('/home/kiyama/.dsh-recovery-retry-20261005')
units = Path('/home/kiyama/.config/systemd/user')
web_override = units / 'dsh-web-managed.service.d/master-upgrade.conf'
daily_override = units / 'ai-reference-store-daily.service.d/master-upgrade.conf'
node = '/home/kiyama/.local/share/mise/installs/node/latest/bin/node'
state = {'phase': 'preflight', 'goalComplete': False, 'home': str(home), 'dataHome': str(data)}

def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)

def save():
    (backup / 'status.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(state, ensure_ascii=False), flush=True)

def override(checkout, dsh_home):
    return f'[Service]\nWorkingDirectory={checkout}\nEnvironment=DSH_HOME={dsh_home}\nExecStart=\nExecStart={node} {checkout}/apps/cli/lib/bin.js web --port 3080 --no-open --trusted-host boiled.colobus-powan.ts.net\n'

def wait_ready():
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        pid = subprocess.check_output(['systemctl', '--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], text=True).strip()
        journal = subprocess.check_output(['journalctl', '--user', '-u', 'dsh-web-managed.service', f'_PID={pid}', '--no-pager'], text=True)
        if 'http://127.0.0.1:3080/?token=' in journal:
            return pid
        time.sleep(0.5)
    raise TimeoutError('No ready URL from current DSH service')

def session_dirs(base):
    return {p.name: p for project in (base / 'sessions').iterdir() if project.is_dir() for p in project.iterdir() if p.is_dir()}

assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == '5badb15009ae1756c3afe0ae0cef1faafc290ccc'
assert (data / 'settings.yaml').read_bytes() == (stage / 'settings-observed.yaml').read_bytes(), 'Active settings changed since preparation'
proof = json.loads((stage / 'web-verification.json').read_text())
assert proof['version'] == '0.2.1-alpha.1' and all(not x['errors'] and not x['failedResponses'] and x['session']['persistedImageLoaded'] for x in proof['results'])
assert not fallback.exists() and not backup.exists()
if sys.argv[1:] == ['--check']:
    print('Retry preflight passed; no deployment or service changes.')
    sys.exit(0)
assert not sys.argv[1:]
backup.mkdir()
ready = False
daily_ready = False
snapshot_ready = False
was_tend_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'kura-tend.service']).returncode == 0
was_timer_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'ai-reference-store-daily.timer']).returncode == 0
save()
try:
    run(['systemctl', '--user', 'stop', 'ai-reference-store-daily.timer'])
    daily_state = subprocess.check_output(['systemctl', '--user', 'show', 'ai-reference-store-daily.service', '-p', 'ActiveState', '--value'], text=True).strip()
    assert daily_state in ('inactive', 'failed'), 'Daily intake is still running; no copy or cutover is permitted'
    run(['systemctl', '--user', 'stop', 'kura-tend.service', 'dsh-web-managed.service'])
    assert (data / 'settings.yaml').read_bytes() == (stage / 'settings-observed.yaml').read_bytes(), 'Settings changed while stopping'
    copy_recovery_home(data, fallback)
    snapshot_ready = True
    shutil.copy2(web_override, backup / 'web-override.conf')
    shutil.copy2(daily_override, backup / 'daily-override.conf')
    shutil.copy2(home / 'cordis.patch.yml', backup / 'home.patch.yml')
    shutil.copy2(home / '.credentials.yaml', backup / 'credentials-before.yaml')
    shutil.copy2('/home/kiyama/.config/kura/kura.toml', backup / 'kura.toml')
    shutil.copy2(stage / 'session-acceptance.json', backup / 'session-acceptance.json')
    # Retain the new-runtime-only diagnostic sessions as additional copies, never replacing an id.
    current = session_dirs(data)
    copied = []
    for sid, source in session_dirs(home).items():
        if sid not in current:
            target = data / 'sessions' / source.relative_to(home / 'sessions')
            target.parent.mkdir(exist_ok=True)
            shutil.copytree(source, target)
            copied.append(sid)
    state['additionalPreservedSessions'] = copied
    # Content-addressed attachment files may be added, but existing bytes must agree.
    for source in (home / 'attachments').rglob('*'):
        if source.is_file():
            target = data / 'attachments' / source.relative_to(home / 'attachments')
            if target.exists():
                assert source.read_bytes() == target.read_bytes(), f'Attachment conflict: {target}'
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
    for profile in ['web', 'headless', 'ai-reference-store-daily']:
        target = home / 'profiles' / profile
        target.rename(backup / f'profile-{profile}')
        shutil.copytree(stage / 'profiles' / profile, target, symlinks=True)
        for name in ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']:
            file = target / name
            file.write_text(file.read_text().replace(str(stage) + '/', str(home) + '/'))
    for preset in (stage / '.agent-presets').iterdir():
        shutil.copytree(preset, home / '.agent-presets' / preset.name, dirs_exist_ok=True, symlinks=True)
    (home / 'cordis.patch.yml').write_text((stage / 'planned-home.patch.yml').read_text())
    credential_temp = home / '.credentials.upgrade-new.yaml'
    shutil.copy2(data / '.credentials.yaml', credential_temp)
    credential_temp.replace(home / '.credentials.yaml')
    state['phase'] = 'migrating-current-data'; save()
    with (backup / 'migration.log').open('w') as log:
        run(['pnpm', 'exec', 'tsx', 'scripts/migrate-sessions-to-v4.ts', '--sessions-dir', str(data / 'sessions'), '--jobs', '4'], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    web_override.write_text(override(root, home))
    daily_override.write_text(f'[Service]\nEnvironment=DSH_HOME={home}\nExecStart=\nExecStart=/bin/bash {home}/profiles/ai-reference-store-daily/daily-start.sh 300 /data /data/references/AI {node} {root}/apps/cli/lib/bin.js --profile ai-reference-store-daily daily run\n')
    kura = Path('/home/kiyama/.config/kura/kura.toml')
    config = kura.read_text()
    assert 'dsh = "/home/kiyama/.dsh/sessions"' in config
    kura_temp = kura.with_suffix('.toml.upgrade-new')
    kura_temp.write_text(config.replace('dsh = "/home/kiyama/.dsh/sessions"', f'dsh = "{data}/sessions"'))
    kura_temp.replace(kura)
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'start', 'dsh-web-managed.service'])
    state['pid'] = wait_ready()
    argv = (Path('/proc') / state['pid'] / 'cmdline').read_bytes().decode().split('\0')
    assert argv[1] == str(root / 'apps/cli/lib/bin.js')
    ready = True
    state['phase'] = 'new-runtime-ready'; save()
    env = dict(os.environ, DSH_HOME=str(home), DSH_TELEMETRY_DISABLED='1', DSH_VERIFY_OUTPUT=str(backup),
               DSH_VERIFY_DATA_HOME=str(data), DSH_ACCEPTANCE_FIXTURE=str(backup / 'session-acceptance.json'))
    with (backup / 'daily-check.log').open('w') as log:
        run([node, str(root / 'apps/cli/lib/bin.js'), '--profile', 'ai-reference-store-daily', 'daily', 'check'], cwd='/data/references/AI', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    assert 'did not activate' not in (backup / 'daily-check.log').read_text()
    daily_ready = True
    with (backup / 'web-verification.log').open('w') as log:
        run([node, '/data/softwares/deepseek-harness-plugins/bin/verify-live-upgrade-web.mjs'], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    state['phase'] = 'verified-awaiting-conversation-resume'; save()
except BaseException as error:
    state['error'] = str(error)
    if ready:
        # A UI assertion must not fork active history again after successful new-runtime startup.
        state['phase'] = 'new-runtime-verification-needs-attention'; save()
    elif snapshot_ready:
        run(['systemctl', '--user', 'stop', 'dsh-web-managed.service'])
        web_override.write_text(override(old, fallback))
        run(['systemctl', '--user', 'daemon-reload'])
        run(['systemctl', '--user', 'start', 'dsh-web-managed.service'])
        state['phase'] = 'startup-failed-recovery'; state['pid'] = wait_ready(); save()
    else:
        run(['systemctl', '--user', 'start', 'dsh-web-managed.service'])
        state['phase'] = 'failed-before-data-switch'; save()
    raise
finally:
    if ready:
        run(['systemctl', '--user', 'start', 'kura-tend.service'])
        if daily_ready:
            run(['systemctl', '--user', 'start', 'ai-reference-store-daily.timer'])
        state['automation'] = 'restored' if daily_ready else 'Kura restored; daily timer paused because profile validation failed'
    elif not snapshot_ready:
        if was_tend_active:
            run(['systemctl', '--user', 'start', 'kura-tend.service'])
        if was_timer_active:
            run(['systemctl', '--user', 'start', 'ai-reference-store-daily.timer'])
        state['automation'] = 'pre-attempt states restored'
    else:
        state['automation'] = 'paused intentionally: startup failed; fallback journal and credential paths need review before resuming'
    save()
