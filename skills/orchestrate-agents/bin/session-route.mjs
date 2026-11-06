#!/usr/bin/env node
// Prints the requested and recorded routes of one Session log, never other Session content.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as zlib from 'node:zlib';

const USAGE = 'node bin/session-route.mjs LOG';
const LOG_NAME = /^session(\.v[1-9][0-9]*)?\.jsonl(\.zstd)?$/;
const DESCRIPTOR_FIELDS = [
  ['mode', 'mode'],
  ['provider', 'subagentProvider'],
  ['agentProvider', 'agentProvider'],
  ['agentModel', 'agentModel'],
  ['agentReasoningEffort', 'agentReasoningEffort'],
];
const ROUTE_FIELDS = ['provider', 'model', 'reasoningEffort'];

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const present = value => value !== undefined && value !== null;
const format = value => (typeof value === 'string' && /^[^\s=]+$/.test(value) ? value : JSON.stringify(value));

function readText(log) {
  const name = basename(log);
  if (!LOG_NAME.test(name)) return { error: `not a Session log name: ${name}` };
  let buffer;
  try {
    buffer = readFileSync(log);
  } catch (error) {
    return { error: `cannot read ${log}: ${error.code}` };
  }
  if (name.endsWith('.jsonl.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      return { error: 'this Node has no zstd support (needs 22.15 or later)' };
    }
    try {
      buffer = zlib.zstdDecompressSync(buffer);
    } catch (error) {
      return { error: `cannot decompress ${log}: ${error.code ?? 'unknown'}` };
    }
  }
  return { text: buffer.toString('utf8') };
}

function parseEvents(log, text) {
  const pieces = text.split('\n');
  if (!text.endsWith('\n')) pieces.pop();
  const events = [];
  for (let index = 0; index < pieces.length; index += 1) {
    if (pieces[index] === '') continue;
    let event;
    try {
      event = JSON.parse(pieces[index]);
    } catch {
      return { error: `${log}:${index + 1}: not a JSON event` };
    }
    if (!isRecord(event)) return { error: `${log}:${index + 1}: not a JSON event` };
    events.push(event);
  }
  return { events };
}

// The marker itself was appended when the child was seeded, so it belongs to the copied prefix.
function inheritedCount(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'session/end-seed' && isRecord(event.data) && event.data.inherited === true) {
      return index + 1;
    }
  }
  return 0;
}

function inspect(log, events) {
  const inherited = inheritedCount(events);
  const first = events[0];
  if (first?.type === 'session' && first.isSeeded === true && inherited === 0) {
    return { error: `${log}: a seeded log has no inherited marker` };
  }
  const own = events.slice(inherited);
  const descriptor = own.find(event => event.type === 'subagent/descriptor' && isRecord(event.data))?.data;
  const routes = [];
  const seen = new Set();
  for (const event of own) {
    if (event.type !== 'request/header' || !isRecord(event.data)) continue;
    if (!isRecord(event.data.header) || !isRecord(event.data.header.config)) continue;
    const config = event.data.header.config;
    const route = {};
    for (const field of ROUTE_FIELDS) {
      if (present(config[field])) route[field] = config[field];
    }
    if (Object.keys(route).length === 0) continue;
    const key = JSON.stringify(ROUTE_FIELDS.map(field => route[field] ?? null));
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ route, seq: typeof event.seq === 'number' ? event.seq : undefined });
  }
  return { inherited, descriptor, routes };
}

function describe(log, inherited, descriptor, routes) {
  const output = [`log ${log}`, `inherited ${inherited}`];
  if (descriptor === undefined) {
    output.push('descriptor none');
  } else {
    let line = 'descriptor';
    for (const [field, name] of DESCRIPTOR_FIELDS) {
      if (present(descriptor[field])) line += ` ${name}=${format(descriptor[field])}`;
    }
    output.push(line);
  }
  for (const { route, seq } of routes) {
    let line = 'route';
    if (seq !== undefined) line += ` seq=${format(seq)}`;
    for (const field of ROUTE_FIELDS) {
      if (present(route[field])) line += ` ${field}=${format(route[field])}`;
    }
    output.push(line);
  }
  return output;
}

function report(message) {
  process.stderr.write(`session-route: ${message}\n`);
  return 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '') {
    process.stderr.write(`Usage: ${USAGE}\n`);
    return 2;
  }
  const [log] = args;
  const read = readText(log);
  if (read.error !== undefined) return report(read.error);
  const parsed = parseEvents(log, read.text);
  if (parsed.error !== undefined) return report(parsed.error);
  const inspected = inspect(log, parsed.events);
  if (inspected.error !== undefined) return report(inspected.error);
  const { inherited, descriptor, routes } = inspected;
  if (routes.length === 0) return report(`no request/header route in ${log}`);
  process.stdout.write(`${describe(log, inherited, descriptor, routes).join('\n')}\n`);
  return 0;
}

process.exitCode = main();
