# /// script
# requires-python = ">=3.11"
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Read-only weekly inventory. Save metadata and hashes, never configuration values.

uv run --no-project weekly-maintenance-inventory.py --output NEW_DIRECTORY
The output directory must be new. This script neither fetches nor deploys.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import yaml

RUNTIME = Path('/data/softwares/deepseek-harness')
PLUGINS = Path('/data/softwares/deepseek-harness-plugins')
HOME = Path('/home/kiyama/.dsh')
PROFILES = ('web', 'headless', 'ai-reference-store-daily')

class Loader(yaml.SafeLoader):
    """Keep Cordis expressions inert."""

Loader.add_constructor('tag:yaml.org,2002:js', lambda loader, node: loader.construct_scalar(node))

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], timeout=60).decode()

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def rows(value):
    result = []
    for row in value if isinstance(value, list) else []:
        if not isinstance(row, dict):
            continue
        record = {key: row[key] for key in ('id', 'name', 'disabled', 'group') if key in row}
        config = row.get('config')
        if isinstance(config, dict):
            record['config_keys'] = sorted(config)
        result.append(record)
        result.extend(rows(row.get('insert')))
        if row.get('group'):
            result.extend(rows(config))
        if isinstance(config, dict):
            result.extend(rows(config.get('plugins')))
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False)
    def save(name, value):
        (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    maintenance = json.loads((PLUGINS / 'maintenance.json').read_text())
    previous = maintenance.get('last_inspected_target', maintenance['upstream_base_commit'])
    target = git(RUNTIME, 'rev-parse', 'upstream/master').strip()
    summary = {'collected_at': datetime.now(timezone.utc).isoformat(), 'runtime_source': str(RUNTIME), 'runtime_head': git(RUNTIME, 'rev-parse', 'HEAD').strip(), 'runtime_manifest_version': json.loads((RUNTIME / 'package.json').read_text())['version'], 'previous_baseline': previous, 'target': target, 'head_vs_target_counts': git(RUNTIME, 'rev-list', '--left-right', '--count', 'HEAD...'+target).strip(), 'official_commits_since_previous': int(git(RUNTIME, 'rev-list', '--count', previous+'..'+target))}
    separation = subprocess.run([sys.executable, str(Path(__file__).with_name('check-core-separation.py')), '--core', str(RUNTIME), '--output', str(args.output / 'core-separation.json')], capture_output=True, text=True, timeout=60)
    (args.output / 'core-separation.log').write_text(separation.stdout + separation.stderr)
    summary['core_separation'] = 'passed' if separation.returncode == 0 else 'failed'
    save('summary.json', summary)
    (args.output / 'official-commits.txt').write_text(git(RUNTIME, 'log', '--first-parent', '--format=%H %s', previous+'..'+target))
    (args.output / 'official-paths.txt').write_text(git(RUNTIME, 'diff', '--name-status', previous, target))
    save('maintenance-before.json', maintenance)
    hashes = {}
    for label, root in [('runtime', RUNTIME), ('plugins', PLUGINS)]:
        (args.output / (label+'-status.txt')).write_text(git(root, 'status', '--short', '--untracked-files=all'))
        names = set(git(root, 'ls-files', '-m', '-o', '--exclude-standard', '-z').split('\0'))
        hashes[label] = {name: sha(root / name) if (root / name).is_file() else None for name in sorted(names) if name and not (root / name).is_relative_to(args.output)}
    save('initial-file-hashes.json', hashes)
    packages = []
    configs = {HOME / 'cordis.patch.yml'}
    profile_hashes = {}
    for profile in PROFILES:
        directory = HOME / 'profiles' / profile
        manifest_path = directory / 'package.json'
        manifest = json.loads(manifest_path.read_text())
        profile_hashes[str(manifest_path)] = sha(manifest_path)
        selected = manifest.get('dsh', {}).get('profile', {}).get('bundles', [])
        configs.update([directory / 'cordis.yml', directory / 'cordis.patch.yml'])
        for name, spec in manifest.get('dependencies', {}).items():
            package_dir = (directory / 'node_modules' / name).resolve()
            package_file = package_dir / 'package.json'
            record = {'profile': profile, 'name': name, 'spec': spec, 'directory': str(package_dir), 'selected_bundle': name in selected}
            if package_file.is_file():
                p = json.loads(package_file.read_text())
                record.update({'version': p.get('version'), 'engines': p.get('engines', {}), 'peerDependencies': p.get('peerDependencies', {}), 'manifest_sha256': sha(package_file)})
                patch = p.get('dsh', {}).get('bundle', {}).get('patch')
                if patch:
                    configs.add(package_dir / patch)
            else:
                record['missing'] = True
            packages.append(record)
    save('packages.json', packages)
    save('profile-hashes.json', profile_hashes)
    compositions = []
    for path in sorted(configs):
        if path.is_file():
            value = yaml.load(path.read_text(), Loader=Loader)
            compositions.append({'path': str(path), 'sha256': sha(path), 'rows': rows(value)})
    save('compositions.json', compositions)
    print(json.dumps(summary, ensure_ascii=False))
    print('Packages:', len(packages), 'compositions:', len(compositions))
    if separation.returncode != 0:
        raise SystemExit('Core separation audit failed; inspect core-separation.json before any deployment')

if __name__ == '__main__':
    main()
