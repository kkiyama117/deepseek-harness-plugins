# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Compare an installed release with its archive, verify authentication, and preserve the recorded production state."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--core', type=Path, default=Path('/data/softwares/deepseek-harness'))
parser.add_argument('--profile-dir', type=Path, default=Path('/home/kiyama/.dsh/profiles/web'))
args = parser.parse_args()
before = json.loads(args.baseline.read_text())
after = {
    'coreHead': subprocess.check_output(['git', '-C', str(args.core), 'rev-parse', 'HEAD'], text=True).strip(),
    'preservedFiles': {},
    'pids': {unit: subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', 'MainPID', '--value'], text=True).strip() for unit in before['pids']},
}
issues = []
for name, expected in before['preservedFiles'].items():
    path = Path(name)
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    if actual != expected:
        issues.append(f'Changed since the recorded baseline: {name}')
    after['preservedFiles'][name] = actual
if after['coreHead'] != before['coreHead']:
    issues.append('Core HEAD changed since the recorded baseline')
if after['pids'] != before['pids']:
    issues.append('Service PIDs changed since the recorded baseline')
installed = args.profile_dir / 'node_modules/@local/dsh-open-in-app-icons'
with tarfile.open(args.archive) as packed:
    members = packed.getmembers()
    for member in members:
        assert member.isfile() and not member.islnk() and not member.issym(), member.name
        parts = Path(member.name).parts
        assert parts[0] == 'package' and '..' not in parts and not Path(member.name).is_absolute(), member.name
        assert installed.joinpath(*parts[1:]).read_bytes() == packed.extractfile(member).read(), member.name
    after['installedFilesVerified'] = len(members)
after['installedVersion'] = json.loads((installed / 'package.json').read_text())['version']
after['authenticationChecks'] = []
for app in ['filemanager', 'cursor', 'vscode']:
    for headers, expected in [({}, 401), ({'Origin': 'https://untrusted.invalid'}, 403)]:
        request = urllib.request.Request(f'http://127.0.0.1:3080/open-in-app/icon/{app}', headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as reply:
                status = reply.status
        except urllib.error.HTTPError as exc:
            status = exc.code
        assert status == expected, (app, status, expected)
        after['authenticationChecks'].append({'app': app, 'expected': expected, 'actual': status})
after['issues'] = issues
after['status'] = 'failed' if issues else 'passed'
with args.report.open('x') as output:
    output.write(json.dumps(after, indent=2) + '\n')
print(json.dumps(after, indent=2))
raise SystemExit(1 if issues else 0)
