#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Adopt the prepared Core/plugin separation exactly once.

Preflight is the default and writes nothing; --execute refuses inside the dsh-web-managed cgroup, so the
parent runs it as an independent systemd oneshot service from the canonical plugin checkout. It snapshots
the old Core runtime, applies the 55 scoped plugin paths, moves the six preserved Jev drafts, fast-forwards
Core to 93ea and rebuilds it, adds pilot 1.1.0 and daily-preset 1.0.1 through the built CLI to the profiles
that already depend on them, starts the services, waits for typed readiness, and runs the canonical checks.
Only a failure before the first new-runtime start rolls back; Session data is never restored and nothing is
cleaned up or declared complete here.
"""
from pathlib import Path
import argparse, hashlib, json, os, shutil, socket, subprocess, sys, tarfile, time
from datetime import datetime, timedelta, timezone
CORE = Path('/data/softwares/deepseek-harness'); LIVE = Path('/data/softwares/deepseek-harness-plugins')
STAGE = Path('/data/softwares/dsh-separation-20261027-plugins'); HOME = Path('/home/kiyama/.dsh')
REPORT = LIVE / 'reports/core-plugin-separation-20261027'
NODE = Path('/home/kiyama/.local/share/mise/installs/node/latest/bin/node'); PYTHON = Path('/usr/bin/python3')
PNPM = Path('/home/kiyama/.local/share/mise/installs/pnpm/latest/bin/pnpm'); STATUS = Path('/home/kiyama/.local/state/slack-intake-bridge/status.json')
CLI = 'apps/cli/lib/bin.js'; PORT = 3080; LONG = 2400; READY = 180; SCOPE_PATHS = 55
PREV = '9cef77e8fba8fa6e4f1bc64b85d79a5f6c2533d7'; NEXT = '93ea327f75f4176ce8cbc69dedae64891a64e97c'
WEB = 'dsh-web-managed.service'; WORKER = 'slack-intake-bridge.service'; DAILY = 'ai-reference-store-daily'
PILOT = '@local/dsh-request-acceptance-pilot'; PRESET = '@local/dsh-ai-reference-store-daily-preset'
GOAL = '@kkiyama117/dsh-goal-acceptance'; VERSIONS = {PILOT: '1.1.0', PRESET: '1.0.1', GOAL: '1.1.0'}
STAGED = 'local-design/jev-design-iTPPoocQ/'; CORE_STAGED = 'jev-design-iTPPoocQ/'
GUARDS = ('bin/check-runtime-placement.py', 'bin/verify-runtime-location.mjs', 'bin/verify-existing-data.mjs', 'bin/staged-service-probe.mjs')
MEMBERS = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'node_modules'); ENV_PATH = f'{PNPM.parent}:{NODE.parent}:/usr/local/bin:/usr/bin:/bin'
class AdoptionError(RuntimeError):
    """A precondition or step is not safe to continue past."""

def require(condition, message):
    if not condition: raise AdoptionError(message)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
def load_json(path): return json.loads(Path(path).read_text())
def stamp(): return datetime.now(timezone.utc).isoformat()
def emit(**fields): print(json.dumps(fields, ensure_ascii=False))
def save_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n'); os.replace(temporary, path)
def run(argv, cwd=None, timeout=900, check=True):
    """The only path to the machine; every test replaces it with a fake."""
    command = [str(part) for part in argv]
    done = subprocess.run(command, cwd=cwd, timeout=timeout, check=False, text=True, capture_output=True,
                          env=dict(os.environ, DSH_HOME=str(HOME), CI='1', PATH=ENV_PATH))
    if check and done.returncode: raise AdoptionError(f'{" ".join(command[:4])} exited {done.returncode}: {done.stderr.strip()[-300:]}')
    return done
def checked_step(label, argv, cwd=None, timeout=900):
    result = run(argv, cwd=cwd, timeout=timeout, check=False)
    (REPORT / ('adoption-' + label + '.log')).write_text(result.stdout + result.stderr)
    require(result.returncode == 0, f'{label} failed; see its adoption log')
    return result

def load_inputs():
    paths = [REPORT / name for name in ('progress.json', 'before.json', 'adoption-scope.json', 'releases.json')]
    require(all(path.is_file() for path in paths), f'missing an authoritative input in {REPORT}')
    progress, before, scope, releases = (load_json(path) for path in paths)
    return {'progress': progress, 'before': before, 'scope': scope, 'releases': releases}
def scope_rows(scope):
    rows = scope.get('changes') or []
    require(bool(rows), 'the reviewed adoption scope is empty')
    for row in rows:
        path = Path(row['path'])
        require(row['status'] in 'AMD' and not path.is_absolute() and '..' not in path.parts, f'unsafe scope row: {row}')
    return rows
def profile_plan(releases):
    """Only profiles that already depend on the pilot or the daily preset change."""
    artifacts = {row['name']: row['artifact'] for row in releases}; plan = []
    for directory in sorted((HOME / 'profiles').iterdir()):
        manifest = load_json(directory / 'package.json') if (directory / 'package.json').is_file() else {}
        dependencies = manifest.get('dependencies') or {}
        changes = {name: f'file:{artifacts[name]}' for name in (PILOT, PRESET) if name in dependencies
                   and name in artifacts and dependencies[name] != f'file:{artifacts[name]}'}
        plan += [{'profile': directory.name, 'changes': changes, 'bundles': (manifest.get('dsh') or {}).get('profile', {}).get('bundles', [])}] if changes else []
    return plan
def inside_gui(web_group):
    """A GUI-run process dies with the service it would rebuild."""
    pid, groups = os.getpid(), []
    while pid > 1 and len(groups) < 32:
        try:
            groups.append(Path(f'/proc/{pid}/cgroup').read_text().split('::', 1)[-1].strip())
            pid = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[-1].split()[1])
        except (OSError, IndexError, ValueError):
            break
    return bool(web_group) and any(group == web_group or group.startswith(web_group + '/') for group in groups)
def move_documents(staged):
    """Hand the six preserved drafts over, leaving every other index entry alone."""
    copies = []
    for name in staged:
        require(name.startswith(CORE_STAGED), f'a staged document is outside the Jev directory: {name}')
        copies.append(STAGED + name[len(CORE_STAGED):]); require(digest(CORE / name) == digest(LIVE / copies[-1]), f'a preserved document differs from its copy: {name}')
    run(['git', '-C', CORE, 'rm', '--cached', '--quiet', '--', *staged])
    for name in staged:
        path = CORE/name; require(path.resolve() == path and not path.is_symlink(), f'unsafe document path: {path}'); path.unlink()
    run(['git', '-C', LIVE, 'add', '--', *copies])
def backup(rows, plan):
    """Snapshot what is about to be replaced, before anything is replaced."""
    target = REPORT / 'adoption-backup'; target.mkdir(parents=True, mode=0o700)
    run(['cp', '-a', str(CORE), str(target / 'core-old')], timeout=LONG)
    volumes = [('pluginSource', LIVE, [row['path'] for row in rows if (LIVE / row['path']).is_file()])]
    for entry in plan:
        directory = HOME / 'profiles' / entry['profile']
        volumes += [(f'profile-{entry["profile"]}', directory, [name for name in MEMBERS if (directory / name).exists() or (directory / name).is_symlink()])]
    for label, root, names in volumes:
        with tarfile.open(target / f'{label}.tar.gz', 'w:gz') as package:
            for name in names: package.add(root / name, arcname=name, recursive=True)
    return target
def start(unit): run(['systemctl', '--user', 'start', unit])
def install_profiles(plan):
    """Add this task's archives through the built CLI; never a hand-written manifest."""
    results = {}
    for entry in plan:
        profile, directory = entry['profile'], HOME / 'profiles' / entry['profile']
        checked_step('packages-' + profile, [NODE, CORE / CLI, 'plugin', '--profile', profile, 'add', *entry['changes'].values(), '--ignore-scripts'],
                     cwd=LIVE, timeout=1200)
        manifest = load_json(directory / 'package.json')
        for name, spec in entry['changes'].items():
            installed = directory / 'node_modules' / name / 'package.json'
            require((manifest.get('dependencies') or {}).get(name) == spec and installed.is_file() and load_json(installed).get('version') == VERSIONS[name], f'{profile}: {name} is not {spec} at {VERSIONS[name]}')
        require((manifest.get('dsh') or {}).get('profile', {}).get('bundles', []) == entry['bundles'], f'{profile}: bundles changed')
        goal = directory / 'node_modules' / GOAL / 'package.json'; results[profile] = load_json(goal).get('version') if goal.is_file() else None
        require(PILOT not in entry['changes'] or results[profile] == VERSIONS[GOAL], f'{profile}: {GOAL} is {results[profile]}')
    return results
def worker_readiness(payload, now=None):
    """Only the typed socket object with a current timestamp proves a connected worker."""
    socket_state = payload.get('socket')
    try: updated = datetime.fromisoformat(str(payload['updated_at']).replace('Z', '+00:00'))
    except (KeyError, TypeError, ValueError): return None
    if (payload.get('phase') != 'online' or payload.get('last_error') is not None or not isinstance(socket_state, dict)
            or socket_state.get('status') != 'connected'
            or (now or datetime.now(timezone.utc)) - updated >= timedelta(seconds=180)): return None
    return {'phase': payload['phase'], 'socket': socket_state['status'], 'updatedAt': payload['updated_at']}
def worker_ready():
    try: return worker_readiness(load_json(STATUS))
    except (OSError, ValueError): return None
def web_ready():
    try: socket.create_connection(('127.0.0.1', PORT), timeout=2).close()
    except OSError: return None
    return {'active': 'active'} if run(['systemctl', '--user', 'is-active', WEB], check=False).stdout.strip() == 'active' else None
def wait(probe, failure, timeout=READY):
    for _ in range(timeout // 2):
        ready = probe()
        if ready: return ready
        time.sleep(2)
    raise AdoptionError(failure)
def checks():
    """The existing canonical verification plus the daily no-model mount check."""
    checked_step('core-separation', [PYTHON, '-B', LIVE / 'bin/check-core-separation.py', '--core', CORE,
                 '--output', REPORT / 'adoption-core-separation.json'], timeout=LONG)
    checked_step('runtime', [NODE, LIVE / 'bin/verify-runtime-location.mjs', CORE], timeout=LONG)
    checked_step('history', [NODE, LIVE / 'bin/verify-existing-data.mjs'], timeout=LONG)
    result = checked_step('daily', [NODE, CORE / CLI, '--profile', DAILY, 'daily', 'check'], cwd=CORE, timeout=120)
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    require(any(row.get('mounted') and row.get('model_turns') == 0 and row.get('tools') == ['aistore_native_task'] for row in lines), 'daily no-model check failed')
    return ['check-core-separation', 'verify-runtime-location', 'verify-existing-data', 'daily-no-model']
def clear_node_modules(profile_dir):
    """Drop generated entries without ever following a symlink into a shared store."""
    require(profile_dir.resolve() == profile_dir and not profile_dir.is_symlink(), f'unsafe profile directory: {profile_dir}')
    node = profile_dir / 'node_modules'
    if node.is_symlink(): node.unlink(); return
    for entry in (node.iterdir() if node.is_dir() else ()):
        if entry.is_symlink() or entry.is_file(): entry.unlink()
        else: shutil.rmtree(entry)
def restore(directory, source):
    with tarfile.open(source) as package: package.extractall(directory, filter='tar')
def rollback(inputs, plan, directory, receipt, state):
    """Undo only this procedure's changes, then prove the previous runtime is back."""
    rows, staged = scope_rows(inputs['scope']), list(inputs['before'].get('stagedCore') or [])
    for profile in (entry['profile'] for entry in plan['profiles']):
        clear_node_modules(HOME / 'profiles' / profile); restore(HOME / 'profiles' / profile, directory / f'profile-{profile}.tar.gz')
    created = [row['path'] for row in rows if row['status'] == 'A' and digest(LIVE / row['path']) == row['newSha256']]
    for name in created: (LIVE / name).unlink()
    if staged_created := [copy for copy in (STAGED + name[len(CORE_STAGED):] for name in staged) if copy in created]:
        run(['git', '-C', LIVE, 'rm', '--cached', '--quiet', '--', *staged_created])
    restore(LIVE, directory / 'pluginSource.tar.gz')
    require(CORE.resolve() == CORE and (CORE / '.git').is_dir(), 'unsafe canonical Core recovery target')
    require(not (directory / 'core-failed').exists() and (directory / 'core-old' / CLI).is_file(), 'Core recovery copy unavailable')
    os.rename(CORE, directory / 'core-failed'); os.rename(directory / 'core-old', CORE)
    try:
        start(WORKER); start(WEB)
        for probe, failure in ((worker_ready, 'the restored worker never reported a connected socket'), (web_ready, 'the restored Web never answered')): wait(probe, failure, 60)
        run([PYTHON, '-B', LIVE / 'bin/check-runtime-placement.py', '--all'], timeout=60)
        state['rollback'] = 'the previous runtime is restored and checked'
    except AdoptionError as error: state['rollback'] = f'restored but not proven: {error}'
    save_json(receipt, state)
    return state['rollback'].endswith('checked')
def adopt(dry):
    """Verify the whole plan first; adopt only when nothing blocks and dry is false."""
    inputs = load_inputs(); scope, before = inputs['scope'], inputs['before']
    rows, staged = scope_rows(scope), sorted(before.get('stagedCore') or []); require(not scope.get('conflicts'), f'the scope lists conflicts: {scope["conflicts"]}')
    issues, writes = [], []
    for row in rows:
        name = row['path']; current = digest(LIVE / name); stage = STAGE / name
        data = None if row['status'] == 'D' else stage.read_bytes(); wanted = row['newSha256'] if data is not None else None
        if data is not None and hashlib.sha256(data).hexdigest() != wanted: issues.append(f'the stage source changed since capture: {name}')
        elif data is None and (stage.exists() or stage.is_symlink()): issues.append(f'the stage source still has a path the scope deletes: {name}')
        elif current == wanted: continue
        elif current == row['currentSha256']: writes.append((name, data))
        else: issues.append(f'an unrelated change would be overwritten: {name}')
    require(not issues, f'the scope does not apply cleanly: {issues}')
    for file, expected in scope['profileHashes'].items(): require(digest(Path(file)) == expected, f'profile changed after review: {file}')
    protected = [row['path'] for row in rows if row['path'] in GUARDS or row['path'].endswith('.service') or row['path'].startswith(('apps/', '.github/', 'compat/'))]
    require(not protected, f'the scope would change protected paths: {protected}')
    for name in staged:
        copy = STAGED + name[len(CORE_STAGED):] if name.startswith(CORE_STAGED) else ''
        require(any(row['path'] == copy and digest(CORE / name) == row['newSha256'] for row in rows),
                f'a staged document has no preserved scoped copy: {name}')
    require(run(['git', '-C', CORE, 'rev-parse', 'HEAD']).stdout.strip() == PREV, f'Core HEAD is not {PREV}')
    entries = [line for line in run(['git', '-C', CORE, 'status', '--porcelain']).stdout.splitlines() if line.strip()]
    require([line[3:] for line in entries if line[:2] == 'A '] == staged and len(entries) == len(staged), f'the Core index is not the six staged documents: {entries}')
    by_name = {row.get('name'): row for row in inputs['releases']}
    for name in (PILOT, PRESET, GOAL):
        artifact = Path((by_name.get(name) or {}).get('artifact') or '/nonexistent')
        require(digest(artifact) == (by_name.get(name) or {}).get('sha256'), f'an archive is missing or changed: {artifact}')
    for row in rows:
        target = LIVE/row['path']; require(target.resolve() == target and not target.is_symlink(), f'unsafe scoped target: {target}')
    require(not any((REPORT / name).exists() for name in ('adoption-receipt.json', 'adoption-backup')), 'an earlier attempt left a receipt or backup; archive it first')
    web_group = run(['systemctl', '--user', 'show', WEB, '-p', 'ControlGroup', '--value'], check=False).stdout.strip()
    plan = {'scopedPaths': len(rows), 'stagedDocuments': staged, 'profiles': profile_plan(inputs['releases']), 'insideGuiCgroup': inside_gui(web_group)}
    activity = json.loads(run([NODE, LIVE/'bin/read-live-session-status.mjs'], timeout=70).stdout)
    allowed = {'session-f89895cd-5930-4eda-9811-b9b0b9e3e1e7'}
    require(activity.get('ok') and all(row['sessionId'] in allowed for row in activity['active']), 'another session is active; no interruption is authorized for this separation')
    run([PYTHON, '-B', LIVE/'bin/check-runtime-placement.py', '--all'], timeout=60)
    if dry: return plan
    receipt, stopped, directory = REPORT / 'adoption-receipt.json', False, None
    state = {'status': 'running', 'startedAt': stamp(), 'runtimeStartIssued': False, 'sessionDataRestored': False, 'parentCleanupRequired': [str(STAGE), str(REPORT / 'adoption-backup')]}
    try: handle = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(handle, (json.dumps(state) + '\n').encode()); os.close(handle)
    except FileExistsError as error: raise AdoptionError(f'an earlier attempt owns the receipt: {error}') from error
    try:
        directory = backup(rows, plan['profiles'])
        run(['systemctl', '--user', 'stop', WORKER, WEB]); stopped = True
        for name, data in writes:
            target = LIVE / name
            if data is None: target.unlink(); continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.with_name(target.name + '.tmp').write_bytes(data); os.replace(target.with_name(target.name + '.tmp'), target)
        move_documents(staged)
        run(['git', '-C', CORE, 'merge', '--ff-only', NEXT])
        require(run(['git', '-C', CORE, 'rev-parse', 'HEAD']).stdout.strip() == NEXT, f'Core did not reach {NEXT}')
        checked_step('core-install', [PNPM, 'install', '--frozen-lockfile', '--ignore-scripts'], cwd=CORE, timeout=LONG)
        checked_step('core-clean', [PNPM, 'run', 'clean'], cwd=CORE, timeout=600)
        checked_step('core-build', [PNPM, 'run', 'build'], cwd=CORE, timeout=LONG); require((CORE / CLI).is_file(), 'the Core build produced no CLI entry point')
        state['profiles'] = install_profiles(plan['profiles'])
        state['runtimeStartIssued'] = True; save_json(receipt, state); start(WORKER)
        state['workerReadiness'] = wait(worker_ready, 'the worker never reported a connected socket')
        start(WEB); state['webReadiness'] = wait(web_ready, 'Web never answered on its canonical port')
        state['checks'] = checks(); state['status'] = 'completed'; state['finishedAt'] = stamp()
        save_json(receipt, state); return state
    except Exception as error:
        state['failure'] = f'{type(error).__name__}: {error}'
        if state['runtimeStartIssued']: state['status'] = 'failed-after-start'
        elif directory is None:
            state['status'] = 'failed-no-mutation'
            if stopped: start(WORKER); start(WEB)
        else: state['status'] = ('failed-rolled-back' if rollback(inputs, plan, directory, receipt, state)
                                 else 'failed-rollback-unverified')
        state['finishedAt'] = stamp(); save_json(receipt, state); raise
def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='perform the one guarded adoption')
    parser.add_argument('--preflight', action='store_true', help='read-only check (the default)')
    args = parser.parse_args(argv); os.umask(0o077)
    if args.execute and args.preflight: parser.error('choose --preflight or --execute')
    try: plan = adopt(True)
    except Exception as error: emit(status='preflight-error', type=type(error).__name__, message=str(error)); return 1
    emit(status='preflight-passed', plan=plan)
    if not args.execute: return 0
    if plan['insideGuiCgroup']:
        emit(status='refused', reason=f'this process is inside the {WEB} cgroup; the parent must launch it as an independent systemd oneshot service'); return 2
    try: state = adopt(False)
    except Exception as error: emit(status='adoption-error', type=type(error).__name__, message=str(error)); return 1
    emit(status=state['status'], checks=state['checks'], receipt=str(REPORT / 'adoption-receipt.json')); return 0
if __name__ == '__main__':
    sys.exit(main())
