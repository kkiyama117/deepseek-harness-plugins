/** Copy preserved local extensions into independent packages; never change the running Host. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error('Usage: node prepare-local-packages.mjs PRESERVED_DSH TARGET_DSH');
const source = resolve(sourceArg);
const target = resolve(targetArg);
const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(target, 'package.json'));
const ts = require('typescript');
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#426B8F" d="M4 4h24v24H4z"/><path fill="none" stroke="white" stroke-width="2" d="M9 11h14M9 16h9M9 21h14"/></svg>\n';
async function createPackage(directory, manifest, title, description) {
  const dir = join(root, directory);
  try { await access(dir); throw new Error(`Refusing to replace existing package ${dir}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(join(dir, 'locale'), { recursive: true });
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, version: '1.0.0', type: 'module', license: 'MIT', ...manifest, exports: { '.': './lib/index.js', './locale/*.json': './locale/*.json', './icon': './icon.svg', './package.json': './package.json', ...manifest.exports }, files: ['lib', 'src', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md', 'UPSTREAM.json', 'LICENSE'] }, null, 2) + '\n');
  await writeFile(join(dir, 'icon.svg'), icon);
  for (const locale of ['en', 'ja']) await writeFile(join(dir, 'locale', `${locale}.json`), JSON.stringify({meta:{title,description}}, null, 2)+'\n');
  await writeFile(join(dir, 'LICENSE'), await readFile(join(source, 'LICENSE')));
  return dir;
}
async function sourceFile(dir, relative, text) {
  await writeFile(join(dir, 'src', relative), text);
  const result = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } });
  await writeFile(join(dir, 'lib', relative.replace(/\.ts$/, '.js')), result.outputText.replace(/from '(\.\/.+)\.ts'/g, "from '$1.js'"));
}
const workflow = await createPackage('dsh-workflow-results', {
  name:'@kkiyama117/dsh-workflow-results', description:'Workflow result selection with retained complete evidence, using the official workflow engine.',
  peerDependencies:{'@deepseek-ai/cordis':'4.0.5-alpha.1','@deepseek-ai/schemastery':'3.18.1','@deepseek-ai/dsh-tools':'0.2.1-alpha.2','@deepseek-ai/dsh-workflow':'0.2.1-alpha.2'},
  dsh:{bundle:{patch:'./cordis.patch.yml'}}
}, 'Workflow result selection', 'Keep full workflow results in spill storage while returning selected fields.');
for (const file of ['index.ts','record.ts','types.ts']) await sourceFile(workflow, file, await readFile(join(source,'packages/workflow/tool-workflow/src',file),'utf8'));
await writeFile(join(workflow,'cordis.patch.yml'), '[]\n');
await writeFile(join(workflow,'UPSTREAM.json'), JSON.stringify({upstream:'@deepseek-ai/dsh-tool-workflow',base:'5badb15009ae1756c3afe0ae0cef1faafc290ccc',target:'d743267388641bc76f17c45ce8b4c231aed1d32c',preserved:'da1639e82401fc34dced7246c60168374f45e8d1',sourceFiles:['index.ts','record.ts','types.ts'],delta:'Optional resultKeys validates and saves the complete result before selected foreground/background delivery; upstream engine remains unchanged.'},null,2)+'\n');
await writeFile(join(workflow,'README.md'), '# Workflow result selection\n\nThis independent tool package retains the deployed `resultKeys` extension without patching DSH. It uses the official workflow engine and preserves native/background recording and cancellation. The complete JSON result is saved before selected fields are delivered; invalid keys or storage failure fail delivery.\n\nInstall this package, then replace the `tool-workflow` plugin in the selected preset with `@kkiyama117/dsh-workflow-results`; preserve its config and its isolated workflow engine. The package alone installs no Host tool. Source and upstream revision are recorded in `UPSTREAM.json`. `lib` is generated from `src` using the selected DSH checkout’s TypeScript compiler. The copied DSH code is MIT licensed; see LICENSE.\n');
const cleanup = await createPackage('dsh-session-cleanup', {
  name:'@kkiyama117/dsh-session-cleanup',description:'Release pi-ai Session-owned connection caches when the Session is disposed.',
  peerDependencies:{'@earendil-works/pi-ai':'>=0.87.1 <2','@deepseek-ai/dsh-session':'0.2.1-alpha.2'},
  dsh:{bundle:{patch:'./cordis.patch.yml'}}
}, 'Session connection cleanup', 'Release provider caches on Session disposal, never at each turn.');
await sourceFile(cleanup,'index.ts',`/** Release only the disposed Session's pi-ai resources through its public API. */\nimport { cleanupSessionResources } from '@earendil-works/pi-ai';\nexport const name = 'local-session-cleanup';\nexport const inject = ['sessions'];\nexport function apply(ctx) {\n  ctx.on('session/disposed', session => { cleanupSessionResources(session.id); });\n}\n`);
await writeFile(join(cleanup,'cordis.patch.yml'), "- insert:\n    - id: local-session-cleanup\n      name: '@kkiyama117/dsh-session-cleanup'\n");
await writeFile(join(cleanup,'README.md'),'# Session connection cleanup\n\nListens to the official `session/disposed` event and calls pi-ai’s public `cleanupSessionResources(session.id)`. It never clears all Sessions or closes a cache after each turn. Cordis owns listener disposal. Socket closure is requested synchronously; peer closure is not awaited.\n\nThe imported pi-ai package is a peer so the Host adapter and this listener use the same module identity. Installation selects the Host row `local-session-cleanup`. No model calls, timers, stored records, or monkey patches are added.\n');
console.log(JSON.stringify({workflow,cleanup}));
