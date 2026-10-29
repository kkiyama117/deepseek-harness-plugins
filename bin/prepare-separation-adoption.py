# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Capture exact source/profile preconditions for the approved separation, without applying changes."""
from pathlib import Path
import subprocess,json,hashlib
stage=Path(__file__).resolve().parent.parent
live=Path('/data/softwares/deepseek-harness-plugins')
report=live/'reports/core-plugin-separation-20261027'
base='00ca231e49496d38a411dfe189551bea417c7e8b'
def digest(data):return hashlib.sha256(data).hexdigest()
rows=subprocess.check_output(['git','-C',str(stage),'diff','--no-renames','--name-status',base,'HEAD'],text=True).splitlines()
plan=[];conflicts=[]
for line in rows:
 status,path=line.split('\t',1)
 old=subprocess.run(['git','-C',str(stage),'show',base+':'+path],capture_output=True)
 current=(live/path).read_bytes() if (live/path).is_file() else None
 wanted=(stage/path).read_bytes() if (stage/path).is_file() else None
 if current is not None and current!=wanted and (old.returncode!=0 or current!=old.stdout):conflicts.append(path)
 plan.append({'status':status,'path':path,'currentSha256':None if current is None else digest(current),'newSha256':None if wanted is None else digest(wanted)})
profiles={}
for name in ['web','headless','ai-reference-store-daily']:
 root=Path('/home/kiyama/.dsh/profiles')/name
 for file in ['package.json','cordis.patch.yml','pnpm-workspace.yaml']:
  profiles[str(root/file)]=digest((root/file).read_bytes())
(report/'adoption-scope.json').write_text(json.dumps({'base':base,'changes':plan,'conflicts':conflicts,'profileHashes':profiles},indent=2)+'\n')
print(json.dumps({'scopedPaths':len(plan),'conflicts':conflicts},indent=2))
raise SystemExit(bool(conflicts))
