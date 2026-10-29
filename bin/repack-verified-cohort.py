#!/usr/bin/env python3
"""Repack the selected npm file lists without inode-based hardlinks, verifying every byte.

The original archives and manifest are retained as failure evidence. New archives
use a distinct .verified.tgz name and the cohort manifest is replaced only after
all new archives pass manifest and content checks.
"""
from pathlib import Path, PurePosixPath
import json, tarfile, hashlib

report = Path('/data/softwares/deepseek-harness-plugins/reports/upgrade-20261026-master')
manifest = report/'cohort.jsonl'
original = manifest.read_bytes()
backup = report/'cohort-attempt1.jsonl'
assert not backup.exists()
backup.write_bytes(original)
rows = [json.loads(line) for line in original.decode().splitlines()]
result, audit = [], []
for row in rows:
    source = Path(row['sourceDirectory'])
    old = Path(row['artifact'])
    new = old.with_name(old.name.removesuffix('.tgz') + '.verified.tgz')
    assert not new.exists(), new
    with tarfile.open(old) as archive:
        members = archive.getmembers()
        names = [m.name for m in members if m.isfile() or m.islnk() or m.issym()]
        differences = []
        for name in names:
            rel = PurePosixPath(name)
            assert rel.parts[0] == 'package' and '..' not in rel.parts and not rel.is_absolute()
            local = source.joinpath(*rel.parts[1:])
            assert local.is_file(), local
            if archive.extractfile(name).read() != local.read_bytes(): differences.append(name)
    with tarfile.open(new, 'w:gz', dereference=True) as archive:
        for name in names:
            archive.add(source.joinpath(*PurePosixPath(name).parts[1:]), arcname=name, recursive=False)
    with tarfile.open(new) as archive:
        for member in archive.getmembers():
            assert member.isfile() and not member.islnk(), member.name
            local = source.joinpath(*PurePosixPath(member.name).parts[1:])
            assert archive.extractfile(member).read() == local.read_bytes(), member.name
        package = json.load(archive.extractfile('package/package.json'))
        assert (package['name'], package['version']) == (row['name'], row['version'])
    result.append({**row, 'artifact': str(new), 'sha256': hashlib.sha256(new.read_bytes()).hexdigest(), 'verifiedAllFiles': True})
    audit.append({'name': row['name'], 'originalMismatches': differences, 'filesVerified': len(names), 'verifiedArchive': str(new)})
manifest.write_text(''.join(json.dumps(row, ensure_ascii=False)+'\n' for row in result))
(report/'archive-content-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'packages': len(rows), 'originalArchivesWithMismatch': sum(bool(row['originalMismatches']) for row in audit), 'allNewFilesVerified': True}))
