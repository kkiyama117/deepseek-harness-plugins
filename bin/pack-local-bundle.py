# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pack npm's selected files as independent data entries and verify every archived byte."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, subprocess, tarfile
p=argparse.ArgumentParser(description=__doc__);p.add_argument('package',type=Path);p.add_argument('output',type=Path);args=p.parse_args()
source=args.package.resolve();output=args.output.resolve();assert source.is_dir() and not output.exists()
manifest=json.loads((source/'package.json').read_text())
result=subprocess.run(['npm','pack','--dry-run','--json','--ignore-scripts'],cwd=source,text=True,capture_output=True,check=True)
files=[row['path'] for row in json.loads(result.stdout)[0]['files']]
assert 'package.json' in files
for name in files:
 rel=PurePosixPath(name);file=source/name
 assert not rel.is_absolute() and '..' not in rel.parts and file.resolve().is_relative_to(source) and file.is_file() and not file.is_symlink(),name
with tarfile.open(output,'w:gz',dereference=True) as archive:
 for name in files:archive.add(source/name,arcname='package/'+name,recursive=False)
with tarfile.open(output) as archive:
 for member in archive.getmembers():
  assert member.isfile() and not member.islnk(),member.name
  assert archive.extractfile(member).read()==(source/member.name.removeprefix('package/')).read_bytes(),member.name
 loaded=json.load(archive.extractfile('package/package.json'))
 assert (loaded['name'],loaded['version'])==(manifest['name'],manifest['version'])
print(json.dumps({'name':manifest['name'],'version':manifest['version'],'artifact':str(output),'filesVerified':len(files),'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
