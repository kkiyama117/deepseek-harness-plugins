#!/usr/bin/env python3
"""Finalize the already deployed upgrade; never install packages or restart services."""
from pathlib import Path
import os, json, hashlib, shutil, subprocess, datetime
CORE=Path('/data/softwares/deepseek-harness')
PLUGINS=Path('/data/softwares/deepseek-harness-plugins')
REPORT=PLUGINS/'reports/upgrade-20261026-master'
HOME=Path('/home/kiyama/.dsh')
NEW='9cef77e8fba8fa6e4f1bc64b85d79a5f6c2533d7'
TEMP=[Path('/data/softwares/dsh-update-20261026-core'),Path('/data/softwares/dsh-update-20261026-plugins'),Path('/data/softwares/dsh-update-20261026-home')]
def git(root,*args): return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
assert git(CORE,'rev-parse','HEAD')==NEW
subprocess.run(['git','-C',str(CORE),'merge-base','--is-ancestor','22ddee3792402c3e70ec5f86a63c3e3e895a2f60',NEW],check=True)
log=(REPORT/'canonical-runtime-verification.log').read_text();health=json.loads(log[log.index('{'):])
assert health['worker']['phase']=='online' and health['worker']['socket']=='connected'
assert len(health['pages'])==2 and all(p['settingsRendered'] and not p['pageErrors'] and p['unavailablePlugins']==0 for p in health['pages'])
daily=json.loads((REPORT/'canonical-daily-check.log').read_text());assert daily['model_turns']==0 and daily['tools']==['aistore_native_task']
history=json.loads((REPORT/'existing-data-verification.json').read_text());assert history['persistedTextVisible'] and history['persistedImageLoaded'] and not history['pageErrors']
for path in TEMP: assert path.resolve()==path and not path.is_symlink()
assert git(TEMP[0],'rev-parse','HEAD')==NEW and not git(TEMP[0],'status','--porcelain')
plugin_commit=git(TEMP[1],'rev-parse','HEAD');assert not git(TEMP[1],'status','--porcelain')
refs=[]
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit(): continue
 try: cwd=os.readlink(proc/'cwd');argv=(proc/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
 except OSError: continue
 if any(str(path) in cwd or str(path) in argv for path in TEMP):refs.append(proc.name)
assert not refs, 'Temporary references remain: '+','.join(refs)
subprocess.run(['git','-C',str(CORE),'worktree','remove',str(TEMP[0])],check=True)
subprocess.run(['git','-C',str(PLUGINS),'worktree','remove',str(TEMP[1])],check=True)
assert TEMP[2]==Path('/data/softwares/dsh-update-20261026-home');shutil.rmtree(TEMP[2])
assert all(not path.exists() for path in TEMP)
invalid=[json.loads(line) for line in (REPORT/'cohort-attempt1.jsonl').read_text().splitlines()]
profiles=''.join((HOME/'profiles'/p/'package.json').read_text() for p in ['web','headless','ai-reference-store-daily'])
for row in invalid:
 p=Path(row['artifact']);assert p.parent==PLUGINS/'releases' and p.resolve()==p and not p.is_symlink()
 assert str(p) not in profiles and hashlib.sha256(p.read_bytes()).hexdigest()==row['sha256']
for row in invalid:Path(row['artifact']).unlink()
env={**os.environ,'DSH_EXPECTED_PLUGIN_IDS':str(REPORT/'expected-active-plugins.json')}
with (REPORT/'canonical-final-placement.log').open('w') as output:
 subprocess.run(['node',str(PLUGINS/'bin/verify-runtime-location.mjs')],cwd=CORE,env=env,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=180)
receipt_path=REPORT/'cutover-state.json';receipt=json.loads(receipt_path.read_text())
(REPORT/'cutover-before-final-acceptance.json').write_text(json.dumps(receipt,indent=2)+'\n')
receipt.update(status='completed-deployment-and-cleanup',deploymentError=receipt.pop('error',None),finalAcceptance='direct verification after transient startup-readiness helper error',temporaryPathsRemoved=True,corruptUnusedArchivesRemoved=len(invalid),pluginSourceCommit=plugin_commit,completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
maintenance_path=PLUGINS/'maintenance.json';maintenance=json.loads(maintenance_path.read_text())
maintenance.update(runtime_manifest_version=json.loads((CORE/'package.json').read_text())['version'],upstream_base_commit='22ddee3792402c3e70ec5f86a63c3e3e895a2f60',integrated_head=NEW,last_inspected_target='22ddee3792402c3e70ec5f86a63c3e3e895a2f60',local_core_commits=[NEW,'0ac71bb06897fc8e7a473217cd4dc9f59a8c1d18'])
maintenance['last_authorized_update']={'status':'deployed_verified_cleaned','core_commit':NEW,'plugin_commit':plugin_commit,'report':str(REPORT/'final-report.ja.md'),'receipt':str(receipt_path),'placement_final':'passed','task_worktrees_removed':True,'daily_business_batch_replayed':False,'new_version_exemptions':0}
maintenance_path.write_text(json.dumps(maintenance,ensure_ascii=False,indent=2)+'\n')
progress_path=REPORT/'progress.json';progress=json.loads(progress_path.read_text());progress.update(status='completed_deployment_verified_cleanup_done',plugins_commit=plugin_commit,temporary_paths_removed=True);progress_path.write_text(json.dumps(progress,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':receipt['status'],'core':NEW,'pluginSourceCommit':plugin_commit,'temporaryPathsRemoved':[str(p) for p in TEMP],'invalidArchivesRemoved':len(invalid)}))
