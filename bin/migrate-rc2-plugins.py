"""Apply the local source-package migration for DSH 0.2.1-rc.2.

Keeps old compatibility ranges, adds only the selected release, and removes
only the retired schedule-tool display filter. Runtime schedule authorization
is unchanged. This edits source bundles, never profile manifests or exemptions.
"""
import argparse
import json
from pathlib import Path

ROOT = Path('/data/softwares/deepseek-harness-plugins')
PACKAGES = [
    'dsh-codex-transport-recovery', 'dsh-session-cleanup',
    'dsh-workflow-results', 'dsh-inspector-origin',
    'compat/slack-intake-alpha2', 'compat/slack-digest-alpha2',
    'compat/intake-knowledge-alpha2',
    'presets/cordis-kura', 'presets/managed-cordis',
    'presets/managed-standard', 'presets/ai-reference-store-next',
]
FILTER = '''                  toolFilter:
                    deny:
                      - schedule_create
                      - schedule_delete
                      - schedule_list
                      - schedule_update
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    changes = []
    for relative in PACKAGES:
        manifest = ROOT / relative / 'package.json'
        text = manifest.read_text()
        data = json.loads(text)
        updated = text
        for name, current in data.get('peerDependencies', {}).items():
            target = ('0.2.1-rc.2' if name.startswith('@deepseek-ai/dsh-') else
                      {'@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/schemastery': '3.18.5'}.get(name))
            if target is None or target in current.split(' || '):
                continue
            old = json.dumps(name) + ': ' + json.dumps(current)
            new = json.dumps(name) + ': ' + json.dumps(current + ' || ' + target)
            assert updated.count(old) == 1, (manifest, name)
            updated = updated.replace(old, new)
        if updated != text:
            changes.append((manifest, updated))
        if relative.startswith('presets/'):
            patch = ROOT / relative / 'cordis.patch.yml'
            text = patch.read_text()
            count = text.count(FILTER)
            assert count in (0, 2), (patch, count)
            if count:
                changes.append((patch, text.replace(FILTER, '')))
    for path, content in changes:
        print(('WRITE ' if args.apply else 'PLAN ') + str(path))
        if args.apply:
            path.write_text(content)
    print(json.dumps({'applied': args.apply, 'files': len(changes)}))


if __name__ == '__main__':
    main()
