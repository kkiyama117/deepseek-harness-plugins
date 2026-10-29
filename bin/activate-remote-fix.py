#!/usr/bin/env python3
"""Restart only the already-upgraded Web service and verify its installed client fix."""
import json
import os
from pathlib import Path
import subprocess
import time

os.umask(0o077)
package = Path('/home/kiyama/.dsh/profiles/web/node_modules/@linxin666/dsh-remote-web-ui/package.json')
assert json.loads(package.read_text())['version'] == '0.4.4-local.2', 'Expected tested local.2 installation'
out = Path('/home/kiyama/.dsh/backups/master-upgrade-20261005/final')
out.mkdir(exist_ok=True)
state = {'phase': 'restarting-web', 'goalComplete': False}
def save():
    (out / 'status.json').write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps(state), flush=True)
save()
try:
    subprocess.run(['systemctl', '--user', 'restart', 'dsh-web-managed.service'], check=True)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        pid = subprocess.check_output(['systemctl', '--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], text=True).strip()
        log = subprocess.check_output(['journalctl', '--user', '-u', 'dsh-web-managed.service', f'_PID={pid}', '--no-pager'], text=True)
        if 'http://127.0.0.1:3080/?token=' in log:
            break
        time.sleep(0.5)
    else:
        raise TimeoutError('Web readiness deadline exceeded')
    state.update(phase='verifying', pid=pid)
    save()
    env = dict(os.environ, DSH_VERIFY_OUTPUT=str(out), DSH_VERIFY_DATA_HOME='/home/kiyama/.dsh-recovery-20261005',
               DSH_ACCEPTANCE_FIXTURE='/home/kiyama/.dsh/backups/master-upgrade-20261005/retry/session-acceptance.json')
    with (out / 'web-verification.log').open('w') as log:
        subprocess.run(['/home/kiyama/.local/share/mise/installs/node/latest/bin/node',
                        '/data/softwares/deepseek-harness-plugins/bin/verify-live-upgrade-web.mjs'],
                       env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=240)
    subprocess.run(['systemctl', '--user', 'is-active', 'dsh-web-managed.service', 'kura.service', 'kura-tend.service', 'ai-reference-store-daily.timer'], check=True)
    state['phase'] = 'verified'
except BaseException as error:
    state.update(phase='verification-needs-attention', error=str(error))
    raise
finally:
    save()
