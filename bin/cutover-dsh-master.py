#!/usr/bin/env python3
"""Cut over the existing DSH service; run in a separate systemd user unit.

A failed cutover serves the pre-cutover copy from a separate recovery home.
It never removes or downgrades published Session generations in the live home.
"""
raise SystemExit('RETIRED: this one-shot cutover promotes a temporary worktree. Deploy only to /data/softwares/deepseek-harness and run bin/verify-runtime-location.mjs.')

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import sys
from upgrade_recovery import copy_recovery_home

os.umask(0o077)
home = Path('/home/kiyama/.dsh')
stage = Path('/home/kiyama/.dsh-upgrade-stage-20261005')
root = Path('/data/softwares/deepseek-harness-upgrade-master')
old = Path('/data/softwares/deepseek-harness-master')
plugins = Path('/data/softwares/deepseek-harness-plugins')
backup_root = home / 'backups/master-upgrade-20261005'
backup = backup_root / 'cutover'
recovery = Path('/home/kiyama/.dsh-recovery-20261005')
units = Path('/home/kiyama/.config/systemd/user')
node = '/home/kiyama/.local/share/mise/installs/node/latest/bin/node'
status = {'phase': 'preflight', 'goalComplete': False}

def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)

def save():
    (backup / 'status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(status, ensure_ascii=False), flush=True)

def unit_override(root_path, data_home):
    return ('[Service]\nWorkingDirectory=' + str(root_path) + '\nEnvironment=DSH_HOME=' + str(data_home)
            + '\nExecStart=\nExecStart=' + node + ' ' + str(root_path / 'apps/cli/lib/bin.js')
            + ' web --port 3080 --no-open --trusted-host boiled.colobus-powan.ts.net\n')

def wait_ready():
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        pid = subprocess.check_output(['systemctl', '--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], text=True).strip()
        log = subprocess.check_output(['journalctl', '--user', '-u', 'dsh-web-managed.service', f'_PID={pid}', '--no-pager'], text=True)
        if 'http://127.0.0.1:3080/?token=' in log:
            return pid
        if subprocess.run(['systemctl', '--user', 'is-failed', '--quiet', 'dsh-web-managed.service']).returncode == 0:
            raise RuntimeError('DSH service failed before publishing its ready URL')
        time.sleep(0.5)
    raise TimeoutError('DSH did not publish its ready URL within 90 seconds')

assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == '5badb15009ae1756c3afe0ae0cef1faafc290ccc'
probe = json.loads((stage / 'boot-probe-result.json').read_text())
assert not probe['failedPlugins'] and not probe['failedBundles'] and not any(x.get('broken') for x in probe['presets'])
assert probe['defaultPreset'] == 'cordis-kura' and probe['toolCount'] > 20 and probe['memoryChars'] > 100
assert probe['defaultModel'] == json.loads((stage / 'expected-model.json').read_text())
status['defaultModel'] = probe['defaultModel']
checks = json.loads((stage / 'verification-proof.json').read_text())
assert checks['docSyncExit'] == checks['lintExit'] == checks['bootExit'] == checks['dailyExit'] == checks['browserExit'] == 0
# Do not discard settings changed through another browser while staging was prepared.
assert (stage / 'settings-observed.yaml').read_bytes() == (home / 'settings.yaml').read_bytes(), 'Live settings changed since staging'
assert not recovery.exists(), f'Recovery home already exists: {recovery}'
web_override = units / 'dsh-web-managed.service.d/master-upgrade.conf'
daily_override = units / 'ai-reference-store-daily.service.d/master-upgrade.conf'
assert not web_override.exists() and not daily_override.exists()
timer_active = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'ai-reference-store-daily.timer']).returncode == 0
assert subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'ai-reference-store-daily.service']).returncode != 0, 'Daily intake is still running'
if sys.argv[1:] == ['--check']:
    print('Cutover preflight passed; no services or deployment files changed.')
    sys.exit(0)
assert not sys.argv[1:], 'Only --check or no arguments are supported'
backup.mkdir()
save()
recovery_ready = False
try:
    run(['systemctl', '--user', 'stop', 'ai-reference-store-daily.timer', 'kura-tend.service'])
    # This kills the calling Web Agent; the independent systemd unit continues.
    run(['systemctl', '--user', 'stop', 'dsh-web-managed.service'])
    assert (stage / 'settings-observed.yaml').read_bytes() == (home / 'settings.yaml').read_bytes(), 'Live settings changed while stopping services'
    status['phase'] = 'stopped-and-backing-up'; save()
    copy_recovery_home(home, recovery)
    recovery_ready = True
    status['recoveryHome'] = str(recovery); save()
    with (backup / 'candidate.patch').open('w') as patch:
        run(['git', '-C', str(root), 'diff', '--binary'], stdout=patch)
    untracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--others', '--exclude-standard', '-z'])
    run(['tar', '--null', '-T', '-', '-czf', str(backup / 'candidate-untracked.tar.gz')], cwd=root, input=untracked)
    shutil.copytree(plugins / 'bin', backup / 'operation-scripts')
    shutil.copy2(stage / 'session-acceptance.json', backup / 'session-acceptance.json')
    for profile in ['web', 'headless', 'ai-reference-store-daily']:
        (home / 'profiles' / profile).rename(backup / f'profile-{profile}')
        copied = home / 'profiles' / profile
        shutil.copytree(stage / 'profiles' / profile, copied, symlinks=True)
        for path in [copied / 'package.json', copied / 'pnpm-lock.yaml', copied / 'cordis.patch.yml']:
            if path.exists():
                path.write_text(path.read_text().replace(str(stage) + '/', str(home) + '/'))
    for preset in (stage / '.agent-presets').iterdir():
        shutil.copytree(preset, home / '.agent-presets' / preset.name, dirs_exist_ok=True, symlinks=True)
    shutil.copy2(home / 'cordis.patch.yml', backup / 'cordis.patch.yml')
    (home / 'cordis.patch.yml').write_text((stage / 'cordis.patch.yml').read_text().replace(str(stage), str(home)))
    (home / 'settings.yaml').rename(backup / 'settings.yaml')
    web_override.parent.mkdir(exist_ok=True)
    web_override.write_text(unit_override(root, home))
    daily_override.parent.mkdir(exist_ok=True)
    daily_override.write_text('[Service]\nExecStart=\nExecStart=/bin/bash /home/kiyama/.dsh/profiles/ai-reference-store-daily/daily-start.sh 300 /data /data/references/AI ' + node + ' ' + str(root / 'apps/cli/lib/bin.js') + ' --profile ai-reference-store-daily daily run\n')
    status['phase'] = 'migrating-live-sessions'; save()
    with (backup / 'migration.log').open('w') as log:
        run(['pnpm', 'exec', 'tsx', 'scripts/migrate-sessions-to-v4.ts', '--sessions-dir', str(home / 'sessions'), '--jobs', '4'],
            cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'start', 'dsh-web-managed.service'])
    status['phase'] = 'verifying-live'; status['pid'] = wait_ready()
    process_root = Path('/proc') / status['pid']
    argv = (process_root / 'cmdline').read_bytes().decode().split('\0')
    assert argv[1] == str(root / 'apps/cli/lib/bin.js'), 'Unexpected running CLI'
    assert os.readlink(process_root / 'cwd') == str(root), 'Unexpected running checkout'
    status['runningCli'] = argv[1]
    save()
    env = dict(os.environ, DSH_HOME=str(home), DSH_TELEMETRY_DISABLED='1', DSH_ACCEPTANCE_FIXTURE=str(backup / 'session-acceptance.json'))
    with (backup / 'daily-check.log').open('w') as log:
        run([node, str(root / 'apps/cli/lib/bin.js'), '--profile', 'ai-reference-store-daily', 'daily', 'check'],
            cwd='/data/references/AI', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=60)
    assert 'did not activate' not in (backup / 'daily-check.log').read_text()
    with (backup / 'web-verification.log').open('w') as log:
        run([node, str(plugins / 'bin/verify-live-upgrade-web.mjs')], cwd=plugins, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    run(['systemctl', '--user', 'start', 'kura-tend.service'])
    if timer_active:
        run(['systemctl', '--user', 'start', 'ai-reference-store-daily.timer'])
    status['phase'] = 'cutover-verified-awaiting-conversation-resume'
    status['version'] = subprocess.check_output([node, str(root / 'apps/cli/lib/bin.js'), '--version'], text=True).strip()
    status['artifacts'] = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in [root / 'apps/cli/lib/bin.js', root / 'packages/llm/llm-pi-ai/lib/index.js', root / 'packages/workflow/tool-workflow/lib/index.js']}
    save()
except BaseException as error:
    status['phase'] = 'failed'; status['error'] = str(error); save()
    if recovery_ready:
        # Keep every new generation in the original home and restore availability separately.
        subprocess.run(['systemctl', '--user', 'stop', 'dsh-web-managed.service'])
        web_override.parent.mkdir(exist_ok=True)
        web_override.write_text(unit_override(old, recovery))
        run(['systemctl', '--user', 'daemon-reload'])
        run(['systemctl', '--user', 'start', 'dsh-web-managed.service'])
        status['phase'] = 'recovery-old-runtime'; status['pid'] = wait_ready(); save()
    else:
        # No profile changes precede a complete recovery copy.
        run(['systemctl', '--user', 'start', 'dsh-web-managed.service', 'kura-tend.service'])
        if timer_active:
            run(['systemctl', '--user', 'start', 'ai-reference-store-daily.timer'])
    raise
