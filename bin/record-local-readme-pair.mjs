/** Record an external package's confirmed README pair with the selected DSH pairing implementation. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [target, source = 'dsh-goal-acceptance/README.md'] = process.argv.slice(2);
if (!target) throw new Error('Run with the selected Core tsx loader: record-local-readme-pair.mjs TARGET_CORE [RELATIVE_README]');
const root=resolve(import.meta.dirname,'..');
const api=await import(pathToFileURL(join(resolve(target),'scripts/translation-pairing-record.ts')).href);
const paths=api.translationPairPaths(source);
const en=readFileSync(join(root,paths.source),'utf8'), zh=readFileSync(join(root,paths.zh),'utf8');
assert.equal(en.split('\n').length,zh.split('\n').length,'README line alignment');
const context={repoRoot:root,isTranslationPairSource:p=>p.endsWith('.md')&&!p.endsWith('.zh.md')&&existsSync(join(root,p.replace(/\.md$/,'.zh.md'))),repositoryFileExists:p=>existsSync(join(root,p))};
const records=api.computeTranslationPairingRecord(paths,en,zh,context);
let text=api.renderTranslationPairingRecord(paths,records);
text=text.replace(/^#   pnpm run verify-translation-pairing.*$/m,'#   node --import tsx/esm bin/record-local-readme-pair.mjs TARGET_CORE '+source);
writeFileSync(join(root,paths.meta),text);
console.log(JSON.stringify({source,sections:records.size,lines:en.split('\n').length-1}));
