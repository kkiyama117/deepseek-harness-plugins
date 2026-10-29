import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Owner-local expected output: the exact SKILL.md body with the YAML
// frontmatter excluded. It is not a DSH recorded-session replay and does not
// prove real-model adherence.
const root = fileURLToPath(new URL('../', import.meta.url));

function bodyWithoutFrontmatter(markdown) {
  const lines = markdown.split('\n');
  assert.equal(lines[0], '---', 'SKILL.md must open with YAML frontmatter');
  const closing = lines.indexOf('---', 1);
  assert.notEqual(closing, -1, 'SKILL.md frontmatter must close');
  return lines.slice(closing + 1).join('\n');
}

test('SKILL.md body without frontmatter matches the expected output', async () => {
  const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
  const expected = await readFile(join(root, 'tests/expected/skill-entry.txt'), 'utf8');
  assert.equal(bodyWithoutFrontmatter(skill), expected);
});
