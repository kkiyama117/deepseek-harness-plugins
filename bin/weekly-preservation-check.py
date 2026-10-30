# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Compare a weekly inventory with current bytes; report concurrent drift without reverting other work."""
from pathlib import Path
import argparse,json,hashlib,datetime
p=argparse.ArgumentParser(description=__doc__);p.add_argument('report',type=Path);args=p.parse_args();r=args.report
initial=json.loads((r/'initial-file-hashes.json').read_text());changes=[];counts={}
for label,root in [('runtime',Path('/data/softwares/deepseek-harness')),('plugins',Path('/data/softwares/deepseek-harness-plugins'))]:
 for name,sha in initial[label].items():
  path=root/name;actual=hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
  if actual!=sha:changes.append({'repository':label,'path':name,'before':sha,'after':actual})
 counts[label]=len(initial[label])
compositions=[]
for x in json.loads((r/'compositions.json').read_text()):
 path=Path(x['path']);sha=hashlib.sha256(path.read_bytes()).hexdigest()
 if sha!=x['sha256']:compositions.append({'path':str(path),'before':x['sha256'],'after':sha,'modifiedAt':datetime.datetime.fromtimestamp(path.stat().st_mtime,datetime.timezone.utc).isoformat()})
profile_changes=[path for path,sha in json.loads((r/'profile-hashes.json').read_text()).items() if hashlib.sha256(Path(path).read_bytes()).hexdigest()!=sha]
result={'status':'drift-observed' if changes or compositions or profile_changes else 'unchanged','initialFilesChecked':counts,'changedInitialFiles':changes,'changedProfileManifests':profile_changes,'changedCompositions':compositions,'note':'This command is read-only except for this report. Writer identity is not inferred from hashes; changes are retained, not reverted.'}
(r/'preservation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
