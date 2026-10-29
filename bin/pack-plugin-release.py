#!/usr/bin/env python3
"""Pack a closed plugin tree without hardlinks and verify every archived byte."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('archive', type=Path)
args = parser.parse_args()
root = args.source.resolve(strict=True)
assert root.is_dir()
assert not args.archive.exists(), args.archive
files = sorted(path for path in root.rglob('*') if path.is_file())
assert files
for path in root.rglob('*'):
    assert not path.is_symlink(), path
    assert path.name not in ['node_modules', '.git'], path
manifest = json.loads((root / 'package.json').read_text())
args.archive.parent.mkdir(parents=True, exist_ok=True)
with args.archive.open('xb') as output:
    with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
        for path in files:
            data = path.read_bytes()
            member = tarfile.TarInfo('package/' + path.relative_to(root).as_posix())
            member.size = len(data)
            member.mode = path.stat().st_mode & 0o777
            archive.addfile(member, io.BytesIO(data))
with tarfile.open(args.archive) as archive:
    members = archive.getmembers()
    assert len(members) == len(files)
    for member in members:
        path = PurePosixPath(member.name)
        assert path.parts[0] == 'package' and '..' not in path.parts and not path.is_absolute()
        assert member.isfile() and not member.islnk() and not member.issym()
        assert archive.extractfile(member).read() == root.joinpath(*path.parts[1:]).read_bytes(), member.name
    packed = json.load(archive.extractfile('package/package.json'))
    assert (packed['name'], packed['version']) == (manifest['name'], manifest['version'])
print(json.dumps({'name': manifest['name'], 'version': manifest['version'], 'artifact': str(args.archive.resolve()),
                  'sha256': hashlib.sha256(args.archive.read_bytes()).hexdigest(), 'filesVerified': len(files),
                  'hardlinks': 0, 'allBytesMatch': True}))
