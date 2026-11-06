#!/usr/bin/env node
// Resolves the effective Session log root and layer from a composed config dump.
// Read-only over Session storage: it lists directories and never opens a Session log.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const USAGE = 'node bin/session-log-path.mjs (--profile NAME [--patch PATH]... | --dump-file PATH) [--session-id ID]';
const ROW_ID = 'session-persistence-jsonl';
const ROW_NAME = '@deepseek-ai/dsh-session-persistence-jsonl';
const BLOCK_SCALAR_ERROR = 'the root is a YAML block scalar, which this tool does not read';
const MISSING_ROOT_ERROR = 'the session-persistence-jsonl row has no config.root';
const STRING_LITERALS = /^\s*(?:(?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*)?\s*$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OPTIONS = new Set(['--profile', '--patch', '--dump-file', '--session-id']);
const QUOTES = new Set(["'", '"']);

const failure = message => ({ error: message });
const trim = value => value.trim();
const stripJs = value => (value.startsWith('!!js ') ? value.slice(5) : value);
const leadingSpaces = line => line.length - line.trimStart().length;

function unquote(value) {
  const text = trim(value);
  const quote = text[0];
  if (text.length >= 2 && QUOTES.has(quote) && text.endsWith(quote)) return text.slice(1, -1);
  return text;
}

function parseArguments(argv) {
  const parsed = { profile: undefined, patches: [], dumpFile: undefined, sessionId: undefined };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!OPTIONS.has(option)) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value === '') return undefined;
    index += 1;
    if (option === '--patch') {
      parsed.patches.push(value);
      continue;
    }
    if (seen.has(option)) return undefined;
    seen.add(option);
    if (option === '--profile') parsed.profile = value;
    else if (option === '--dump-file') parsed.dumpFile = value;
    else parsed.sessionId = value;
  }
  if ((parsed.profile === undefined) === (parsed.dumpFile === undefined)) return undefined;
  if (parsed.dumpFile !== undefined && parsed.patches.length > 0) return undefined;
  if (parsed.profile !== undefined && !PROFILE_NAME.test(parsed.profile)) return undefined;
  return parsed;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function dshHome() {
  const configured = process.env.DSH_HOME;
  if (configured !== undefined && trim(configured) !== '') return resolve(expandHome(configured));
  return join(homedir(), '.dsh');
}

function dumpFromProfile(args) {
  const profiles = join(dshHome(), 'profiles');
  if (!existsSync(join(profiles, args.profile, 'package.json'))) {
    return failure(`profile ${args.profile} does not exist under ${profiles}; refusing to let dsh create it`);
  }
  const configured = process.env.DSH_CLI;
  const command = configured !== undefined && trim(configured) !== '' ? configured : 'dsh';
  const child = spawnSync(command, [
    '--profile', args.profile,
    ...args.patches.flatMap(patch => ['--patch', patch]),
    '--dump-config',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (child.error !== undefined) return failure(`dsh --dump-config failed to start: ${child.error.code}`);
  if (child.status === null) return failure(`dsh --dump-config was killed by ${child.signal}`);
  if (child.status !== 0) return failure(`dsh --dump-config exited ${child.status}`);
  return { dump: child.stdout };
}

function splitRows(lines) {
  const rows = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start].startsWith('- ')) continue;
    let end = start + 1;
    while (end < lines.length && (lines[end] === '' || lines[end].startsWith(' '))) end += 1;
    let contentEnd = end;
    while (contentEnd > start + 1 && trim(lines[contentEnd - 1]) === '') contentEnd -= 1;
    rows.push({ start, lines: lines.slice(start, contentEnd) });
    start = end - 1;
  }
  return rows;
}

function fieldOf(rowLines, key) {
  const head = new RegExp(`^- ${key}: (.+)$`).exec(rowLines[0]);
  if (head !== null) return unquote(head[1]);
  const nested = new RegExp(`^  ${key}: (.+)$`);
  for (const line of rowLines) {
    const match = nested.exec(line);
    if (match !== null) return unquote(match[1]);
  }
  return undefined;
}

function layerOf(lines, start) {
  for (let index = start - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('# == ')) return lines[index].slice(5);
  }
  return 'unknown';
}

function foldContinuation(rowLines, rootIndex) {
  const collected = [];
  for (let index = rootIndex + 1; index < rowLines.length; index += 1) {
    const line = rowLines[index];
    if (trim(line) !== '' && leadingSpaces(line) <= 4) break;
    collected.push(line);
  }
  if (collected.length === 0) return undefined;
  if (collected.some(line => trim(line) === '')) return undefined;
  const indent = leadingSpaces(collected[0]);
  if (collected.some(line => leadingSpaces(line) !== indent)) return undefined;
  return collected.map(line => trim(line)).join(' ');
}

function resolveRootScalar(raw, rowLines, rootIndex) {
  let value = raw;
  const jsPrefix = value.startsWith('!!js ') ? '!!js ' : '';
  let rest = stripJs(value);
  let folded = false;
  while (rest === '>-') {
    if (folded) return failure(BLOCK_SCALAR_ERROR);
    const joined = foldContinuation(rowLines, rootIndex);
    if (joined === undefined) return failure(BLOCK_SCALAR_ERROR);
    value = jsPrefix + joined;
    folded = true;
    rest = stripJs(value);
  }
  if (rest.startsWith('>') || rest.startsWith('|')) return failure(BLOCK_SCALAR_ERROR);
  if (value.startsWith("'") && value.endsWith("'")) return { value: value.slice(1, -1).replaceAll("''", "'") };
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return { value: JSON.parse(value) };
    } catch {
      return failure(`cannot read the quoted root: ${value}`);
    }
  }
  const homePath = /^!!js dshHomePath\((.*)\)$/.exec(value);
  if (homePath !== null && STRING_LITERALS.test(homePath[1])) {
    const literals = [...homePath[1].matchAll(/'[^']*'|"[^"]*"/g)].map(match => match[0].slice(1, -1));
    return { value: join(dshHome(), ...literals) };
  }
  if (value.startsWith('!!js')) return failure(`cannot evaluate the JavaScript root: ${rest}`);
  return { value };
}

function inspectDump(dump) {
  const lines = dump.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const rows = splitRows(lines).map(row => ({
    ...row,
    id: fieldOf(row.lines, 'id'),
    name: fieldOf(row.lines, 'name'),
  }));
  const matches = rows.filter(row => row.id === ROW_ID || (row.id === undefined && row.name === ROW_NAME));
  if (matches.length === 0) return failure('no top-level session-persistence-jsonl row in the composed config');
  if (matches.length > 1) return failure('more than one session-persistence-jsonl row in the composed config');
  const [row] = matches;
  const layer = layerOf(lines, row.start);

  for (const line of row.lines) {
    const disabled = /^  disabled: (.*)$/.exec(line);
    if (disabled === null) continue;
    const value = trim(disabled[1]);
    if (value === 'true') return failure('session-persistence-jsonl is disabled in the composed config');
    if (value !== 'false' && value !== 'null' && value !== '~' && value !== '') {
      return failure(`cannot read the disabled value: ${value}`);
    }
  }

  const configIndex = row.lines.findIndex(line => line === '  config:');
  if (configIndex === -1) return failure(MISSING_ROOT_ERROR);
  let rootIndex = -1;
  let rootValue;
  for (let index = configIndex + 1; index < row.lines.length; index += 1) {
    const match = /^    root: (.+)$/.exec(row.lines[index]);
    if (match === null) continue;
    rootIndex = index;
    rootValue = match[1];
    break;
  }
  if (rootIndex === -1) return failure(MISSING_ROOT_ERROR);

  let suffix = '.jsonl.zstd';
  let otherSuffix = '.jsonl';
  for (let index = configIndex + 1; index < row.lines.length; index += 1) {
    const compression = /^    compression: (.+)$/.exec(row.lines[index]);
    if (compression === null) continue;
    const value = trim(compression[1]);
    const selected = unquote(value);
    if (selected === 'none') {
      suffix = '.jsonl';
      otherSuffix = '.jsonl.zstd';
    } else if (selected !== 'zstd') {
      return failure(`cannot read the compression value: ${value}`);
    }
    break;
  }

  const scalar = resolveRootScalar(trim(rootValue), row.lines, rootIndex);
  if (scalar.error !== undefined) return failure(scalar.error);
  const root = scalar.value;
  if (!isAbsolute(root)) return failure(`root is not an absolute path: ${root}`);
  return { root: resolve(root), layer, suffix, otherSuffix };
}

function encodeSegment(id) {
  if (id === '.') return '~002E';
  if (id === '..') return '~002E~002E';
  let encoded = '';
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== '~' && /[A-Za-z0-9._-]/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

function generationVersion(name, suffix) {
  if (!name.endsWith(suffix)) return undefined;
  const base = name.slice(0, name.length - suffix.length);
  if (base === 'session') return 0;
  const tagged = /^session\.v([1-9][0-9]*)$/.exec(base);
  if (tagged === null) return undefined;
  const version = Number(tagged[1]);
  return Number.isSafeInteger(version) ? version : undefined;
}

function findLog(root, id, suffix, otherSuffix) {
  const encoded = encodeSegment(id);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') return failure(`cannot read ${root}: ${error.code}`);
    entries = [];
  }
  const projects = entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name))
    .sort();
  const matches = [];
  for (const project of projects) {
    const session = join(project, encoded);
    let sessionEntries;
    try {
      sessionEntries = readdirSync(session, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') return failure(`cannot read ${session}: ${error.code}`);
      continue;
    }
    sessionEntries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    let selected;
    for (const entry of sessionEntries) {
      const version = generationVersion(entry.name, suffix);
      if (version !== undefined) {
        if (selected === undefined || version > selected.version) selected = { name: entry.name, version };
        continue;
      }
      if (generationVersion(entry.name, otherSuffix) !== undefined) {
        return failure(`${join(session, entry.name)} uses ${otherSuffix}, but the config selects ${suffix}`);
      }
    }
    if (selected !== undefined) matches.push({ dir: session, path: join(session, selected.name) });
  }
  if (matches.length > 1) {
    const directories = matches.map(match => match.dir).sort().join(', ');
    return failure(`session id ${id} appears in more than one project directory: ${directories}`);
  }
  return { encoded, log: matches[0]?.path };
}

function report(problem) {
  process.stderr.write(`session-log-path: ${problem.error}\n`);
  return 1;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args === undefined) {
    process.stderr.write(`Usage: ${USAGE}\n`);
    return 2;
  }
  let dump;
  if (args.dumpFile !== undefined) {
    try {
      dump = readFileSync(args.dumpFile, 'utf8');
    } catch (error) {
      return report(failure(`cannot read the dump file: ${error.code}`));
    }
  } else {
    const dumped = dumpFromProfile(args);
    if (dumped.error !== undefined) return report(dumped);
    dump = dumped.dump;
  }
  const inspected = inspectDump(dump);
  if (inspected.error !== undefined) return report(inspected);
  const { root, layer, suffix, otherSuffix } = inspected;
  const output = [`root ${root}`, `layer ${layer}`];
  if (args.sessionId !== undefined) {
    const found = findLog(root, args.sessionId, suffix, otherSuffix);
    if (found.error !== undefined) return report(found);
    if (found.log === undefined) {
      process.stderr.write(`session-log-path: no session log for ${args.sessionId}\n`
        + `searched: ${root}/*/${found.encoded}/\n`
        + `effective root: ${root} (${layer})\n`);
      return 1;
    }
    output.push(`log ${found.log}`);
  }
  process.stdout.write(`${output.join('\n')}\n`);
  return 0;
}

process.exitCode = main();
