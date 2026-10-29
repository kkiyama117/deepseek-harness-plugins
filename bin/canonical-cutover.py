#!/usr/bin/env python3
"""Guarded canonical-path DSH cutover. No deployment path is changed to a worktree.

Run in a separate systemd user unit so stopping the GUI cannot kill this process.
Failures before new services start preserve backups and attempt to restore the old
source/artifacts/profiles. Failures after startup never overwrite Session data.
"""
from pathlib import Path
import os, json, subprocess, hashlib, shutil, traceback, time, sys, tarfile, socket
from datetime import datetime

CORE = Path('/data/softwares/deepseek-harness')
STAGE = Path('/data/softwares/dsh-update-20261026-core')
PLUGINS = Path('/data/softwares/deepseek-harness-plugins')
PSTAGE = Path('/data/softwares/dsh-update-20261026-plugins')
HOME = Path('/home/kiyama/.dsh')
DATA = Path('/home/kiyama/.dsh-recovery-20261005')
REPORT = PLUGINS / 'reports/upgrade-20261026-master'
ATTEMPTS = {'--placement-loaded': 'placement-loaded', '--complete-20261027': 'completion-20261027', '--validated-runner': 'validated-runner', '--verified-archives': 'verified-archives'}
ATTEMPT = next((value for flag, value in ATTEMPTS.items() if flag in sys.argv), 'initial')
BACKUP = Path('/data/backups/dsh-master-20261026')
if ATTEMPT != 'initial': BACKUP = BACKUP/ATTEMPT
OLD = 'dc7b99773abc2a9f7332ea6294fdcc8c173d9630'
NEW = '9cef77e8fba8fa6e4f1bc64b85d79a5f6c2533d7'
SELF = 'session-f89895cd-5930-4eda-9811-b9b0b9e3e1e7'
WEB = 'dsh-web-managed.service'
WORKER = 'slack-intake-bridge.service'
NODE = '/home/kiyama/.local/share/mise/installs/node/latest/bin/node'
PNPM = '/home/kiyama/.local/share/mise/installs/pnpm/latest/bin/pnpm'
os.umask(0o077)
os.environ['PATH'] = str(Path(NODE).parent) + ':' + str(Path(PNPM).parent) + ':/usr/local/bin:/usr/bin:/bin'
os.environ['DSH_HOME'] = str(HOME)
os.environ['CI'] = '1'
CHECK_ONLY = '--preflight' in sys.argv
if not CHECK_ONLY:
    lock = os.open(REPORT/('cutover-started' if ATTEMPT == 'initial' else 'cutover-started-'+ATTEMPT), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(lock, str(os.getpid()).encode()); os.close(lock)
state = {'attempt': ATTEMPT, 'status': 'preflight', 'oldHead': OLD, 'targetHead': NEW, 'startedAt': time.time(), 'servicesStarted': False}

def save(**values):
    state.update(values)
    (REPORT / 'cutover-state.json').write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps(values), flush=True)

def run(args, cwd=CORE, timeout=900, name=None):
    print('RUN', ' '.join(map(str,args)), flush=True)
    if name:
        with (REPORT / name).open('w') as log:
            subprocess.run(list(map(str,args)), cwd=cwd, check=True, timeout=timeout, stdout=log, stderr=subprocess.STDOUT)
        return ''
    return subprocess.check_output(list(map(str,args)), cwd=cwd, text=True, stderr=subprocess.STDOUT, timeout=timeout)

def git(*args, cwd=CORE): return run(['git', *args], cwd=cwd).strip()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def archive(root, paths, dest):
    selected = [str(p) for p in paths if (root/p).exists() or (root/p).is_symlink()]
    listing = BACKUP / (dest.name + '.paths0')
    listing.write_bytes(b''.join(os.fsencode(p)+b'\0' for p in selected))
    run(['tar', '--zstd', '-cf', dest, '-C', root, '--null', '-T', listing], cwd=root, timeout=1200)
    assert dest.stat().st_size > 0

def restore_profiles(archive_path):
    profiles = ['web', 'headless', 'ai-reference-store-daily']
    for profile in profiles:
        modules = HOME/'profiles'/profile/'node_modules'
        assert modules.resolve() == modules and not modules.is_symlink()
        if modules.exists(): shutil.rmtree(modules)
    run(['tar', '--zstd', '-xf', archive_path, '-C', HOME, *['profiles/'+p for p in profiles]], timeout=1200)

def worker_ready(worker, started_at):
    """Treat the initial socket='offline' status as pending, not a failed cutover."""
    fresh = datetime.fromisoformat(worker['updated_at'].replace('Z', '+00:00')).timestamp() >= started_at
    return (fresh and worker['phase'] == 'online'
            and isinstance(worker['socket'], dict) and worker['socket']['status'] == 'connected'
            and worker['last_error'] is None)

stopped = False
source_changed = False
backed_up = False
try:
    assert CORE.resolve() == CORE and (CORE/'.git').is_dir()
    assert STAGE.resolve() == STAGE and (STAGE/'.git').is_file()
    assert json.loads((BACKUP/'owner.json').read_text())['newHead'] == NEW
    assert git('rev-parse','HEAD') == OLD
    assert git('rev-parse','HEAD',cwd=STAGE) == NEW
    assert not git('status','--porcelain',cwd=STAGE)
    original = (REPORT/'runtime-local.patch').read_bytes()
    assert subprocess.check_output(['git','-C',str(CORE),'diff','HEAD','--binary']) == original, 'Canonical source changed; rebase first'
    run([NODE, PSTAGE/'bin/read-live-session-status.mjs', REPORT/'pre-cutover-activity.json'],cwd=PSTAGE,timeout=70,name='pre-cutover-activity.log')
    activity = json.loads((REPORT/'pre-cutover-activity.json').read_text())
    allowed_sessions = {SELF} | {arg.removeprefix('--allow-session=') for arg in sys.argv if arg.startswith('--allow-session=')}
    assert activity['ok'] and all(row['sessionId'] in allowed_sessions for row in activity['active']), 'Another Agent is running outside the explicit interruption approval'
    state['approvedInterruptionSessionIds'] = sorted(allowed_sessions-{SELF})
    run(['/usr/bin/python3','-B',PLUGINS/'bin/check-runtime-placement.py','--all'],timeout=30,name='pre-cutover-placement.log')
    package_commit = git('rev-parse','HEAD',cwd=PSTAGE)
    paths = git('diff','--name-only','--diff-filter=ACM','0ecfc1bd87520fdc533af9653806eb5d2d1b96cc',package_commit,cwd=PSTAGE).splitlines()
    assert paths and all(not p.startswith(('reports/','releases/')) for p in paths)
    initial = json.loads((REPORT/'initial-file-hashes.json').read_text())['plugins']
    for p in paths:
        assert (PLUGINS/p).resolve() == PLUGINS/p and not (PSTAGE/p).is_symlink(), p
        if p in initial and sha(PLUGINS/p) != initial[p]:
            assert sha(PLUGINS/p) == sha(PSTAGE/p), f'Concurrent plugin edit: {p}'
    source_hashes = {p:sha(PLUGINS/p) for p in paths}
    (BACKUP/'plugin-source-before.json').write_text(json.dumps(source_hashes,indent=2)+'\n')
    (BACKUP/'core-index').write_bytes((CORE/'.git/index').read_bytes())
    (BACKUP/'plugin-index').write_bytes((PLUGINS/'.git/index').read_bytes())
    cohort = [json.loads(line) for line in (REPORT/'cohort.jsonl').read_text().splitlines()]
    for item in cohort:
        assert sha(Path(item['artifact'])) == item['sha256']
        with tarfile.open(item['artifact']) as package_archive:
            manifest = json.load(package_archive.extractfile('package/package.json'))
            assert (manifest['name'], manifest['version']) == (item['name'], item['version'])
            for member in package_archive.getmembers():
                assert member.isfile() and member.name.startswith('package/') and '..' not in Path(member.name).parts
                assert package_archive.extractfile(member).read() == (Path(item['sourceDirectory'])/member.name.removeprefix('package/')).read_bytes()
    if CHECK_ONLY:
        save(status='preflight-only-passed', packageCommit=package_commit, pluginFiles=len(paths))
        sys.exit(0)
    save(status='stopping', packageCommit=package_commit)
    run(['systemctl','--user','stop',WORKER,WEB],timeout=120)
    stopped = True
    save(status='backing-up')
    outputs = [Path('node_modules'),Path('.dsh-build')]
    for pattern in ['apps/*/lib','apps/*/dist','apps/*/node_modules','packages/*/*/lib','packages/*/*/node_modules','vendor/*/lib','vendor/*/node_modules','native/system/packages/*/lib','native/system/packages/*/bin']:
        outputs += [p.relative_to(CORE) for p in CORE.glob(pattern)]
    archive(CORE, outputs, BACKUP/'runtime-artifacts.tar.zst')
    archive(HOME, [Path('profiles'),Path('cordis.patch.yml'),Path('.credentials.yaml'),Path('.env'),Path('settings.yaml')], BACKUP/'profiles.tar.zst')
    archive(DATA, [Path('sessions'),Path('storages'),Path('attachments')], BACKUP/'session-data.tar.zst')
    archive(PLUGINS, [Path(p) for p in paths], BACKUP/'plugin-source.tar.zst')
    backed_up = True
    assert subprocess.check_output(['git','-C',str(CORE),'diff','HEAD','--binary']) == original
    for p,digest in source_hashes.items(): assert sha(PLUGINS/p)==digest, f'Concurrent plugin edit: {p}'
    overlap = [p for p in json.loads((REPORT/'source-snapshot.json').read_text())['files'] if not p.startswith('jev-design-iTPPoocQ/')]
    pathspec = BACKUP/'core-overlap.paths0'; pathspec.write_bytes(b''.join(os.fsencode(p)+b'\0' for p in overlap))
    run(['git','stash','push','-m','DSH pre-master 20261026 overlapping local source',f'--pathspec-from-file={pathspec}','--pathspec-file-nul'])
    state['sourceStash'] = git('rev-parse','refs/stash')
    save(status='updating-source')
    run(['git','merge','--ff-only',NEW])
    source_changed = True
    save(status='installing-core-dependencies')
    run([PNPM,'install','--frozen-lockfile','--ignore-scripts'],name='canonical-install.log',timeout=600)
    run([PNPM,'run','clean'],name='canonical-clean.log',timeout=180)
    save(status='building-canonical-runtime')
    run([PNPM,'run','build'],name='canonical-build.log',timeout=1800)
    for p in paths:
        source=PSTAGE/p; dest=PLUGINS/p
        assert dest.resolve().is_relative_to(PLUGINS), p
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,dest)
    save(status='installing-profile-cohort')
    cli=CORE/'apps/cli/lib/bin.js'
    for profile in ['web','headless','ai-reference-store-daily']:
        manifest=json.loads((HOME/'profiles'/profile/'package.json').read_text())
        selected=['file:'+item['artifact'] for item in cohort if item['name'] in manifest.get('dependencies',{})]
        if profile=='web':
            selected.append('file:'+str(PLUGINS/'releases/nonamelego-dsh-catppuccin-0.6.4.tgz'))
            selected += ['link:'+str(CORE/'packages/experimental'/p) for p in ['agent-team-profile','auto-review','inspector-profile']]
        if selected: run([NODE,cli,'plugin','--profile',profile,'add',*selected,'--ignore-scripts'],name=f'canonical-{profile}-packages.log',timeout=600)
    run(['/usr/bin/python3','-B',PLUGINS/'bin/check-runtime-placement.py','--all'],name='canonical-placement-before-start.log',timeout=30)
    save(status='starting',servicesStarted=True)
    run(['systemctl','--user','start',WEB,WORKER],timeout=180)
    deadline = time.monotonic()+120
    while True:
        ready = False
        try:
            worker = json.loads(Path('/home/kiyama/.local/state/slack-intake-bridge/status.json').read_text())
            with socket.create_connection(('127.0.0.1',3080),timeout=0.5):
                ready = worker_ready(worker, state['startedAt'])
        except (OSError,ValueError,KeyError):
            ready = False
        if ready: break
        if time.monotonic() >= deadline: raise RuntimeError('New Web/Slack service readiness deadline expired; inspect service logs')
        time.sleep(0.25)
    save(status='verifying')
    os.environ['DSH_EXPECTED_PLUGIN_IDS'] = str(REPORT/'expected-active-plugins.json')
    run([NODE,PLUGINS/'bin/verify-runtime-location.mjs'],name='canonical-runtime-verification.log',timeout=240)
    run([NODE,cli,'--profile','ai-reference-store-daily','daily','check'],name='canonical-daily-check.log',timeout=120)
    daily_log = (REPORT/'canonical-daily-check.log').read_text()
    assert '"model_turns":0' in daily_log and '"aistore_native_task"' in daily_log
    assert 'incompatible with dsh' not in daily_log and 'entries did not activate' not in daily_log
    save(status='deployed-verification-passed-cleanup-pending',newWebPid=run(['systemctl','--user','show',WEB,'-p','MainPID','--value']).strip())
    temporary = [STAGE, PSTAGE, Path('/data/softwares/dsh-update-20261026-home')]
    references = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit(): continue
        try:
            cwd = os.readlink(proc/'cwd'); argv = (proc/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
        except OSError: continue
        if any(str(path) in cwd or str(path) in argv for path in temporary): references.append(proc.name)
    assert not references, 'Temporary paths still referenced by processes: '+','.join(references)
    assert git('rev-parse','HEAD',cwd=STAGE) == NEW and not git('status','--porcelain',cwd=STAGE)
    assert git('rev-parse','HEAD',cwd=PSTAGE) == package_commit and not git('status','--porcelain',cwd=PSTAGE)
    for path in temporary: assert path.resolve()==path and not path.is_symlink()
    run(['git','worktree','remove',STAGE],timeout=180)
    run(['git','worktree','remove',PSTAGE],cwd=PLUGINS,timeout=180)
    assert temporary[2] == Path('/data/softwares/dsh-update-20261026-home')
    shutil.rmtree(temporary[2])
    assert all(not path.exists() for path in temporary)
    corrupt = [json.loads(line) for line in (REPORT/'cohort-attempt1.jsonl').read_text().splitlines()]
    profile_text = ''.join((HOME/'profiles'/profile/'package.json').read_text() for profile in ['web','headless','ai-reference-store-daily'])
    for item in corrupt:
        bad = Path(item['artifact'])
        assert bad.parent == PLUGINS/'releases' and bad.resolve() == bad and not bad.is_symlink()
        assert str(bad) not in profile_text and sha(bad) == item['sha256']
    for item in corrupt: Path(item['artifact']).unlink()
    state['corruptUnusedArchivesRemoved'] = len(corrupt)
    run([NODE,PLUGINS/'bin/verify-runtime-location.mjs'],name='canonical-final-placement.log',timeout=240)
    maintenance_path = PLUGINS/'maintenance.json'
    maintenance = json.loads(maintenance_path.read_text())
    (BACKUP/'maintenance-before-final.json').write_text(json.dumps(maintenance,ensure_ascii=False,indent=2)+'\n')
    maintenance.update(runtime_manifest_version=json.loads((CORE/'package.json').read_text())['version'],
        upstream_base_commit='22ddee3792402c3e70ec5f86a63c3e3e895a2f60', integrated_head=NEW,
        last_inspected_target='22ddee3792402c3e70ec5f86a63c3e3e895a2f60',
        last_authorized_update={'status':'deployed_verified_cleaned','core_commit':NEW,'plugin_commit':package_commit,
        'report':str(REPORT/'final-report.ja.md'),'receipt':str(REPORT/'cutover-state.json'),
        'new_web_pid':state['newWebPid'],'placement_final':'passed','task_worktrees_removed':True,
        'daily_business_batch_replayed':False,'new_version_exemptions':0})
    maintenance_path.write_text(json.dumps(maintenance,ensure_ascii=False,indent=2)+'\n')
    save(status='completed-deployment-and-cleanup',temporaryPathsRemoved=True,finishedAt=time.time())
    (REPORT/'final-report.ja.md').write_text('# DSH master更新結果\n\n常用配置での更新・稼働検証・一時作業ツリー撤去が完了しました。\n\n'
        +f'- Core commit: `{NEW}`（公式master `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` を含む）\n'
        +f'- 更新後Web PID: `{state["newWebPid"]}`\n'
        +'- ローカル／HTTPS設定画面、必要プラグイン、Slack接続、日次の無モデル構成確認を検証しました。日次業務バッチは再実行していません。\n'
        +'- 常用起動先は `/data/softwares/deepseek-harness` のままです。一時worktree 2件と検証用homeを撤去しました。\n'
        +f'- 復旧用バックアップ: `{BACKUP}`。Sessionデータを巻き戻す処理は行っていません。\n'
        +'- 新たなバージョン例外は追加していません。既存のユーザー設定は保持しました。\n'
        +f'- 詳細：[更新記録](<{REPORT}/cutover-state.json>)／[最終配置検証](<{REPORT}/canonical-final-placement.log>)／[日次構成確認](<{REPORT}/canonical-daily-check.log>)。\n')
    subprocess.run(['systemctl','--user','stop','dsh-master-upgrade-20261026.timer'],check=False,capture_output=True)
except SystemExit:
    raise
except BaseException as error:
    save(status='failed',error=str(error),finishedAt=time.time())
    (REPORT/'cutover-error.txt').write_text(traceback.format_exc())
    if stopped and not state['servicesStarted']:
        try:
            if source_changed:
                # Refuse to overwrite edits made outside this cutover, even during recovery.
                assert git('rev-parse','HEAD') == NEW
                drafts = {p for p in json.loads((REPORT/'source-snapshot.json').read_text())['files'] if p.startswith('jev-design-iTPPoocQ/')}
                assert set(git('diff','HEAD','--name-only').splitlines()).issubset(drafts)
                for p in drafts:
                    assert (CORE/p).read_bytes() == subprocess.check_output(['git','-C',str(CORE),'show','3c94b7a3e7d851fceea2dc56402c82a2879f5b7e:'+p])
                # Source and overwritten artifacts are backed up; no new runtime has written Session data.
                run(['git','reset','--hard',OLD])
                if state.get('sourceStash'): run(['git','stash','apply','--index',state['sourceStash']])
            elif state.get('sourceStash'):
                run(['git','stash','apply','--index',state['sourceStash']])
            if backed_up:
                for root,name in [(CORE,'runtime-artifacts.tar.zst'),(PLUGINS,'plugin-source.tar.zst')]:
                    run(['tar','--zstd','-xf',BACKUP/name,'-C',root],timeout=1200)
                restore_profiles(BACKUP/'profiles.tar.zst')
                (CORE/'.git/index').write_bytes((BACKUP/'core-index').read_bytes())
            run(['systemctl','--user','start',WEB,WORKER],timeout=180)
            save(recovery='old-runtime-restored-before-new-start')
        except BaseException as recovery:
            save(recovery='failed',recoveryError=str(recovery))
    raise
