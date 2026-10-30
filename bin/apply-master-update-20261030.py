# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Apply one reviewed update plan from an independent service; never roll back data after startup."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,os,shutil,subprocess,time

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(path):return json.loads(Path(path).read_text())
def save(path,value):
 temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,indent=2)+'\n');os.replace(temp,path)
def call(argv,*,cwd=None,timeout=900,log=None,check=True):
 result=subprocess.run([str(x) for x in argv],cwd=cwd,timeout=timeout,text=True,capture_output=True)
 if log:Path(log).write_text(result.stdout+result.stderr)
 if check and result.returncode:raise RuntimeError(f'{argv[0]} failed ({result.returncode}); log={log}')
 return result.stdout
def git(root,*args):return call(['git','-C',root,*args]).strip()
def wait_ready(core,plugins,home,report):
 deadline=time.monotonic()+180
 while time.monotonic()<deadline:
  pid=call(['systemctl','--user','show','dsh-web-managed.service','-p','MainPID','--value']).strip()
  journal=call(['journalctl','--user','-u','dsh-web-managed.service',f'_PID={pid}','--no-pager'])
  status=read(home.parent/'.local/state/slack-intake-bridge/status.json')
  socket=status.get('socket');updated=datetime.fromisoformat(status['updated_at'].replace('Z','+00:00'))
  if 'http://127.0.0.1:3080/?token=' in journal and status.get('phase')=='online' and isinstance(socket,dict) and socket.get('status')=='connected' and status.get('last_error') is None and (datetime.now(timezone.utc)-updated).total_seconds()<180:return
  time.sleep(2)
 raise RuntimeError('New runtime did not become authenticated/connected within180s')
def restore_profile_dependencies(live,prior):
 assert live.resolve()==live and not live.is_symlink()
 modules=live/'node_modules'
 if modules.is_symlink():modules.unlink()
 elif modules.exists():shutil.rmtree(modules)
 call(['cp','-a',prior/'node_modules',modules])
 for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml']:
  if (prior/name).is_file():shutil.copy2(prior/name,live/name)

def preflight(plan,report):
 core=Path(plan['coreRoot']);plugins=Path(plan['pluginsRoot']);home=Path(plan['homeRoot'])
 assert core.resolve()==core and (core/'.git').is_dir()
 assert git(core,'rev-parse','HEAD')==plan['coreBefore']
 assert git(plugins,'rev-parse','HEAD')==plan['pluginBefore'] and not git(plugins,'status','--porcelain')
 names={x for x in call(['git','-C',core,'ls-files','-m','-o','--exclude-standard','-z']).split('\0') if x}
 assert names==set(plan['originalFileHashes'])
 for name,digest in plan['originalFileHashes'].items():assert sha(core/name)==digest,name
 for profile,info in plan['profiles'].items():
  for name,digest in info['files'].items():assert sha(home/'profiles'/profile/name)==digest,(profile,name)
 for item in plan['releases']:assert sha(item['artifact'])==item['sha256'],item['artifact']
 assert sha(home/'cordis.patch.yml')==plan['homePatchHash']
 activity=json.loads(call(['node',plugins/'bin/read-live-session-status.mjs'],timeout=70))
 assert activity['ok'] and all(row['sessionId']==plan['sessionId'] for row in activity['active']), 'Other sessions are active'
 daily=call(['systemctl','--user','show','ai-reference-store-daily.service','-p','ActiveState','--value']).strip()
 assert daily not in ['active','activating','deactivating'],daily
 call(['/usr/bin/python3','-B',plugins/'bin/check-runtime-placement.py','--all'])
 assert not (report/'update-receipt.json').exists() and not Path(plan['backupRoot']).exists()
 return core,plugins,home

def apply(plan_path,execute=False):
 plan=read(plan_path);report=plan_path.parent;os.environ['DSH_HOME']=plan['homeRoot'];os.environ['DSH_VERIFY_SERVICE']='dsh-web-managed.service';core,plugins,home=preflight(plan,report)
 if not execute:return {'status':'preflight-passed','coreTarget':plan['coreTarget'],'pluginTarget':plan['pluginTarget']}
 assert 'dsh-web-managed.service' not in Path('/proc/self/cgroup').read_text(),'Run as an independent systemd service'
 backup=Path(plan['backupRoot']);assert backup.resolve()==backup and backup.parent.is_dir()
 receipt=report/'update-receipt.json';state={'status':'running','startedAt':datetime.now(timezone.utc).isoformat(),'newRuntimeStartIssued':False,'dataRestored':False}
 with receipt.open('x') as output:json.dump(state,output)
 def step(label,argv,cwd=None,timeout=900):
  state['phase']=label;save(receipt,state);return call(argv,cwd=cwd,timeout=timeout,log=report/(label+'.log'))
 stopped=False
 try:
  stopped=True;step('stop',['systemctl','--user','stop','slack-intake-bridge.service','dsh-web-managed.service'])
  backup.mkdir(mode=0o700)
  for label,source in [('core-before',core),('profiles-before',home/'profiles'),('data-before',Path(plan['dataRoot']))]:
   step('backup-'+label,['cp','-a','--reflink=auto',source,backup/label],timeout=1800)
  shutil.copy2(home/'cordis.patch.yml',backup/'home.patch.yml')
  shutil.copy2(plan_path,backup/'plan.json')
  state['backupComplete']=True;save(receipt,state)
  for name,digest in plan['originalFileHashes'].items():assert sha(core/name)==digest,name
  step('preserve-working-state',['git','-C',core,'stash','push','--include-untracked','-m','authorized master update 20261030'])
  state['workStash']=git(core,'rev-parse','stash@{0}');save(receipt,state)
  step('core-fast-forward',['git','-C',core,'merge','--ff-only',plan['coreTarget']])
  step('restore-working-state',['git','-C',core,'stash','apply','--index',state['workStash']])
  for name,digest in plan['integratedFileHashes'].items():assert sha(core/name)==digest,name
  step('plugin-fast-forward',['git','-C',plugins,'merge','--ff-only',plan['pluginTarget']])
  step('core-install',['pnpm','install','--frozen-lockfile','--ignore-scripts'],core,1800)
  step('core-clean',['pnpm','run','clean'],core,600)
  step('core-build',['pnpm','run','build'],core,2400)
  artifacts={row['name']:row for row in plan['releases']}
  for profile,info in plan['profiles'].items():
   changes={name:'file:'+artifacts[name]['artifact'] for name in info['manifest']['dependencies'] if name in artifacts}
   if changes:step('packages-'+profile,['node',core/'apps/cli/lib/bin.js','plugin','--profile',profile,'add',*changes.values(),'--ignore-scripts'],plugins,1200)
   actual=read(home/'profiles'/profile/'package.json');old=info['manifest']
   assert actual['dsh']['profile']['bundles']==old['dsh']['profile']['bundles']
   assert {k:v for k,v in actual['dependencies'].items() if k not in changes}=={k:v for k,v in old['dependencies'].items() if k not in changes}
   for name,spec in changes.items():
    assert actual['dependencies'][name]==spec
    installed=read(home/'profiles'/profile/'node_modules'/name/'package.json');assert installed['version']==artifacts[name]['version']
   for name in ['cordis.patch.yml','pnpm-workspace.yaml']:assert sha(home/'profiles'/profile/name)==info['files'][name]
  assert sha(home/'cordis.patch.yml')==plan['homePatchHash']
  state['newRuntimeStartIssued']=True;save(receipt,state)
  step('start',['systemctl','--user','start','slack-intake-bridge.service','dsh-web-managed.service'])
  wait_ready(core,plugins,home,report)
  step('verify-runtime',['node',plugins/'bin/verify-runtime-location.mjs'],timeout=240)
  step('verify-history',['node',plugins/'bin/verify-existing-data.mjs'],timeout=180)
  step('verify-inspector',['node',core/'bin/verify-inspector-pages.mjs',*plan['origins']],report,180)
  daily=step('verify-daily',['node',core/'apps/cli/lib/bin.js','--profile','ai-reference-store-daily','daily','check'],core,120)
  assert any(row.get('model_turns')==0 and row.get('mounted') for row in [json.loads(line) for line in daily.splitlines() if line.startswith('{')])
  state.update(status='applied-and-verified',finishedAt=datetime.now(timezone.utc).isoformat(),remaining='Parent verifies storage and working-state preservation, records known Core draft deviations, updates metadata and removes inactive staging paths')
  save(receipt,state);return state
 except Exception as error:
  state['failure']=type(error).__name__+': '+str(error)
  if state['newRuntimeStartIssued']:state['status']='failed-after-start-no-automatic-data-rollback'
  elif state.get('backupComplete'):
   assert core.resolve()==core and (core/'.git').is_dir() and not (backup/'core-failed').exists()
   os.rename(core,backup/'core-failed');os.rename(backup/'core-before',core)
   # Only generated dependency trees and package metadata are restored; user patches and persistent data are not replaced.
   for profile in plan['profiles']:
    restore_profile_dependencies(home/'profiles'/profile,backup/'profiles-before'/profile)
   call(['systemctl','--user','start','slack-intake-bridge.service','dsh-web-managed.service'])
   state['status']='failed-prestart-runtime-restored';state['pluginSourceMayRemainForwardCompatible']=True
  else:
   if stopped:call(['systemctl','--user','start','slack-intake-bridge.service','dsh-web-managed.service'])
   state['status']='failed-before-source-mutation'
  save(receipt,state);raise

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('plan',type=Path);parser.add_argument('--execute',action='store_true');args=parser.parse_args();os.umask(0o077)
 print(json.dumps(apply(args.plan,args.execute),indent=2))
