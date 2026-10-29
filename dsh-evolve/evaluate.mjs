/** Deterministic output checks; fixtures belong to the operator, never to proposals. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Hash JSON with sorted object keys, preserving array order and exact text. */
export function digest(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]))
      : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Check an entire response without normalizing whitespace or accepting extra JSON prose. */
export function checkOutput(test, output) {
  if (test.equals !== undefined && output !== test.equals) return false;
  if (test.contains?.some(text => !output.includes(text))) return false;
  if (test.notContains?.some(text => output.includes(text))) return false;
  if (Object.hasOwn(test, 'jsonEquals')) {
    try {
      if (!isDeepStrictEqual(JSON.parse(output), test.jsonEquals)) return false;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }
  return true;
}

/** Bind a result to its suite, exact model route, and execution controls. */
export function validationHash(config, asset) {
  return digest({ version: 1, asset: asset.name, purpose: asset.description,
    tests: asset.tests, route: config.route, request: config.request });
}

/** Bind an approval to immutable text, its parent revision, and its evaluator. */
export function candidateDigest(candidate) {
  return digest({ asset: candidate.asset, description: candidate.description, content: candidate.content,
    baseRevision: candidate.baseRevision, validationHash: candidate.validationHash });
}
