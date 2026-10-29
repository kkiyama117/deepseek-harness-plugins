#!/usr/bin/env python3
"""Deploy the tested Kura master merge while its service and workers are stopped."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess

os.umask(0o077)
checkout = Path('/home/kiyama/.cache/checkouts/github.com/lna-lab/distill-kura')
backup = Path('/home/kiyama/.dsh/backups/master-upgrade-20261005/kura-cutover')
installed = Path('/home/kiyama/.local/share/uv/tools/distill-kura')
adapter = Path('/home/kiyama/.config/kura/bin/kura-dsh.py')
candidate = checkout / '.upgrade-candidate/kura-dsh.py'
expected = '16cf88dcd3e5242b254e738a472995a0545b1dbf5dbf24459a79b0530ad008e1'
assert hashlib.sha256(candidate.read_bytes()).hexdigest() == expected
assert subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip() == 'a9215baaf2c71a3a5033a0286ee797f19f4b8bbf'
backup.mkdir()
subprocess.run(['systemctl', '--user', 'stop', 'kura-tend.service', 'kura.service'], check=True)
for unit in ['kura-tend.service', 'kura.service']:
    state = subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'ActiveState', '--value'], text=True).strip()
    assert state == 'inactive', (unit, state)
try:
    shutil.copytree(installed, backup / 'uv-tool', symlinks=True)
    shutil.copy2(adapter, backup / 'kura-dsh.py')
    subprocess.run(['tar', '-czf', str(backup / 'data.tar.gz'), '-C', '/home/kiyama/.local/share', 'kura'], check=True)
    subprocess.run(['tar', '-tzf', str(backup / 'data.tar.gz')], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['uv', 'tool', 'install', '--force', '--reinstall', '--python', '3.13', str(checkout)], check=True)
    new = adapter.with_suffix('.py.new')
    shutil.copyfile(candidate, new)
    new.chmod(0o600)
    new.replace(adapter)
    python = str(installed / 'bin/python')
    subprocess.run([python, '-B', '/home/kiyama/.config/kura/bin/test-kura-dsh.py'], check=True)
    package = next(installed.glob('lib/python*/site-packages/distill_kura'))
    files = list((checkout / 'distill_kura').rglob('*.py'))
    for source in files:
        assert source.read_bytes() == (package / source.relative_to(checkout / 'distill_kura')).read_bytes(), source
    print(f'Installed core matches candidate: {len(files)} Python files', flush=True)
    subprocess.run([python, '-B', str(installed / 'bin/kura'), '-c', '/home/kiyama/.config/kura/kura.toml', '-s', 'shared', 'weave', '--no-model'], check=True)
except BaseException:
    print(f'Kura deployment incomplete; services remain stopped. Recovery inputs: {backup}', flush=True)
    raise
subprocess.run(['systemctl', '--user', 'start', 'kura.service', 'kura-tend.service'], check=True)
subprocess.run(['systemctl', '--user', 'is-active', 'kura.service', 'kura-tend.service'], check=True)
print('Kura master deployment complete; HTTP/read-only verification remains.', flush=True)
