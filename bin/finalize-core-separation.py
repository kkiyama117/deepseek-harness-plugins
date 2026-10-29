# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Verify inactive staging references, preserve the rollback copy, then remove this task's temporary paths."""
from pathlib import Path
import os, json, hashlib, shutil, subprocess
core=Path('/data/softwares/deepseek-harness');plugins=Path('/data/softwares/deepseek-harness-plugins');report=plugins/'reports/core-plugin-separation-20261027'
core_stage=Path('/data/softwares/dsh-separation-20261027-core');plugin_stage=Path('/data/softwares/dsh-separation-20261027-plugins');home=Path('/data/softwares/dsh-separation-20261027-home')
legacy=Path('/home/kiyama/.dsh/.agent-presets/ai-reference-store-daily');backup=report/'adoption-backup';saved=Path('/data/backups/dsh-separation-20261027')
assert not saved.exists() and backup.is_dir() and legacy.is_dir()
for key in ['live-core-final.json','live-providers-final.json','final-preservation.json']:
 assert json.loads((report/key).read_text())['status']=='passed',key
prefixes=[str(p) for p in [core_stage,plugin_stage,home,legacy]]
references=[]
for profile in ['web','headless','ai-reference-store-daily']:
 root=Path('/home/kiyama/.dsh/profiles')/profile
 for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml','node_modules/.modules.yaml']:
  file=root/name
  if file.is_file() and any(prefix in file.read_text() for prefix in prefixes):references.append(str(file))
 for directory, dirs, files in os.walk(root/'node_modules',followlinks=False):
  for name in dirs+files:
   path=Path(directory)/name
   if path.is_symlink() and any(str(path.resolve()).startswith(prefix) for prefix in prefixes):references.append(str(path))
assert not references,references
ancestors=set();pid=os.getpid()
while pid:
 ancestors.add(str(pid))
 try:pid=int(Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[1])
 except (OSError,ValueError):break
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit() or proc.name in ancestors:continue
 try:command=(proc/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace');cwd=str((proc/'cwd').resolve())
 except OSError:continue
 assert not any(prefix in command or cwd.startswith(prefix) for prefix in prefixes),f'active staging reference: PID {proc.name}'
for root in [core_stage,plugin_stage]:
 assert root.resolve()==root and (root/'.git').is_file()
 assert subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True)==''
heads={str(root):subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip() for root in [core_stage,plugin_stage]}
expected=json.loads((report/'daily-preset-source-hashes.json').read_text())
assert {p.name for p in legacy.iterdir()}==set(expected)
for name,digest in expected.items():assert hashlib.sha256((legacy/name).read_bytes()).hexdigest()==digest
for path in [legacy,backup,home]:assert path.resolve()==path and not path.is_symlink()
shutil.copytree(legacy,backup/'legacy-daily-preset-source')
assert saved.parent.is_dir();shutil.move(str(backup),str(saved))
subprocess.run(['git','-C',str(core),'worktree','remove',str(core_stage)],check=True)
subprocess.run(['git','-C',str(plugins),'worktree','remove',str(plugin_stage)],check=True)
shutil.rmtree(home);shutil.rmtree(legacy)
result={'status':'passed','removed':[str(p) for p in [core_stage,plugin_stage,home,legacy]],'preservedGitHeads':heads,'rollbackBackup':str(saved),'references':references}
(report/'cleanup.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
