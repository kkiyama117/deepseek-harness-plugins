# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Remove only this maintenance run's committed inactive worktrees and isolated profile home."""
from pathlib import Path
import os,json,subprocess,shutil,argparse
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('report',type=Path);parser.add_argument('--isolated-home',type=Path,required=True);parser.add_argument('--live-home',type=Path,required=True);args=parser.parse_args()
report=args.report;state=json.loads((report/'preparation.json').read_text());prior=json.loads((report/'maintenance-before.json').read_text())
core=Path(prior['runtime_source']);plugins=Path(prior['plugin_repository'])
targets=[Path(state['coreWorktree']),Path(state['pluginWorktree']),args.isolated_home]
for target in targets:assert target.resolve()==target and target.is_dir() and not target.is_symlink()
for target in targets[:2]:
 assert (target/'.git').is_file()
 assert subprocess.check_output(['git','-C',str(target),'status','--porcelain'],text=True)==''
for profile in ['web','headless','ai-reference-store-daily']:
 directory=args.live_home/'profiles'/profile
 for name in ['package.json','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml','node_modules/.modules.yaml']:
  path=directory/name
  if path.is_file():assert not any(str(target) in path.read_text() for target in targets),path
ancestors=set();pid=os.getpid()
while pid:
 ancestors.add(str(pid))
 try:pid=int(Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[1])
 except (OSError,ValueError):break
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit() or proc.name in ancestors:continue
 try:command=(proc/'cmdline').read_bytes().decode(errors='replace');cwd=str((proc/'cwd').resolve())
 except OSError:continue
 assert not any(str(target) in command or cwd.startswith(str(target)) for target in targets),f'active reference: PID {proc.name}'
heads={str(target):subprocess.check_output(['git','-C',str(target),'rev-parse','HEAD'],text=True).strip() for target in targets[:2]}
for repository,target in zip([core,plugins],targets[:2]):subprocess.run(['git','-C',str(repository),'worktree','remove',str(target)],check=True)
shutil.rmtree(targets[2])
result={'status':'passed','removed':[str(target) for target in targets],'preservedCommits':heads,'runtimeChanged':False}
(report/'cleanup.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
