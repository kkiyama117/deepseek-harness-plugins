/** Emit the external extension artifacts with the selected DSH compiler; no Host is changed. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
const target = process.argv[2];
if (!target) throw new Error('Usage: node build-local-extensions.mjs TARGET_DSH');
const root = resolve(import.meta.dirname, '..');
const ts = createRequire(join(resolve(target), 'package.json'))('typescript');
for (const [name, files] of Object.entries({
  'dsh-workflow-results': ['index.ts', 'record.ts', 'types.ts'],
  'dsh-goal-acceptance': ['index.ts', 'check.ts', 'schema.ts', 'goal-provider.ts', 'subagent-provider.ts'],
  'dsh-session-cleanup': ['index.ts'],
})) {
  await mkdir(join(root, 'plugins', name, 'lib'), { recursive: true });
  for (const file of files) {
    const source = await readFile(join(root, 'plugins', name, 'src', file), 'utf8');
    const output = ts.transpileModule(source, {fileName: file, compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:true}});
    await writeFile(join(root, 'plugins', name, 'lib', file.replace(/\.ts$/, '.js')), output.outputText.replace(/from '(\.\/.+)\.ts'/g,"from '$1.js'"));
  }
  console.log(name);
}
