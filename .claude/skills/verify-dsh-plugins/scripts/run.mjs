// Lifecycle of one disposable DSH run: up, doctor, headless, store, logs, down.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DshvError, REPO } from './config.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));

async function waitFor(label, seconds, check, next) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new DshvError(`timed out after ${seconds}s waiting for ${label}`, next);
    await sleep(250);
  }
}

/** The run's environment: own HOME and DSH_HOME, no inherited keys, no display. */
export function isolatedEnv(state, settings) {
  return {
    HOME: join(state.run, 'home'),
    DSH_HOME: join(state.run, 'home/.dsh'),
    PATH: `${join(state.run, 'bin')}:${process.env.PATH}`,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    PLAYWRIGHT_BROWSERS_PATH: settings.browsersPath,
    DEEPSEEK_API_KEY: 'mock-key',
    DEEPSEEK_BASE_URL: state.mockUrl ?? 'http://127.0.0.1:9/v1',
    DSHV_RUN: state.run,
    DSHV_EVIDENCE: state.evidence,
    DSHV_DSH_ROOT: state.dshRoot,
  };
}

export const statePath = run => join(run, 'state.json');
export const saveState = state => writeFileSync(statePath(state.run), `${JSON.stringify(state, null, 2)}\n`);

/** Load a run by path, or `latest` for the newest run under the run root. */
export function loadState(run, settings) {
  if (!run) throw new DshvError('missing <run>', 'pass the path `dshv up` printed, or `latest`');
  if (run === 'latest') {
    const runs = existsSync(settings.runRoot) ? readdirSync(settings.runRoot)
      .map(name => join(settings.runRoot, name)).filter(path => existsSync(statePath(path))) : [];
    if (!runs.length) throw new DshvError(`no runs under ${settings.runRoot}`, 'start one with `dshv up <package>`');
    run = runs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }
  const path = statePath(resolve(run));
  if (!existsSync(path)) throw new DshvError(`no run at ${run}`, 'pass the path `dshv up` printed, or `latest`');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** True when `pid` is alive and was started by this run (its environment carries DSHV_RUN). */
export function ownsPid(state, pid) {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`DSHV_RUN=${state.run}`);
  } catch {
    return false;
  }
}

function dsh(state, settings, args, options = {}) {
  return spawnSync('node', [join(state.dshRoot, 'apps/cli/lib/bin.js'), ...args], {
    env: { ...isolatedEnv(state, settings), ...options.env }, cwd: options.cwd ?? state.dshRoot, encoding: 'utf8',
  });
}

function packageSpec(arg) {
  const path = resolve(REPO, arg);
  if (existsSync(join(path, 'package.json'))) {
    return { spec: `link:${path}`, name: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name };
  }
  if (path.endsWith('.tgz') && existsSync(path)) {
    const manifest = spawnSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' });
    return { spec: `file:${path}`, name: JSON.parse(manifest.stdout).name };
  }
  throw new DshvError(`not a package directory or .tgz: ${arg}`, 'pass e.g. plugins/dsh-workspace-attach or releases/<name>.tgz');
}

function startDetached(state, settings, command, args, logName, cwd) {
  const out = openSync(join(state.run, `${logName}.out`), 'a');
  const err = openSync(join(state.run, `${logName}.err`), 'a');
  // detached = setsid, so the pid is also the process-group id that `down` signals.
  const child = spawn(command, args, { cwd, env: isolatedEnv(state, settings), detached: true, stdio: ['ignore', out, err] });
  child.unref();
  return child.pid;
}

/** Start a run with `packages` installed in fresh web and headless profiles. */
export async function up(packages, settings) {
  if (!packages.length) throw new DshvError('up needs at least one package', 'pass e.g. plugins/dsh-workspace-attach');
  if (!existsSync(join(settings.dshRoot, 'apps/cli/lib/bin.js'))) {
    throw new DshvError(`no built DSH checkout at ${settings.dshRoot}`, 'set DSHV_DSH_ROOT in the skill\'s .env');
  }
  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${process.pid}`;
  const state = {
    id, run: join(settings.runRoot, id), evidence: join(settings.evidenceRoot, id), dshRoot: settings.dshRoot, packages: [],
  };
  mkdirSync(join(state.run, 'home/.config'), { recursive: true });
  // Without a Documents user dir, `xdg-user-dir DOCUMENTS` prints $HOME and DSH skips the first-use Default workspace.
  writeFileSync(join(state.run, 'home/.config/user-dirs.dirs'), 'XDG_DOCUMENTS_DIR="$HOME/Documents"\n');
  mkdirSync(join(state.run, 'bin'));
  mkdirSync(state.evidence, { recursive: true });
  writeFileSync(join(state.run, 'bin/dsh'), `#!/bin/sh\nexec node '${join(state.dshRoot, 'apps/cli/lib/bin.js')}' "$@"\n`);
  chmodSync(join(state.run, 'bin/dsh'), 0o755);
  saveState(state);

  for (const profile of ['web', 'headless']) {
    const result = dsh(state, settings, ['--profile', profile, '--dump-config']);
    if (result.status !== 0) throw new DshvError(`creating the ${profile} profile failed:\n${result.stderr}`);
  }
  for (const arg of packages) {
    const { spec, name } = packageSpec(arg);
    for (const profile of ['web', 'headless']) {
      const result = dsh(state, settings, ['plugin', '--profile', profile, 'add', spec]);
      if (result.status !== 0) throw new DshvError(`adding ${spec} to ${profile} failed:\n${result.stderr}`);
    }
    state.packages.push(name);
  }

  state.mockPid = startDetached(state, settings, 'node', ['--import', 'tsx', 'packages/test-support/llm-mock-server/src/bin.ts',
    '--port', '0', '--api-key', 'mock-key', '--sequence', settings.mockSequence, '--repeat-last'], 'mock', state.dshRoot);
  saveState(state);
  state.mockUrl = await waitFor('the mock LLM', 30, () => {
    const line = readFileSync(join(state.run, 'mock.out'), 'utf8').split('\n').find(text => text.includes('"type":"ready"'));
    return line && JSON.parse(line).baseURL;
  }, `read ${join(state.run, 'mock.err')}`);

  state.webPid = startDetached(state, settings, 'node', [join(state.dshRoot, 'apps/cli/lib/bin.js'),
    '--profile', 'web', '--port', '0', '--host', '127.0.0.1', '--no-open'], 'web', state.dshRoot);
  saveState(state);
  state.webUrl = await waitFor('the web URL', 90, () =>
    readFileSync(join(state.run, 'web.out'), 'utf8').match(/dsh web: (http:\/\/\S+)/)?.[1], `read ${join(state.run, 'web.err')}`);
  state.webOrigin = new URL(state.webUrl).origin;
  saveState(state);
  return state;
}

/** Process, port, and version checks. The web UI checks live in browser.mjs. */
export function processChecks(state, settings) {
  const checks = [];
  const add = (ok, check, detail) => checks.push({ ok, check, ...(detail === undefined ? {} : { detail }) });
  const version = dsh(state, settings, ['--version']).stdout.trim();
  const commit = spawnSync('git', ['-C', state.dshRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  add(true, 'dsh build', `${version} from ${state.dshRoot} @ ${commit}`);
  add(true, 'packages under test', state.packages.join(' '));
  for (const [label, pid] of [['mock LLM', state.mockPid], ['web host', state.webPid]]) {
    add(ownsPid(state, pid), `${label} pid ${pid} belongs to this run`);
  }
  const port = new URL(state.webOrigin).port;
  add(port !== settings.livePort, `web port ${port} is not the live port ${settings.livePort}`);
  const listener = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' }).stdout;
  add(listener.includes(`pid=${state.webPid},`), `web port ${port} is owned by pid ${state.webPid}`);
  return checks;
}

/** Run one headless task; the transcript goes to evidence. */
export function headless(state, settings, task, { cwd, env = {}, name, patches = [] } = {}) {
  const dir = resolve(cwd ?? join(state.run, 'home'));
  if (!existsSync(dir)) throw new DshvError(`no directory ${dir}`, 'create it first, e.g. under the run\'s home');
  const overlays = patches.flatMap(patch => {
    if (!existsSync(resolve(patch))) throw new DshvError(`no patch file ${patch}`, 'pass an existing YAML overlay');
    return ['--patch', resolve(patch)];
  });
  const result = dsh(state, settings, ['--profile', 'headless', ...overlays, '--json', task], { cwd: dir, env });
  const events = result.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
  const outDir = join(state.evidence, 'headless');
  mkdirSync(outDir, { recursive: true });
  const transcript = join(outDir, `${name ?? Date.now()}.jsonl`);
  writeFileSync(transcript, result.stdout);
  writeFileSync(transcript.replace(/\.jsonl$/, '.stderr.txt'), result.stderr);
  const final = events.find(event => event.type === 'final');
  return {
    exitCode: result.status,
    sessionId: events.find(event => event.type === 'session')?.sessionId,
    cwd: dir,
    finished: Boolean(final),
    text: events.filter(event => event.type === 'text').map(event => event.text).join(''),
    warnings: result.stderr.split('\n').filter(line => line.startsWith('dsh: warning') || line.includes('pending')),
    transcript,
  };
}

/** Read one storage-domain file of the run, e.g. `workspace`. */
export function store(state, name) {
  const path = join(state.run, 'home/.dsh/storages', `${name}.json`);
  if (!existsSync(path)) {
    const known = readdirSync(join(state.run, 'home/.dsh/storages')).filter(file => file.endsWith('.json')).map(file => basename(file, '.json'));
    throw new DshvError(`no storage ${name}`, `known: ${known.join(', ') || 'none yet'}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Last lines of a run log: web.out, web.err, mock.out, mock.err, browser.err. */
export function logs(state, which, tail) {
  const path = join(state.run, which);
  if (!existsSync(path)) throw new DshvError(`no log ${which}`, 'use one of web.out, web.err, mock.out, mock.err, browser.err');
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-tail);
}

/** Stop what this run started and delete its directory; evidence stays. */
export async function down(state, { dryRun = false, keep = false } = {}) {
  const groups = [['web host', state.webPid], ['mock LLM', state.mockPid], ['browser', state.browser?.pid]]
    .filter(([, pid]) => pid && ownsPid(state, pid));
  const plan = {
    stop: groups.map(([label, pid]) => ({ label, processGroup: pid })),
    copyLogs: join(state.evidence, 'logs'),
    [keep ? 'keepRunDirAt' : 'delete']: keep ? join(state.evidence, 'run') : state.run,
    evidence: state.evidence,
  };
  if (dryRun) return { dryRun: true, ...plan };
  for (const [, pid] of groups) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
  for (const [, pid] of groups) {
    const gone = await waitFor('exit', 15, () => !ownsPid(state, pid)).catch(() => false);
    if (!gone) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  }
  mkdirSync(plan.copyLogs, { recursive: true });
  for (const log of ['web.out', 'web.err', 'mock.out', 'mock.err', 'browser.err']) {
    if (existsSync(join(state.run, log))) cpSync(join(state.run, log), join(plan.copyLogs, log));
  }
  // The browser profile is cache, not evidence.
  if (keep) cpSync(state.run, plan.keepRunDirAt, { recursive: true, verbatimSymlinks: true, filter: src => !src.startsWith(join(state.run, 'browser')) });
  rmSync(state.run, { recursive: true, force: true });
  return { stopped: true, ...plan };
}
