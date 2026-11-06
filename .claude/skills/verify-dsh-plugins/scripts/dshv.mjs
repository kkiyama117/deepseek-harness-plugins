// dshv: disposable DSH instances for verifying this repository's plugins. Output is JSON.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { connect, open, screenshot, snapshot, target } from './browser.mjs';
import { DshvError, loadSettings } from './config.mjs';
import * as runs from './run.mjs';

const HELP = {
  '': `usage: dshv <command> [options]    (each command has --help; output is JSON)

lifecycle   up, doctor, down
drive       web, headless, exec
inspect     state, store, logs

<run> is the path \`dshv up\` printed, or \`latest\`.`,
  up: `usage: dshv up <package>...

Start a run: fresh web and headless profiles with each package installed
(a directory as link:, a releases/*.tgz as file:), a keyless mock LLM, and a
web host on 127.0.0.1. Prints the run state, including "run". Fails unless doctor passes.
Settings come from the shell, then the skill's .env (see .env.example).`,
  doctor: `usage: dshv doctor <run>

Read-only. Checks the DSH build, that every pid and the web port belong to this
run, that the port is not the live one, that the UI loads without page errors,
and that every row of the packages under test is active. Exit 1 on any failure.`,
  down: `usage: dshv down <run> [--dry-run] [--keep]

Stop the process groups this run started (checked by DSHV_RUN, never by name),
copy logs to evidence, and delete the run directory. Evidence stays.
  --dry-run   print what would be stopped and deleted; change nothing
  --keep      copy the run directory (sessions, storages, profiles) into evidence first`,
  web: `usage: dshv web <run> <action> [options]

Drive the run's browser. It starts on first use and keeps its page between
commands. Targets are ARIA roles and accessible names (en-US UI).

actions
  open [--reload]                       load the web UI (or reload it)
  snapshot [--role R --name N]          ARIA snapshot of the page or one element
  screenshot <file>                     relative paths go under the run's evidence
  click --role R --name N               click a target
  fill --role R --name N --value V      type into a textbox
  press --role R --name N --key K       press a key on a target (e.g. Enter)
  wait --role R --name N [--timeout S]  wait until a target is visible
  attr --role R --name N --attribute A  read one attribute (e.g. aria-expanded)
  fetch <path> [--method M]             request a URL from the signed-in page; prints
                                        status, content-type, cache-control, and the body's start

target options
  --in "<role>=<name>"   search inside one element, e.g. --in "dialog=Select Workspace Directory"
  --exact                match the name exactly (default: substring)`,
  headless: `usage: dshv headless <run> [--cd DIR] [--env K=V]... <task...>

Run one \`dsh --profile headless --json\` task in the isolated environment.
Prints exitCode, sessionId, finished, text, warnings, and the saved transcript path.
  --cd DIR     working directory (default: the run's home); it must exist
  --env K=V    extra environment, e.g. --env DSH_WORKSPACE_ID=cwd
  --patch F    extra profile overlay (dsh --patch), e.g. to point providers at the mock
  --name N     transcript file name under evidence/headless/`,
  exec: `usage: dshv exec <run> [--cd DIR] -- <command...>

Run any command in the isolated environment (own HOME and DSH_HOME, mock LLM,
\`dsh\` on PATH). Output passes through; the exit code is the command's.`,
  state: `usage: dshv state <run> [field]

Print the run state: paths, pids, URLs, packages. With a field (run, evidence,
webUrl, webOrigin, mockUrl, ...), print just that value as plain text, e.g.
  DIR=$(dshv state latest run)/home/attach-project`,
  store: `usage: dshv store <run> <name>

Print one of the run's storage files, e.g. \`workspace\` for workspaces and their sessions.`,
  logs: `usage: dshv logs <run> [web.err|web.out|mock.out|mock.err|browser.err] [--tail N]

Last lines of a run log (default web.err, 40 lines).`,
};

const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function parse(args, options, help) {
  const parsed = parseArgs({ args, options: { help: { type: 'boolean' }, ...options }, allowPositionals: true });
  if (parsed.values.help) { console.log(help); process.exit(0); }
  return parsed;
}

async function doctor(state, settings) {
  const checks = runs.processChecks(state, settings);
  const add = (ok, check, detail) => checks.push({ ok, check, ...(detail === undefined ? {} : { detail }) });
  let session;
  try {
    session = await connect(state, settings);
    add(true, `web UI loads at ${state.webOrigin}`);
    const reply = await session.page.evaluate(async () => {
      const method = 'pluginManager/listPlugins';
      const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: {} } }) });
      return response.json();
    });
    add(reply.result?.ok === true, 'plugin inventory answers');
    const rows = reply.result?.value ?? [];
    for (const row of rows.filter(row => row.fiberPhase === 'failed')) add(false, `row ${row.entryId} failed`);
    for (const name of state.packages) {
      const own = rows.filter(row => row.moduleName === name || row.moduleName?.startsWith(`${name}/`));
      add(own.length > 0, `${name} has rows in the web profile`);
      for (const row of own) add(row.fiberPhase === 'active', `${row.entryId} is ${row.fiberPhase}`);
    }
    add(session.errors.length === 0, 'no page errors', session.errors.length ? session.errors : undefined);
  } catch (error) {
    add(false, 'web UI loads', String(error.message ?? error));
  } finally {
    await session?.close();
  }
  return { ok: checks.every(check => check.ok), checks };
}

async function web(state, settings, args) {
  const { values, positionals } = parse(args, {
    role: { type: 'string' }, name: { type: 'string' }, in: { type: 'string' }, exact: { type: 'boolean' },
    value: { type: 'string' }, key: { type: 'string' }, attribute: { type: 'string' }, timeout: { type: 'string' },
    reload: { type: 'boolean' }, method: { type: 'string' },
  }, HELP.web);
  const [action, file] = positionals;
  const session = await connect(state, settings);
  const { page } = session;
  try {
    const timeout = Number(values.timeout ?? 15) * 1000;
    switch (action) {
      case 'open':
        if (values.reload) await page.reload({ waitUntil: 'domcontentloaded' }); else await open(page, state);
        await page.getByRole('button', { name: 'New session' }).first().waitFor({ timeout: 30_000 });
        return { url: page.url() };
      case 'snapshot': return await snapshot(page, values);
      case 'screenshot': return await screenshot(page, state, file);
      case 'click': await target(page, values).click({ timeout }); return { clicked: values };
      case 'fill':
        if (values.value === undefined) throw new DshvError('missing --value');
        await target(page, values).fill(values.value, { timeout }); return { filled: values };
      case 'press':
        if (!values.key) throw new DshvError('missing --key', 'e.g. --key Enter');
        await target(page, values).press(values.key, { timeout }); return { pressed: values };
      case 'wait': await target(page, values).waitFor({ timeout }); return { visible: values };
      case 'attr':
        if (!values.attribute) throw new DshvError('missing --attribute', 'e.g. --attribute aria-expanded');
        return { [values.attribute]: await target(page, values).getAttribute(values.attribute, { timeout }) };
      case 'fetch':
        if (!file) throw new DshvError('missing <path>', 'e.g. `dshv web <run> fetch /open-in-app/icon/cursor`');
        return await page.evaluate(async ({ path, method }) => {
          const response = await fetch(path, { method });
          const body = await response.text();
          return { status: response.status, contentType: response.headers.get('content-type'),
            cacheControl: response.headers.get('cache-control'), bytes: body.length, start: body.slice(0, 200) };
        }, { path: file, method: values.method ?? 'GET' });
      default: throw new DshvError(`unknown web action ${action ?? '(none)'}`, 'run `dshv web --help`');
    }
  } catch (error) {
    if (error instanceof DshvError) throw error;
    throw new DshvError(String(error.message ?? error).split('\n')[0],
      'run `dshv web <run> snapshot` to see the current roles and names, or `dshv web <run> screenshot debug.png`');
  } finally {
    if (session.errors.length) process.stderr.write(`page errors: ${session.errors.join('; ')}\n`);
    await session.close();
  }
}

async function main(argv) {
  const [command = '', ...rest] = argv;
  if (!(command in HELP) || command === '' || command === '--help') { console.log(HELP['']); return command && command !== '--help' ? 2 : 0; }
  const settings = loadSettings();

  if (command === 'up') {
    const { positionals } = parse(rest, {}, HELP.up);
    const state = await runs.up(positionals, settings);
    const health = await doctor(state, settings);
    print({ run: state.run, evidence: state.evidence, webUrl: state.webUrl, packages: state.packages, doctor: health });
    if (!health.ok) throw new DshvError('the run started but is not healthy', `inspect it, then \`dshv down ${state.run}\``);
    return 0;
  }
  if (command === 'web') {
    if (rest[0] === '--help' || !rest.length) { console.log(HELP.web); return 0; }
    print(await web(runs.loadState(rest[0], settings), settings, rest.slice(1)));
    return 0;
  }
  if (command === 'exec') {
    const split = rest.indexOf('--');
    const { values, positionals } = parse(split === -1 ? rest : rest.slice(0, split), { cd: { type: 'string' } }, HELP.exec);
    const commandLine = split === -1 ? [] : rest.slice(split + 1);
    if (!commandLine.length) throw new DshvError('exec needs a command after --', HELP.exec.split('\n')[0]);
    const state = runs.loadState(positionals[0], settings);
    const result = spawnSync(commandLine[0], commandLine.slice(1), {
      cwd: values.cd ?? `${state.run}/home`, env: runs.isolatedEnv(state, settings), stdio: 'inherit',
    });
    return result.status ?? 1;
  }

  const options = {
    doctor: {}, state: {}, store: {},
    down: { 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' } },
    headless: { cd: { type: 'string' }, env: { type: 'string', multiple: true }, name: { type: 'string' }, patch: { type: 'string', multiple: true } },
    logs: { tail: { type: 'string' } },
  }[command];
  const { values, positionals } = parse(rest, options, HELP[command]);
  const state = runs.loadState(positionals[0], settings);
  switch (command) {
    case 'doctor': { const health = await doctor(state, settings); print(health); return health.ok ? 0 : 1; }
    case 'state':
      if (positionals[1] === undefined) { print(state); return 0; }
      if (!(positionals[1] in state)) throw new DshvError(`no field ${positionals[1]}`, `known: ${Object.keys(state).join(', ')}`);
      console.log(typeof state[positionals[1]] === 'object' ? JSON.stringify(state[positionals[1]]) : state[positionals[1]]);
      return 0;
    case 'store': print(runs.store(state, positionals[1] ?? 'workspace')); return 0;
    case 'logs': print(runs.logs(state, positionals[1] ?? 'web.err', Number(values.tail ?? 40))); return 0;
    case 'down': print(await runs.down(state, { dryRun: values['dry-run'], keep: values.keep })); return 0;
    case 'headless': {
      const task = positionals.slice(1).join(' ');
      if (!task) throw new DshvError('missing <task>', 'e.g. `dshv headless latest "Say hello"`');
      const env = Object.fromEntries((values.env ?? []).map(pair => [pair.split('=')[0], pair.split('=').slice(1).join('=')]));
      const result = runs.headless(state, settings, task, { cwd: values.cd, env, name: values.name, patches: values.patch });
      print(result);
      return result.exitCode === 0 && result.finished ? 0 : 1;
    }
  }
  return 2;
}

main(process.argv.slice(2)).then(code => process.exit(code), error => {
  process.stderr.write(`dshv: ${error.message ?? error}\n`);
  process.exit(1);
});
