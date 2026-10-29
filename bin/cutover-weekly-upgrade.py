"""Offline cutover through the supported DSH CLI; keep data and source rollback copies.

Only run under a separate systemd user job after staging passes. Credentials and
logs stay private. This script never treats rollback as a completed upgrade.
"""
raise SystemExit('RETIRED: this one-shot cutover promotes a temporary worktree. Deploy only to /data/softwares/deepseek-harness and run bin/verify-runtime-location.mjs.')

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT=Path('/data/softwares/deepseek-harness')
LIVE=Path('/data/softwares/deepseek-harness-upgrade-master')
STAGED=ROOT/'.dsh-maintenance/worktrees/d743267388'
ARCHIVE=Path('/data/softwares/deepseek-harness-preupgrade-20261013')
HOME=Path('/home/kiyama/.dsh')
DATA=Path('/home/kiyama/.dsh-recovery-20261005')
PLUGINS=Path('/data/softwares/deepseek-harness-plugins')
BACKUP=ROOT/'.dsh-maintenance/cutover-20261013'
NODE=Path('/home/kiyama/.local/share/mise/installs/node/latest/bin/node')
NEW_HEAD='b5059f530faec33b8485da5f89b74b70d4f925a9'
UNIT='dsh-web-managed.service'
os.umask(0o077)

def run(args,**kwargs):
    return subprocess.run([str(x) for x in args],check=True,timeout=kwargs.pop('timeout',180),**kwargs)

def git(path,*args):
    return subprocess.check_output(['git','-C',str(path),*args],text=True).strip()

def state(**values):
    record.update(values)
    (BACKUP/'state.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')

if '--execute' not in sys.argv:
    print(json.dumps({'live':str(LIVE),'staged':str(STAGED),'archive':str(ARCHIVE),'backup':str(BACKUP),'expectedHead':NEW_HEAD,'mode':'preflight-only'},indent=2))
    assert git(STAGED,'rev-parse','HEAD')==NEW_HEAD
    assert git(STAGED,'status','--porcelain')==''
    assert not ARCHIVE.exists() and not BACKUP.exists()
    raise SystemExit(0)

assert LIVE.resolve()==LIVE and STAGED.resolve()==STAGED
assert ARCHIVE.resolve()==ARCHIVE and not ARCHIVE.exists()
assert git(STAGED,'rev-parse','HEAD')==NEW_HEAD and git(STAGED,'status','--porcelain')==''
assert git(LIVE,'rev-parse','HEAD')=='da1639e82401fc34dced7246c60168374f45e8d1'
BACKUP.mkdir(mode=0o700)
record={'status':'preparing','targetHead':NEW_HEAD,'applied':False}
state()
moved_old=False
moved_new=False
try:
    run(['systemctl','--user','stop',UNIT],timeout=90)
    state(status='stopped')
    # Copy the actual recovery data root while no Host can append to it.
    shutil.copytree(DATA,BACKUP/'recovery-data',symlinks=True)
    shutil.copytree(HOME/'profiles/web',BACKUP/'profile-web',symlinks=True)
    shutil.copytree(HOME,BACKUP/'dsh-home',symlinks=True,
                    ignore=shutil.ignore_patterns('backups','reports','node_modules'))
    for name in ['cordis.patch.yml','.credentials.yaml','AGENTS.md']:
        source=HOME/name
        if source.exists():shutil.copy2(source,BACKUP/name)
    state(status='backed-up')
    # All four paths are fixed, asserted absolute targets, not computed shell inputs.
    run(['git','-C',ROOT,'worktree','move',LIVE,ARCHIVE])
    moved_old=True
    assert not LIVE.exists()
    run(['git','-C',ROOT,'worktree','move',STAGED,LIVE])
    moved_new=True
    if (ARCHIVE/'.env').is_file():shutil.copy2(ARCHIVE/'.env',LIVE/'.env')
    state(status='source-switched')
    env={**os.environ,'DSH_HOME':str(HOME)}
    cli=[NODE,LIVE/'apps/cli/lib/bin.js','plugin','--profile','web']
    packages=[
        'dshmarket@1.66.19',
        ROOT/'.dsh-maintenance/artifacts/dsh-better-sidebar-0.25.0-local.1.tgz',
        '@linxin666/dsh-client-ui-skill-explorer@0.4.6',
        '@linxin666/dsh-client-ui-web-ui-settings@0.4.6',
        '@linxin666/dsh-remote-web-ui@0.4.6',
        '@nonamelego/dsh-catppuccin@0.6.1',
        PLUGINS/'dsh-session-cleanup',PLUGINS/'dsh-workflow-results',
        PLUGINS/'compat/slack-intake-alpha2',PLUGINS/'compat/slack-digest-alpha2',PLUGINS/'compat/intake-knowledge-alpha2',
        *[PLUGINS/'presets'/name for name in ['cordis-kura','managed-cordis','managed-standard','ai-reference-store-next']],
    ]
    with (BACKUP/'install.log').open('w') as log:
        run([*cli,'add',*packages,'--ignore-scripts'],env=env,cwd=LIVE,stdout=log,stderr=subprocess.STDOUT,timeout=300)
    with (BACKUP/'remove.log').open('w') as log:
        run([*cli,'remove','@kkiyama117/dsh-prompt-compact','@local/dsh-energy-followup','@local/dsh-harness-improvement-launcher','--ignore-scripts'],env=env,cwd=LIVE,stdout=log,stderr=subprocess.STDOUT,timeout=180)
    state(status='packages-updated')
    run(['systemctl','--user','start',UNIT],timeout=90)
    # Keep historical evidence links usable; Git records only the actual live worktree.
    assert not STAGED.exists()
    STAGED.symlink_to(LIVE,target_is_directory=True)
    state(status='started-awaiting-verification',applied=True,finishedAt=time.time())
except Exception as error:
    state(status='failed',error=str(error),applied=False)
    run(['systemctl','--user','stop',UNIT],timeout=90)
    if moved_new:
        assert LIVE.resolve()==LIVE and not STAGED.exists()
        run(['git','-C',ROOT,'worktree','move',LIVE,STAGED])
    if moved_old:
        assert ARCHIVE.resolve()==ARCHIVE and not LIVE.exists()
        run(['git','-C',ROOT,'worktree','move',ARCHIVE,LIVE])
    # Preserve the failed profile rather than deleting it. Data were not migrated by the installer.
    if (BACKUP/'profile-web').exists():
        failed=HOME/'profiles/web-failed-upgrade-20261013'
        assert not failed.exists() and (HOME/'profiles/web').resolve()==HOME/'profiles/web'
        (HOME/'profiles/web').rename(failed)
        shutil.copytree(BACKUP/'profile-web',HOME/'profiles/web',symlinks=True)
    run(['systemctl','--user','start',UNIT],timeout=90)
    state(status='rolled-back-not-complete')
    raise
