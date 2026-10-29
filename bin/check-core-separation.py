# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Reject unrecorded Core source changes; approved exceptions are exact patches, not directory allowlists."""
from pathlib import Path
import argparse, hashlib, json, subprocess
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--core',type=Path,default=Path('/data/softwares/deepseek-harness'))
parser.add_argument('--output',type=Path)
args=parser.parse_args();core=args.core.resolve()
policy=json.loads(Path(__file__).resolve().parent.parent.joinpath('core-exceptions.json').read_text())
def git(*a):return subprocess.check_output(['git','-C',str(core),*a])
base=policy['approvedUpstreamBase'];head=git('rev-parse','HEAD').decode().strip()
ancestor=subprocess.run(['git','-C',str(core),'merge-base','--is-ancestor',base,head],capture_output=True).returncode==0
patch=git('diff','--binary',base,'--','.')
paths=git('diff','--name-only',base,'--','.').decode().splitlines()
untracked=git('ls-files','--others','--exclude-standard').decode().splitlines()
allowed=set(policy['exception']['files']);digest=hashlib.sha256(patch).hexdigest()
issues=[]
if not ancestor:issues.append('Approved upstream base is not an ancestor of Core HEAD')
if set(paths)-allowed:issues.append('Core contains paths outside the approved exception')
if paths and digest!=policy['exception']['patchSha256']:issues.append('Core exception content differs from the reviewed patch')
if untracked:issues.append('Core contains untracked non-build files')
result={'status':'failed' if issues else 'passed','head':head,'approvedUpstreamBase':base,'localDiffPaths':paths,'patchSha256':digest,'untracked':untracked,'issues':issues}
if args.output:args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
raise SystemExit(bool(issues))
