# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Install a release through dsh into an isolated profile, verify its bytes and composition, and run regressions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('--core', type=Path, default=Path('/data/softwares/deepseek-harness'))
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
archive = args.archive.resolve(strict=True)
with tarfile.open(archive) as packed:
    expected_manifest = json.load(packed.extractfile('package/package.json'))
core = args.core.resolve(strict=True)
report_path = args.report.resolve()
assert not report_path.exists(), 'Refusing to overwrite an existing rehearsal report'
root = Path(tempfile.mkdtemp(prefix='dsh-icons-stage-')).resolve()
home = root / 'home'
env = {k: v for k, v in os.environ.items() if not k.startswith('DSH_')}
env['DSH_HOME'] = str(home)
cli = ['node', str(core / 'apps/cli/lib/bin.js')]
report = {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'status': 'running'}

def run(command, timeout=180):
    process = subprocess.Popen(command, cwd=core, env=env, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
        raise
    if process.returncode:
        raise RuntimeError(f'Command failed ({process.returncode}): {command}\n{stdout[-12000:]}\n{stderr[-12000:]}')
    return stdout, stderr

try:
    stdout, stderr = run(cli + ['plugin', '--profile', 'web', 'add', str(archive)])
    print(stdout, end='')
    print(stderr, end='')
    installed = home / 'profiles/web/node_modules/@local/dsh-open-in-app-icons'
    manifest = json.loads((installed / 'package.json').read_text())
    assert manifest['name'] == '@local/dsh-open-in-app-icons'
    assert manifest['version'] == expected_manifest['version']
    count = 0
    with tarfile.open(archive) as packed:
        for member in packed.getmembers():
            assert member.isfile() and not member.islnk() and not member.issym(), member.name
            parts = Path(member.name).parts
            assert parts[0] == 'package' and '..' not in parts and not Path(member.name).is_absolute(), member.name
            target = installed.joinpath(*parts[1:])
            assert target.read_bytes() == packed.extractfile(member).read(), member.name
            count += 1
    assert ET.parse(installed / 'assets/fallback.svg').getroot().tag == '{http://www.w3.org/2000/svg}svg'
    report['installedFilesVerified'] = count
    stdout, _ = run(cli + ['--profile', 'web', '--dump-config'])
    assert re.search(r'id:\s+local-open-in-app-icons\b', stdout), 'Bundle row is absent from the composed profile'
    assert all(value in stdout for value in ['applicationIds', 'filemanager', 'cursor', 'vscode', 'cacheMaxAgeSeconds'])
    report['profileCompositionVerified'] = True
    stdout, _ = run(cli + ['plugin', '--profile', 'web', 'version-exemptions'])
    assert json.loads(stdout) == {}, 'Unexpected compatibility exemption in isolated profile'
    report['versionExemptions'] = {}
    launcher = Path(__file__).resolve().with_name('test.py')
    stdout, stderr = run(['uv', 'run', '--no-project', str(launcher), '--core', str(core), '--package', str(installed)], timeout=60)
    print(stdout, end='')
    print(stderr, end='')
    report['installedArtifactRegressionsPassed'] = True
    report['status'] = 'passed'
except BaseException as exc:
    report['status'] = 'failed'
    report['error'] = str(exc)
    raise
finally:
    assert root.parent == Path(tempfile.gettempdir()).resolve() and root.name.startswith('dsh-icons-stage-')
    shutil.rmtree(root)
    report['temporaryRootRemoved'] = not root.exists()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
