#!/usr/bin/env node
/** Refresh owner-local prompt snapshots; review the diff before accepting it. */
import { readFile, writeFile } from 'node:fs/promises';
import { createFlowRuntime } from '../scripts/runtime.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const save = (path, value) => writeFile(new URL(path, root), value);
const lines = (await read('SKILL.md')).split('\n');
if (lines[0] !== '---' || lines.indexOf('---', 1) < 0) throw new Error('Expected skill frontmatter');
await save('tests/expected/skill-entry.txt', lines.slice(lines.indexOf('---', 1) + 1).join('\n'));
const expected = JSON.parse(await read('tests/expected/review-context.json'));
for (const [flow, reviews] of Object.entries(expected)) {
  const request = JSON.parse(await read(`examples/${flow}.json`));
  request.options.repairRounds = 2;
  const graph = createFlowRuntime().buildTemplate({ request });
  for (const [id, review] of Object.entries(reviews)) {
    const node = graph.nodes.find(n => n.id === id);
    if (!node) throw new Error(`Missing review node ${id}`);
    review.instruction = node.prompt;
  }
}
await save('tests/expected/review-context.json', JSON.stringify(expected, null, 2) + '\n');
