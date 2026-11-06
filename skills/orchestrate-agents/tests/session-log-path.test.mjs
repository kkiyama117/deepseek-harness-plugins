import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../bin/session-log-path.mjs', import.meta.url));
const USAGE = 'node bin/session-log-path.mjs (--profile NAME [--patch PATH]... | --dump-file PATH) [--session-id ID]';
const LAYER = '@deepseek-ai/dsh-base, patched by /home/u/.dsh/cordis.patch.yml';

const text = lines => `${lines.join('\n')}\n`;

const tailRows = [
  '- id: attachment-local',
  "  name: '@deepseek-ai/dsh-attachment-local'",
  '  config:',
  '    dshHome: /srv/dsh',
  '# == @deepseek-ai/dsh-base',
  '- id: storage-json',
  '  config:',
  "    root: !!js dshHomePath('storages')",
];

const sessionRow = (...rootLines) => [
  '- id: session-persistence-jsonl',
  "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  '  config:',
  ...rootLines,
];

const dumpWith = sessionLines => text([`# == ${LAYER}`, ...sessionLines, ...tailRows]);

const envWith = changes => {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
};

const run = (args, { env = process.env, timeout } = {}) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  env,
  ...timeout === undefined ? {} : { timeout },
});

const scratch = () => mkdtemp(join(tmpdir(), 'session-log-path-'));

const writeDump = async (directory, content) => {
  const file = join(directory, 'dump.yml');
  await writeFile(file, content);
  return file;
};

const makeSessions = async (root, layout) => {
  for (const [relative, names] of Object.entries(layout)) {
    const session = join(root, relative);
    await mkdir(session, { recursive: true });
    for (const name of names) await writeFile(join(session, name), '');
  }
};

test('session-log-path reads an overridden root and its layer', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `root ${root}\nlayer ${LAYER}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path resolves dshHomePath from DSH_HOME', async () => {
  const directory = await scratch();
  try {
    const home = join(directory, 'home');
    const file = await writeDump(directory, dumpWith(sessionRow("    root: !!js dshHomePath('sessions')")));
    const result = run(['--dump-file', file], { env: envWith({ DSH_HOME: home }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], `root ${join(home, 'sessions')}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path resolves dshHomePath from the home directory', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, dumpWith(sessionRow("    root: !!js dshHomePath('sessions')")));
    const result = run(['--dump-file', file], { env: envWith({ DSH_HOME: undefined, HOME: directory }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], `root ${join(directory, '.dsh', 'sessions')}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path rejects other JavaScript roots', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, dumpWith(sessionRow('    root: !!js process.env.SESSIONS')));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'session-log-path: cannot evaluate the JavaScript root: process.env.SESSIONS\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path reads a folded long root', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'long dir name');
    await mkdir(root);
    const file = await writeDump(directory, dumpWith(sessionRow('    root: >-', `      ${directory}/long`, '      dir name')));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], `root ${root}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path reads a folded dshHomePath root', async () => {
  const directory = await scratch();
  try {
    const home = join(directory, 'home');
    const file = await writeDump(directory, dumpWith(sessionRow('    root: !!js >-', "      dshHomePath('sessions')")));
    const result = run(['--dump-file', file], { env: envWith({ DSH_HOME: home }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], `root ${join(home, 'sessions')}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path folds a root only once', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, dumpWith(sessionRow('    root: >-', '      >-')));
    const result = run(['--dump-file', file], { timeout: 5000 });
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'session-log-path: the root is a YAML block scalar, which this tool does not read\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path reads a folded root in the last row', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'long dir name');
    await mkdir(root);
    const file = await writeDump(directory, text([
      `# == ${LAYER}`,
      '- id: session-persistence-jsonl',
      '  config:',
      '    root: >-',
      `      ${directory}/long`,
      '      dir name',
    ]));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], `root ${root}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path stops the root search at the row\'s end', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, dumpWith([
      ...sessionRow(),
      '- id: other-row',
      '  config:',
      '    root: /srv/other',
    ]));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'session-log-path: the session-persistence-jsonl row has no config.root\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path rejects a block scalar root', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, dumpWith(sessionRow('    root: >', '      /srv/a')));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'session-log-path: the root is a YAML block scalar, which this tool does not read\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path finds a row by name without an id', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const file = await writeDump(directory, dumpWith([
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${root}`,
    ]));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `root ${root}\nlayer ${LAYER}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path picks the newest generation', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const session = join(root, '--p--', 's1');
    await makeSessions(root, {
      '--p--/s1': ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v10.jsonl.zstd', 'session.v11.jsonl.zstd.tmp'],
    });
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const result = run(['--dump-file', file, '--session-id', 's1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `root ${root}\nlayer ${LAYER}\nlog ${join(session, 'session.v10.jsonl.zstd')}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path honours compression none', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    await makeSessions(root, { '--p--/s1': ['session.v3.jsonl', 'session.v4.jsonl'] });
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`, '    compression: none')));
    const result = run(['--dump-file', file, '--session-id', 's1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[2], `log ${join(root, '--p--', 's1', 'session.v4.jsonl')}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path rejects the other encoding', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    await makeSessions(root, { '--p--/s1': ['session.v4.jsonl.zstd', 'session.v5.jsonl'] });
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const result = run(['--dump-file', file, '--session-id', 's1']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `session-log-path: ${join(root, '--p--', 's1', 'session.v5.jsonl')} uses .jsonl, but the config selects .jsonl.zstd\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path rejects a duplicate session id', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    await makeSessions(root, {
      '--p--/s1': ['session.v4.jsonl.zstd'],
      '--q--/s1': ['session.v4.jsonl.zstd'],
    });
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const result = run(['--dump-file', file, '--session-id', 's1']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'session-log-path: session id s1 appears in more than one project directory: '
      + `${join(root, '--p--', 's1')}, ${join(root, '--q--', 's1')}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path finds an escaped session id', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    await makeSessions(root, {
      '--p--/a~002Fb': ['session.v4.jsonl.zstd'],
      '--p--/a.b': ['session.v4.jsonl.zstd'],
    });
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const escaped = run(['--dump-file', file, '--session-id', 'a/b']);
    const plain = run(['--dump-file', file, '--session-id', 'a.b']);
    assert.equal(escaped.status, 0, escaped.stderr);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(escaped.stdout.includes(`log ${join(root, '--p--', 'a~002Fb', 'session.v4.jsonl.zstd')}\n`));
    assert.ok(plain.stdout.includes(`log ${join(root, '--p--', 'a.b', 'session.v4.jsonl.zstd')}\n`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path ignores the default root when the dump overrides it', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const home = join(directory, 'home');
    await makeSessions(join(home, '.dsh', 'sessions'), { '--p--/s1': ['session.v4.jsonl.zstd'] });
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const result = run(['--dump-file', file, '--session-id', 's1'], { env: envWith({ HOME: home, DSH_HOME: undefined }) });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'session-log-path: no session log for s1\n'
      + `searched: ${root}/*/s1/\n`
      + `effective root: ${root} (${LAYER})\n`);
    assert.ok(!result.stdout.includes(home));
    assert.ok(!result.stderr.includes(home));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path never prints the rest of the dump', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const file = await writeDump(directory, text([
      `# == ${LAYER}`,
      ...sessionRow(`    root: ${root}`),
      ...tailRows,
      '- id: secret-row',
      '  config:',
      '    token: SECRET-VALUE-123',
    ]));
    const plain = run(['--dump-file', file]);
    const missing = run(['--dump-file', file, '--session-id', 'missing']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(missing.status, 1);
    for (const result of [plain, missing]) {
      assert.ok(!result.stdout.includes('SECRET-VALUE-123'));
      assert.ok(!result.stderr.includes('SECRET-VALUE-123'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path does not open session logs', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    await makeSessions(root, { '--p--/a~002Fb': ['session.v4.jsonl.zstd'] });
    const log = join(root, '--p--', 'a~002Fb', 'session.v4.jsonl.zstd');
    await chmod(log, 0o000);
    try {
      const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
      const result = run(['--dump-file', file, '--session-id', 'a/b']);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`log ${log}\n`));
    } finally { await chmod(log, 0o644); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path fails without a session-persistence-jsonl row', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, text([
      '# == @deepseek-ai/dsh-base',
      '- id: storage-json',
      '  config:',
      "    root: !!js dshHomePath('storages')",
    ]));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'session-log-path: no top-level session-persistence-jsonl row in the composed config\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path ignores nested rows', async () => {
  const directory = await scratch();
  try {
    const file = await writeDump(directory, text([
      `# == ${LAYER}`,
      ...tailRows,
      '- id: group-1',
      '  group: true',
      '  config:',
      '    - id: session-persistence-jsonl',
      '      config:',
      '        root: /srv/dsh/sessions',
    ]));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'session-log-path: no top-level session-persistence-jsonl row in the composed config\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path finds a row whose id is not first', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const file = await writeDump(directory, dumpWith([
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  id: session-persistence-jsonl',
      '  config:',
      `    root: ${root}`,
    ]));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `root ${root}\nlayer ${LAYER}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path rejects an unknown compression', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const file = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`, '    compression: !!js process.env.C')));
    const result = run(['--dump-file', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'session-log-path: cannot read the compression value: !!js process.env.C\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path refuses a disabled row', async () => {
  const directory = await scratch();
  try {
    const root = join(directory, 'logs');
    await mkdir(root);
    const row = disabled => [
      '- id: session-persistence-jsonl',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      `  disabled: ${disabled}`,
      '  config:',
      `    root: ${root}`,
    ];
    const file = await writeDump(directory, dumpWith(row('true')));
    const refused = run(['--dump-file', file]);
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr, 'session-log-path: session-persistence-jsonl is disabled in the composed config\n');
    await writeFile(file, dumpWith(row('!!js process.env.OFF')));
    const unreadable = run(['--dump-file', file]);
    assert.equal(unreadable.status, 1);
    assert.equal(unreadable.stderr, 'session-log-path: cannot read the disabled value: !!js process.env.OFF\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const fakeCli = async (directory, body) => {
  const path = join(directory, 'fake-dsh.sh');
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return path;
};

test('session-log-path passes profile and patches to dsh', async () => {
  const directory = await scratch();
  try {
    const home = join(directory, 'home');
    await mkdir(join(home, 'profiles', 'web'), { recursive: true });
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '');
    const root = join(directory, 'logs');
    await mkdir(root);
    const dumpFile = await writeDump(directory, dumpWith(sessionRow(`    root: ${root}`)));
    const argsFile = join(directory, 'args.txt');
    const cli = await fakeCli(directory, `printf '%s\\n' "$@" > '${argsFile}'\ncat '${dumpFile}'\n`);
    const result = run(['--profile', 'web', '--patch', '/a.yml', '--patch', '/b.yml'], {
      env: envWith({ DSH_HOME: home, DSH_CLI: cli }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(argsFile, 'utf8'), '--profile\nweb\n--patch\n/a.yml\n--patch\n/b.yml\n--dump-config\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path reports a failing dsh', async () => {
  const directory = await scratch();
  try {
    const home = join(directory, 'home');
    await mkdir(join(home, 'profiles', 'web'), { recursive: true });
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '');
    const cli = await fakeCli(directory, 'echo SECRET-VALUE-123\necho SECRET-VALUE-123 >&2\nexit 3\n');
    const result = run(['--profile', 'web'], { env: envWith({ DSH_HOME: home, DSH_CLI: cli }) });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'session-log-path: dsh --dump-config exited 3\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path refuses a missing profile', async () => {
  const directory = await scratch();
  try {
    const home = join(directory, 'home');
    const marker = join(directory, 'marker.txt');
    const cli = await fakeCli(directory, `echo ran > '${marker}'\n`);
    const result = run(['--profile', 'web'], { env: envWith({ DSH_HOME: home, DSH_CLI: cli }) });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `session-log-path: profile web does not exist under ${join(home, 'profiles')}; `
      + 'refusing to let dsh create it\n');
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('session-log-path rejects bad usage', async () => {
  const cases = [
    [],
    ['--profile', 'x', '--dump-file', 'y'],
    ['--dump-file', 'y', '--patch', 'z'],
    ['--dump-file', 'y', '--dump-file', 'y'],
    ['--dump-file', 'y', '--session-id', ''],
    ['--dump-file'],
    ['--profile', '../x'],
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `exit status for ${JSON.stringify(args)}`);
    assert.equal(result.stdout, '', `stdout for ${JSON.stringify(args)}`);
    assert.equal(result.stderr, `Usage: ${USAGE}\n`, `stderr for ${JSON.stringify(args)}`);
  }
});

test('session-log-path reports an unreadable dump file', async () => {
  const directory = await scratch();
  try {
    const result = run(['--dump-file', join(directory, 'missing.yml')]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'session-log-path: cannot read the dump file: ENOENT\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
