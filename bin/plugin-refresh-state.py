#!/usr/bin/env python3
"""Capture private rollback inputs and integrity-checked registry archives."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request

ROOT = Path('/data/softwares/deepseek-harness-plugins/reports/plugin-refresh-20261027')
PROFILE = Path('/home/kiyama/.dsh/profiles/web')


def put_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def snapshot(label):
    destination = ROOT / label
    destination.mkdir(parents=True, mode=0o700)
    files = {}
    for name in ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'compatibility.json', '.dsh-market/state.json']:
        source = PROFILE / name
        if source.exists():
            data = source.read_bytes()
            put_new(destination / name, data)
            files[name] = hashlib.sha256(data).hexdigest()
    packages = {}
    manifest = json.loads((PROFILE / 'package.json').read_text())
    for name, spec in manifest['dependencies'].items():
        installed = PROFILE / 'node_modules' / name / 'package.json'
        item = json.loads(installed.read_text())
        packages[name] = {'spec': spec, 'version': item.get('version')}
    state = {'files': files, 'packages': packages,
             'core_head': subprocess.check_output(['git', '-C', '/data/softwares/deepseek-harness', 'rev-parse', 'HEAD'], text=True).strip(),
             'web_pid': subprocess.check_output(['systemctl', '--user', 'show', 'dsh-web-managed.service', '-p', 'MainPID', '--value'], text=True).strip()}
    put_new(destination / 'state.json', (json.dumps(state, indent=2) + '\n').encode())
    print(json.dumps({'snapshot': str(destination), 'packages': len(packages), 'core_head': state['core_head'], 'web_pid': state['web_pid']}))


def artifact(name, version):
    metadata_url = 'https://registry.npmjs.org/' + urllib.parse.quote(name, safe='') + '/' + urllib.parse.quote(version, safe='')
    with urllib.request.urlopen(metadata_url, timeout=30) as response:
        metadata = json.load(response)
    assert metadata['name'] == name and metadata['version'] == version
    dist = metadata['dist']
    integrity = dist['integrity']
    algorithm, expected = integrity.split('-', 1)
    assert algorithm == 'sha512', integrity
    with urllib.request.urlopen(dist['tarball'], timeout=60) as response:
        data = response.read(100 * 1024 * 1024 + 1)
    assert len(data) <= 100 * 1024 * 1024
    assert base64.b64encode(hashlib.sha512(data).digest()).decode() == expected
    filename = name.removeprefix('@').replace('/', '-') + '-' + version + '.tgz'
    target = ROOT / 'archives' / filename
    put_new(target, data)
    record = {'name': name, 'version': version, 'path': str(target), 'metadata_url': metadata_url,
              'tarball_url': dist['tarball'], 'integrity': integrity, 'sha256': hashlib.sha256(data).hexdigest(),
              'engines': metadata.get('engines'), 'dsh': metadata.get('dsh'), 'peerDependencies': metadata.get('peerDependencies')}
    put_new(target.with_suffix('.json'), (json.dumps(record, indent=2) + '\n').encode())
    print(json.dumps(record))


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--report-root', type=Path, default=ROOT)
commands = parser.add_subparsers(dest='command', required=True)
p = commands.add_parser('snapshot')
p.add_argument('label', choices=['before', 'after-sidebar', 'after-remote', 'final', 'before-resume', 'after-sidebar-restarted', 'after-remote-restarted'])
p = commands.add_parser('artifact')
p.add_argument('name')
p.add_argument('version')
args = parser.parse_args()
ROOT = args.report_root.resolve()
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(ROOT, 0o700)
if args.command == 'snapshot':
    snapshot(args.label)
else:
    artifact(args.name, args.version)
